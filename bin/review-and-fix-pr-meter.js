#!/usr/bin/env node
'use strict'
// review-and-fix-pr meter. Reads a workflow run's subagent transcripts and reports the
// token shape of each agent, so the orchestrator can calibrate its reset projection.
//
//   node review-and-fix-pr-meter.js --dir <.../subagents/workflows/<runId>> [--label-prefix chunk]
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

const DIR = argv('dir')
const PREFIX = argv('label-prefix', null)
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
    sumCtx,
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

process.stdout.write(JSON.stringify({
  agents,
  totals: { agents: agents.length, requests: sum('N'), output: sum('O'), ite: sum('ite') },
  medians: { S: med('S'), R: med('R'), N: med('N'), O: med('O'), C: med('C') },
  chunkMedians: firsts.length
    ? { S: medianOf(firsts, 'S'), R: medianOf(firsts, 'R'), N: medianOf(firsts, 'N'), O: medianOf(firsts, 'O') }
    : null,
  rho: { observed: rhoObserved, firstPasses: firsts.length, repeatPasses: repeats.length, firstIte, repeatIte },
}, null, 2))
