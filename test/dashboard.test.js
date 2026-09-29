'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dashboard = require('../bench/dashboard')
const artifacts = require('../bench/lib/artifacts')

const ROOT = path.join(__dirname, '..')
const BASE_SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)

function createCompleteDashboardCohort(root, options = {}) {
  const runId = options.runId || 'claude-opus-5-5'
  const target = options.target || {
    id: 'sample', language: 'Snapshot JS', fork: 'snapshot/project', forkPr: 7,
    forkPrUrl: 'https://example.test/snapshot/project/pull/7', upstreamPrUrl: 'https://example.test/upstream/pull/7',
    upstreamTitle: 'Pinned snapshot target', localDiffBytes: 42, commits: 2,
  }
  const toolFile = options.toolFile || {
    context: 'Pinned review of {fork}',
    tools: [{ id: 'tool', label: 'Pinned Tool', source: 'snapshot-source', prompt: '{context}', description: 'Pinned description' }],
  }
  const groundtruth = options.groundtruth || {
    [target.id]: {
      url: 'https://example.test/pinned-review', author: 'author',
      review: { inline: [{ user: 'reviewer', path: 'src/new.js', line: 1, body: 'Pinned review comment.' }], issue: [] },
    },
  }
  const toolsFile = path.join(root, 'tools.json')
  fs.writeFileSync(toolsFile, JSON.stringify(toolFile))
  const manifest = artifacts.ensureManifest(root, {
    runId,
    requestedModel: 'claude-opus-5-5',
    modelLabel: 'Claude Opus 5.5',
    claudeVersion: '9.9.9',
    configSha256: artifacts.sha256File(toolsFile),
    targets: { [target.id]: { baseSha: BASE_SHA, headSha: HEAD_SHA } },
    targetMetadata: { [target.id]: target },
    groundtruth,
    expectedCells: [{ id: `${runId}/${target.id}/tool`, target: target.id, tool: 'tool' }],
    toolConfig: toolFile,
  })
  const paths = artifacts.cohortPaths(root, runId)
  const cellId = `${runId}/${target.id}/tool`
  const resultFile = path.join(paths.results, target.id, 'tool.json')
  const result = {
    schemaVersion: 2, ...artifacts.manifestMetadata(manifest), cellId, target: target.id, tool: 'tool',
    label: 'Pinned Tool', source: 'snapshot-source', baseSha: BASE_SHA, headSha: HEAD_SHA,
    exitCode: 0, isError: false, result: 'new', transcriptUsage: { models: { 'claude-sonnet-observed': 2 } },
  }
  fs.mkdirSync(path.dirname(resultFile), { recursive: true })
  fs.writeFileSync(resultFile, JSON.stringify(result))
  const { seal } = artifacts.ensureSeal(root, runId)
  const cell = seal.cells[0]
  const findingFile = artifacts.findingFileForCell(root, runId, cell)
  const finding = {
    schemaVersion: 2, ...artifacts.manifestMetadata(manifest), cellId, target: target.id, tool: 'tool',
    baseSha: BASE_SHA, headSha: HEAD_SHA, sourceResultSha256: cell.sha256,
    findings: [{ title: 'New claim', file: 'src/new.js', line: 1, severity: 'medium', kind: 'bug', claim: 'New claim.', selfRejected: false }],
    extractError: null,
  }
  fs.mkdirSync(path.dirname(findingFile), { recursive: true })
  fs.writeFileSync(findingFile, JSON.stringify(finding))
  const judgementFile = path.join(paths.judgement, `${target.id}.json`)
  const judgement = {
    schemaVersion: 2, ...artifacts.manifestMetadata(manifest), target: target.id, language: target.language,
    baseSha: BASE_SHA, headSha: HEAD_SHA, rawFindings: 1,
    issues: [{
      id: 'I1', title: 'New issue', file: 'src/new.js', line: 1, kind: 'bug', severity: 'medium',
      verdict: 'real', verdictReason: 'Verified.', introducedByPr: true, scope: 'in-scope', scopeReason: 'Added here.',
      reportedBy: ['tool'], reportedByRuns: [cellId], reportedAs: { tool: 'New claim.' }, reportedAsByRun: { [cellId]: 'New claim.' },
    }],
  }
  fs.mkdirSync(path.dirname(judgementFile), { recursive: true })
  fs.writeFileSync(judgementFile, JSON.stringify(judgement))
  artifacts.ensureComplete(root, runId)
  return { manifest, paths, resultFile, findingFile, judgementFile, target, toolFile, groundtruth }
}

test('normalizeUsage prefers transcript fields and falls back field by field', () => {
  const usage = dashboard.normalizeUsage({
    transcriptUsage: { input: 0, output: 12, thinking: null, cacheRead: 30, models: {} },
    modelUsage: {
      alpha: { inputTokens: 99, outputTokens: 50, thinkingTokens: 7, cacheCreationInputTokens: 5, costUSD: 1.25 },
      beta: { thinkingTokens: 3, cacheCreationInputTokens: 2, costUSD: 0.75 },
    },
    reportedUsage: { input_tokens: 101, cache_read_input_tokens: 88 },
    reportedCostUsd: 9,
  })
  assert.equal(usage.input, 0, 'a recorded zero is available, not missing')
  assert.equal(usage.output, 12)
  assert.equal(usage.thinking, 10)
  assert.equal(usage.cacheRead, 30)
  assert.equal(usage.cacheCreation, 7)
  assert.equal(usage.costUsd, 2)
  assert.equal(usage.sessions, null)
  assert.equal(usage.total, 49)
  assert.equal(usage.sources.thinking, 'model')
  assert.equal(usage.sources.total, 'derived')
  assert.equal(usage.source, 'mixed')
})

test('normalizeUsage reaches reported fields and preserves unavailable values', () => {
  const usage = dashboard.normalizeUsage({
    reportedUsage: { input_tokens: 3, output_tokens: 4, output_tokens_details: { thinking_tokens: 1 } },
    reportedCostUsd: 0.5,
  })
  assert.equal(usage.input, 3)
  assert.equal(usage.output, 4)
  assert.equal(usage.costUsd, 0.5)
  assert.equal(usage.cacheRead, null)
  assert.equal(usage.sessions, null)
  assert.equal(usage.total, 7)
  assert.equal(usage.source, 'reported')
})

test('deriveStatus preserves complete, failed, and DNF states', () => {
  assert.equal(dashboard.deriveStatus({ exitCode: 0, isError: false, result: 'ok' }), 'complete')
  assert.equal(dashboard.deriveStatus({ exitCode: 1, isError: true, result: null }), 'failed')
  assert.equal(dashboard.deriveStatus({ exitCode: 0, result: 'partial', dnf: true }), 'dnf')
})

test('recommended runs must succeed, find something real, and stay under token ceiling', () => {
  const base = { status: 'complete', metrics: { real: 1 }, usage: { total: 100 } }
  assert.equal(dashboard.isRecommendedRun(base, 100), true)
  assert.equal(dashboard.isRecommendedRun({ ...base, status: 'failed' }, 100), false)
  assert.equal(dashboard.isRecommendedRun({ ...base, metrics: { real: 0 } }, 100), false)
  assert.equal(dashboard.isRecommendedRun({ ...base, usage: { total: 101 } }, 100), false)
  assert.equal(dashboard.isRecommendedRun({ ...base, usage: { total: null } }, 100), false)
})

test('metrics use transparent verdict rules and make zero denominators unavailable', () => {
  const issues = [
    { verdict: 'real', scope: 'in-scope', severity: 'blocker', introducedByPr: true, reportedBy: ['one'] },
    { verdict: 'real', scope: 'in-scope', severity: 'high', introducedByPr: true, reportedBy: ['one'] },
    { verdict: 'real', scope: 'out-of-scope', severity: 'medium', introducedByPr: false, reportedBy: ['one', 'two'] },
    { verdict: 'false-positive', scope: 'in-scope' },
    { verdict: 'unproven', scope: 'in-scope' },
  ]
  const metrics = dashboard.metricsFor(issues, [{}, {}], { costUsd: 4 }, 120000)
  assert.deepEqual(metrics, {
    claims: 2, judged: 5, real: 3, falsePositive: 1, unproven: 1, inScope: 2,
    prIntroduced: 2, uniqueReal: 2, severityHigh: 2, severityMediumPlus: 3,
    severityLowPlus: 3, precision: 3 / 4, falsePositiveRate: 1 / 4, realPerDollar: 0.75,
    minutesPerReal: 2 / 3, costPerReal: 4 / 3,
  })
  const empty = dashboard.metricsFor([], [], { costUsd: 0 }, 0)
  assert.equal(empty.precision, null)
  assert.equal(empty.falsePositiveRate, null)
  assert.equal(empty.realPerDollar, null)
  assert.equal(empty.minutesPerReal, null)
  assert.equal(empty.costPerReal, null)
})

test('comparison overlap uses stable IDs only for the same target', () => {
  const left = { targetId: 'a', issues: [{ id: 'I1' }, { id: 'I2' }] }
  const right = { targetId: 'a', issues: [{ id: 'I2' }, { id: 'I3' }] }
  const overlap = dashboard.comparisonFor(left, right)
  assert.equal(overlap.compatible, true)
  assert.deepEqual(overlap.shared.map((issue) => issue.id), ['I2'])
  assert.deepEqual(overlap.leftOnly.map((issue) => issue.id), ['I1'])
  assert.deepEqual(overlap.rightOnly.map((issue) => issue.id), ['I3'])
  const crossTarget = dashboard.comparisonFor(left, { ...right, targetId: 'b' })
  assert.equal(crossTarget.compatible, false)
  assert.match(crossTarget.reason, /different targets/)
  assert.deepEqual(crossTarget.shared, [])
  const crossCohort = dashboard.comparisonFor(
    { ...left, cohortId: 'old' },
    { ...right, cohortId: 'new' },
  )
  assert.equal(crossCohort.compatible, false)
  assert.match(crossCohort.reason, /different judgement snapshots/)
})

test('artifact loader reads the complete tracked matrix without runtime transcript accounting', () => {
  const data = dashboard.loadArtifacts()
  assert.equal(data.schemaVersion, 2)
  assert.equal(data.defaultModel, 'claude-opus-5-5')
  assert.deepEqual(data.models.map((model) => model.id), ['claude-opus-5-5', 'claude-opus-5'])
  assert.ok(data.cohorts.some((cohort) => cohort.id === 'legacy'))
  assert.equal(data.targets.length, 3)
  assert.equal(data.tools.length, 8)
  const legacyRuns = data.runs.filter((run) => run.cohortId === 'legacy')
  const legacyIssues = data.issues.filter((issue) => issue.cohortId === 'legacy')
  assert.equal(legacyRuns.length, 18)
  assert.equal(legacyIssues.length, 137)
  assert.doesNotMatch(JSON.stringify(data), /review-and-fix-pr|rafp-(?:review|detailed)/)
  assert.deepEqual(legacyRuns.reduce((counts, run) => {
    counts[run.status] = (counts[run.status] || 0) + 1
    return counts
  }, {}), { complete: 17, dnf: 1 })
  assert.ok(data.runs.every((run) => !run.salvaged))
  assert.ok(data.runs.every((run) => run.claims && run.issueIds && run.metrics))
  assert.ok(legacyRuns.every((run) => run.id === `legacy/${run.targetId}/${run.toolId}`))
  assert.ok(legacyRuns.every((run) => run.runId === 'legacy'))
  assert.ok(legacyRuns.every((run) => run.requestedModel === null && run.modelId === 'claude-opus-5'))
  assert.ok(legacyRuns.every((run) => run.modelLabel === 'Claude Opus 5' && run.modelProvenance === 'observed'))
  assert.ok(data.targets.every((target) => target.groundtruth), 'global targets retain upstream review context for legacy runs')
  assert.ok(legacyIssues.every((issue) => issue.id === `legacy/${issue.targetId}/${issue.issueId}`))
  assert.equal(new Set(data.runs.map((run) => run.id)).size, data.runs.length)
  assert.equal(new Set(data.issues.map((issue) => issue.id)).size, data.issues.length)
  assert.equal(data.defaultTokenLimit, 25000000)
  assert.equal(legacyRuns.filter((run) => dashboard.isRecommendedRun(run, data.defaultTokenLimit)).length, 15)
  const source = fs.readFileSync(path.join(ROOT, 'bench', 'dashboard.js'), 'utf8')
  assert.doesNotMatch(source, /require\(['"]\.\/lib\/usage['"]\)/)
  assert.doesNotMatch(source, /path\.join\(root,\s*['"](?:work|logs)['"]/)
  assert.doesNotMatch(source, /\.claude\/projects/)
})

test('artifact loader limits directory reads to the documented inputs', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-dashboard-'))
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true })
    fs.writeFileSync(path.join(fixture, file), JSON.stringify(value))
  }
  try {
    write('state.json', { targets: { sample: { id: 'sample', language: 'JS', fork: 'x/y', forkPr: 1 } } })
    write('tools.json', { context: 'Review {fork}', tools: [{ id: 'tool', label: 'Tool', prompt: '{context}' }] })
    write('models.json', {
      schemaVersion: 1,
      defaultModel: 'claude-opus-5-5',
      models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { id: 'claude-opus-5', label: 'Claude Opus 5' }],
      legacyCohort: { runId: 'legacy', label: 'Original benchmark', requestedModel: null, observedModel: 'claude-opus-5', modelLabel: 'Claude Opus 5' },
    })
    write('results/sample/tool.json', { target: 'sample', tool: 'tool', exitCode: 0, isError: false, result: 'ok' })
    write('results/sample/salvaged.json', { target: 'sample', tool: 'salvaged', salvaged: true, result: 'recovered' })
    write('findings/sample/tool.json', { findings: [] })
    write('judgement/sample.json', { issues: [] })
    write('groundtruth/sample.json', { url: 'https://example.test/pr/1', review: {} })
    fs.mkdirSync(path.join(fixture, 'work', 'secret'), { recursive: true })
    fs.writeFileSync(path.join(fixture, 'work', 'secret', 'invalid.json'), 'not json')
    fs.mkdirSync(path.join(fixture, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(fixture, 'logs', 'invalid.json'), 'not json')
    const data = dashboard.loadArtifacts(fixture)
    assert.equal(data.runs.length, 1)
    assert.equal(data.runs[0].prompt, 'Review x/y')
    assert.equal(data.runs[0].id, 'legacy/sample/tool')
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test('artifact loader uses complete cohort snapshots after live state and tools disappear', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-dashboard-cohorts-'))
  try {
    fs.copyFileSync(path.join(ROOT, 'bench', 'models.json'), path.join(fixture, 'models.json'))
    fs.writeFileSync(path.join(fixture, 'state.json'), JSON.stringify({ targets: { live: { id: 'live', language: 'Wrong' } } }))
    fs.writeFileSync(path.join(fixture, 'tools.json'), JSON.stringify({ context: 'Live', tools: [{ id: 'tool', label: 'Wrong', prompt: 'Wrong' }] }))
    const finished = createCompleteDashboardCohort(fixture)
    artifacts.ensureManifest(fixture, {
      runId: 'in-progress',
      requestedModel: finished.manifest.requestedModel,
      modelLabel: finished.manifest.modelLabel,
      claudeVersion: finished.manifest.claudeVersion,
      configSha256: finished.manifest.configSha256,
      targets: finished.manifest.targets,
      targetMetadata: finished.manifest.targetMetadata,
      groundtruth: finished.manifest.groundtruth,
      expectedCells: [{ id: 'in-progress/sample/tool', target: 'sample', tool: 'tool' }],
      toolConfig: finished.manifest.toolConfig,
    })
    fs.unlinkSync(path.join(fixture, 'state.json'))
    fs.unlinkSync(path.join(fixture, 'tools.json'))
    fs.mkdirSync(path.join(fixture, 'groundtruth'), { recursive: true })
    fs.writeFileSync(path.join(fixture, 'groundtruth', 'sample.json'), JSON.stringify({ url: 'https://example.test/changed-live-review' }))

    const data = dashboard.loadArtifacts(fixture)
    assert.deepEqual(data.runs.map((run) => run.id), ['claude-opus-5-5/sample/tool'])
    assert.deepEqual(data.issues.map((issue) => issue.id), ['claude-opus-5-5/sample/I1'])
    assert.deepEqual(data.targets.map((target) => target.id), ['sample'])
    assert.deepEqual(data.tools.map((tool) => tool.id), ['tool'])
    assert.deepEqual(data.cohorts.map((cohort) => cohort.id), ['claude-opus-5-5'])
    assert.deepEqual(data.omittedCohorts, [{ id: 'in-progress', reason: 'incomplete' }])
    const run = data.runs[0]
    assert.equal(run.targetSnapshot.title, 'Pinned snapshot target')
    assert.equal(run.targetSnapshot.language, 'Snapshot JS')
    assert.equal(run.toolSnapshot.label, 'Pinned Tool')
    assert.equal(run.toolSnapshot.source, 'snapshot-source')
    assert.equal(run.prompt, 'Pinned review of snapshot/project')
    assert.equal(run.requestedModel, 'claude-opus-5-5')
    assert.equal(run.modelProvenance, 'requested')
    assert.deepEqual(run.observedModels, ['claude-sonnet-observed'])
    assert.deepEqual(run.issueIds, ['claude-opus-5-5/sample/I1'])
    assert.equal(data.targets[0].snapshots['claude-opus-5-5'].groundtruth.url, 'https://example.test/pinned-review')
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test('artifact loader rejects result, finding, and judgement tampering via complete marker', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-dashboard-integrity-'))
  try {
    fs.copyFileSync(path.join(ROOT, 'bench', 'models.json'), path.join(fixture, 'models.json'))
    fs.writeFileSync(path.join(fixture, 'state.json'), JSON.stringify({ targets: {} }))
    fs.writeFileSync(path.join(fixture, 'tools.json'), JSON.stringify({ context: '', tools: [] }))
    const files = createCompleteDashboardCohort(fixture)
    assert.equal(dashboard.loadArtifacts(fixture).runs.length, 1)
    for (const [file, pattern] of [
      [files.resultFile, /sealed results changed/],
      [files.findingFile, /finding hashes mismatch/],
      [files.judgementFile, /judgement hashes mismatch/],
    ]) {
      const original = fs.readFileSync(file)
      fs.appendFileSync(file, ' ')
      assert.throws(() => dashboard.loadArtifacts(fixture), pattern)
      fs.writeFileSync(file, original)
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test('HTML export is deterministic, self-contained, and script-data safe', () => {
  const data = dashboard.loadArtifacts()
  const first = dashboard.render(data)
  const second = dashboard.render(data)
  assert.equal(first, second)
  assert.match(first, /^<!doctype html>/)
  assert.match(first, /id="dashboard-data" type="application\/json"/)
  for (const view of ['Summary', 'Leaderboard', 'Compare', 'Insights', 'Findings', 'Runs']) assert.match(first, new RegExp(`navLink\\('${view}'`))
  assert.match(first, /function renderLanding\(params\)/)
  assert.match(first, /function landingRankCard\(group, marker, value, note\)/)
  assert.doesNotMatch(first, /value-leader-card|function leaderCard/)
  assert.doesNotMatch(first, /review-bakeoff\.md/)
  assert.doesNotMatch(first, /<script\s+[^>]*src=/i)
  assert.doesNotMatch(first, /<link\s+[^>]*href=/i)
  assert.doesNotMatch(first, /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket/i)
  const hostile = dashboard.render({ value: '</script><script>alert(1)</script>\u2028' })
  assert.doesNotMatch(hostile, /<script>alert\(1\)<\/script>/)
  assert.match(hostile, /\\u003c\/script>/)
})

test('dashboard metric hints are visible, concise, and keyboard reachable', () => {
  const html = dashboard.render(dashboard.loadArtifacts())
  assert.match(html, /'Real \/ run': 'Distinct verified real issues divided by complete runs\.'/)
  assert.doesNotMatch(html, /salvag/i)
  assert.match(html, /'Precision': 'Real issues divided by real issues plus false positives; unproven issues are excluded\.'/)
  assert.match(html, /class: 'hint-mark', tabindex: 0, title: hint, 'data-hint': hint/)
  assert.match(html, /class: 'hint-tooltip', role: 'tooltip'/)
  assert.match(html, /document\.addEventListener\('focusin'/)
  assert.match(html, /\.hint-tooltip \{ position: fixed;/)
})

test('dashboard exposes tested-skill metadata and exact run-set links', () => {
  const data = dashboard.loadArtifacts()
  const builtIn = data.tools.find((tool) => tool.id === 'builtin-code-review')
  assert.equal(builtIn.repoUrl, 'https://github.com/anthropics/claude-code')
  assert.match(builtIn.description, /multi-agent pull-request review/)
  assert.match(builtIn.invoke, /code-review/)
  assert.ok(data.tools.every((tool) => tool.description && tool.install && tool.invoke && tool.repoUrl && tool.pageUrl))
  const html = dashboard.render(data)
  assert.match(html, /function renderSkills\(focusId = null, params = new URLSearchParams\(\)\)/)
  assert.match(html, /function runsHash\(rows\)/)
  assert.match(html, /View \$\{skill\.rows\.length\} run/)
})

test('dashboard model picker defaults to requested model and keeps observed stack separate', () => {
  const html = dashboard.render(dashboard.loadArtifacts())
  assert.match(html, /function selectedModel\(params\)/)
  assert.match(html, /return DATA\.defaultModel \|\|/)
  assert.match(html, /\['all', 'All models \/ history'\]/)
  assert.match(html, /return selected === 'all' \|\| run\.modelId === selected/)
  assert.match(html, /summaryItem\('Model under test'/)
  assert.match(html, /summaryItem\('Observed model stack'/)
  assert.match(html, /legacyRunAliases/)
  assert.match(html, /different judgement snapshots/)
  assert.doesNotMatch(html, /selectedModels.*usage\.models/)
})

test('dashboard includes blocker in severity filters, ordering, and cumulative scopes', () => {
  const html = dashboard.render(dashboard.loadArtifacts())
  assert.match(html, /all: completenessFor\(\['blocker', 'high', 'medium', 'low', 'nit'\]\)/)
  assert.match(html, /major: completenessFor\(\['blocker', 'high'\]\)/)
  assert.match(html, /majorMinor: completenessFor\(\['blocker', 'high', 'medium'\]\)/)
  assert.match(html, /const rank = \{ blocker: 0, high: 1, medium: 2, low: 3, nit: 4 \}/)
  assert.match(html, /\['blocker', 'Blocker'\]/)
  assert.match(html, /severity\(\['blocker', 'high', 'medium', 'low'\]\)/)
})

test('tracked dashboard exactly matches a fresh export', () => {
  const index = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8')
  const tracked = fs.readFileSync(path.join(ROOT, 'docs', 'run-explorer.html'), 'utf8')
  const report = fs.readFileSync(path.join(ROOT, 'docs', 'review-bakeoff.md'), 'utf8')
  const fresh = dashboard.render(dashboard.loadArtifacts())
  assert.equal(index, fresh, 'run make bench-dashboard after changing benchmark artifacts or dashboard assets')
  assert.equal(tracked, fresh, 'the backwards-compatible run-explorer URL must match the Pages entry point')
  assert.doesNotMatch(report, /review-and-fix-pr|rafp-(?:review|detailed)/)
})
