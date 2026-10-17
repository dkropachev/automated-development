'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadExperiments, renderExperimentSummary } = require('../bench/experiments')
const dashboard = require('../bench/dashboard')
const { calculateSkillModelGroups } = require('../bench/dashboard/app')
const { expectedPublication, publish } = require('../bench/publish')
const ROOT = path.resolve(__dirname, '../bench')
const PARITY = 'codex-parity-2026-10-15'
const FOCUS = 'codex-focus-2026-10-16'
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data))

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'experiment-publication-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.cpSync(path.join(ROOT, 'experiments'), path.join(root, 'experiments'), { recursive: true })
  return root
}

test('publishes every archived record with qualified identity, corrections and distinct repeats', () => {
  const records = loadExperiments(ROOT)
  assert.equal(records.length, 30)
  assert.equal(new Set(records.map((r) => r.id)).size, 30)
  assert.equal(records.filter((r) => r.experimentId === PARITY).length, 9)
  assert.equal(records.filter((r) => r.experimentId === FOCUS).length, 21)
  assert.equal(records.filter((r) => r.platform === 'codex').length, 27)
  assert.ok(records.every((r) => r.skillId === `${r.platform}:${r.toolId}` && r.report && r.reportSha256))
  const claude = records.filter((r) => r.platform === 'claude')
  assert.equal(claude.find((r) => r.targetId === 'quillstone').verifiedGroups, 7)
  assert.equal(claude.reduce((n, r) => n + r.verifiedGroups, 0), 22)
  assert.equal(claude.reduce((n, r) => n + r.bugGroups, 0), 11)
  assert.ok(claude.every((r) => r.correction.url.endsWith('category-baseline.json')))
  assert.equal(records.filter((r) => r.featured).length, 6)
  assert.deepEqual(records.filter((r) => /^quillstone-toolkit-split(-r2)?$/.test(r.recordId)).map((r) => r.totalTokens).sort(), [1759984, 1822666])
  assert.equal(json(path.join(ROOT, 'experiments', PARITY, 'evidence.json')).records.find((r) => r.id === 'quillstone-claude-matched').verifiedGroups, 8, 'original receipt remains intact')
  assert.match(renderExperimentSummary(records), /7 Rust groups and 22 total groups/)
})

test('platform comes from publication metadata, never the model; missing measurements stay null', (t) => {
  const root = fixture(t)
  const file = path.join(root, 'experiments', FOCUS, 'evidence.json')
  const data = json(file)
  data.records[0].model = 'claude-opus-5-5'
  delete data.records[0].totalTokens
  delete data.records[0].grade.bug_groups
  delete data.records[0].grade.valid_groups
  write(file, data)
  const record = loadExperiments(root).find((r) => r.recordId === data.records[0].id && r.experimentId === FOCUS)
  assert.equal(record.platform, 'codex')
  assert.equal(record.totalTokens, null)
  assert.equal(record.bugGroups, null)
  assert.equal(record.verifiedGroups, null)
  assert.match(renderExperimentSummary([record]), /unavailable \| unavailable \| unavailable/)
})

for (const failure of ['missing report', 'hash mismatch', 'missing binding', 'extra binding', 'duplicate binding', 'unresolved measurement', 'missing publication']) {
  test(`publication fails closed on ${failure}`, (t) => {
    const root = fixture(t)
    const dir = path.join(root, 'experiments', PARITY)
    const file = path.join(dir, 'publication.json')
    const publication = json(file)
    if (failure === 'missing report') fs.unlinkSync(path.join(dir, 'reports/ironweave-baseline.md'))
    if (failure === 'hash mismatch') fs.appendFileSync(path.join(dir, 'reports/ironweave-baseline.md'), '\nchanged')
    if (failure === 'missing binding') publication.records.pop()
    if (failure === 'extra binding') publication.records.push({ ...publication.records[0], recordId: 'absent' })
    if (failure === 'duplicate binding') publication.records.push(publication.records[0])
    if (failure === 'unresolved measurement') publication.records[0].measurement.pointer = '/reports/absent'
    write(file, publication)
    if (failure === 'missing publication') fs.unlinkSync(file)
    assert.throws(() => loadExperiments(root), /ENOENT|hash mismatch|publication|measurement reference/)
    assert.throws(() => expectedPublication({ root }, { discoverCohorts: () => [], renderDashboard: () => 'unused' }), /ENOENT|hash mismatch|publication|measurement reference/)
  })
}

test('experiment publication leaves every benchmark metric and canonical mapping unchanged', (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-without-experiments-'))
  const root = path.join(repository, 'bench')
  fs.mkdirSync(root)
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }))
  fs.cpSync(path.join(ROOT, '../.agents/skills/code-review-ad'), path.join(repository, '.agents/skills/code-review-ad'), { recursive: true })
  for (const name of ['models.json', 'state.json', 'tools.json', 'issue-identities.json', 'runs', 'results', 'findings', 'judgement', 'groundtruth', 'gold', 'cost-estimates']) {
    fs.cpSync(path.join(ROOT, name), path.join(root, name), { recursive: true })
  }
  const before = dashboard.loadArtifacts(root)
  const after = dashboard.loadArtifacts(ROOT)
  assert.deepEqual(after.runs, before.runs)
  assert.deepEqual(after.issues, before.issues)
  assert.deepEqual(after.identityIssues, before.identityIssues)
  assert.deepEqual(after.modelComparison, before.modelComparison)
  assert.ok(after.runs.every((r) => r.platform === (after.cohorts.find((cohort) => cohort.id === r.cohortId).platform || 'claude') && r.skillId === `${r.platform}:${r.toolId}`))
  assert.deepEqual(after.tools.filter((tool) => tool.id === 'code-review-ad').map((tool) => tool.skillId).sort(), ['claude:code-review-ad', 'codex:code-review-ad'])
})

test('aggregation separates equal skill names and equal models on different platforms', () => {
  const runs = ['claude', 'codex'].map((platform) => ({
    toolId: 'same-name', platform, skillId: `${platform}:same-name`, modelId: 'same-model',
    toolLabel: `same-name · ${platform}`, status: 'complete', usage: { costUsd: 2, models: {} },
    issues: [], targetId: 'target',
  }))
  const groups = calculateSkillModelGroups(runs, {}, {
    eligibleTargets: () => ['target'], issueUniverse: () => new Set(), issueKey: () => '',
    testedModel: () => 'same-model', total: (rows, getter) => rows.reduce((sum, row) => sum + getter(row), 0),
  })
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((g) => g.cost), [2, 2])
})

test('publisher checks the experiment summary and both dashboard exports', (t) => {
  const root = fixture(t)
  const docs = path.join(root, 'docs')
  const dependencies = { discoverCohorts: () => [], renderDashboard: () => 'dashboard' }
  publish('write', { root, docs }, dependencies)
  assert.equal(publish('check', { root, docs }, dependencies).ok, true)
  for (const name of ['review-skill-experiments.md', 'index.html', 'run-explorer.html']) {
    const file = path.join(docs, name)
    fs.appendFileSync(file, 'stale')
    const check = publish('check', { root, docs }, dependencies)
    assert.equal(check.ok, false)
    assert.ok(check.changed.some((entry) => entry.file === file))
    publish('write', { root, docs }, dependencies)
  }
})
