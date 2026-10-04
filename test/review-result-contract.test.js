'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const artifacts = require('../bench/lib/artifacts')
const codexContract = require('../lib/review-codex-contract')

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

function candidate(overrides = {}) {
  return {
    candidateId: 'C1',
    claimHash: 'a'.repeat(64),
    originInvocationId: null,
    judgeInvocationId: 'judge-1',
    verdict: 'real',
    finalDisposition: 'confirmed',
    ...overrides,
  }
}

function v2Contract(overrides = {}) {
  return {
    ...completeContract({
      schemaVersion: 2,
      findings: { provisional: 1, confirmed: 1, rejected: 0, unresolved: 0 },
    }),
    candidateLedger: [candidate()],
    newLeadResolutions: [],
    codex: {
      provider: 'openai', model: 'gpt-5.6-sol', reasoningEffort: 'high',
      cliVersion: '0.149.0', receiptSha256: 'f'.repeat(64),
    },
    ...overrides,
  }
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

test('benchmark dispatches frozen v1 and v2 contracts without version drift', () => {
  const v1 = completeContract()
  const v2 = v2Contract()
  assert.equal(artifacts.REVIEW_AND_FIX_PR_CONTRACT_V1, 'review-and-fix-pr-v1')
  assert.equal(artifacts.REVIEW_AND_FIX_PR_CONTRACT_V2, 'review-and-fix-pr-v2')
  assert.equal(artifacts.reviewAndFixPrContractForTool({
    toolConfig: { tools: [{ id: 'review-and-fix-pr' }] },
  }, 'review-and-fix-pr'), artifacts.REVIEW_AND_FIX_PR_CONTRACT_V1)
  assert.deepEqual(artifacts.parseReviewAndFixPrResultContract(
    finalResult(v1), artifacts.REVIEW_AND_FIX_PR_CONTRACT_V1,
  ), v1)
  assert.deepEqual(artifacts.parseReviewAndFixPrResultContract(
    finalResult(v2), artifacts.REVIEW_AND_FIX_PR_CONTRACT_V2,
  ), v2)
  assert.throws(() => artifacts.parseReviewAndFixPrResultContract(
    finalResult(v1), artifacts.REVIEW_AND_FIX_PR_CONTRACT_V2,
  ), /schemaVersion must be 2/)
  assert.throws(() => artifacts.parseReviewAndFixPrResultContract(
    finalResult(v2), artifacts.REVIEW_AND_FIX_PR_CONTRACT_V1,
  ), /schemaVersion must be 1/)
})

test('v2 closure rejects an omitted admitted lead and accepts fixed-point closure', () => {
  const discovered = candidate()
  const admitted = candidate({
    candidateId: 'C2', claimHash: 'b'.repeat(64), originInvocationId: 'judge-1',
    judgeInvocationId: 'judge-2', verdict: 'false_positive', finalDisposition: 'rejected',
  })
  const attempt0002 = v2Contract({
    candidateLedger: [discovered, admitted],
    findings: { provisional: 2, confirmed: 1, rejected: 1, unresolved: 0 },
  })
  assert.throws(() => artifacts.validateReviewAndFixPrContract(
    attempt0002, artifacts.REVIEW_AND_FIX_PR_CONTRACT_V2,
  ), /requires exactly one admitted new lead/)

  const attempt0003 = {
    ...attempt0002,
    newLeadResolutions: [{
      leadId: 'L1', claimHash: admitted.claimHash, originInvocationId: 'judge-1',
      resolution: 'admitted', candidateId: 'C2',
    }],
  }
  assert.deepEqual(artifacts.validateReviewAndFixPrContract(
    attempt0003, artifacts.REVIEW_AND_FIX_PR_CONTRACT_V2,
  ), attempt0003)
})

test('v2 closure preserves duplicate mappings and prohibits self-judgment', () => {
  const duplicate = v2Contract({
    newLeadResolutions: [{
      leadId: 'L1', claimHash: 'c'.repeat(64), originInvocationId: 'judge-1',
      resolution: 'duplicate', candidateId: 'C1',
    }],
  })
  assert.deepEqual(artifacts.validateReviewAndFixPrContract(
    duplicate, artifacts.REVIEW_AND_FIX_PR_CONTRACT_V2,
  ), duplicate)
  assert.throws(() => artifacts.validateReviewAndFixPrContract(v2Contract({
    candidateLedger: [candidate({ originInvocationId: 'judge-1' })],
  }), artifacts.REVIEW_AND_FIX_PR_CONTRACT_V2), /cannot be judged by its originating invocation/)
})

test('v2 closure rejects count drift and compound candidates', () => {
  assert.throws(() => artifacts.validateReviewAndFixPrContract(v2Contract({
    findings: { provisional: 2, confirmed: 1, rejected: 1, unresolved: 0 },
  }), artifacts.REVIEW_AND_FIX_PR_CONTRACT_V2), /counts do not match/)
  assert.throws(() => codexContract.normalizeCandidate({
    id: 'C1', claim: 'Two defects.', basisType: 'claim', basis: 'Source inspection.',
    mechanisms: ['first mechanism', 'second mechanism'], consequence: 'Two independent failures.',
    defectClass: 'compound',
    category: 'correctness', locations: [{ path: 'src/a.cc', line: 1 }],
    evidence: [{ path: 'src/a.cc', line: 1, detail: 'Evidence.' }], sourceIds: ['lane-1'],
  }), /exactly one atomic mechanism/)
  assert.throws(() => artifacts.validateReviewAndFixPrContract(v2Contract({
    codex: { ...v2Contract().codex, cliVersion: '0.148.9' },
  }), artifacts.REVIEW_AND_FIX_PR_CONTRACT_V2), /Codex identity is invalid/)
})

test('candidate hashes normalize whitespace while duplicate mechanisms retain their basis', () => {
  const base = {
    id: 'C1', claim: 'The branch returns the wrong value.', basisType: 'trigger',
    basis: 'Calling changed() reaches the branch.', mechanisms: ['The branch returns false.'],
    consequence: 'Callers observe the wrong result.', category: 'correctness',
    defectClass: 'wrong-return-value',
    locations: [{ path: 'src/a.cc', line: 1 }],
    evidence: [{ path: 'src/a.cc', line: 1, detail: 'The return is false.' }], sourceIds: ['lane-1'],
  }
  const spaced = { ...base, claim: '  The branch   returns the wrong value.  ' }
  assert.equal(codexContract.candidateClaimHash(base), codexContract.candidateClaimHash(spaced))
  assert.equal(codexContract.sameMechanism(base, { ...base, basis: 'A different reachable trigger.' }), false)
  assert.equal(codexContract.sameMechanism(base, { ...base, category: 'maintainability' }), true)
  for (const unsafe of ['/etc/passwd', '../src/a.cc', 'src/../a.cc', 'C:\\src\\a.cc']) {
    assert.throws(() => codexContract.normalizeCandidate({
      ...base,
      locations: [{ path: unsafe, line: 1 }],
    }), /safe repository-relative/i)
  }
})

test('extracted findings cannot publish reserved result or receipt rows', () => {
  const finding = {
    title: 'Claim', file: 'src/a.cc', line: 1, severity: 'low', kind: 'docs',
    claim: 'The comment is stale.',
  }
  assert.doesNotThrow(() => artifacts.validateFinding(finding))
  for (const prefix of ['REVIEW_AND_FIX_PR_RESULT_JSON=', 'REVIEW_AND_FIX_PR_CODEX_RECEIPT_JSON=']) {
    for (const field of ['title', 'file', 'claim']) {
      assert.throws(() => artifacts.validateFinding({ ...finding, [field]: `${finding[field]} ${prefix}{}` }),
        /reserved machine receipt text/)
    }
  }
})
