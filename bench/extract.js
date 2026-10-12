'use strict'
// Turn each tool's prose report into comparable findings inside the selected immutable cohort.
//
//   node bench/extract.js [--run <run-id>] [--only <target>] [--tool <tool>]
//                         [--max-budget-usd <amount>] [--timeout <minutes>]
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  acquireLocalLock,
  assertRecordMetadata,
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
  codexReceiptPath,
  REVIEW_AND_FIX_PR_CONTRACT_V3,
} = require('./lib/artifacts')
const { validateReceipt, hashReceipt } = require('../lib/review-codex-contract')
const quota = require('./quota')

const ROOT = __dirname
const CLAUDE = process.env.CLAUDE || 'claude'
const EXTRACTOR_MODEL = 'claude-sonnet-5'
const DEFAULT_TIMEOUT_MS = 120 * 60_000
const TITLE_LIMIT = 90
const MACHINE_REPORT_PREFIXES = Object.freeze([
  'REVIEW_AND_FIX_PR_RESULT_JSON=',
  'REVIEW_AND_FIX_PR_CODEX_RECEIPT_JSON=',
  'REVIEW_AND_FIX_PR2_CLAIM_AUDIT_JSON=',
  'CODE_REVIEW_AD_CLAIM_AUDIT_JSON=',
])

const INSTRUCTIONS = `You are given one code-review report. Extract every distinct finding it makes.

Rules:
- One row per distinct claim about the code. A finding repeated in a summary and again in a detail section is ONE row.
- Copy the tool's own claim; do not verify it, do not add findings of your own, do not drop findings you disagree with.
- "file" as the report gives it, or "" if none. "line" must be one nonnegative integer: use the first cited line of a range or list, or 0 if no line is cited. Never put a range or list in "line".
- "title": <=90 chars, the defect, not the fix.
- "severity": one of blocker, high, medium, low, nit - map the report's own wording onto that scale.
- "kind": one of bug, security, test-gap, style, docs, perf, design, question.
- "claim": preserve the report's triggering path, duration or repetition, and consequence in up to three concise sentences. For retries, keep the stored state that makes the next attempt repeat the same failure and whether it clears on failure. Do not reduce a persistent-failure or recovery scenario to the intended behavior of one event. Keep any condition that distinguishes the reported defect from the PR's stated fix.
- "selfRejected": true if the report explicitly says it checked this and it is NOT a problem, or that it is out of scope and was not investigated.
Return ONLY a JSON array, no prose, no code fences. An empty report is [].

REPORT:
`

function parseArgs(argv, root = ROOT) {
  if (argv.includes('--force')) throw new Error('--force is not supported; benchmark artifacts are append-only')
  const options = {
    runId: defaultRunId(root),
    only: null,
    onlyTool: null,
    maxBudgetUsd: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }
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
    if (arg === '--max-budget-usd') {
      options.maxBudgetUsd = Number(value(arg, i++))
      if (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd <= 0) {
        throw new Error('--max-budget-usd must be a positive finite number')
      }
      continue
    }
    if (arg === '--timeout') {
      const minutes = Number(value(arg, i++))
      options.timeoutMs = minutes * 60_000
      if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(options.timeoutMs)) {
        throw new Error('--timeout must be a positive finite number')
      }
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  if (options.runId === 'legacy') throw new Error('legacy cohort is read-only')
  return options
}

function extractorArgs(report, options = {}) {
  const args = [
    '-p', INSTRUCTIONS + report,
    '--output-format', 'json',
    '--model', EXTRACTOR_MODEL,
    '--effort', 'high',
    '--tools', '',
    '--permission-mode', 'bypassPermissions',
  ]
  if (options.maxBudgetUsd != null) args.push('--max-budget-usd', String(options.maxBudgetUsd))
  args.push('--disallowedTools', 'WebSearch', 'WebFetch', 'Bash', 'Edit', 'Write')
  return args
}

// Structured review closure records are benchmark evidence, not review findings. Keep them out of
// the model prompt even when a producer indents them or emits a receipt before the terminal marker.
function sanitizeExtractionReport(report) {
  if (typeof report !== 'string') return report
  return report.split('\n').filter((line) => {
    const content = line.trimStart()
    return !MACHINE_REPORT_PREFIXES.some((prefix) => content.startsWith(prefix))
  }).join('\n')
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

function normalizeLine(line) {
  if (typeof line !== 'string') return line
  const clean = line.trim()
  // Reports can cite several ranges for one claim. Preserve strict validation for other malformed
  // values, but use the first cited line when the extractor copies a numeric range/list verbatim.
  const match = /^:?(\d+)(?:\s*[-–—]\s*\d+)?(?:\s*[,;]\s*\d+(?:\s*[-–—]\s*\d+)?)*$/.exec(clean)
  return match ? Number(match[1]) : line
}

function normalizeFindings(findings) {
  return findings.map((finding) => (
    finding && typeof finding === 'object' && !Array.isArray(finding)
      ? {
          ...finding,
          title: normalizeTitle(finding.title),
          line: normalizeLine(finding.line),
        }
      : finding
  ))
}

function extractOne(file, cwd, executable = CLAUDE, dependencies = {}, options = {}) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  const report = sanitizeExtractionReport(record.result || '')
  if (!report.trim()) return { ok: true, record, findings: [], extractError: null, modelUsage: null, sourceReportEmpty: true }
  const runExtractor = dependencies.spawnSync || spawnSync
  const result = runExtractor(executable, extractorArgs(report, options), {
    maxBuffer: 1 << 28,
    encoding: 'utf8',
    cwd,
    timeout: options.timeoutMs == null ? DEFAULT_TIMEOUT_MS : options.timeoutMs,
    killSignal: 'SIGKILL',
  })
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

function structuredV3Findings(source, root, manifest, target, tool) {
  const file = codexReceiptPath(root, manifest.runId, target, tool, source.codexReceiptId)
  const receipt = validateReceipt(JSON.parse(fs.readFileSync(file, 'utf8')), {
    target: { repository: manifest.targetMetadata[target].fork,
      baseSha: manifest.targets[target].baseSha, headSha: manifest.targets[target].headSha },
    pluginFingerprint: manifest.pluginFingerprint,
    schemaSha256: manifest.codexJudge.schemaSha256,
  })
  if (receipt.contract !== REVIEW_AND_FIX_PR_CONTRACT_V3 ||
      hashReceipt(receipt) !== source.resultContract.codex.receiptSha256) {
    throw new Error('structured Codex receipt does not match sealed result')
  }
  return receipt.candidates.filter((candidate) =>
    ['confirmed', 'suggestion'].includes(candidate.finalDisposition)).map((candidate) => {
    const location = candidate.locations[0]
    const kind = { tests: 'test-gap', docs: 'docs', comments: 'docs', performance: 'perf',
      security: 'security', standards: 'style', maintainability: 'design' }[candidate.category] || 'bug'
    return {
      title: normalizeTitle(candidate.claim.split(/[.!?]/, 1)[0]),
      file: location.path.startsWith('@') ? '' : location.path,
      line: location.line || 0,
      severity: candidate.severity === 'critical' ? 'blocker' : candidate.severity,
      kind, claim: candidate.claim, selfRejected: false,
      reviewDisposition: candidate.finalDisposition,
      candidateId: candidate.id, claimHash: candidate.claimHash,
    }
  })
}

function assertRecordCohort(record, manifest) {
  return assertRecordMetadata(record, manifest, `${record.target || 'result'}/${record.tool || 'unknown'}`)
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
      const sourceReport = sanitizeExtractionReport(source.result || '')
      let executable = CLAUDE
      let authorization = null
      if (manifest.requestedModel === 'claude-fable-5-1' && sourceReport.trim()) {
        authorization = authorize(root, {
          runId: manifest.runId, stage: 'extract', target, tool,
          claudeVersion: manifest.claudeVersion,
        }, dependencies)
        executable = authorization.executable
      }
      const structured = source.resultContract && source.resultContract.schemaVersion === 3
      const extracted = structured
        ? { ok: true, record: source, findings: structuredV3Findings(source, root, manifest, target, tool),
            sourceReportEmpty: false, modelUsage: null }
        : runExtract(input, cwd, executable, dependencies, options)
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
        extractorRequestedModel: extracted.sourceReportEmpty || structured ? null : EXTRACTOR_MODEL,
        extractorModelUsage: extracted.modelUsage,
        extractionSkippedReason: extracted.sourceReportEmpty ? 'empty-source-report'
          : structured ? 'structured-codex-receipt' : null,
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
  DEFAULT_TIMEOUT_MS, EXTRACTOR_MODEL, TITLE_LIMIT, assertRecordCohort, extractOne, extractorArgs, main,
  normalizeFindings, normalizeLine, normalizeTitle, parseArgs, sanitizeExtractionReport, structuredV3Findings,
}

if (require.main === module) {
  try {
    if (main() > 0) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
