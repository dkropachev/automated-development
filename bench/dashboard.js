#!/usr/bin/env node
'use strict'

// Build the offline run explorer from committed benchmark artifacts. Deliberately do not import
// lib/usage: that module reads local Claude transcripts, while this export must be reproducible
// from the repository alone.
const fs = require('node:fs')
const path = require('node:path')

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
  if (record.salvaged) return 'salvaged'
  if (record.exitCode === 0 && !record.isError && record.result) return 'complete'
  return 'failed'
}

function isRecommendedRun(run, tokenLimit = DEFAULT_TOKEN_LIMIT) {
  return ['complete', 'salvaged'].includes(run.status) &&
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
    uniqueReal: real.filter((issue) => (issue.reportedBy || []).length === 1).length,
    severityHigh: severityAtLeast(['high']),
    severityMediumPlus: severityAtLeast(['high', 'medium']),
    severityLowPlus: severityAtLeast(['high', 'medium', 'low']),
    precision: ratio(real.length, real.length + falsePositive),
    falsePositiveRate: ratio(falsePositive, real.length + falsePositive),
    realPerDollar: ratio(real.length, usage.costUsd),
    minutesPerReal: ratio(finite(wallMs) == null ? null : wallMs / 60000, real.length),
    costPerReal: ratio(usage.costUsd, real.length),
  }
}

function comparisonFor(left, right) {
  if (!left || !right) return { compatible: false, reason: 'Two runs are required.', shared: [], leftOnly: [], rightOnly: [] }
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

function loadArtifacts(root = ROOT) {
  const state = readJson(path.join(root, 'state.json'))
  const toolFile = readJson(path.join(root, 'tools.json'))
  const targets = Object.values(state.targets || {})
  const tools = toolFile.tools || []
  const toolById = new Map(tools.map((tool) => [tool.id, tool]))
  const targetData = []
  const runs = []
  const issues = []

  for (const target of targets) {
    const judgementFile = path.join(root, 'judgement', `${target.id}.json`)
    const groundtruthFile = path.join(root, 'groundtruth', `${target.id}.json`)
    const judgement = fs.existsSync(judgementFile) ? readJson(judgementFile) : { issues: [] }
    const groundtruth = fs.existsSync(groundtruthFile) ? readJson(groundtruthFile) : null
    const targetRuns = []
    for (const issue of judgement.issues || []) issues.push({ ...issue, targetId: target.id })
    for (const file of jsonFiles(path.join(root, 'results', target.id))) {
      const record = readJson(path.join(root, 'results', target.id, file))
      const findingFile = path.join(root, 'findings', target.id, file)
      const findingRecord = fs.existsSync(findingFile) ? readJson(findingFile) : { findings: [], extractError: null }
      const claims = findingRecord.findings || []
      const issues = (judgement.issues || []).filter((issue) => (issue.reportedBy || []).includes(record.tool))
      const usage = normalizeUsage(record)
      const tool = toolById.get(record.tool)
      const run = {
        id: `${target.id}/${record.tool}`,
        targetId: target.id,
        targetLabel: `${target.id} · ${target.language}`,
        toolId: record.tool,
        toolLabel: record.label || (tool && tool.label) || record.tool,
        toolSource: record.source || (tool && tool.source) || null,
        status: deriveStatus(record),
        wallMs: finite(record.wallMs),
        finishedAt: record.finishedAt || null,
        exitCode: finite(record.exitCode),
        signal: record.signal || null,
        isError: Boolean(record.isError),
        apiErrorStatus: record.apiErrorStatus || null,
        salvaged: Boolean(record.salvaged),
        wallMsDerived: Boolean(record.wallMsDerived),
        attempts: finite(record.attempts),
        dnfReason: record.dnfReason || null,
        usage,
        numTurns: finite(record.numTurns),
        sessionId: record.sessionId || null,
        subagentStats: record.subagentStats || null,
        claims,
        extractError: findingRecord.extractError || null,
        issueIds: issues.map((issue) => issue.id),
        metrics: metricsFor(issues, claims, usage, record.wallMs),
        report: record.result || '',
        prompt: record.prompt || expandPrompt(tool, target, toolFile.context),
        promptSource: record.prompt ? 'recorded' : 'reconstructed from tools.json',
        stderr: record.stderrTail || '',
        metadata: cleanMetadata(record),
      }
      runs.push(run)
      targetRuns.push(run.id)
    }
    targetData.push({
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
      runIds: targetRuns,
      groundtruth,
    })
  }
  return {
    schemaVersion: 1,
    defaultTokenLimit: DEFAULT_TOKEN_LIMIT,
    targets: targetData,
    tools: tools.map(({ id, label, source, languages, parked, parkedReason, catalogId, catalogLabel, description, install, invoke, repoUrl, pageUrl }) => ({
      id, label, source, languages: languages || null, parked: Boolean(parked), parkedReason: parkedReason || null,
      catalogId: catalogId || id, catalogLabel: catalogLabel || label, description: description || null,
      install: install || null, invoke: invoke || null, repoUrl: repoUrl || null, pageUrl: pageUrl || null,
    })),
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
