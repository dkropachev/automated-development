'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const artifacts = require('../bench/lib/artifacts')

const MARKER = 'REVIEW_AND_FIX_PR_RESULT_JSON='

function completeContract(overrides = {}) {
  return {
    schemaVersion: 1,
    coverage: 'complete',
    verification: 'complete',
    fix: 'not-requested',
    stopTrigger: 'none',
    stopReason: 'completed',
    fixRequested: false,
    completedLenses: [...artifacts.REVIEW_AND_FIX_PR_MANDATORY_LENSES],
    skippedLenses: [],
    failedLenses: [],
    coverageGapCount: 0,
    findings: { provisional: 3, confirmed: 2, rejected: 1, unresolved: 0 },
    ...overrides,
  }
}

function finalResult(contract = completeContract(), report = 'Review report') {
  return `${report}\n\n${MARKER}${JSON.stringify(contract)}`
}

test('benchmark validates the complete stateless review-only v1 contract', () => {
  const contract = completeContract()

  assert.equal(artifacts.REVIEW_AND_FIX_PR_CONTRACT, 'review-and-fix-pr-v1')
  assert.deepEqual(artifacts.validateReviewAndFixPrContract(contract), contract)
  assert.deepEqual(artifacts.parseReviewAndFixPrResultContract(finalResult(contract)), contract)
  assert.deepEqual(Object.keys(contract.findings), ['provisional', 'confirmed', 'rejected', 'unresolved'])
})

test('benchmark parser requires exactly one marker as the final nonempty line', () => {
  const contract = completeContract()
  const marker = `${MARKER}${JSON.stringify(contract)}`

  assert.deepEqual(
    artifacts.parseReviewAndFixPrResultContract(`Human-readable findings\r\n\r\n${marker}\r\n`),
    contract,
  )
  assert.throws(
    () => artifacts.parseReviewAndFixPrResultContract('Human-readable findings only'),
    /requires exactly one/,
  )
  assert.throws(
    () => artifacts.parseReviewAndFixPrResultContract(`${marker}\n${marker}`),
    /requires exactly one/,
  )
  assert.throws(
    () => artifacts.parseReviewAndFixPrResultContract(`${marker}\ntext after the contract`),
    /must be the final nonempty line/,
  )
  assert.throws(
    () => artifacts.parseReviewAndFixPrResultContract(`${MARKER}{not-json}`),
    /JSON is invalid/,
  )
})

test('benchmark rejects partial, fixing, skipped, failed, and gapped review results', () => {
  const invalid = [
    [completeContract({ coverage: 'partial' }), /coverage must be "complete"/],
    [completeContract({ verification: 'incomplete' }), /verification must be "complete"/],
    [completeContract({ fix: 'complete' }), /fix must be "not-requested"/],
    [completeContract({ fixRequested: true }), /fixRequested must be false/],
    [completeContract({ skippedLenses: ['testing'] }), /skipped or failed lenses/],
    [completeContract({ failedLenses: ['contracts'] }), /skipped or failed lenses/],
    [completeContract({ coverageGapCount: 1 }), /coverageGapCount must be 0/],
  ]

  for (const [contract, expected] of invalid) {
    assert.throws(() => artifacts.parseReviewAndFixPrResultContract(finalResult(contract)), expected)
  }
})

test('benchmark requires every stable methodology ID exactly once', () => {
  const lenses = [...artifacts.REVIEW_AND_FIX_PR_MANDATORY_LENSES]
  assert.ok(lenses.length > 0)

  assert.throws(
    () => artifacts.validateReviewAndFixPrContract(completeContract({ completedLenses: lenses.slice(1) })),
    /missing mandatory lenses/,
  )
  assert.throws(
    () => artifacts.validateReviewAndFixPrContract(completeContract({ completedLenses: [...lenses, lenses[0]] })),
    /must be unique/,
  )
  assert.throws(
    () => artifacts.validateReviewAndFixPrContract(completeContract({ completedLenses: [...lenses, 'optional-specialist'] })),
    /unknown methodology IDs/,
  )
})

test('benchmark rejects schema drift and invalid finding counts', () => {
  assert.throws(
    () => artifacts.validateReviewAndFixPrContract({ ...completeContract(), extra: true }),
    /fields are invalid/,
  )
  assert.throws(
    () => artifacts.validateReviewAndFixPrContract(completeContract({
      findings: { provisional: 1, confirmed: -1, rejected: 1, unresolved: 0 },
    })),
    /findings are invalid/,
  )
  assert.throws(
    () => artifacts.validateReviewAndFixPrContract(completeContract({
      findings: { provisional: 3, confirmed: 1, rejected: 1, unresolved: 0 },
    })),
    /do not partition/,
  )
})
