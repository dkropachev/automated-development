'use strict'
// Turn each tool's prose report into a list of findings. Every tool writes a different shape of
// report - a table, a numbered list, a SARIF-ish dump, a wall of headings - and none of them can be
// compared until they are the same shape, so a small model reads each report and emits one JSON
// row per finding. Nothing is judged here: a claim is copied out exactly as the tool made it.
//
//   node bench/extract.js [--only <target>] [--tool <tool>] [--force]
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = __dirname
const args = process.argv.slice(2)
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const only = flag('--only', null)
const onlyTool = flag('--tool', null)
const force = args.includes('--force')

const INSTRUCTIONS = `You are given one code-review report. Extract every distinct finding it makes.

Rules:
- One row per distinct claim about the code. A finding repeated in a summary and again in a detail section is ONE row.
- Copy the tool's own claim; do not verify it, do not add findings of your own, do not drop findings you disagree with.
- "file" and "line" as the report gives them ("" and 0 if it gives none).
- "title": <=90 chars, the defect, not the fix.
- "severity": one of blocker, high, medium, low, nit - map the report's own wording onto that scale.
- "kind": one of bug, security, test-gap, style, docs, perf, design, question.
- "claim": one or two sentences stating what the tool says is wrong.
- "selfRejected": true if the report explicitly says it checked this and it is NOT a problem, or that it is out of scope and was not investigated.
Return ONLY a JSON array, no prose, no code fences. An empty report is [].

REPORT:
`

function extractOne(file) {
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  const report = rec.result || ''
  if (!report.trim()) return { ...rec, findings: [], extractError: 'empty report' }
  const r = spawnSync('claude', ['-p', INSTRUCTIONS + report, '--output-format', 'json',
    '--model', 'sonnet', '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'WebSearch', 'WebFetch', 'Bash', 'Edit', 'Write'],
  { maxBuffer: 1 << 28, encoding: 'utf8', cwd: path.join(ROOT, 'work') })
  let findings = [], err = null
  try {
    const text = JSON.parse(r.stdout).result || ''
    const body = text.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim()
    findings = JSON.parse(body.slice(body.indexOf('[')))
  } catch (e) { err = `${e.message}: ${(r.stdout || r.stderr || '').slice(0, 300)}` }
  return { ...rec, findings, extractError: err }
}

const results = path.join(ROOT, 'results')
for (const target of fs.readdirSync(results)) {
  if (only && target !== only) continue
  for (const f of fs.readdirSync(path.join(results, target))) {
    if (!f.endsWith('.json')) continue
    const tool = f.replace(/\.json$/, '')
    if (onlyTool && tool !== onlyTool) continue
    const out = path.join(ROOT, 'findings', target, f)
    if (fs.existsSync(out) && !force) { console.log(`skip ${target}/${tool}`); continue }
    const rec = extractOne(path.join(results, target, f))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify({
      target, tool, label: rec.label, findings: rec.findings, extractError: rec.extractError,
    }, null, 2) + '\n')
    console.log(`${target}/${tool}: ${rec.findings.length} findings${rec.extractError ? ' (' + rec.extractError + ')' : ''}`)
  }
}
