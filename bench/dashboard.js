#!/usr/bin/env node
'use strict'

// Build the offline run explorer from committed benchmark artifacts. Deliberately do not import
// lib/usage: that module reads local Claude transcripts, while this export must be reproducible
// from the repository alone.
const fs = require('node:fs')
const path = require('node:path')
const { cellId, discoverCohorts, loadModelConfig, manifestMetadata, readComplete } = require('./lib/artifacts')

const ROOT = __dirname
const ASSET_DIR = path.join(ROOT, 'dashboard')
const USAGE_FIELDS = ['input', 'output', 'thinking', 'cacheRead', 'cacheCreation', 'costUsd', 'sessions']
const DEFAULT_TOKEN_LIMIT = 25000000
const LEGACY_RERUN_ISSUE_URL = 'https://github.com/dkropachev/automated-development/issues/42'

const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null
const sum = (values) => values.some((value) => value != null)
  ? values.reduce((total, value) => total + (value || 0), 0)
  : null

function modelUsage(record) {
  const rows = Object.entries(record.modelUsage || {})
  const value = (key) => sum(rows.map(([, usage]) => finite(usage && usage[key])))
  return {
    input: value('inputTokens'),
    output: value('outputTokens'),
    thinking: value('thinkingTokens'),
    cacheRead: value('cacheReadInputTokens'),
    cacheCreation: value('cacheCreationInputTokens'),
    costUsd: value('costUSD'),
    sessions: null,
    models: Object.fromEntries(rows.map(([name, usage]) => [name, finite(usage && usage.costUSD)])),
  }
}

function reportedUsage(record) {
  const usage = record.reportedUsage || {}
  return {
    input: finite(usage.input_tokens),
    output: finite(usage.output_tokens),
    thinking: finite(usage.output_tokens_details && usage.output_tokens_details.thinking_tokens),
    cacheRead: finite(usage.cache_read_input_tokens),
    cacheCreation: finite(usage.cache_creation_input_tokens),
    costUsd: finite(record.reportedCostUsd),
    sessions: null,
  }
}

function normalizeUsage(record) {
  const transcript = record.transcriptUsage || {}
  const model = modelUsage(record)
  const reported = reportedUsage(record)
  const sources = {}
  const normalized = {}
  for (const field of USAGE_FIELDS) {
    const candidates = [
      ['transcript', finite(transcript[field])],
      ['model', finite(model[field])],
      ['reported', finite(reported[field])],
    ]
    const found = candidates.find(([, value]) => value != null)
    normalized[field] = found ? found[1] : null
    sources[field] = found ? found[0] : null
  }
  normalized.total = finite(transcript.total)
  if (normalized.total == null) {
    const parts = ['input', 'output', 'cacheRead', 'cacheCreation'].map((field) => normalized[field])
    normalized.total = parts.every((value) => value == null) ? null : sum(parts)
    sources.total = normalized.total == null ? null : 'derived'
  } else sources.total = 'transcript'

  normalized.models = Object.keys(transcript.models || {}).length
    ? Object.fromEntries(Object.entries(transcript.models).map(([name, cost]) => [name, finite(cost)]))
    : model.models
  normalized.rawMessages = finite(transcript.rawMessages)
  normalized.subagentTranscripts = finite(transcript.subagentTranscripts)
  normalized.sources = sources
  const used = new Set(Object.values(sources).filter(Boolean).filter((source) => source !== 'derived'))
  normalized.source = used.size === 0 ? 'unavailable' : used.size === 1 ? [...used][0] : 'mixed'
  return normalized
}

function deriveStatus(record) {
  if (record.dnf) return 'dnf'
  if (record.exitCode === 0 && !record.isError && typeof record.result === 'string') return 'complete'
  return 'failed'
}

function isRecommendedRun(run, tokenLimit = DEFAULT_TOKEN_LIMIT) {
  return run.status === 'complete' &&
    run.metrics.real > 0 &&
    run.usage.total != null &&
    run.usage.total <= tokenLimit
}

function ratio(numerator, denominator) {
  return denominator > 0 && numerator != null ? numerator / denominator : null
}

function median(values) {
  const sorted = values.filter((value) => finite(value) != null).sort((left, right) => left - right)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function issueIdsForMapping(mapping) {
  const ids = Array.isArray(mapping.issueIds) ? [...mapping.issueIds] : []
  if (mapping.canonicalIssueId != null) ids.push(mapping.canonicalIssueId)
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length))]
}

function logicalCell(cell) {
  const targetId = cell && (cell.targetId || cell.target)
  const toolId = cell && (cell.toolId || cell.tool)
  return targetId && toolId ? `${targetId}/${toolId}` : null
}

function deriveModelMetrics(comparison, options = {}) {
  if (!comparison) return { scope: null, denominator: 0, matchedCells: [], models: [] }
  const scopes = comparison.scopes || []
  const scope = scopes.find((candidate) => candidate.id === options.scopeId) ||
    (!options.scopeId && scopes[0])
  if (!scope) throw new Error(`Unknown model comparison scope: ${options.scopeId}`)

  const modelIds = options.modelIds || scope.modelIds || []
  const targetFilter = options.targetIds ? new Set(options.targetIds) : null
  const toolFilter = options.toolIds ? new Set(options.toolIds) : null
  const cellFilter = options.cellIds ? new Set(options.cellIds) : null
  const scopeCells = (scope.matchedCells || []).map((cell) => ({
    ...cell,
    id: cell.id || logicalCell(cell),
    targetId: cell.targetId || cell.target,
    toolId: cell.toolId || cell.tool,
  }))
  const denominatorTargets = new Set(scopeCells
    .filter((cell) => !targetFilter || targetFilter.has(cell.targetId))
    .map((cell) => cell.targetId))
  const matchedCells = scopeCells.filter((cell) =>
    (!targetFilter || targetFilter.has(cell.targetId)) &&
    (!toolFilter || toolFilter.has(cell.toolId)) &&
    (!cellFilter || cellFilter.has(cell.id)))
  const matchedKeys = new Set(matchedCells.map(logicalCell))
  const matchedSourceCellIds = new Set(matchedCells.flatMap((cell) => cell.sourceCellIds || []))
  const matchedRunIds = new Set(scope.runIds || [])

  const canonicalById = new Map((comparison.canonicalIssues || []).map((issue) => [issue.id, issue]))
  const denominator = new Set((comparison.canonicalIssues || [])
    .filter((issue) => issue.verdict === 'real' && denominatorTargets.has(issue.targetId || issue.target))
    .map((issue) => issue.id)).size
  const mappingsByCell = new Map()
  for (const mapping of comparison.sourceMappings || comparison.mappings || []) {
    if (!mappingsByCell.has(mapping.cellId)) mappingsByCell.set(mapping.cellId, [])
    mappingsByCell.get(mapping.cellId).push(mapping)
  }

  const allEvidence = comparison.sourceEvidence || []
  const models = modelIds.map((modelId) => {
    const evidence = allEvidence.filter((entry) => {
      const cohortId = entry.cohortId || String(entry.cellId || '').split('/')[0]
      const cellMatches = matchedSourceCellIds.size
        ? matchedSourceCellIds.has(entry.cellId)
        : matchedKeys.has(logicalCell(entry))
      return entry.modelId === modelId && cellMatches && (!matchedRunIds.size || matchedRunIds.has(cohortId))
    })
    const creditedIds = new Set()
    for (const entry of evidence) {
      if (entry.status !== 'complete' || entry.salvaged || entry.creditEligible === false) continue
      for (const mapping of mappingsByCell.get(entry.cellId) || []) {
        if (mapping.creditEligible === false) continue
        for (const issueId of issueIdsForMapping(mapping)) {
          if (canonicalById.has(issueId)) creditedIds.add(issueId)
        }
      }
    }
    const credited = [...creditedIds].map((id) => canonicalById.get(id))
    const real = credited.filter((issue) => issue.verdict === 'real')
    const falsePositive = credited.filter((issue) => issue.verdict === 'false-positive')
    const unproven = credited.filter((issue) => issue.verdict === 'unproven')
    const recordedCosts = evidence.map((entry) => finite(entry.costUsd)).filter((value) => value != null)
    const recordedWallTimes = evidence.map((entry) => finite(entry.wallMs)).filter((value) => value != null)
    const totalCost = recordedCosts.length ? recordedCosts.reduce((total, cost) => total + cost, 0) : null
    const model = (comparison.cohorts || []).find((cohort) => cohort.modelId === modelId) || {}
    return {
      modelId,
      label: model.label || model.modelLabel || modelId,
      provenance: model.provenance || null,
      recordedTotalCostUsd: totalCost,
      medianRecordedCostUsd: median(recordedCosts),
      medianWallMs: median(recordedWallTimes),
      canonicalReal: real.length,
      canonicalHighMedium: real.filter((issue) => ['blocker', 'high', 'medium'].includes(issue.severity)).length,
      canonicalFalsePositive: falsePositive.length,
      canonicalUnproven: unproven.length,
      precision: ratio(real.length, real.length + falsePositive.length),
      completeness: ratio(real.length, denominator),
      realPerDollar: ratio(real.length, totalCost),
      costPerReal: ratio(totalCost, real.length),
      successRate: ratio(evidence.filter((entry) => entry.status === 'complete').length, evidence.length),
      evidenceCount: evidence.length,
      expectedEvidenceCount: matchedCells.length,
      completeEvidenceCount: evidence.filter((entry) => entry.status === 'complete').length,
      issueIds: [...creditedIds].sort(),
      runIds: evidence.map((entry) => entry.cellId || entry.runId).filter(Boolean),
    }
  })
  return { scope, denominator, matchedCells, models }
}

function metricsFor(issues, claims, usage, wallMs) {
  const real = issues.filter((issue) => issue.verdict === 'real')
  const falsePositive = issues.filter((issue) => issue.verdict === 'false-positive').length
  const unproven = issues.filter((issue) => issue.verdict === 'unproven').length
  const severityAtLeast = (allowed) => real.filter((issue) => allowed.includes(issue.severity)).length
  return {
    claims: claims.length,
    judged: issues.length,
    real: real.length,
    falsePositive,
    unproven,
    inScope: real.filter((issue) => issue.scope === 'in-scope').length,
    prIntroduced: real.filter((issue) => issue.introducedByPr).length,
    uniqueReal: real.filter((issue) => (issue.reporterIds || issue.reportedByRuns || issue.reportedBy || []).length === 1).length,
    severityHigh: severityAtLeast(['blocker', 'high']),
    severityMediumPlus: severityAtLeast(['blocker', 'high', 'medium']),
    severityLowPlus: severityAtLeast(['blocker', 'high', 'medium', 'low']),
    precision: ratio(real.length, real.length + falsePositive),
    falsePositiveRate: ratio(falsePositive, real.length + falsePositive),
    realPerDollar: ratio(real.length, usage.costUsd),
    minutesPerReal: ratio(finite(wallMs) == null ? null : wallMs / 60000, real.length),
    costPerReal: ratio(usage.costUsd, real.length),
  }
}

function comparisonFor(left, right) {
  if (!left || !right) return { compatible: false, reason: 'Two runs are required.', shared: [], leftOnly: [], rightOnly: [] }
  if (left.cohortId && right.cohortId && left.cohortId !== right.cohortId) {
    return {
      compatible: false,
      reason: 'Issue overlap is unavailable because these runs use different judgement snapshots.',
      shared: [], leftOnly: [], rightOnly: [],
    }
  }
  if (left.targetId !== right.targetId) {
    return {
      compatible: false,
      reason: 'Issue overlap is unavailable because these runs reviewed different targets.',
      shared: [], leftOnly: [], rightOnly: [],
    }
  }
  const leftById = new Map(left.issues.map((issue) => [issue.id, issue]))
  const rightById = new Map(right.issues.map((issue) => [issue.id, issue]))
  return {
    compatible: true,
    reason: null,
    shared: [...leftById.keys()].filter((id) => rightById.has(id)).map((id) => leftById.get(id)),
    leftOnly: [...leftById.keys()].filter((id) => !rightById.has(id)).map((id) => leftById.get(id)),
    rightOnly: [...rightById.keys()].filter((id) => !leftById.has(id)).map((id) => rightById.get(id)),
  }
}

function expandPrompt(tool, target, context) {
  if (!tool) return null
  const values = {
    pr: target.forkPr, fork: target.fork, language: target.language,
    head: target.forkHead, prUrl: target.forkPrUrl,
  }
  const fill = (text) => String(text || '').replace(/\{(pr|fork|language|head|prUrl)\}/g, (_, key) => values[key] == null ? `{${key}}` : values[key])
  return fill(tool.prompt).replace(/\{context\}/g, fill(context))
}

function cleanMetadata(record) {
  const copy = JSON.parse(JSON.stringify(record))
  // The three large text fields have dedicated panels. Everything else stays verbatim so the raw
  // panel can answer questions that the normalized summary does not, including accounting detail.
  for (const key of ['result', 'prompt', 'stderrTail']) delete copy[key]
  return copy
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function jsonFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()
}

function cohortDirectories(cohort, root) {
  const base = cohort.legacy ? root : path.join(root, 'runs', cohort.runId)
  const paths = cohort.paths || {}
  return {
    results: paths.results || paths.result || cohort.resultsDir || path.join(base, 'results'),
    findings: paths.findings || cohort.findingsDir || path.join(base, 'findings'),
    judgement: paths.judgement || paths.judgments || cohort.judgementDir || path.join(base, 'judgement'),
  }
}

function assertCohortMetadata(record, cohort, kind, file) {
  if (!record || record.schemaVersion !== 2) throw new Error(`${kind} has invalid schemaVersion: ${file}`)
  for (const [key, expected] of Object.entries(manifestMetadata(cohort))) {
    if (record[key] !== expected) {
      throw new Error(`${kind} ${key} does not match cohort ${cohort.runId}: ${file}`)
    }
  }
}

function assertCellIdentity(record, cohort, targetId, fileName, kind, file) {
  assertCohortMetadata(record, cohort, kind, file)
  if (record.target !== targetId) throw new Error(`${kind} target does not match directory ${targetId}: ${file}`)
  if (typeof record.tool !== 'string' || `${record.tool}.json` !== fileName) {
    throw new Error(`${kind} filename does not match tool: ${file}`)
  }
  const expected = cellId(cohort.runId, targetId, record.tool)
  if (record.cellId !== expected) throw new Error(`${kind} cellId does not match cohort: ${file}`)
}

function assertJudgementIdentity(record, cohort, targetId, file) {
  assertCohortMetadata(record, cohort, 'judgement', file)
  if (record.target !== targetId) throw new Error(`judgement target does not match filename ${targetId}: ${file}`)
}

function targetView(target, groundtruth = null) {
  return {
    id: target.id,
    language: target.language,
    title: target.upstreamTitle,
    fork: target.fork,
    pr: target.forkPr,
    prUrl: target.forkPrUrl,
    upstreamUrl: target.upstreamPrUrl,
    diffBytes: finite(target.localDiffBytes),
    commits: finite(target.commits),
    preparedAt: target.preparedAt || null,
    groundtruth,
  }
}

function toolView(tool) {
  const {
    id, label, source, languages, parked, parkedReason, catalogId, catalogLabel,
    description, install, invoke, repoUrl, pageUrl,
  } = tool
  return {
    id, label, source, languages: languages || null, parked: Boolean(parked), parkedReason: parkedReason || null,
    catalogId: catalogId || id, catalogLabel: catalogLabel || label, description: description || null,
    install: install || null, invoke: invoke || null, repoUrl: repoUrl || null, pageUrl: pageUrl || null,
  }
}

function modelLookup(config) {
  return new Map((config.models || []).map((model) => [model.id, model]))
}

function modelIdentity(cohort, record, configById, usage) {
  const requestedModel = cohort.legacy ? null : cohort.requestedModel || record.requestedModel || null
  const observedNames = Object.keys(usage.models || {})
  const observedModel = cohort.observedModel || (cohort.legacy && observedNames.length === 1 ? observedNames[0] : null)
  const id = requestedModel || observedModel
  const configured = configById.get(id)
  const label = cohort.modelLabel || record.modelLabel || (configured && configured.label) || id || 'Model unavailable'
  return {
    requestedModel,
    requestedModelLabel: requestedModel ? label : null,
    id,
    label,
    provenance: requestedModel ? 'requested' : observedModel ? (cohort.observedModel ? 'observed' : 'inferred') : 'unavailable',
  }
}

function normalizeComparisonScope(scope, cohortsById = new Map()) {
  const matchedCells = (scope.matchedCells || scope.coordinates || scope.cells || []).map((cell) => ({
    ...cell,
    id: cell.id || logicalCell(cell),
    targetId: cell.targetId || cell.target,
    toolId: cell.toolId || cell.tool,
    sourceCellIds: cell.sourceCellIds || cell.cellIds || [],
  }))
  const labels = {
    'all-models': 'All models',
    'controlled-pair': 'Current controlled pair',
  }
  return {
    ...scope,
    id: scope.id === 'current-pair' ? 'controlled-pair' : scope.id,
    label: scope.label || labels[scope.id] || scope.id,
    modelIds: [...(scope.modelIds || (scope.runIds || []).map((runId) => cohortsById.get(runId) && cohortsById.get(runId).modelId).filter(Boolean))],
    matchedCells,
    count: matchedCells.length,
  }
}

function normalizeComparisonCohort(cohort) {
  const id = cohort.id || cohort.runId
  const modelId = cohort.modelId || cohort.requestedModel || cohort.observedModel
  return {
    ...cohort,
    id,
    runId: cohort.runId || id,
    modelId,
    label: cohort.label || cohort.modelLabel || modelId,
    provenance: cohort.provenance || (cohort.controlled === false ? 'historical/inferred' : 'controlled'),
  }
}

function normalizeComparisonEvidence(entry, cohortsById, runsById) {
  const cellId = entry.cellId || entry.id || null
  const suppliedRunId = entry.runId || null
  const cohortId = entry.cohortId || (cohortsById.has(suppliedRunId) ? suppliedRunId : String(cellId || '').split('/')[0]) || null
  const cohort = cohortsById.get(cohortId) || {}
  const run = runsById.get(cellId)
  const targetId = entry.targetId || entry.target || (run && run.targetId)
  const toolId = entry.toolId || entry.tool || (run && run.toolId)
  const reportedStatus = String(entry.status || '').toLowerCase()
  const status = (run && run.status) ||
    (['complete', 'completed', 'success', 'succeeded', 'passed'].includes(reportedStatus) || entry.success === true ? 'complete' : 'failed')
  const salvaged = Boolean(entry.salvaged || entry.discoveryOnly)
  return {
    ...entry,
    cellId: cellId || (cohortId && targetId && toolId ? `${cohortId}/${targetId}/${toolId}` : null),
    runId: cellId || suppliedRunId,
    cohortId,
    targetId,
    toolId,
    modelId: entry.modelId || cohort.modelId || (run && run.modelId),
    salvaged,
    status,
    creditEligible: entry.creditEligible == null ? status === 'complete' && !salvaged : Boolean(entry.creditEligible),
    costUsd: run ? run.usage.costUsd : finite(entry.costUsd),
    wallMs: run ? run.wallMs : finite(entry.wallMs),
  }
}

function recordedComparisonEvidence(root, entry) {
  const file = entry.result && entry.result.file
  if (!root || typeof file !== 'string') return entry
  const absolute = path.resolve(root, file)
  const prefix = `${path.resolve(root)}${path.sep}`
  if (!absolute.startsWith(prefix) || !fs.existsSync(absolute)) throw new Error(`Published gold result is unavailable: ${file}`)
  const record = readJson(absolute)
  return {
    ...entry,
    status: deriveStatus(record),
    costUsd: normalizeUsage(record).costUsd,
    wallMs: finite(record.wallMs),
  }
}

function normalizePublishedComparison(published, runs = [], root = null) {
  if (!published || typeof published !== 'object') throw new Error('Published model comparison is invalid')
  const cohorts = (published.cohorts || []).map(normalizeComparisonCohort)
  const cohortsById = new Map(cohorts.map((cohort) => [cohort.runId, cohort]))
  const runsById = new Map(runs.map((run) => [run.id, run]))
  const canonicalIssues = (published.canonicalIssues || []).map((issue) => ({
    ...issue,
    targetId: issue.targetId || issue.target,
  }))
  const rawEvidence = ((published.sourceManifest && published.sourceManifest.sources) || published.sourceEvidence || [])
    .map((entry) => recordedComparisonEvidence(root, entry))
  const rawEvidenceById = new Map(rawEvidence.map((entry) => [entry.cellId || entry.id, entry]))
  const sourceMappings = (published.sourceMappings || published.mappings || []).map((mapping) => {
    const issueIds = issueIdsForMapping(mapping)
    const source = rawEvidenceById.get(mapping.cellId) || {}
    const parts = String(mapping.cellId || '').split('/')
    const cohort = cohortsById.get(source.runId || parts[0]) || {}
    return {
      ...mapping,
      issueIds,
      canonicalIssueId: mapping.canonicalIssueId || (issueIds.length === 1 ? issueIds[0] : null),
      targetId: mapping.targetId || mapping.target || source.targetId || source.target || parts[1] || null,
      modelId: mapping.modelId || source.modelId || cohort.modelId || null,
      creditEligible: mapping.creditEligible == null ? source.creditEligible !== false : Boolean(mapping.creditEligible),
    }
  })
  const sourceEvidence = rawEvidence.map((entry) =>
    normalizeComparisonEvidence(entry, cohortsById, runsById))
  return {
    id: published.id,
    issueUrl: published.issueUrl || LEGACY_RERUN_ISSUE_URL,
    scopes: (published.scopes || []).map((scope) => normalizeComparisonScope(scope, cohortsById)),
    cohorts,
    canonicalIssues,
    sourceMappings,
    sourceEvidence,
    provenance: published.provenance || null,
    manifest: published.manifest || null,
    sourceManifest: published.sourceManifest || null,
    complete: published.complete || null,
  }
}

function loadPublishedModelComparison(root, runs = []) {
  const indexFile = path.join(root, 'gold', 'index.json')
  if (!fs.existsSync(indexFile)) return null
  // Keep reconciliation validation at the publication boundary. The validator rehashes the
  // selected completion marker, source files, target pins, canonical issues, and mappings.
  const reconcile = require('./reconcile')
  const validate = reconcile.validatePublished || reconcile.loadPublishedComparison
  if (typeof validate !== 'function') throw new Error('Published gold validator is unavailable')
  return normalizePublishedComparison(validate(root), runs, root)
}

function reporterReferences(issue) {
  return Array.isArray(issue.reportedByRuns) ? issue.reportedByRuns : issue.reportedBy || []
}

function referenceMatchesRun(reference, run, record) {
  if (reference && typeof reference === 'object') {
    const id = reference.id || reference.run || reference.runKey || null
    if (id && referenceMatchesRun(id, run, record)) return true
    const cohort = reference.cohortId || reference.runId || null
    const target = reference.targetId || reference.target || null
    const tool = reference.toolId || reference.tool || null
    return (!cohort || cohort === run.cohortId) && (!target || target === run.targetId) && (!tool || tool === run.toolId) && Boolean(cohort || target || tool)
  }
  const value = String(reference || '')
  const candidates = new Set([
    run.id,
    `${run.cohortId}/${run.toolId}`,
    `${run.targetId}/${run.toolId}`,
    `${record.runId || run.cohortId}/${run.toolId}`,
    record.id,
    record.runKey,
    record.cellId,
  ].filter(Boolean))
  return candidates.has(value) || value === run.toolId
}

function namespacedIssue(cohortId, targetId, issue) {
  const judgementId = String(issue.id)
  const id = `${cohortId}/${targetId}/${judgementId}`
  const reporterIds = reporterReferences(issue).map((reference) => typeof reference === 'string' ? reference : JSON.stringify(reference))
  return {
    ...issue,
    id,
    key: id,
    issueId: judgementId,
    judgementId,
    cohortId,
    targetId,
    reporterIds: [...new Set(reporterIds)],
  }
}

function loadArtifacts(root = ROOT) {
  const modelConfig = loadModelConfig(root)
  const configuredModels = modelLookup(modelConfig)
  const discovered = discoverCohorts(root)
  const stateFile = path.join(root, 'state.json')
  const toolsFile = path.join(root, 'tools.json')
  const state = fs.existsSync(stateFile) ? readJson(stateFile) : { targets: {} }
  const liveToolFile = fs.existsSync(toolsFile) ? readJson(toolsFile) : { context: '', tools: [] }
  const groundtruthFor = (targetId) => {
    const file = path.join(root, 'groundtruth', `${targetId}.json`)
    return fs.existsSync(file) ? readJson(file) : null
  }
  const contexts = []
  const omittedCohorts = []
  for (const entry of discovered) {
    if (entry.legacy) {
      contexts.push({
        cohort: entry,
        targets: Object.values(state.targets || {}),
        toolFile: liveToolFile,
        groundtruth: Object.fromEntries(Object.keys(state.targets || {}).map((targetId) => [targetId, groundtruthFor(targetId)])),
        cells: null,
      })
      continue
    }
    // In-progress cohorts are intentionally invisible. A present complete marker is a promise that
    // all hashes validate, so readComplete remains strict and propagates any corruption.
    if (!entry.paths.complete || !fs.existsSync(entry.paths.complete)) {
      omittedCohorts.push({ id: entry.runId, reason: 'incomplete' })
      continue
    }
    // A nonlegacy cohort is displayable only after all three artifact layers have been sealed and
    // hashed. readComplete also returns the immutable target/tool snapshots used by that run.
    const completed = readComplete(root, entry.runId)
    const manifest = completed.manifest
    contexts.push({
      cohort: { ...entry, ...manifest, label: manifest.modelLabel, complete: true },
      targets: Object.values(manifest.targetMetadata),
      toolFile: manifest.toolConfig,
      groundtruth: manifest.groundtruth || {},
      cells: completed.seal.cells,
    })
  }
  const targetDataById = new Map()
  const toolDataById = new Map()
  for (const context of contexts) {
    for (const target of context.targets) {
      const snapshot = targetView(target, context.groundtruth[target.id] || null)
      if (!targetDataById.has(target.id)) targetDataById.set(target.id, { ...snapshot, runIds: [], snapshots: {} })
      targetDataById.get(target.id).snapshots[context.cohort.runId] = snapshot
    }
    for (const tool of context.toolFile.tools || []) {
      const snapshot = toolView(tool)
      if (!toolDataById.has(tool.id)) toolDataById.set(tool.id, { ...snapshot, snapshots: {} })
      toolDataById.get(tool.id).snapshots[context.cohort.runId] = snapshot
    }
  }
  const runs = []
  const issues = []

  for (const context of contexts) {
    const { cohort, toolFile } = context
    const cohortId = cohort.runId
    const dirs = cohortDirectories(cohort, root)
    const toolById = new Map((toolFile.tools || []).map((tool) => [tool.id, tool]))
    for (const target of context.targets) {
      // Ground-truth comments live once on the global target entry. Embedding them into every run
      // snapshot multiplies the self-contained dashboard by megabytes.
      const snapshot = targetView(target)
      const judgementFile = path.join(dirs.judgement, `${target.id}.json`)
      const judgement = fs.existsSync(judgementFile) ? readJson(judgementFile) : { issues: [] }
      if (!cohort.legacy && fs.existsSync(judgementFile)) assertJudgementIdentity(judgement, cohort, target.id, judgementFile)
      const cohortIssues = (judgement.issues || []).map((issue) => ({
        ...namespacedIssue(cohortId, target.id, issue),
        targetSnapshot: snapshot,
      }))
      issues.push(...cohortIssues)
      const findingDir = path.join(dirs.findings, target.id)
      const findingRecords = new Map()
      if (!cohort.legacy) {
        for (const file of jsonFiles(findingDir)) {
          const findingFile = path.join(findingDir, file)
          const findingRecord = readJson(findingFile)
          assertCellIdentity(findingRecord, cohort, target.id, file, 'finding', findingFile)
          findingRecords.set(file, findingRecord)
        }
      }
      const resultDir = path.join(dirs.results, target.id)
      const resultFiles = cohort.legacy
        ? jsonFiles(resultDir)
        : context.cells.filter((cell) => cell.target === target.id).map((cell) => `${cell.tool}.json`)
      for (const file of resultFiles) {
        const resultFile = path.join(resultDir, file)
        const record = readJson(resultFile)
        if (!cohort.legacy) assertCellIdentity(record, cohort, target.id, file, 'result', resultFile)
        if (record.salvaged) continue
        const legacyFinding = path.join(findingDir, file)
        const findingRecord = cohort.legacy && fs.existsSync(legacyFinding)
          ? readJson(legacyFinding)
          : findingRecords.get(file) || { findings: [], extractError: null }
        const claims = findingRecord.findings || []
        const usage = normalizeUsage(record)
        const tool = toolById.get(record.tool)
        const toolSnapshot = tool ? toolView(tool) : { id: record.tool, label: record.label || record.tool }
        if (!toolDataById.has(record.tool)) toolDataById.set(record.tool, { ...toolSnapshot, snapshots: {} })
        toolDataById.get(record.tool).snapshots[cohortId] = toolSnapshot
        const identity = modelIdentity(cohort, record, configuredModels, usage)
        const run = {
          id: `${cohortId}/${target.id}/${record.tool}`,
          cellId: `${cohortId}/${target.id}/${record.tool}`,
          recordedCellId: record.cellId || null,
          runId: cohortId,
          recordedRunId: record.runId || null,
          cohortId,
          cohortLabel: cohort.label || cohortId,
          targetId: target.id,
          targetLabel: `${target.id} · ${target.language}`,
          targetSnapshot: snapshot,
          toolId: record.tool,
          toolLabel: (tool && tool.label) || record.label || record.tool,
          toolSource: (tool && tool.source) || record.source || null,
          toolSnapshot,
          status: deriveStatus(record),
          wallMs: finite(record.wallMs),
          finishedAt: record.finishedAt || null,
          exitCode: finite(record.exitCode),
          signal: record.signal || null,
          isError: Boolean(record.isError),
          apiErrorStatus: record.apiErrorStatus || null,
          wallMsDerived: Boolean(record.wallMsDerived),
          attempts: finite(record.attempts),
          dnfReason: record.dnfReason || null,
          usage,
          numTurns: finite(record.numTurns),
          sessionId: record.sessionId || null,
          subagentStats: record.subagentStats || null,
          claims,
          extractError: findingRecord.extractError || null,
          report: record.result || '',
          prompt: record.prompt || expandPrompt(tool, target, toolFile.context),
          promptSource: record.prompt ? 'recorded' : 'reconstructed from tools.json',
          stderr: record.stderrTail || '',
          metadata: cleanMetadata(record),
          requestedModel: identity.requestedModel,
          requestedModelId: identity.requestedModel,
          requestedModelLabel: identity.requestedModelLabel,
          modelId: identity.id,
          modelLabel: identity.label,
          modelProvenance: identity.provenance,
          modelUnderTest: { id: identity.id, label: identity.label, provenance: identity.provenance },
          observedModels: Object.keys(usage.models || {}).sort(),
        }
        const runIssues = cohortIssues.filter((issue) => Array.isArray(issue.reportedByRuns)
          ? issue.reportedByRuns.some((reference) => referenceMatchesRun(reference, run, record))
          : (issue.reportedBy || []).includes(record.tool))
        run.issueIds = runIssues.map((issue) => issue.id)
        run.metrics = metricsFor(runIssues, claims, usage, record.wallMs)
        runs.push(run)
        targetDataById.get(target.id).runIds.push(run.id)
      }
    }
  }
  const cohorts = contexts.map((context) => context.cohort)
  const targetData = [...targetDataById.values()]
  const tools = [...toolDataById.values()]
  const models = (modelConfig.models || []).map(({ id, label, cliModel }) => ({ id, label: label || id, cliModel: cliModel || null }))
  for (const cohort of cohorts) {
    const modelId = cohort.requestedModel || cohort.observedModel
    if (modelId && !models.some((model) => model.id === modelId)) models.push({ id: modelId, label: cohort.modelLabel || modelId, cliModel: null })
  }
  const modelComparison = loadPublishedModelComparison(root, runs)
  return {
    schemaVersion: 3,
    defaultTokenLimit: DEFAULT_TOKEN_LIMIT,
    defaultModel: modelConfig.defaultModel || (models[0] && models[0].id) || null,
    models,
    omittedCohorts,
    cohorts: cohorts.map((cohort) => ({
      id: cohort.runId,
      runId: cohort.runId,
      label: cohort.label || cohort.runId,
      requestedModel: cohort.requestedModel || null,
      observedModel: cohort.observedModel || null,
      modelLabel: cohort.modelLabel || null,
      modelProvenance: cohort.requestedModel ? 'requested' : cohort.observedModel ? 'observed' : 'unavailable',
      claudeVersion: cohort.claudeVersion || null,
      createdAt: cohort.createdAt || null,
      complete: Boolean(cohort.complete),
      legacy: Boolean(cohort.legacy),
    })),
    targets: targetData,
    tools,
    issues,
    runs,
    modelComparison,
  }
}

function escapeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function render(data, assets = ASSET_DIR) {
  const css = fs.readFileSync(path.join(assets, 'styles.css'), 'utf8').trim()
  const js = fs.readFileSync(path.join(assets, 'app.js'), 'utf8').trim()
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="description" content="A verified benchmark of Claude Code review skills, with clear findings-per-dollar and completeness-per-dollar leaders">
<title>Review Bench · Claude Code review skill benchmark</title>
<style>\n${css}\n</style>
</head>
<body>
<a class="skip-link" href="#app">Skip to dashboard</a>
<div id="app"><noscript>This dashboard requires JavaScript, but makes no network requests.</noscript></div>
<script id="dashboard-data" type="application/json">${escapeScriptJson(data)}</script>
<script>\n${js}\n</script>
</body>
</html>\n`
}

function main() {
  process.stdout.write(render(loadArtifacts()))
}

module.exports = {
  comparisonFor, deriveModelMetrics, deriveStatus, escapeScriptJson, isRecommendedRun, loadArtifacts,
  loadPublishedModelComparison, metricsFor, normalizePublishedComparison, normalizeUsage, render,
}

if (require.main === module) main()
