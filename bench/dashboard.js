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
  if (record.exitCode === 0 && !record.isError && record.result) return 'complete'
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
  return {
    schemaVersion: 2,
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
      legacy: Boolean(cohort.legacy),
    })),
    targets: targetData,
    tools,
    issues,
    runs,
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
  comparisonFor, deriveStatus, escapeScriptJson, isRecommendedRun, loadArtifacts, metricsFor, normalizeUsage, render,
}

if (require.main === module) main()
