'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const publish = require('../bench/publish')

const REPO = path.join(__dirname, '..')
const BENCH = path.join(REPO, 'bench')
const RUNS = path.join(BENCH, 'runs')

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

test('discovers every tracked complete modern cohort and hash-verifies it', () => {
  const markerIds = fs.readdirSync(RUNS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(RUNS, entry.name, 'complete.json')))
    .map((entry) => entry.name)
    .sort()
  const cohorts = publish.discoverCompletedCohorts(BENCH)

  assert.ok(markerIds.length > 0)
  assert.deepEqual(cohorts.map((cohort) => cohort.runId), markerIds)
  for (const cohort of cohorts) {
    assert.equal(cohort.legacy, false)
    assert.equal(cohort.snapshot.manifest.runId, cohort.runId)
    assert.equal(cohort.snapshot.complete.runId, cohort.runId)
  }
})

test('ignores a valid modern manifest until it has a complete marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-publish-incomplete-'))
  try {
    fs.copyFileSync(path.join(BENCH, 'models.json'), path.join(root, 'models.json'))
    const source = JSON.parse(fs.readFileSync(path.join(RUNS, 'sonnet-5-5-2026-09-30', 'manifest.json'), 'utf8'))
    source.runId = 'incomplete-fixture'
    source.expectedCells = source.expectedCells.map((cell) => ({
      ...cell,
      id: `incomplete-fixture/${cell.target}/${cell.tool}`,
    }))
    writeJson(path.join(root, 'runs', source.runId, 'manifest.json'), source)

    assert.deepEqual(publish.discoverCompletedCohorts(root), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('propagates corruption from a cohort that claims to be complete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-publish-corrupt-'))
  const runId = 'sonnet-5-5-2026-09-30'
  try {
    fs.copyFileSync(path.join(BENCH, 'models.json'), path.join(root, 'models.json'))
    fs.cpSync(path.join(RUNS, runId), path.join(root, 'runs', runId), { recursive: true })
    fs.appendFileSync(path.join(root, 'runs', runId, 'results', 'tidepool', 'builtin-code-review.json'), '\n')

    assert.throws(() => publish.discoverCompletedCohorts(root), /changed|hash mismatch/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('expected publication has one report per completed cohort and both dashboard aliases', () => {
  const completeFile = path.join('/fixture', 'runs', 'complete-one', 'complete.json')
  const expected = publish.expectedPublication({ root: '/fixture', docs: '/site' }, {
    discoverCohorts: () => [
      { runId: 'legacy', legacy: true, paths: { complete: null } },
      { runId: 'in-progress', legacy: false, paths: { complete: '/missing/complete.json' } },
      { runId: 'complete-one', legacy: false, paths: { complete: completeFile } },
    ],
    existsSync: (file) => file === completeFile,
    readComplete: (_root, runId) => ({ manifest: { runId }, complete: { runId } }),
    renderReport: (_root, runId) => `report for ${runId}\n`,
    renderDashboard: () => '<html>dashboard</html>\n',
  })

  assert.deepEqual(expected.cohorts.map((cohort) => cohort.runId), ['complete-one'])
  assert.deepEqual(expected.files.map((entry) => path.basename(entry.file)), [
    'review-bakeoff-complete-one.md', 'index.html', 'run-explorer.html',
  ])
  assert.equal(expected.files[1].content, expected.files[2].content)
})

test('inspection catches missing and stale exports and atomic writes make them current', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-publish-write-'))
  const docs = path.join(root, 'docs')
  const expected = [
    { file: path.join(docs, 'review-bakeoff-new-cohort.md'), content: 'report\n', kind: 'cohort-report', runId: 'new-cohort' },
    { file: path.join(docs, 'index.html'), content: 'dashboard\n', kind: 'dashboard' },
    { file: path.join(docs, 'run-explorer.html'), content: 'dashboard\n', kind: 'dashboard-alias' },
  ]
  try {
    publish.atomicWrite(expected[1].file, expected[1].content)
    publish.atomicWrite(expected[2].file, 'old dashboard\n')
    assert.deepEqual(publish.inspectPublication(expected).map((entry) => entry.status), [
      'missing', 'current', 'stale',
    ])
    for (const entry of expected) publish.atomicWrite(entry.file, entry.content)
    assert.deepEqual(publish.inspectPublication(expected).map((entry) => entry.status), [
      'current', 'current', 'current',
    ])
    assert.equal(fs.readdirSync(docs).some((file) => file.includes('.tmp-')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('check detects and write removes orphaned generated cohort reports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-publish-orphan-'))
  const docs = path.join(root, 'docs')
  const completeFile = path.join(root, 'runs', 'current', 'complete.json')
  const orphan = path.join(docs, 'review-bakeoff-removed.md')
  const unrelated = path.join(docs, 'review-bakeoff-model-notes.md')
  const dependencies = {
    discoverCohorts: () => [{ runId: 'current', legacy: false, paths: { complete: completeFile } }],
    readComplete: () => ({ manifest: { runId: 'current' }, complete: { runId: 'current' } }),
    renderReport: () => 'current report\n',
    renderDashboard: () => '<html>current</html>\n',
  }
  try {
    writeJson(completeFile, {})
    fs.mkdirSync(docs, { recursive: true })
    fs.writeFileSync(orphan, '**Cohort:** `removed`\n')
    fs.writeFileSync(unrelated, '# Hand-written model notes\n')
    let result = publish.publish('write', { root, docs }, dependencies)
    assert.ok(result.changed.some((entry) => entry.file === orphan && entry.status === 'orphan'))
    assert.equal(fs.existsSync(orphan), false)
    assert.equal(fs.existsSync(unrelated), true)
    result = publish.publish('check', { root, docs }, dependencies)
    assert.equal(result.ok, true)
    fs.writeFileSync(orphan, '**Cohort:** `removed`\n')
    result = publish.publish('check', { root, docs }, dependencies)
    assert.equal(result.ok, false)
    assert.ok(result.changed.some((entry) => entry.file === orphan && entry.status === 'orphan'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checked-in reports and both Pages exports match all complete cohorts', () => {
  const result = spawnSync(process.execPath, [path.join(BENCH, 'publish.js'), '--check'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /complete cohorts, \d+ publication files current/)
})
