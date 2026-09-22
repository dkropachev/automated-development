'use strict'
// Recover a run whose parent process died while the review itself kept going. The report is the last
// assistant message in the session transcript and the spend is the session's own cost record, so a
// run is recoverable as long as its working directory survives.
//
//   node bench/salvage.js <target> <tool>
const fs = require('node:fs')
const path = require('node:path')
const { totalsForCwd, slugFor } = require('./lib/usage')

const argv = process.argv.slice(2)
// `--short` sweeps every recorded run and re-reads the transcript of any whose captured report is
// too short to be one - the sign-off after a background workflow, not the review.
if (argv[0] === '--short') {
  const { execFileSync } = require('node:child_process')
  const base = path.join(__dirname, 'results')
  for (const t of fs.readdirSync(base)) {
    for (const f of fs.readdirSync(path.join(base, t))) {
      if (!f.endsWith('.json')) continue
      const rec = JSON.parse(fs.readFileSync(path.join(base, t, f), 'utf8'))
      if ((rec.result || '').length >= 800) continue
      console.log(`short: ${t}/${rec.tool} (${(rec.result || '').length} chars) - re-reading transcript`)
      try { execFileSync('node', [__filename, t, rec.tool], { stdio: 'inherit' }) } catch { /* reported */ }
    }
  }
  process.exit(0)
}
const [target, tool] = argv
// A run whose tool was renamed after the fact still has its transcripts filed under the working
// directory it actually ran in, so that path can be given explicitly.
const cwdOverride = argv.includes('--cwd') ? argv[argv.indexOf('--cwd') + 1] : null
if (!target || !tool) { console.error('usage: node bench/salvage.js <target> <tool> [--cwd <dir>] | --short'); process.exit(2) }

const ROOT = __dirname
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8')).targets[target]
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.json'), 'utf8'))
const def = cfg.tools.find(t => t.id === tool)
const cwd = cwdOverride || path.join(ROOT, 'work', target, 'runs', tool, 'repo')
const dir = path.join(process.env.HOME, '.claude', 'projects', slugFor(cwd))

// The report is not always the final message: a run that polls a background workflow often signs off
// with a one-line remark after it, so the longest late message is a better bet than the last one.
const texts = []
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.isSidechain) continue
    const m = ev.message
    if (ev.type !== 'assistant' || !m || !Array.isArray(m.content)) continue
    const text = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
    const ts = Date.parse(ev.timestamp || 0) || 0
    if (text) texts.push({ text, ts })
  }
}
if (!texts.length) { console.error('no assistant text in', dir); process.exit(1) }
texts.sort((a, b) => a.ts - b.ts)
const tail = texts.slice(-10)
const pick = tail.reduce((best, t) => (t.text.length > best.text.length ? t : best), tail[0])
const last = pick.text
const when = pick.ts
const usage = totalsForCwd(cwd)
const out = path.join(ROOT, 'results', target, `${tool}.json`)
fs.writeFileSync(out, JSON.stringify({
  target, language: state.language, fork: state.fork, pr: state.forkPr,
  tool, label: def && def.label, source: def && def.source,
  salvaged: true, salvagedFrom: dir, usageCwd: cwd,
  exitCode: 0, isError: false, reportedCostUsd: usage.costUsd,
  transcriptUsage: usage, result: last, finishedAt: new Date(when).toISOString(),
}, null, 2) + '\n')
console.log(`${target}/${tool}: ${last.length} chars, ${usage.total} tokens, $${usage.costUsd.toFixed(2)} -> ${out}`)
