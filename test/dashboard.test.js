'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dashboard = require('../bench/dashboard')

const ROOT = path.join(__dirname, '..')

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
    { verdict: 'real', scope: 'in-scope', severity: 'high', introducedByPr: true, reportedBy: ['one'] },
    { verdict: 'real', scope: 'out-of-scope', severity: 'medium', introducedByPr: false, reportedBy: ['one', 'two'] },
    { verdict: 'false-positive', scope: 'in-scope' },
    { verdict: 'unproven', scope: 'in-scope' },
  ]
  const metrics = dashboard.metricsFor(issues, [{}, {}], { costUsd: 4 }, 120000)
  assert.deepEqual(metrics, {
    claims: 2, judged: 4, real: 2, falsePositive: 1, unproven: 1, inScope: 1,
    prIntroduced: 1, uniqueReal: 1, severityHigh: 1, severityMediumPlus: 2,
    severityLowPlus: 2, precision: 2 / 3, falsePositiveRate: 1 / 3, realPerDollar: 0.5,
    minutesPerReal: 1, costPerReal: 2,
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
})

test('artifact loader reads the complete tracked matrix without runtime transcript accounting', () => {
  const data = dashboard.loadArtifacts()
  assert.equal(data.targets.length, 3)
  assert.equal(data.tools.length, 8)
  assert.equal(data.runs.length, 18)
  assert.equal(data.issues.length, 137)
  assert.doesNotMatch(JSON.stringify(data), /review-and-fix-pr|rafp-(?:review|detailed)/)
  assert.deepEqual(data.runs.reduce((counts, run) => {
    counts[run.status] = (counts[run.status] || 0) + 1
    return counts
  }, {}), { complete: 17, dnf: 1 })
  assert.ok(data.runs.every((run) => !run.salvaged))
  assert.ok(data.runs.every((run) => run.claims && run.issueIds && run.metrics))
  assert.equal(data.defaultTokenLimit, 25000000)
  assert.equal(data.runs.filter((run) => dashboard.isRecommendedRun(run, data.defaultTokenLimit)).length, 15)
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
  assert.match(html, /function renderSkills\(focusId = null\)/)
  assert.match(html, /function runsHash\(rows\)/)
  assert.match(html, /View \$\{skill\.rows\.length\} run/)
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
