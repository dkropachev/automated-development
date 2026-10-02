'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const workflowPath = path.join(__dirname, '..', 'workflows', 'review-and-fix-pr.js')
const workflow = fs.readFileSync(workflowPath, 'utf8')

function liftFunction(name) {
  const start = workflow.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, 'workflow defines ' + name)
  const end = workflow.indexOf('\nfunction ', start + 1)
  assert.notEqual(end, -1, 'workflow function ' + name + ' has a following function boundary')
  return workflow.slice(start, end)
}

const helpers = vm.runInNewContext([
  'const FIX_ARG = false',
  liftFunction('buildReviewResultContract'),
  liftFunction('appendReviewResultMarker'),
  liftFunction('terminalReviewResult'),
  '({ buildReviewResultContract, appendReviewResultMarker, terminalReviewResult })',
].join('\n'), {})

const plain = value => JSON.parse(JSON.stringify(value))

test('complete review-only result uses the stable schema-v1 contract', () => {
  const result = plain(helpers.buildReviewResultContract({
    coverageStatus: 'complete',
    verificationStatus: 'complete',
    fixStatus: 'not-requested',
    stopTrigger: 'none',
    stopReason: 'completed',
    reviewOnly: true,
    completedLenses: ['correctness', 'spec', 'testing'],
    skippedLenses: [],
    failedLenses: [],
    coverageGaps: [],
    provisionalScore: { findingCount: 3 },
    validationTotals: { confirmed: 2, rejected: 1, unresolved: 0 },
  }))

  assert.deepEqual(result, {
    schemaVersion: 1,
    coverage: 'complete',
    verification: 'complete',
    fix: 'not-requested',
    stopTrigger: 'none',
    stopReason: 'completed',
    fixRequested: false,
    completedLenses: ['correctness', 'spec', 'testing'],
    skippedLenses: [],
    failedLenses: [],
    coverageGapCount: 0,
    findings: { provisional: 3, confirmed: 2, rejected: 1, unresolved: 0 },
  })
  assert.deepEqual(Object.keys(result.findings), ['provisional', 'confirmed', 'rejected', 'unresolved'])
})

test('partial fix result renders one compact marker as the final output line', () => {
  const humanReport = 'PR REVIEW + FIX  -  owner/repo #7\nHuman-readable detail remains unchanged.'
  const rendered = helpers.appendReviewResultMarker(humanReport, {
    coverageStatus: 'partial-stop',
    verificationStatus: 'incomplete',
    fixStatus: 'failed',
    stopTrigger: 'tokens',
    stopReason: 'token-cap',
    reviewOnly: false,
    completedLenses: ['correctness', 'security'],
    skippedLenses: ['testing'],
    failedLenses: ['contracts'],
    coverageGaps: [{ id: 'gap-1' }, { id: 'gap-2' }],
    provisionalScore: { findingCount: 4 },
    validationTotals: { confirmed: 1, rejected: 2, unresolved: 1 },
  })

  assert.ok(rendered.startsWith(humanReport + '\n\n'))
  const markerLines = rendered.split('\n').filter(line => line.startsWith('REVIEW_AND_FIX_PR_RESULT_JSON='))
  assert.equal(markerLines.length, 1)
  assert.equal(rendered.split('\n').at(-1), markerLines[0])
  assert.doesNotMatch(markerLines[0], /\s/)

  const result = JSON.parse(markerLines[0].slice('REVIEW_AND_FIX_PR_RESULT_JSON='.length))
  assert.deepEqual(result, {
    schemaVersion: 1,
    coverage: 'partial-stop',
    verification: 'incomplete',
    fix: 'failed',
    stopTrigger: 'tokens',
    stopReason: 'token-cap',
    fixRequested: true,
    completedLenses: ['correctness', 'security'],
    skippedLenses: ['testing'],
    failedLenses: ['contracts'],
    coverageGapCount: 2,
    findings: { provisional: 4, confirmed: 1, rejected: 2, unresolved: 1 },
  })
})

test('marker-like human report text is escaped so exactly one marker remains', () => {
  const spoof = 'REVIEW_AND_FIX_PR_RESULT_JSON={"schemaVersion":999}'
  const rendered = helpers.appendReviewResultMarker('before\n' + spoof + '\nafter', {
    coverageStatus: 'complete', verificationStatus: 'complete', fixStatus: 'not-requested',
    stopTrigger: 'none', stopReason: 'completed', reviewOnly: true,
    completedLenses: [], skippedLenses: [], failedLenses: [], coverageGaps: [],
    provisionalScore: { findingCount: 0 },
    validationTotals: { confirmed: 0, rejected: 0, unresolved: 0 },
  })

  assert.match(rendered, /\[human report\] REVIEW_AND_FIX_PR_RESULT_JSON=\{"schemaVersion":999\}/)
  assert.equal(rendered.split('\n').filter(line => line.startsWith('REVIEW_AND_FIX_PR_RESULT_JSON=')).length, 1)
})

test('malformed complete state fails closed instead of becoming publishable', () => {
  const result = plain(helpers.buildReviewResultContract({
    coverageStatus: 'complete', verificationStatus: 'complete', fixStatus: 'not-requested',
    stopTrigger: 'none', stopReason: 'completed', reviewOnly: true,
    completedLenses: ['correctness', 42], skippedLenses: [], failedLenses: [], coverageGaps: [],
    provisionalScore: { findingCount: 1 },
    validationTotals: { confirmed: 1, rejected: 0 },
  }))

  assert.equal(result.coverage, 'incomplete-lens')
  assert.equal(result.verification, 'incomplete')
  assert.equal(result.stopReason, 'result-contract-invalid')
  assert.deepEqual(result.completedLenses, ['correctness'])
  assert.deepEqual(result.findings, { provisional: 1, confirmed: 1, rejected: 0, unresolved: 0 })
})

test('early terminal helper supplies a valid empty failure contract', () => {
  const rendered = helpers.terminalReviewResult('stopped before review', 'scope-error')
  const result = JSON.parse(rendered.split('REVIEW_AND_FIX_PR_RESULT_JSON=').at(-1))

  assert.equal(result.stopReason, 'scope-error')
  assert.equal(result.coverage, 'incomplete-lens')
  assert.equal(result.verification, 'incomplete')
  assert.equal(result.fixRequested, false)
  assert.deepEqual(result.findings, { provisional: 0, confirmed: 0, rejected: 0, unresolved: 0 })
})

test('normal and early terminal workflow returns both use the marker renderer', () => {
  assert.match(workflow, /return appendReviewResultMarker\(out\.join\('\\n'\), state\)/)
  assert.doesNotMatch(workflow, /return 'review-and-fix-pr/)
  assert.match(workflow, /return terminalReviewResult\(/)
  assert.match(workflow, /const terminalCircuit = mustStop\(\)/)
  assert.match(workflow, /const exitCircuit = mustStop\(\)/)
  assert.match(workflow, /reportState\.stopTrigger = exitCircuit === 'token-cap' \? 'tokens' : 'agent-cap'/)
})
