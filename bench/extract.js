'use strict'
// Turn each tool's prose report into comparable findings inside the selected immutable cohort.
//
//   node bench/extract.js [--run <run-id>] [--only <target>] [--tool <tool>]
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  acquireLocalLock,
  assertSafeId,
  defaultRunId,
  ensureSeal,
  findingFileForCell,
  manifestMetadata,
  readFindingRecord,
  releaseLocalLock,
  resultFileForCell,
  validateClaudeResponse,
  validateFinding,
  validateFindingRecord,
  writeJsonExclusive,
} = require('./lib/artifacts')
const quota = require('./quota')

const ROOT = __dirname
const CLAUDE = process.env.CLAUDE || 'claude'
const EXTRACTOR_MODEL = 'claude-sonnet-5'
const TITLE_LIMIT = 90

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

function parseArgs(argv, root = ROOT) {
  if (argv.includes('--force')) throw new Error('--force is not supported; benchmark artifacts are append-only')
  const options = { runId: defaultRunId(root), only: null, onlyTool: null }
  const value = (flag, index) => {
    const next = argv[index + 1]
    if (next == null || next.startsWith('--')) throw new Error(`${flag} requires a value`)
    return next
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--run') { options.runId = assertSafeId(value(arg, i++), 'run id'); continue }
    if (arg === '--only') { options.only = assertSafeId(value(arg, i++), 'target'); continue }
    if (arg === '--tool') { options.onlyTool = assertSafeId(value(arg, i++), 'tool'); continue }
    throw new Error(`unknown argument: ${arg}`)
  }
  if (options.runId === 'legacy') throw new Error('legacy cohort is read-only')
  return options
}

function extractorArgs(report) {
  return [
    '-p', INSTRUCTIONS + report,
    '--output-format', 'json',
    '--model', EXTRACTOR_MODEL,
    '--effort', 'high',
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'WebSearch', 'WebFetch', 'Bash', 'Edit', 'Write',
  ]
}

// Model output occasionally exceeds its requested title ceiling by a few characters. Titles are
// display summaries, so shorten only that field mechanically; claims and all scoring fields stay
// verbatim and still pass strict schema validation below.
function normalizeTitle(title) {
  if (typeof title !== 'string') return title
  const clean = title.trim()
  if (clean.length <= TITLE_LIMIT) return clean
  const prefix = clean.slice(0, TITLE_LIMIT - 1)
  const atWord = prefix.replace(/\s+\S*$/, '').trimEnd()
  return (atWord || prefix.trimEnd()) + '…'
}

function normalizeFindings(findings) {
  return findings.map((finding) => (
    finding && typeof finding === 'object' && !Array.isArray(finding)
      ? { ...finding, title: normalizeTitle(finding.title) }
      : finding
  ))
}

function extractOne(file, cwd, executable = CLAUDE, dependencies = {}) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  const report = record.result || ''
  if (!report.trim()) return { ok: true, record, findings: [], extractError: null, modelUsage: null, sourceReportEmpty: true }
  const runExtractor = dependencies.spawnSync || spawnSync
  const result = runExtractor(executable, extractorArgs(report), { maxBuffer: 1 << 28, encoding: 'utf8', cwd })
  let meta
  try {
    meta = JSON.parse(result.stdout)
  } catch (error) {
    return { ok: false, record, error: `invalid extractor response: ${error.message}: ${(result.stdout || result.stderr || '').slice(0, 300)}` }
  }
  try {
    validateClaudeResponse(result, meta, EXTRACTOR_MODEL)
    const text = meta.result || ''
    const body = text.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim()
    const start = body.indexOf('[')
    if (start < 0) throw new Error('JSON array not found')
    const findings = JSON.parse(body.slice(start))
    if (!Array.isArray(findings)) throw new Error('extractor output is not an array')
    return { ok: true, record, findings: normalizeFindings(findings), extractError: null, modelUsage: meta.modelUsage || null }
  } catch (error) {
    return { ok: false, record, error: `invalid extractor findings: ${error.message}: ${(result.stdout || result.stderr || '').slice(0, 300)}` }
  }
}

function assertRecordCohort(record, manifest) {
  for (const [key, value] of Object.entries(manifestMetadata(manifest))) {
    if (record[key] !== value) {
      throw new Error(`${record.target || 'result'}/${record.tool || 'unknown'} ${key} does not match cohort manifest`)
    }
  }
}

function main(argv = process.argv.slice(2), root = ROOT, dependencies = {}) {
  const options = parseArgs(argv, root)
  const { manifest, seal } = ensureSeal(root, options.runId)
  const cwd = fs.existsSync(path.join(root, 'work')) ? path.join(root, 'work') : root
  const runExtract = dependencies.extractOne || extractOne
  const authorize = dependencies.authorizePaidCall || quota.authorizePaidCall
  let failures = 0
  for (const sealedCell of seal.cells) {
    const { target, tool } = sealedCell
    assertSafeId(target, 'target')
    if (options.only && target !== options.only) continue
    if (options.onlyTool && tool !== options.onlyTool) continue
    const input = resultFileForCell(root, manifest.runId, sealedCell)
    const out = findingFileForCell(root, manifest.runId, sealedCell)
    if (fs.existsSync(out)) {
      readFindingRecord(out, manifest, sealedCell)
      console.log(`skip ${target}/${tool}`)
      continue
    }
    const lock = acquireLocalLock(out + '.lock')
    if (!lock) {
      if (fs.existsSync(out)) readFindingRecord(out, manifest, sealedCell)
      console.log(`skip ${target}/${tool} (${fs.existsSync(out) ? 'recorded' : 'claimed by another extractor'})`)
      continue
    }
    try {
      if (fs.existsSync(out)) {
        readFindingRecord(out, manifest, sealedCell)
        console.log(`skip ${target}/${tool}`)
        continue
      }
      const source = JSON.parse(fs.readFileSync(input, 'utf8'))
      let executable = CLAUDE
      let authorization = null
      if (manifest.requestedModel === 'claude-fable-5-1' && source.result.trim()) {
        authorization = authorize(root, {
          runId: manifest.runId, stage: 'extract', target, tool,
          claudeVersion: manifest.claudeVersion,
        }, dependencies)
        executable = authorization.executable
      }
      const extracted = runExtract(input, cwd, executable, dependencies)
      if (!extracted.ok) {
        console.error(`FAIL ${target}/${tool}: ${extracted.error}`)
        return failures + 1
      }
      try {
        extracted.findings.forEach((finding, index) => validateFinding(finding, `${sealedCell.id} finding ${index + 1}`))
      } catch (error) {
        console.error(`FAIL ${target}/${tool}: ${error.message}`)
        return failures + 1
      }
      const pins = manifest.targets[target]
      const record = {
        schemaVersion: 2,
        ...manifestMetadata(manifest),
        cellId: sealedCell.id,
        target,
        tool,
        baseSha: pins.baseSha,
        headSha: pins.headSha,
        sourceResultSha256: sealedCell.sha256,
        label: extracted.record.label,
        findings: extracted.findings,
        extractError: null,
        sourceReportEmpty: Boolean(extracted.sourceReportEmpty),
        extractorRequestedModel: extracted.sourceReportEmpty ? null : EXTRACTOR_MODEL,
        extractorModelUsage: extracted.modelUsage,
        extractionSkippedReason: extracted.sourceReportEmpty ? 'empty-source-report' : null,
        ...(manifest.requestedModel === 'claude-fable-5-1'
          ? { quotaEvidence: extracted.sourceReportEmpty ? null : authorization && authorization.quotaEvidence }
          : {}),
        extractedAt: new Date().toISOString(),
      }
      validateFindingRecord(record, manifest, sealedCell)
      try {
        writeJsonExclusive(out, record)
      } catch (error) {
        if (error.code === 'EEXIST') {
          readFindingRecord(out, manifest, sealedCell)
          console.log(`skip ${target}/${tool}`)
          continue
        }
        throw error
      }
      console.log(`${target}/${tool}: ${record.findings.length} findings`)
    } finally {
      releaseLocalLock(lock)
    }
  }
  return failures
}

module.exports = {
  EXTRACTOR_MODEL, TITLE_LIMIT, assertRecordCohort, extractOne, extractorArgs, main,
  normalizeFindings, normalizeTitle, parseArgs,
}

if (require.main === module) {
  try {
    if (main() > 0) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
