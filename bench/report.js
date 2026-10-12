'use strict'
// Render one bake-off cohort. Everything here is mechanical: the numbers come from that cohort's
// results (what each run spent), findings (what each run claimed) and judgement (what survived
// checking). The legacy cohort also has an Analysis section written by hand.
//
//   node bench/report.js --run <runId|legacy> [--write]
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { totalsForCwd } = require('./lib/usage')
const {
  assertRecordMetadata, assertSafeId, cohortPaths, loadModelConfig, readComplete,
} = require('./lib/artifacts')

const ROOT = __dirname
const args = process.argv.slice(2)
let requestedRun = null
let writeReport = false
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--write') { writeReport = true; continue }
  if (args[i] === '--run') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) {
      console.error('--run requires a value')
      process.exit(2)
    }
    requestedRun = args[++i]
    continue
  }
  console.error(`unknown argument: ${args[i]}`)
  process.exit(2)
}
if (requestedRun) {
  try { assertSafeId(requestedRun, 'run id') } catch (error) { console.error(error.message); process.exit(2) }
}
const config = loadModelConfig(ROOT)
// Keep no-argument stdout on legacy forever. Old shell redirections must not replace historical
// report after new default cohort appears. Make target passes configured default explicitly.
const selectedRun = requestedRun || 'legacy'
let cohort
try {
  if (selectedRun === 'legacy') {
    const paths = cohortPaths(ROOT, selectedRun)
    const exists = [paths.results, paths.findings, paths.judgement].some(file => fs.existsSync(file))
    if (!exists) throw new Error('cohort not found: legacy')
    cohort = { ...config.legacyCohort, legacy: true, claudeVersion: null, paths }
  } else {
    // A report is a final snapshot, not a view over whichever files happen to exist now. This call
    // validates the manifest, sealed result hashes, successful findings, judgements, and complete
    // marker hashes before any number is rendered.
    const finalized = readComplete(ROOT, selectedRun)
    const manifest = finalized.manifest
    cohort = {
      ...manifest,
      label: manifest.modelLabel,
      observedModel: null,
      legacy: false,
      paths: cohortPaths(ROOT, selectedRun),
      seal: finalized.seal,
      complete: finalized.complete,
    }
  }
} catch (error) {
  console.error(selectedRun === 'legacy' ? error.message : `cannot report cohort ${selectedRun}: ${error.message}`)
  process.exit(2)
}
if (writeReport && !cohort.legacy &&
    cohort.expectedCells.some((cell) => ['review-and-fix-pr2', 'code-review-ad'].includes(cell.tool))) {
  console.error(`cohort ${selectedRun} is dashboard-only; no standalone report is written`)
  process.exit(2)
}
// Legacy predates snapshots and deliberately keeps its live inputs. New cohorts must remain
// reproducible even after state.json or tools.json changes, so every display field comes from the
// manifest copies used to run the matrix.
const state = cohort.legacy
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8'))
  : { targets: cohort.targetMetadata }
const toolConfig = cohort.legacy
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.json'), 'utf8'))
  : cohort.toolConfig
const tools = toolConfig.tools
const SHORT = {
  'builtin-code-review': 'CR', 'ce-code-review': 'CE', 'tob-diff-review': 'TB-D',
  'tob-rust-review': 'TB-R', 'tob-c-review': 'TB-C', 'anthropic-pr-review': 'ANT',
  'superpowers-review': 'SP', 'mattpocock-review': 'MP',
}
const snapshotHashes = new Map()
if (!cohort.legacy) {
  const frozen = [...cohort.seal.cells, ...cohort.complete.findings, ...cohort.complete.judgements]
  if (cohort.complete.quota) frozen.push(cohort.complete.quota)
  if (cohort.complete.probe) frozen.push(cohort.complete.probe)
  for (const entry of frozen) {
    snapshotHashes.set(path.join(cohort.paths.root, ...entry.file.split('/')), entry.sha256)
  }
}
const readBytes = (file) => {
  const bytes = fs.readFileSync(file)
  if (!cohort.legacy && file.startsWith(cohort.paths.root + path.sep)) {
    const expected = snapshotHashes.get(file)
    if (!expected) throw new Error(`artifact is not in complete snapshot: ${file}`)
    const actual = crypto.createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) throw new Error(`artifact changed after complete snapshot validation: ${file}`)
  }
  return bytes
}
const read = (file) => JSON.parse(readBytes(file).toString('utf8'))
const exists = (p) => fs.existsSync(p)
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'))
const money = (n) => (n == null ? '-' : '$' + Number(n).toFixed(2))
const mins = (ms) => (ms == null ? '-' : (ms / 60000).toFixed(1))
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const sumKnown = (values) => values.some(value => value != null)
  ? values.reduce((sum, value) => sum + (value || 0), 0)
  : null
function storedUsage(record) {
  const transcript = record.transcriptUsage || {}
  const models = Object.entries(record.modelUsage || {})
  const modelSum = (key) => sumKnown(models.map(([, usage]) => finite(usage && usage[key])))
  const reported = record.reportedUsage || {}
  const fields = {
    input: [finite(transcript.input), modelSum('inputTokens'), finite(reported.input_tokens)],
    output: [finite(transcript.output), modelSum('outputTokens'), finite(reported.output_tokens)],
    thinking: [finite(transcript.thinking), modelSum('thinkingTokens'), finite(reported.output_tokens_details && reported.output_tokens_details.thinking_tokens)],
    cacheRead: [finite(transcript.cacheRead), modelSum('cacheReadInputTokens'), finite(reported.cache_read_input_tokens)],
    cacheCreation: [finite(transcript.cacheCreation), modelSum('cacheCreationInputTokens'), finite(reported.cache_creation_input_tokens)],
    costUsd: [finite(transcript.costUsd), modelSum('costUSD'), finite(record.reportedCostUsd)],
    sessions: [finite(transcript.sessions)],
  }
  const usage = Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, values.find(value => value != null) ?? null]))
  usage.total = finite(transcript.total)
  if (usage.total == null) usage.total = sumKnown([usage.input, usage.output, usage.cacheRead, usage.cacheCreation])
  usage.models = Object.keys(transcript.models || {}).length
    ? transcript.models
    : Object.fromEntries(models.map(([name, value]) => [name, finite(value && value.costUSD)]))
  return usage
}
function zeroUsage() {
  return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, sessions: 0, total: 0, models: {} }
}
function assertSelectedCohort(record, file) {
  if (cohort.legacy) return
  assertRecordMetadata(record, cohort, file)
  if (record.target && record.tool && record.cellId !== `${cohort.runId}/${record.target}/${record.tool}`) {
    throw new Error(`${file}: cellId does not match cohort, target, and tool`)
  }
}

const expectedTargetIds = cohort.legacy
  ? Object.keys(state.targets)
  : [...new Set(cohort.expectedCells.map(cell => cell.target))]
const targets = expectedTargetIds.map((id) => {
  if (!Object.hasOwn(state.targets, id)) throw new Error(`cohort target metadata is missing: ${id}`)
  return state.targets[id]
})
if (!cohort.legacy) {
  const configuredTools = new Set(tools.map(tool => tool.id))
  for (const cell of cohort.expectedCells) {
    if (!configuredTools.has(cell.tool)) throw new Error(`cohort tool snapshot is missing: ${cell.tool}`)
  }
}
const results = {}
for (const t of targets) {
  results[t.id] = {}
  const dir = path.join(cohort.paths.results, t.id)
  if (!exists(dir)) {
    if (cohort.legacy) continue
    throw new Error(`complete cohort result directory disappeared: ${dir}`)
  }
  // `.lock` files sit next to the results; only the results are results.
  const files = cohort.legacy
    ? fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    : cohort.seal.cells.filter(cell => cell.target === t.id).map(cell => `${cell.tool}.json`)
  for (const f of files) {
    const file = path.join(dir, f)
    const rec = read(file)
    assertSelectedCohort(rec, file)
    if (!cohort.legacy && (rec.target !== t.id || f !== `${rec.tool}.json`)) {
      throw new Error(`${file}: result identity does not match its path`)
    }
    if (cohort.legacy) {
      // Legacy usage is recomputed rather than trusted from the run record: its accounting was
      // fixed after the first runs were already on disk, and its transcripts outlive the record.
      // `usageCwd` is set when a run's tool was renamed after it ran.
      const cwd = rec.usageCwd || path.join(ROOT, 'work', t.id, 'runs', rec.tool, 'repo')
      const live = totalsForCwd(cwd)
      const hasLiveUsage = (live.sessions || 0) > 0 || (live.total || 0) > 0 || (live.costUsd || 0) > 0
      rec.cell = hasLiveUsage ? live : storedUsage(rec)
      // What the REPORT cost is the attempt that produced it, not everything ever run in that
      // directory. Dead attempts are still counted as `wasted`, because somebody paid for them.
      if (hasLiveUsage) {
        const start = rec.attemptSince || (rec.finishedAt && rec.wallMs ? Date.parse(rec.finishedAt) - rec.wallMs - 120000 : 0)
        rec.usage = start ? totalsForCwd(cwd, { since: start }) : rec.cell
        // A run that never produced a report bought nothing with any of it, last attempt included.
        if (rec.dnf) rec.usage = totalsForCwd(cwd, { since: Date.now() })
      } else {
        // A fresh checkout has no local Claude transcripts. Keep legacy spend visible from the
        // committed record; successful and discarded attempts cannot be split without timestamps.
        rec.usage = rec.dnf ? zeroUsage() : rec.cell
        rec.storedUsageFallback = true
      }
      rec.wastedUsd = Math.max(0, (rec.cell.costUsd || 0) - (rec.usage.costUsd || 0))
      rec.wastedTok = Math.max(0, (rec.cell.total || 0) - (rec.usage.total || 0))
    } else {
      // New cohorts are reproducible from committed artifacts. Never let mutable local transcript
      // state change their report after the runner records the final attempt's usage.
      rec.cell = rec.transcriptUsage || {}
      rec.usage = rec.transcriptUsage || {}
      rec.wastedUsd = 0
      rec.wastedTok = 0
    }
    results[t.id][rec.tool] = rec
  }
}
const findings = {}
let rawClaims = 0
let confirmedClaims = 0
let suggestionClaims = 0
let extractionCalls = 0
let extractionCost = 0
for (const t of targets) {
  findings[t.id] = {}
  const dir = path.join(cohort.paths.findings, t.id)
  if (!exists(dir)) {
    if (cohort.legacy) continue
    throw new Error(`complete cohort finding directory disappeared: ${dir}`)
  }
  const files = cohort.legacy
    ? fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    : cohort.seal.cells.filter(cell => cell.target === t.id).map(cell => `${cell.tool}.json`)
  for (const f of files) {
    const file = path.join(dir, f)
    const rec = read(file)
    assertSelectedCohort(rec, file)
    if (!cohort.legacy && (rec.target !== t.id || f !== `${rec.tool}.json`)) {
      throw new Error(`${file}: finding identity does not match its path`)
    }
    findings[t.id][rec.tool] = rec.findings || []
    rawClaims += (rec.findings || []).length
    confirmedClaims += (rec.findings || []).filter((finding) => finding.reviewDisposition === 'confirmed').length
    suggestionClaims += (rec.findings || []).filter((finding) => finding.reviewDisposition === 'suggestion').length
    if (rec.extractorRequestedModel) {
      extractionCalls += 1
      extractionCost += Object.values(rec.extractorModelUsage || {})
        .reduce((sum, usage) => sum + (finite(usage && usage.costUSD) || 0), 0)
    }
  }
}
const judged = {}
let judgeCalls = 0
let judgeCost = 0
let mergedIssues = 0
const verdicts = { real: 0, 'false-positive': 0, unproven: 0 }
for (const t of targets) {
  const p = path.join(cohort.paths.judgement, `${t.id}.json`)
  if (exists(p)) {
    const rec = read(p)
    assertSelectedCohort(rec, p)
    if (!cohort.legacy && rec.target !== t.id) throw new Error(`${p}: judgement identity does not match its path`)
    judged[t.id] = rec.issues || []
    judgeCalls += 1
    judgeCost += finite(rec.judgeCostUsd) || 0
    mergedIssues += (rec.issues || []).length
    for (const issue of rec.issues || []) if (Object.hasOwn(verdicts, issue.verdict)) verdicts[issue.verdict] += 1
  } else if (!cohort.legacy) {
    throw new Error(`complete cohort judgement disappeared: ${p}`)
  }
}

const groundtruth = {}
for (const t of targets) {
  if (cohort.legacy) {
    const p = path.join(ROOT, 'groundtruth', t.id + '.json')
    if (exists(p)) groundtruth[t.id] = read(p)
  } else if (cohort.groundtruth[t.id] !== null) {
    groundtruth[t.id] = cohort.groundtruth[t.id]
  }
}
// A review comment as one table cell: quoted replies stripped, newlines and pipes flattened.
function oneline(body) {
  const s = String(body || '').split('\n').filter(l => !l.startsWith('>')).join(' ')
  const t = s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
  return t.length > 220 ? t.slice(0, 217) + '...' : t
}

// What the token column is actually made of. Four classes priced an order of magnitude apart get
// summed into one number, so the number needs its composition printed next to it.
const tokenMix = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 }
for (const t of targets) for (const rec of Object.values(results[t.id] || {})) {
  for (const k of Object.keys(tokenMix)) tokenMix[k] += rec.usage[k] || 0
}
// Thinking is a subset of output, so it is left out of the denominator.
const mixTotal = tokenMix.input + tokenMix.output + tokenMix.cacheRead + tokenMix.cacheCreation
const pctOfTotal = (k) => (mixTotal ? (100 * tokenMix[k] / mixTotal).toFixed(1) : '0') + '%'
const reviewCalls = targets.reduce((count, target) => count + Object.keys(results[target.id] || {}).length, 0)
const reviewCost = targets.reduce((total, target) => total + Object.values(results[target.id] || {})
  .reduce((sum, record) => sum + (record.usage.costUsd || 0), 0), 0)
const reviewWall = targets.reduce((total, target) => total + Object.values(results[target.id] || {})
  .reduce((sum, record) => sum + (record.wallMs || 0), 0), 0)
let probeCost = 0
let finalQuota = null
if (!cohort.legacy && cohort.complete.probe) {
  probeCost = finite(read(path.join(cohort.paths.root, cohort.complete.probe.file)).reportedCostUsd) || 0
}
if (!cohort.legacy && cohort.complete.quota) {
  const lines = readBytes(path.join(cohort.paths.root, cohort.complete.quota.file)).toString('utf8').trim().split('\n')
  finalQuota = JSON.parse(lines.at(-1))
}

const used = tools.filter(tl => targets.some(t => results[t.id] && results[t.id][tl.id]))
const storedFallbacks = targets.reduce((count, target) => count + Object.values(results[target.id] || {}).filter(rec => rec.storedUsageFallback).length, 0)
const publishedGold = !cohort.legacy && fs.existsSync(path.join(ROOT, 'gold', 'index.json'))
  ? require('./reconcile').loadPublishedComparison(ROOT) : null
const canonicalIncluded = (publishedGold?.manifest.declaration.supplementalRunIds || []).includes(cohort.runId)
const out = []
const P = (s) => out.push(s)

P(`# Review-tool bake-off: ${used.length} review configuration${used.length === 1 ? '' : 's'}, ${targets.length} real PR${targets.length === 1 ? '' : 's'}\n`)
if (cohort.legacy) {
  P(`**Cohort:** \`legacy\` (${cohort.label}). **Observed model:** ${cohort.modelLabel} (\`${cohort.observedModel}\`), inferred from saved runtime metadata; the legacy runner did not record a requested model.\n`)
  if (storedFallbacks) {
    P(`**Accounting note:** local legacy transcripts were unavailable for ${storedFallbacks} run${storedFallbacks === 1 ? '' : 's'}, so those cells use committed aggregate usage. Their successful and discarded retry spend cannot be separated.\n`)
  }
} else {
  P(`**Cohort:** \`${cohort.runId}\`. **Requested model:** ${cohort.modelLabel} (\`${cohort.requestedModel}\`). Claude Code: \`${cohort.claudeVersion}\`.\n`)
  const experimental = used.filter(tool => tool.experimental)
  if (experimental.length) {
    const authored = experimental.some(tool => tool.selfAuthored) ? ' and self-authored' : ''
    P(canonicalIncluded
      ? `**Experimental cohort-local evidence:** ${experimental.map(tool => `\`${tool.id}\``).join(', ')} is experimental${authored}. Its confirmed claims are mapped in the sealed ${publishedGold.id} gold snapshot; suggestions are excluded from confirmed credit. The cohort-local judgements below remain separate.\n`
      : `**Experimental cohort-local evidence:** ${experimental.map(tool => `\`${tool.id}\``).join(', ')} is experimental${authored}. These results are not canonical gold.\n`)
  }
}
P('Every number below is produced by `bench/` in this repository and can be regenerated with')
P(`\`make bench-report RUN=${cohort.runId}\`.`)
if (!cohort.legacy) P(`This complete cohort contains ${cohort.seal.cells.length} hash-pinned review cells.`)
P('Every run used its own headless `claude -p` process and')
P('working directory so its token spend is attributable.\n')

P('## What was reviewed\n')
P('| Target | Language | Diff | Commits | PR under review | Upstream original |')
P('|---|---|---:|---:|---|---|')
for (const t of targets) {
  P(`| \`${t.id}\` | ${t.language} | ${fmt(t.localDiffBytes)} B | ${t.commits} commits | ${t.forkPrUrl} | ${t.upstreamPrUrl} |`)
}
P('')
P('Each PR was replayed in its own fork with its commits under a neutral author. The preparer rewrote')
P('repository references in review material and denied `WebSearch`/`WebFetch`. The benchmark freezes')
P('the review inputs because access to upstream comments would bias discovery.\n')

if (!cohort.legacy) {
  const knownSpend = probeCost + reviewCost + extractionCost + judgeCost
  P('## Cohort accounting\n')
  if (cohort.complete.probe) P(`- Exact-model probe: ${money(probeCost)}.`)
  P(`- Reviews: ${reviewCalls} calls, ${fmt(mixTotal)} tokens, ${money(reviewCost)}, ${mins(reviewWall)} minutes wall time.`)
  P(`- Extraction: ${extractionCalls} calls, ${fmt(rawClaims)} raw claims${suggestionClaims ? ` (${fmt(confirmedClaims)} confirmed, ${fmt(suggestionClaims)} suggestions)` : ''}, ${money(extractionCost)}.`)
  P(`- Judging: ${judgeCalls} calls, ${fmt(mergedIssues)} merged issues${suggestionClaims ? ` from ${fmt(confirmedClaims)} confirmed claims` : ''} (${fmt(verdicts.real)} real, ${fmt(verdicts['false-positive'])} false-positive, ${fmt(verdicts.unproven)} unproven), ${money(judgeCost)}.`)
  P(`- Total known cohort spend: ${money(knownSpend)}. Discarded attempts are not included in immutable stage artifacts.`)
  if (finalQuota) {
    P(`- Final quota: current session ${finalQuota.usage['Current session']}%, all-model week ${finalQuota.usage['Current week (all models)']}%, Fable week ${finalQuota.usage['Current week (Fable)']}% (recorded ceilings: ${finalQuota.thresholds['Current session']}% / ${finalQuota.thresholds['Current week (all models)']}% / ${finalQuota.thresholds['Current week (Fable)']}%).`)
  }
  P('')
}

if (publishedGold) {
  const supplementalRunIds = publishedGold.manifest.declaration.supplementalRunIds || []
  if (supplementalRunIds.includes(cohort.runId)) {
    const { deriveModelMetrics } = require('./dashboard')
    const matched = deriveModelMetrics(publishedGold, { scopeId: 'all-models' })
    const supplemental = deriveModelMetrics(publishedGold, { scopeId: `supplemental-${cohort.runId}` })
    const evidenceById = new Map(publishedGold.sourceEvidence.map((entry) => [entry.cellId, entry]))
    const rows = [
      ...matched.models.map((model) => ({ ...model, evidenceLabel: `${matched.matchedCells.length} matched tool cells` })),
      ...supplemental.models.map((model) => ({ ...model,
        evidenceLabel: `${supplemental.matchedCells.length} review-and-fix-pr cells`, skill: true })),
    ]
    P('## Separate skill evidence on canonical gold\n')
    P(`The review-and-fix-pr skill was tested with Claude Opus 5.5 on the same ${targets.length} pinned PRs and ${fmt(matched.denominator)} reviewed real gold issues. It is a separate skill, not a separate model or a row in the model ranking. The matched model rows below use ${matched.matchedCells.length} tool cells each; this skill uses ${supplemental.matchedCells.length}. Tool sets differ, and suggestions are excluded from confirmed gold credit.\n`)
    P('| Candidate | Evidence | Gold issues found | Claude tokens | Claude review cost | Summed review time |')
    P('|---|---|---:|---:|---:|---:|')
    for (const row of rows) {
      const evidence = row.runIds.map((id) => evidenceById.get(id))
      const tokens = sumKnown(evidence.map((entry) => {
        if (!entry) return null
        const result = JSON.parse(fs.readFileSync(path.join(ROOT, entry.result.file), 'utf8'))
        return finite(result.transcriptUsage && result.transcriptUsage.total)
      }))
      const wall = sumKnown(evidence.map((entry) => finite(entry && entry.wallMs)))
      const label = row.skill ? 'review-and-fix-pr skill (Claude Opus 5.5)' : row.label
      P(`| ${label} | ${row.evidenceLabel} | ${row.canonicalReal} / ${matched.denominator} | ${fmt(tokens)} | ${money(row.recordedTotalCostUsd)} | ${mins(wall)} min |`)
    }
    const codexTokens = targets.reduce((sum, target) => sum + Object.values(results[target.id] || {})
      .reduce((part, record) => part + (finite(record.codexUsage && record.codexUsage.totalTokens) || 0), 0), 0)
    P('')
    P(`This cohort additionally used ${fmt(codexTokens)} Codex tokens for adjudication; its receipts do not provide a USD cost. The ${publishedGold.manifest.counts.suggestionClaims} suggestions remain visible in the structured review receipts and are not counted above.`)
    P(`Canonical gold credits ${supplemental.models[0].canonicalReal} real issues from this cohort; the cohort-local judge reports ${verdicts.real}. These are separate adjudications over the same pinned PRs.`)
    P(`The skill appears in the [Skills comparison](./index.html#choose?tab=skills&skills=review-and-fix-pr); the [matched-model ranking](./index.html#choose?tab=models) remains separate.\n`)
  }
}

P('## Findings, by issue\n')
P('One row per distinct issue claim, including false positives, merged across tools by a judge that had')
P('the code in front of it. `✓` = that tool reported it.\n')
const cols = used.map(tl => SHORT[tl.id] || tl.id)
P(`| # | Issue | Verdict | Scope | New? | Sev | ${cols.join(' | ')} |`)
P(`|---|---|---|---|---|---|${cols.map(() => '---').join('|')}|`)
let n = 0
for (const t of targets) {
  const issues = judged[t.id]
  if (!issues) continue
  P(`| | **${t.id} (${t.language})** | | | | | ${cols.map(() => '').join(' | ')} |`)
  for (const i of issues) {
    n += 1
    const by = new Set(i.reportedBy || [])
    const marks = used.map(tl => (by.has(tl.id) ? '✓' : ''))
    const where = i.file ? `\`${i.file}${i.line ? ':' + i.line : ''}\`` : ''
    P(`| ${n} | ${i.title} ${where} | ${i.verdict} | ${i.scope} | ${i.introducedByPr ? 'yes' : 'no'} | ${i.severity} | ${marks.join(' | ')} |`)
  }
}
P('')

P('## Per tool\n')
if (cohort.legacy) {
  if (storedFallbacks) {
    P('*Tokens* and *Cost* use the committed cell aggregate where local transcripts are unavailable;')
    P('that aggregate can include retries. Cells with local transcripts retain the original attempt-window accounting.')
  } else {
    P('*Tokens* and *Cost* are the attempt that produced the report being scored.')
  }
  P('*Lost to limits* is what the same cell spent on earlier attempts that the account\'s usage limit')
  P('cut off mid-review: they produced nothing and were retried from scratch. Both columns are real')
  P(storedFallbacks
    ? 'money; a `-` is unknown when only committed aggregate usage remains.\n'
    : 'money; only the first is the price of a review.\n')
} else {
  P('*Tokens* and *Cost* are the attempt that produced the report being scored.')
  P('New cohorts commit the final attempt\'s transcript usage only. Earlier retry spend is unavailable')
  P('and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.\n')
}
P('**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are')
P(`priced an order of magnitude apart, and ${pctOfTotal('cacheRead')} of it is cache reads, which bill at a tenth of`)
P(`input; cache creation, another ${pctOfTotal('cacheCreation')}, bills at 1.25x. Output - the tokens a reviewer`)
P(`actually wrote - is ${pctOfTotal('output')} of the total. A tool that re-reads a large tree under a warm cache`)
P('therefore looks enormous and costs little. The cost column is not computed from these counts: it is')
P('the per-session figure Claude Code itself bills, already priced per class. Thinking tokens')
P(`(${fmt(tokenMix.thinking)} across the matrix) are counted in the cost and reported by the model as part of`)
P('its output, so they are deliberately not added on top of it here.\n')
const multiTool = used.length > 1
P(`| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | ${multiTool ? 'Only this tool | ' : ''}Tokens | Cost | Wall | Lost to limits |`)
P(`|---|---:|---:|---:|---:|---:|---:|---:|${multiTool ? '---:|' : ''}---:|---:|---:|---:|`)
for (const tl of used) {
  let raised = 0, real = 0, fp = 0, unproven = 0, inScope = 0, pre = 0, uniq = 0, tok = 0, cost = 0, wall = 0, runs = 0, wasted = 0
  for (const t of targets) {
    const rec = results[t.id] && results[t.id][tl.id]
    if (rec) { runs += 1; tok += rec.usage.total || 0; cost += rec.usage.costUsd || 0; wall += rec.wallMs || 0; wasted += rec.wastedUsd || 0 }
    for (const i of judged[t.id] || []) {
      if (!(i.reportedBy || []).includes(tl.id)) continue
      raised += 1
      if (i.verdict === 'real') real += 1
      else if (i.verdict === 'false-positive') fp += 1
      else unproven += 1
      if (i.verdict === 'real' && i.scope === 'in-scope') inScope += 1
      if (i.verdict === 'real' && !i.introducedByPr) pre += 1
      if ((i.reportedBy || []).length === 1 && i.verdict === 'real') uniq += 1
    }
  }
  P(`| ${tl.label} | ${runs} | ${raised} | ${real} | ${fp} | ${unproven} | ${inScope} | ${pre} | ${multiTool ? `${uniq} | ` : ''}${fmt(tok)} | ${money(cost)} | ${mins(wall)} min | ${wasted > 0.005 ? money(wasted) : '-'} |`)
}
P('')

P('### Spend per run\n')
P(`| Tool | ${targets.map(t => t.id).join(' | ')} |`)
P(`|---|${targets.map(() => '---:').join('|')}|`)
for (const tl of used) {
  const cells = targets.map(t => {
    const rec = results[t.id] && results[t.id][tl.id]
    if (!rec) return '-'
    return `${fmt(rec.usage.total)} tok / ${money(rec.usage.costUsd)} / ${mins(rec.wallMs)} min`
  })
  P(`| ${tl.label} | ${cells.join(' | ')} |`)
}
P('')
const sumOver = (f) => targets.reduce((a, t) => a + Object.values(results[t.id] || {}).reduce((b, r) => b + (f(r) || 0), 0), 0)
const totalCost = sumOver(r => r.usage.costUsd)
const totalTok = sumOver(r => r.usage.total)
const wastedCost = sumOver(r => r.wastedUsd)
const wastedTok = sumOver(r => r.wastedTok)
const runCount = sumOver(() => 1)
if (cohort.legacy) {
  const subject = storedFallbacks
    ? `${runCount} completed review cells, including inseparable retry spend in stored-only records, account for`
    : `${runCount} scored reviews cost`
  P(`**The ${subject} ${fmt(totalTok)} tokens, ${money(totalCost)}.** A further`)
  P(`**${fmt(wastedTok)} tokens, ${money(wastedCost)}** were identifiable as attempts the usage limit killed before they`)
  P(`reported, for a bill of ${money(totalCost + wastedCost)} across the matrix. Judging and extraction are`)
  P('counted separately.\n')
} else {
  P(`**The ${runCount} scored reviews' recorded attempts cost ${fmt(totalTok)} tokens, ${money(totalCost)}.**`)
  P('Retry attempts, judging, and extraction are not included.\n')
}

P('### Raw claims before judging\n')
if (suggestionClaims) {
  P(`Extracted claims include ${fmt(suggestionClaims)} suggestions. They remain visible for reviewer judgment but do not enter cohort judging. The ${fmt(confirmedClaims)} confirmed claims were merged and verified into ${fmt(mergedIssues)} issues.\n`)
} else {
  P('What each run said before verification. Self-rejected claims are excluded, and the judge may merge several claims about one mechanism. The gap from *Raised* is not a miss count.\n')
}
P(`| Tool | ${targets.map(t => t.id).join(' | ')} |`)
P(`|---|${targets.map(() => '---:').join('|')}|`)
for (const tl of used) {
  P(`| ${tl.label} | ${targets.map(t => {
    const claims = (findings[t.id] || {})[tl.id] || []
    if (!claims.length) return results[t.id] && results[t.id][tl.id] ? '0' : '-'
    const suggestions = claims.filter((claim) => claim.reviewDisposition === 'suggestion').length
    return suggestions ? `${claims.length} (${claims.length - suggestions} confirmed, ${suggestions} suggestions)` : String(claims.length)
  }).join(' | ')} |`)
}
P('')

P('## What the maintainers actually said\n')
P('The upstream reviews, fetched at prepare time and never shown to any reviewer or to the judge.')
P('Bot comments are dropped, and so are the PR author\'s own replies, which are answers rather than')
P('findings.\n')
P('Read these as context, not as a scoreboard. The PRs were reviewed at their pinned revisions,')
P('after some upstream comments may already have been addressed. Not repeating a comment is not')
P('automatically a miss; the useful question is whether a concern still applies to the pinned code.\n')
for (const t of targets) {
  const g = groundtruth[t.id]
  if (!g) continue
  const author = String(g.author || '').toLowerCase()
  const human = (c) => !/(?:\[bot\]$|^copilot$)/i.test(c.user || '') && String(c.user || '').toLowerCase() !== author
  const inline = ((g.review || {}).inline || []).filter(human)
  const issue = ((g.review || {}).issue || []).filter(human)
  P(`**\`${t.id}\`** - ${g.url} - ${inline.length} inline review comments, ${issue.length} thread comments.\n`)
  if (!inline.length && !issue.length) { P('No human review comments upstream.\n'); continue }
  P('| Who | Where | What they said |')
  P('|---|---|---|')
  for (const c of inline) P(`| ${c.user} | \`${c.path}${c.line ? ':' + c.line : ''}\` | ${oneline(c.body)} |`)
  for (const c of issue) P(`| ${c.user} | thread | ${oneline(c.body)} |`)
  P('')
}

P('### Runs that did not complete\n')
const bad = []
for (const t of targets) for (const [id, rec] of Object.entries(results[t.id] || {})) {
  if (rec.exitCode === 0 && !rec.isError && typeof rec.result === 'string') continue
  const how = `exit ${rec.exitCode}${rec.signal ? ' ' + rec.signal : ''}${rec.apiErrorStatus ? ' api ' + rec.apiErrorStatus : ''}`
  const spent = `${fmt(rec.cell.total)} tokens and ${money(rec.cell.costUsd)} spent across ${rec.cell.sessions} sessions`
  bad.push(`- \`${t.id}/${id}\` - ${how}, ${spent}.${rec.dnfReason ? ' ' + rec.dnfReason : ''}`)
}
P(bad.length ? bad.join('\n') : 'None - every run in the matrix returned a report.')
P('')
// Hand-written analysis describes the original matrix. Never attach its fixed counts and model
// conclusions to a different cohort.
const analysisPath = path.join(ROOT, 'analysis.md')
if (cohort.legacy && exists(analysisPath)) P(fs.readFileSync(analysisPath, 'utf8').trim() + '\n')
if (!cohort.legacy) {
  P('## Analysis\n')
  P('No hand-written analysis is attached to this cohort. `bench/analysis.md` describes only the immutable `legacy` results.\n')
}
const rendered = out.join('\n').trimEnd() + '\n'
if (writeReport) {
  const name = cohort.legacy ? 'review-bakeoff.md' : `review-bakeoff-${cohort.runId}.md`
  const file = path.join(ROOT, '..', 'docs', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${name}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`)
  try {
    fs.writeFileSync(temporary, rendered, { flag: 'wx' })
    fs.renameSync(temporary, file)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  }
  console.log(path.relative(path.join(ROOT, '..'), file))
} else {
  process.stdout.write(rendered)
}
