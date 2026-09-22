'use strict'
// Run every review tool against every prepared PR, one headless `claude -p` process per pair, and
// record what each one said and what it spent.
//
//   node bench/run.js [--only <target>] [--tool <tool>] [--concurrency N] [--timeout MIN] [--force] [--list]
//
// Each pair gets a working directory of its own - that is what makes the token accounting exact,
// because Claude Code files transcripts per working directory and nothing else writes there.
// Results land in bench/results/<target>/<tool>.json and a run already recorded is skipped, so the
// matrix can be stopped and resumed.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { run, git, gitTry } = require('./lib/exec')
const { totalsForCwd } = require('./lib/usage')

const ROOT = __dirname
const args = process.argv.slice(2)
const flag = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def)
const only = flag('--only', null)
const onlyTool = flag('--tool', null)
const concurrency = Number(flag('--concurrency', '2'))
const timeoutMs = Number(flag('--timeout', '120')) * 60_000
const force = args.includes('--force')
const includeParked = args.includes('--include-parked')
const listOnly = args.includes('--list')

const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8'))
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.json'), 'utf8'))

function fill(tpl, t, tool) {
  const context = cfg.context
    .replace(/{pr}/g, t.forkPr).replace(/{fork}/g, t.fork)
    .replace(/{language}/g, t.language).replace(/{head}/g, t.forkHead)
  return tpl
    .replace(/{context}/g, context)
    .replace(/{pr}/g, t.forkPr).replace(/{prUrl}/g, t.forkPrUrl)
    .replace(/{fork}/g, t.fork).replace(/{language}/g, t.language)
    .replace(/{head}/g, t.forkHead).replace(/{tool}/g, tool.id)
}

// A fresh checkout of the blinded PR, cloned from the local copy so the network is not hit once per
// run, with `origin` repointed at the private repo so `gh pr view` resolves the PR.
function workspace(t, tool) {
  const dir = path.join(ROOT, 'work', t.id, 'runs', tool.id)
  const repo = path.join(dir, 'repo')
  if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  run('git', ['clone', '--quiet', path.join(ROOT, 'work', t.id, 'src'), repo])
  git(repo, 'checkout', '--quiet', '-B', 'main', 'origin/main')
  git(repo, 'checkout', '--quiet', '-B', t.forkHead, 'origin/pr')
  gitTry(repo, 'remote', 'set-url', 'origin', `git@github.com:${t.fork}.git`)
  gitTry(repo, 'config', 'user.name', 'Bench Author')
  gitTry(repo, 'config', 'user.email', 'bench@example.invalid')
  return repo
}

function claudeRun(prompt, cwd) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('claude', [
      '-p', prompt,
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      // No web: the upstream project's own PR, with the maintainers' review already on it, is one
      // search away, and a reviewer that reads it is not reviewing anything.
      '--disallowedTools', 'WebSearch', 'WebFetch',
    ], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, out, err, wallMs: Date.now() - started })
    })
  })
}

const pairs = []
for (const t of Object.values(state.targets)) {
  if (only && t.id !== only) continue
  for (const tool of cfg.tools) {
    if (onlyTool && tool.id !== onlyTool) continue
    if (tool.languages && !tool.languages.includes(t.language)) continue
    const outFile = path.join(ROOT, 'results', t.id, `${tool.id}.json`)
    pairs.push({ t, tool, outFile })
  }
}

if (listOnly) {
  for (const p of pairs) console.log(`${p.t.id.padEnd(12)} ${p.tool.id.padEnd(22)} ${fs.existsSync(p.outFile) ? 'done' : p.tool.parked ? 'parked' : 'pending'}`)
  console.log(`${pairs.length} pairs`)
  process.exit(0)
}

// Claimed before the workspace is built, with an exclusive create, so several runner processes can
// chew through the same matrix without two of them starting the same pair.
function claim(outFile) {
  const lock = outFile + '.lock'
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true } catch { return false }
}

// A run that ends on the account's usage limit has not reviewed anything - it must not be recorded
// as a result, or the matrix would skip it forever on the next pass.
const LIMIT = /hit your (session|usage) limit|usage limit reached|rate_limit_error/i
function hitLimit(parsed, out) {
  if (parsed && parsed.api_error_status === 429) return true
  const text = (parsed && parsed.result) || out || ''
  return LIMIT.test(text)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function execPair(p) {
  const { t, tool, outFile } = p
  // A parked tool stays in the matrix so the report still accounts for it, but it is never launched
  // again: parking is what we do to a tool whose run cannot finish inside one usage window, and
  // retrying it only spends the window. `--include-parked` is the deliberate override.
  if (tool.parked && !includeParked) { console.log(`skip ${t.id}/${tool.id} (parked: ${tool.parkedReason || 'parked'})`); return }
  if (fs.existsSync(outFile) && !force) { console.log(`skip ${t.id}/${tool.id} (recorded)`); return }
  if (!claim(outFile)) { console.log(`skip ${t.id}/${tool.id} (claimed by another runner)`); return }
  const prompt = fill(tool.prompt, t, tool)
  let repo, r, parsed
  for (let attempt = 1; ; attempt += 1) {
    repo = workspace(t, tool)
    console.log(`start ${t.id}/${tool.id}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
    r = await claudeRun(prompt, repo)
    // Reset per attempt: a killed or crashed run has no json, and the previous attempt's parse
    // must not be mistaken for this one's.
    parsed = null
    try { parsed = JSON.parse(r.out) } catch {}
    if (!hitLimit(parsed, r.out)) break
    const wait = Math.min(30, 5 * attempt)
    console.log(`limit  ${t.id}/${tool.id} - ${(parsed && parsed.result) || 'usage limit'}; retrying in ${wait} min`)
    await sleep(wait * 60_000)
  }
  const usage = totalsForCwd(repo)
  const rec = {
    target: t.id, language: t.language, fork: t.fork, pr: t.forkPr,
    tool: tool.id, label: tool.label, source: tool.source,
    prompt, exitCode: r.code, signal: r.signal, wallMs: r.wallMs,
    reportedCostUsd: parsed ? parsed.total_cost_usd : null,
    reportedUsage: parsed ? parsed.usage : null,
    modelUsage: parsed ? parsed.modelUsage : null,
    numTurns: parsed ? parsed.num_turns : null,
    subagentStats: parsed ? parsed.subagent_stats : null,
    sessionId: parsed ? parsed.session_id : null,
    isError: parsed ? parsed.is_error : true,
    apiErrorStatus: parsed ? parsed.api_error_status : null,
    transcriptUsage: usage,
    result: parsed ? parsed.result : null,
    stderrTail: r.err.slice(-4000),
    finishedAt: new Date().toISOString(),
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(rec, null, 2) + '\n')
  console.log(`done  ${t.id}/${tool.id} exit=${r.code} ${Math.round(r.wallMs / 1000)}s tokens=${usage.total} cost=${rec.reportedCostUsd}`)
}

async function main() {
  const queue = pairs.slice()
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const p = queue.shift()
      if (!p) return
      try { await execPair(p) } catch (e) { console.log(`FAIL ${p.t.id}/${p.tool.id}: ${e.message.slice(0, 500)}`) }
    }
  })
  await Promise.all(workers)
}
main()
