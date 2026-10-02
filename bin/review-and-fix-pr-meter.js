#!/usr/bin/env node
'use strict'
// review-and-fix-pr meter. Reads a workflow run's subagent transcripts and reports the
// token shape of each agent, so the orchestrator can calibrate its reset projection.
//
//   node review-and-fix-pr-meter.js --dir <.../subagents/workflows/<runId>> [--label-prefix chunk]
//   node review-and-fix-pr-meter.js --cwd <unique-review-worktree> --summary-only
//
// CRITICAL: the transcript writes one record per assistant CONTENT BLOCK, so a message
// carrying both `thinking` and `tool_use` appears twice with the same usage. Summing
// records naively double-counts input by ~1.8x. Everything here dedupes by requestId,
// keeping the record with the largest output_tokens (the complete one).

const fs = require('fs')
const path = require('path')

function argv(name, dflt) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1) return dflt
  const v = process.argv[i + 1]
  return (v === undefined || v.startsWith('--')) ? true : v
}

function workflowDirForCwd(cwd, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '.', '.claude')) {
  const root = fs.realpathSync(path.resolve(cwd))
  const project = path.join(configDir, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'))
  if (!fs.existsSync(project)) throw new Error('meter: no Claude project transcript directory for --cwd')
  const candidates = []
  for (const session of fs.readdirSync(project, { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    const workflows = path.join(project, session.name, 'subagents', 'workflows')
    if (!fs.existsSync(workflows)) continue
    for (const entry of fs.readdirSync(workflows, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = path.join(workflows, entry.name)
      const journal = path.join(directory, 'journal.jsonl')
      if (!fs.existsSync(journal)) continue
      candidates.push({ directory, modified: fs.statSync(journal).mtimeMs })
    }
  }
  if (!candidates.length) throw new Error('meter: no workflow transcript found for --cwd')
  candidates.sort((left, right) => right.modified - left.modified || right.directory.localeCompare(left.directory))
  return candidates[0].directory
}

const explicitDir = argv('dir')
const cwd = argv('cwd')
if ((explicitDir && cwd) || (!explicitDir && !cwd)) {
  console.error('meter: provide exactly one of --dir or --cwd')
  process.exit(2)
}
let DIR
try { DIR = explicitDir ? fs.realpathSync(path.resolve(explicitDir)) : workflowDirForCwd(cwd) } catch (error) {
  console.error(error.message)
  process.exit(2)
}
const PREFIX = argv('label-prefix', null)
const SUMMARY_ONLY = argv('summary-only', false) === true
if (!DIR || !fs.existsSync(DIR)) { console.error('meter: --dir must point at an existing run directory'); process.exit(2) }

const agents = []
for (const f of fs.readdirSync(DIR).filter(x => /^agent-.*\.jsonl$/.test(x)).sort()) {
  const metaPath = path.join(DIR, f.replace(/\.jsonl$/, '.meta.json'))
  let meta = {}
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) } catch { /* no meta yet */ }
  const label = meta.description || f
  if (PREFIX && typeof PREFIX === 'string' && !label.startsWith(PREFIX)) continue

  const byReq = new Map()
  const order = []
  let lines
  try { lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n') } catch { continue }
  for (const line of lines) {
    if (!line) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (r.type !== 'assistant') continue
    const m = r.message || {}
    const u = m.usage
    if (!u) continue
    const key = r.requestId || m.id
    if (!byReq.has(key)) { byReq.set(key, u); order.push(key) }
    else if ((u.output_tokens || 0) > (byReq.get(key).output_tokens || 0)) byReq.set(key, u)
  }
  if (!order.length) continue

  const ctxOf = u => (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0)
  const first = byReq.get(order[0])
  const last = byReq.get(order[order.length - 1])
  let O = 0, cr = 0, cw = 0, fresh = 0, sumCtx = 0
  for (const k of order) {
    const u = byReq.get(k)
    O += u.output_tokens || 0
    cr += u.cache_read_input_tokens || 0
    cw += u.cache_creation_input_tokens || 0
    fresh += u.input_tokens || 0
    sumCtx += ctxOf(u)
  }
  const S = ctxOf(first)                  // fixed prefix: system + tools + workflow prompt
  const C = ctxOf(last)                   // final context
  agents.push({
    label, phase: meta.workflowPhase || '',
    S, C, R: Math.max(0, C - S), N: order.length, O,
    input: fresh, cacheRead: cr, cacheCreation: cw, output: O,
    tokens: fresh + cr + cw + O, sumCtx,
    ite: Math.round(cr * 0.1 + cw * 1.25 + fresh + O * 5),
  })
}

// rho: how much a REPEAT pass over a chunk costs relative to a FIRST pass.
// Chunk agents are labelled "chunk <id> c<n>", so this is measurable rather than guessed.
const passOf = label => { const m = /^chunk\s+\S+\s+c(\d+)$/.exec(String(label)); return m ? Number(m[1]) : 0 }
const firsts = agents.filter(a => passOf(a.label) === 1)
const repeats = agents.filter(a => passOf(a.label) > 1)
const medianOf = (arr, k) => {
  if (!arr.length) return 0
  const v = arr.map(x => x[k]).sort((x, y) => x - y)
  return v[Math.floor(v.length / 2)]
}
const firstIte = medianOf(firsts, 'ite')
const repeatIte = medianOf(repeats, 'ite')
const rhoObserved = (firsts.length && repeats.length && firstIte > 0)
  ? Number((repeatIte / firstIte).toFixed(3))
  : -1

const sum = (k) => agents.reduce((n, a) => n + a[k], 0)
const med = (k) => {
  if (!agents.length) return 0
  const v = agents.map(a => a[k]).sort((x, y) => x - y)
  return v[Math.floor(v.length / 2)]
}

const tokens = {
  input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'),
  cacheCreation: sum('cacheCreation'),
}
tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation
// This script runs inside a helper agent. Its tool-use request is visible while the script reads
// transcripts; the agent's final structured-output request is not written until after the script
// returns. Reserve one full observed agent total plus bounded output for that in-flight tail so a
// near-limit measurement cannot authorize another wave on a stale undercount.
const meterAgents = agents.filter(agent => String(agent.label).startsWith('measure transcript tokens '))
// The first meter cannot see its own not-yet-written assistant response. Use the largest completed
// agent total as a conservative first-call proxy; later meters can use prior meter totals
// directly. Always reserve output too, so the first boundary never reports a zero in-flight tail.
const tailAgents = meterAgents.length ? meterAgents : agents
tokens.tailReserve = Math.max(0, ...tailAgents.map(agent => Math.max(agent.tokens, agent.C))) + 16384
tokens.effectiveTotal = tokens.total + tokens.tailReserve
const output = {
  ok: true,
  workflowDir: DIR,
  tokens,
  totals: { agents: agents.length, requests: sum('N'), output: sum('O'), ite: sum('ite') },
  medians: { S: med('S'), R: med('R'), N: med('N'), O: med('O'), C: med('C') },
  chunkMedians: firsts.length
    ? { S: medianOf(firsts, 'S'), R: medianOf(firsts, 'R'), N: medianOf(firsts, 'N'), O: medianOf(firsts, 'O') }
    : null,
  rho: { observed: rhoObserved, firstPasses: firsts.length, repeatPasses: repeats.length, firstIte, repeatIte },
}
if (!SUMMARY_ONLY) output.agents = agents
process.stdout.write(JSON.stringify(output, null, 2))
