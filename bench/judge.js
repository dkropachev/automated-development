'use strict'
// Decide, once per PR, what all the tools between them actually found. Every extracted finding from
// every tool goes to one judge that has the repository in front of it; the judge merges the ones
// that are the same defect, checks each merged issue against the real code, and records four things
// the report is built on: is it real, is it in this PR's scope, did this PR introduce it, and which
// tools reported it.
//
// The judge is deliberately not shown the upstream project's own review - that comparison is made
// afterwards, from bench/groundtruth/, so the judge cannot simply agree with the maintainers.
//
//   node bench/judge.js [--only <target>] [--force]
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { run, git, gitTry } = require('./lib/exec')

const ROOT = __dirname
const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const force = args.includes('--force')
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8'))

const SCHEMA = `[
  {
    "id": "I1",
    "title": "<=90 chars, the defect",
    "file": "path/from/repo/root",
    "line": 0,
    "kind": "bug|security|test-gap|style|docs|perf|design|question",
    "severity": "blocker|high|medium|low|nit",
    "verdict": "real|false-positive|unproven",
    "verdictReason": "one or two sentences, naming the code you checked",
    "introducedByPr": true,
    "scope": "in-scope|out-of-scope",
    "scopeReason": "one sentence",
    "reportedBy": ["tool-id", "..."],
    "reportedAs": { "tool-id": "that tool's own wording, trimmed" }
  }
]`

function prompt(target, findingsBlob) {
  return `You are adjudicating a set of code-review findings about pull request #${target.forkPr} in this repository, which is checked out at the PR's head commit. Its base branch is \`main\`; the change under review is exactly \`git diff main...HEAD\`.

Several independent review tools each reviewed this same PR. Their findings are below as JSON, each tagged with the tool that produced it.

Your job, in order:

1. MERGE. Group findings that are the same defect in the same place, even when the wording differs. Different defects in the same function stay separate. Keep every distinct claim - including ones only one tool made.
2. VERIFY. For each merged issue, read the actual code and decide:
   - "real": the code does what the finding says and that is a defect.
   - "false-positive": the code does not do what the finding says, or what it does is correct.
   - "unproven": you could not settle it without running something you cannot run. Use this sparingly and say what is missing.
   Run things if it helps - the tree is yours to build and test, but do not commit, push, or comment on the PR.
3. SCOPE. "introducedByPr": true when the PR's own diff created the defect or made it reachable/worse. "scope": "in-scope" when this PR is the right place to fix it - a defect the PR introduced, or one its change makes reachable - otherwise "out-of-scope" (pre-existing and untouched). Undecidable counts as in-scope.
4. RATE. Severity is about consequence: blocker = data loss, crash, or wrong results on a normal path; nit = cosmetic.

Judge the claim on its merits. A finding that only one tool made is not weaker for that, and one that five tools made is not stronger.

Write your answer as JSON to ./judgement.json in this exact shape, and nothing else in that file:

${SCHEMA}

FINDINGS:
${findingsBlob}
`
}

for (const t of Object.values(state.targets)) {
  if (only && t.id !== only) continue
  const out = path.join(ROOT, 'judgement', `${t.id}.json`)
  if (fs.existsSync(out) && !force) { console.log(`skip ${t.id}`); continue }
  const dir = path.join(ROOT, 'findings', t.id)
  if (!fs.existsSync(dir)) { console.log(`no findings for ${t.id}`); continue }
  const blob = []
  for (const f of fs.readdirSync(dir)) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    for (const fi of rec.findings || []) blob.push({ tool: rec.tool, ...fi })
  }
  const repo = path.join(ROOT, 'work', t.id, 'runs', '_judge', 'repo')
  fs.rmSync(repo, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(repo), { recursive: true })
  run('git', ['clone', '--quiet', path.join(ROOT, 'work', t.id, 'src'), repo])
  git(repo, 'checkout', '--quiet', '-B', 'main', 'origin/main')
  git(repo, 'checkout', '--quiet', '-B', t.forkHead, 'origin/pr')
  gitTry(repo, 'remote', 'set-url', 'origin', `git@github.com:${t.fork}.git`)
  console.log(`judging ${t.id}: ${blob.length} raw findings from ${fs.readdirSync(dir).length} tools`)
  const r = spawnSync('claude', ['-p', prompt(t, JSON.stringify(blob, null, 1)),
    '--output-format', 'json', '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'WebSearch', 'WebFetch'],
  { cwd: repo, maxBuffer: 1 << 28, encoding: 'utf8' })
  let meta = null
  try { meta = JSON.parse(r.stdout) } catch { /* killed or crashed */ }
  const file = path.join(repo, 'judgement.json')
  if (!fs.existsSync(file)) { console.log(`  FAILED - no judgement.json (${(r.stderr || '').slice(-400)})`); continue }
  const issues = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({
    target: t.id, language: t.language, rawFindings: blob.length, issues,
    judgeCostUsd: meta && meta.total_cost_usd, judgedAt: new Date().toISOString(),
  }, null, 2) + '\n')
  console.log(`  ${issues.length} issues -> ${out}`)
}
