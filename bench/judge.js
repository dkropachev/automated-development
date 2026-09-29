'use strict'
// Merge and verify findings from one immutable benchmark cohort.
//
//   node bench/judge.js [--run <run-id>] [--only <target>]
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  acquireLocalLock,
  assertSafeId,
  cohortPaths,
  defaultRunId,
  ensureComplete,
  findingFileForCell,
  manifestMetadata,
  readJudgementRecord,
  readSeal,
  releaseLocalLock,
  validateFindingRecord,
  validateIssues,
  validateJudgementRecord,
  writeJsonExclusive,
} = require('./lib/artifacts')
const { normalizeTitle } = require('./extract')
const { checkoutPrepared } = require('./run')

const ROOT = __dirname
const CLAUDE = process.env.CLAUDE || 'claude'
const JUDGE_MODEL = 'claude-sonnet-5'

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
    "reportedByRuns": ["run-id/target-id/tool-id", "..."],
    "reportedAs": { "tool-id": "that tool's own wording, trimmed" },
    "reportedAsByRun": { "run-id/target-id/tool-id": "that cell's own wording, trimmed" }
  }
]`

function parseArgs(argv, root = ROOT) {
  if (argv.includes('--force')) throw new Error('--force is not supported; benchmark artifacts are append-only')
  const options = { runId: defaultRunId(root), only: null }
  const value = (flag, index) => {
    const next = argv[index + 1]
    if (next == null || next.startsWith('--')) throw new Error(`${flag} requires a value`)
    return next
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--run') { options.runId = assertSafeId(value(arg, i++), 'run id'); continue }
    if (arg === '--only') { options.only = assertSafeId(value(arg, i++), 'target'); continue }
    throw new Error(`unknown argument: ${arg}`)
  }
  if (options.runId === 'legacy') throw new Error('legacy cohort is read-only')
  return options
}

function prompt(target, findingsBlob) {
  return `You are adjudicating a set of code-review findings about pull request #${target.forkPr} in this repository, which is checked out at the PR's head commit. Its base branch is \`main\`; the change under review is exactly \`git diff main...HEAD\`.

Several independent review tools each reviewed this same PR. Their findings are below as JSON. Each is tagged with both its tool ID and its full benchmark cell ID.

Your job, in order:

1. MERGE. Group findings that are the same defect in the same place, even when the wording differs. Different defects in the same function stay separate. Keep every distinct claim - including ones only one tool made.
2. VERIFY. For each merged issue, read the actual code and decide:
   - "real": the code does what the finding says and that is a defect.
   - "false-positive": the code does not do what the finding says, or what it does is correct.
   - "unproven": you could not settle it without running something you cannot run. Use this sparingly and say what is missing.
   Run things if it helps - the tree is yours to build and test, but do not commit, push, or comment on the PR.
3. SCOPE. "introducedByPr": true when the PR's own diff created the defect or made it reachable/worse. "scope": "in-scope" when this PR is the right place to fix it - a defect the PR introduced, or one its change makes reachable - otherwise "out-of-scope" (pre-existing and untouched). Undecidable counts as in-scope.
4. RATE. Severity is about consequence: blocker = data loss, crash, or wrong results on a normal path; nit = cosmetic.
5. ATTRIBUTE. Copy tool IDs into reportedBy and full cell IDs into reportedByRuns. Keep reportedAs keyed by tool ID for compatibility, and reportedAsByRun keyed by full cell ID.

Judge the claim on its merits. A finding that only one tool made is not weaker for that, and one that five tools made is not stronger.

Write your answer as JSON to ./judgement.json in this exact shape, and nothing else in that file:

${SCHEMA}

FINDINGS:
${findingsBlob}
`
}

function judgeArgs(text) {
  return [
    '-p', text,
    '--output-format', 'json',
    '--model', JUDGE_MODEL,
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'WebSearch', 'WebFetch',
  ]
}

function normalizeAttribution(issues, blob, runId, targetId) {
  const cells = new Map(blob.map((finding) => [finding.cellId, finding.tool]))
  const cellForTool = new Map(blob.map((finding) => [finding.tool, finding.cellId]))
  return issues.map((issue) => {
    const reportedBy = [...new Set((issue.reportedBy || []).filter((tool) => cellForTool.has(tool)))]
    const reportedByRuns = [...new Set((issue.reportedByRuns || []).filter((id) => cells.has(id)))]
    for (const tool of reportedBy) {
      const id = cellForTool.get(tool)
      if (!reportedByRuns.includes(id)) reportedByRuns.push(id)
    }
    for (const id of reportedByRuns) {
      const tool = cells.get(id)
      if (!reportedBy.includes(tool)) reportedBy.push(tool)
    }
    const reportedAs = { ...(issue.reportedAs || {}) }
    const reportedAsByRun = { ...(issue.reportedAsByRun || {}) }
    for (const tool of reportedBy) {
      const id = cellForTool.get(tool) || `${runId}/${targetId}/${tool}`
      if (reportedAsByRun[id] == null && reportedAs[tool] != null) reportedAsByRun[id] = reportedAs[tool]
      if (reportedAs[tool] == null && reportedAsByRun[id] != null) reportedAs[tool] = reportedAsByRun[id]
    }
    return { ...issue, title: normalizeTitle(issue.title), reportedBy, reportedByRuns, reportedAs, reportedAsByRun }
  })
}

function loadSealedFindings(root, manifest, seal) {
  const byTarget = new Map()
  for (const sealedCell of seal.cells) {
    const file = findingFileForCell(root, manifest.runId, sealedCell)
    if (!fs.existsSync(file)) throw new Error(`missing successful finding for sealed cell: ${sealedCell.id}`)
    const record = validateFindingRecord(JSON.parse(fs.readFileSync(file, 'utf8')), manifest, sealedCell)
    const blob = byTarget.get(sealedCell.target) || []
    for (const finding of record.findings) blob.push({ ...finding, tool: sealedCell.tool, cellId: sealedCell.id })
    byTarget.set(sealedCell.target, blob)
  }
  return byTarget
}

function judgeTarget(root, manifest, target, cells, blob, out, dependencies) {
  if (fs.existsSync(out)) {
    readJudgementRecord(out, manifest, target.id, cells)
    console.log(`skip ${target.id}`)
    return
  }
  const lock = acquireLocalLock(out + '.lock')
  if (!lock) {
    if (fs.existsSync(out)) readJudgementRecord(out, manifest, target.id, cells)
    console.log(`skip ${target.id} (${fs.existsSync(out) ? 'recorded' : 'claimed by another judge'})`)
    return
  }
  try {
    if (fs.existsSync(out)) {
      readJudgementRecord(out, manifest, target.id, cells)
      console.log(`skip ${target.id}`)
      return
    }
    const prepareCheckout = dependencies.checkoutPrepared || checkoutPrepared
    const runJudge = dependencies.spawnSync || spawnSync
    const checkout = prepareCheckout(root, target, { id: '_judge' }, manifest.runId, manifest.targets[target.id])
    console.log(`judging ${target.id}: ${blob.length} raw findings from ${cells.length} tools`)
    const file = path.join(checkout.repo, 'judgement.json')
    if (fs.existsSync(file)) throw new Error(`judge workspace is not fresh: ${file}`)
    const result = runJudge(CLAUDE, judgeArgs(prompt(target, JSON.stringify(blob, null, 1))), {
      cwd: checkout.repo, maxBuffer: 1 << 28, encoding: 'utf8',
    })
    if (result.error) throw new Error(`judge failed for ${target.id}: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`judge exited ${result.status} for ${target.id}: ${(result.stderr || '').slice(-400)}`)
    let meta
    try { meta = JSON.parse(result.stdout) } catch (error) {
      throw new Error(`invalid judge response for ${target.id}: ${error.message}`, { cause: error })
    }
    if (meta.is_error || meta.api_error_status || /hit your (session|usage) limit|usage limit reached|rate_limit_error/i.test(meta.result || '')) {
      throw new Error(`judge model error for ${target.id}: ${meta.result || meta.api_error_status}`)
    }
    if (!fs.existsSync(file)) throw new Error(`judge produced no judgement.json for ${target.id}`)
    const issues = normalizeAttribution(JSON.parse(fs.readFileSync(file, 'utf8')), blob, manifest.runId, target.id)
    validateIssues(issues, cells)
    const record = {
      schemaVersion: 2,
      ...manifestMetadata(manifest),
      target: target.id,
      language: target.language,
      baseSha: manifest.targets[target.id].baseSha,
      headSha: manifest.targets[target.id].headSha,
      rawFindings: blob.length,
      issues,
      judgeCostUsd: meta && meta.total_cost_usd,
      judgeRequestedModel: JUDGE_MODEL,
      judgeModelUsage: meta && meta.modelUsage,
      workspace: checkout.workspace,
      judgedAt: new Date().toISOString(),
    }
    validateJudgementRecord(record, manifest, target.id, cells)
    try {
      writeJsonExclusive(out, record)
    } catch (error) {
      if (error.code === 'EEXIST') {
        readJudgementRecord(out, manifest, target.id, cells)
        console.log(`skip ${target.id}`)
        return
      }
      throw error
    }
    console.log(`  ${issues.length} issues -> ${out}`)
  } finally {
    releaseLocalLock(lock)
  }
}

function main(argv = process.argv.slice(2), root = ROOT, dependencies = {}) {
  const options = parseArgs(argv, root)
  const { manifest, seal } = readSeal(root, options.runId)
  const paths = cohortPaths(root, options.runId)
  // Validate every sealed cell before publishing any target judgement. A partial extraction remains
  // retryable and can never produce an immutable partial judgement cohort.
  const findingsByTarget = loadSealedFindings(root, manifest, seal)
  const cellsByTarget = new Map()
  for (const sealedCell of seal.cells) {
    const cells = cellsByTarget.get(sealedCell.target) || []
    cells.push(sealedCell)
    cellsByTarget.set(sealedCell.target, cells)
  }
  for (const target of Object.values(manifest.targetMetadata)) {
    assertSafeId(target.id, 'target')
    if (options.only && target.id !== options.only) continue
    const out = path.join(paths.judgement, `${target.id}.json`)
    const cells = cellsByTarget.get(target.id) || []
    if (!cells.length) { console.log(`no sealed results for ${target.id}`); continue }
    const blob = findingsByTarget.get(target.id) || []
    judgeTarget(root, manifest, target, cells, blob, out, dependencies)
  }
  const completed = ensureComplete(root, manifest.runId)
  console.log(completed ? `complete ${manifest.runId}` : `pending ${manifest.runId}: judgements remain`)
}

module.exports = { JUDGE_MODEL, SCHEMA, judgeArgs, judgeTarget, loadSealedFindings, main, normalizeAttribution, parseArgs, prompt }

if (require.main === module) {
  try { main() } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
