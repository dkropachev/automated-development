'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const artifacts = require('../bench/lib/artifacts')
const runner = require('../bench/run')

const ROOT = path.join(__dirname, '..', 'bench')

test('fresh Fable cohort scope is exactly the 19 active cells', () => {
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8'))
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.json'), 'utf8'))
  const runId = 'fable-5-1-scope-test'
  const options = runner.parseArgs([
    '--model', 'claude-fable-5-1', '--run', runId, '--concurrency', '1',
  ], ROOT)
  const cells = runner.expectedCellsForFreshCohort(
    ROOT,
    options,
    artifacts.cohortPaths(ROOT, runId),
    state,
    config,
  )

  assert.equal(cells.length, 19)
  assert.equal(cells.some((cell) => cell.target === 'ironweave' && cell.tool === 'tob-c-review'), false)
  assert.deepEqual(
    cells.filter((cell) => cell.tool === 'tob-rust-review').map((cell) => cell.target),
    ['quillstone'],
  )
  for (const target of ['ironweave', 'quillstone', 'tidepool']) {
    assert.equal(cells.filter((cell) => cell.target === target).length, target === 'quillstone' ? 7 : 6)
  }
})

test('Fable execution cannot opt parked cells back into its cohort', () => {
  assert.throws(() => runner.parseArgs([
    '--model', 'claude-fable-5-1',
    '--run', 'fable-with-parked',
    '--concurrency', '1',
    '--include-parked',
  ], ROOT), /excludes parked benchmark cells/)
})
