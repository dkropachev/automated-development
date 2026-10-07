'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const runner = require('../bin/review-and-fix-pr-codex')
const contract = require('../lib/review-codex-contract')
const { validateReviewAndFixPrContract } = require('../bench/lib/artifacts')
const { structuredV3Findings } = require('../bench/extract')
const { eligibleForCohortJudge } = require('../bench/judge')

const evidence = [{ path: 'src/a.js', line: 7, detail: 'same condition is checked twice' }]
function judgment(id, verdict, suggestedEdit, suggestedConsequence) {
  return { candidateId: id, verdict, severity: 'low', scope: 'in', reason: 'Checked exact source',
    sourceEvidence: evidence, suggestedEdit, suggestedConsequence }
}
function output() {
  return { schemaVersion: 2, provider: 'OpenAI Codex', model: contract.JUDGE_MODEL,
    judgments: [judgment('C1', 'real', 'add a regression assertion', 'the test catches the bug'),
      judgment('C2', 'suggestion', 'edit the second guard', 'the first guard can drift'),
      judgment('C3', 'false_positive', null, null)], newCandidates: [] }
}
function receipt() {
  const atom = { id: 'C1', claim: 'The assertion accepts the wrong result', basisType: 'trigger',
    basis: 'test returns normally', mechanisms: ['missing assertion'], consequence: 'regression escapes',
    defectClass: 'test-gap', category: 'tests', locations: [{ path: 'src/a.js', line: 7 }], evidence }
  const candidate = {
    id: atom.id, claim: atom.claim, basisType: atom.basisType, basis: atom.basis,
    mechanism: atom.mechanisms[0], consequence: atom.consequence, defectClass: atom.defectClass,
    category: atom.category, locations: atom.locations, evidence: atom.evidence,
    claimHash: contract.candidateClaimHash(atom), originInvocationId: null,
    judgmentInvocationId: 'J1', verdict: 'real', severity: 'low', scope: 'in',
    reason: 'confirmed against assertion', sourceEvidence: evidence, finalDisposition: 'confirmed',
    suggestedEdit: 'assert returned error', suggestedConsequence: 'test catches a normal return',
  }
  const suggested = { ...candidate, id: 'C2', claim: 'Duplicate guard may drift',
    mechanism: 'duplicated guard', consequence: 'future edit may miss one',
    verdict: 'suggestion', finalDisposition: 'suggestion',
    suggestedEdit: 'edit second guard', suggestedConsequence: 'first guard may drift' }
  suggested.claimHash = contract.candidateClaimHash({ ...atom, id: suggested.id,
    claim: suggested.claim, mechanisms: [suggested.mechanism], consequence: suggested.consequence })
  const rejected = { ...candidate, id: 'C3', claim: 'Disproved concern',
    mechanism: 'disproved mechanism', consequence: 'no effect',
    verdict: 'false_positive', finalDisposition: 'rejected', suggestedEdit: null, suggestedConsequence: null }
  rejected.claimHash = contract.candidateClaimHash({ ...atom, id: rejected.id,
    claim: rejected.claim, mechanisms: [rejected.mechanism], consequence: rejected.consequence })
  return { schemaVersion: 2, contract: contract.CONTRACT_V3, status: 'complete',
    sourceDisclosure: { discovery: 'Anthropic Claude', adjudication: 'OpenAI Codex' },
    inputSha256: '1'.repeat(64), target: { repository: 'example/repo',
      baseSha: '2'.repeat(40), headSha: '3'.repeat(40) }, pluginFingerprint: null,
    judge: { provider: 'OpenAI Codex', model: contract.JUDGE_MODEL, reasoningEffort: 'high',
      cliVersion: '0.156.0', executableSha256: '4'.repeat(64), authenticated: true,
      schemaSha256: '5'.repeat(64) },
    invocations: [{ id: 'J1', sequence: 1, candidateIds: ['C1', 'C2', 'C3'], model: contract.JUDGE_MODEL,
      traceSha256: '6'.repeat(64), resultSha256: '7'.repeat(64), promptSha256: '8'.repeat(64),
      newLeadHashes: [], usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0,
        outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 14 },
      writeAttempted: false, webAttempted: false }],
    candidates: [candidate, suggested, rejected], newLeadResolutions: [], pendingCandidateIds: [],
    counts: { provisional: 3, confirmed: 1, suggestion: 1, rejected: 1, unresolved: 0 },
    createdAt: '2026-10-07T00:00:00.000Z' }
}

test('v3 accepts proposed edits on real findings and requires edit consequences on suggestions', () => {
  const source = output()
  assert.deepEqual(runner.validateJudgeOutput(source, ['C1', 'C2', 'C3'], contract.CONTRACT_V3)
    .judgments.map((row) => row.verdict), ['real', 'suggestion', 'false_positive'])
  assert.throws(() => runner.validateJudgeOutput(source, ['C1', 'C2', 'C3'], contract.CONTRACT_V2))
  const altered = JSON.parse(JSON.stringify(source))
  altered.judgments[1].suggestedConsequence = null
  assert.throws(() => runner.validateJudgeOutput(altered, ['C1', 'C2', 'C3'], contract.CONTRACT_V3), /suggestedConsequence/)
})

test('v3 receipt and marker bind the suggestion partition and reject tampering', () => {
  const source = receipt()
  const normalized = contract.validateReceipt(source)
  const binding = contract.receiptResultBinding(normalized)
  assert.equal(binding.findings.suggestion, 1)
  const marker = { schemaVersion: 3, coverage: 'complete', verification: 'complete', fix: 'not-requested',
    stopTrigger: 'none', stopReason: 'completed', fixRequested: false,
    completedLenses: ['correctness', 'spec', 'standards', 'security', 'reliability', 'contracts',
      'testing', 'performance', 'comments', 'maintainability'], skippedLenses: [], failedLenses: [],
    coverageGapCount: 0, ...binding }
  assert.equal(validateReviewAndFixPrContract(marker, contract.CONTRACT_V3).findings.suggestion, 1)
  assert.throws(() => contract.validateReceipt({ ...source, counts: { ...source.counts, confirmed: 2 } }))
  assert.throws(() => validateReviewAndFixPrContract({ ...marker,
    findings: { ...marker.findings, confirmed: 2 } }, contract.CONTRACT_V3))
})

test('structured extraction excludes rejected prose and prevents suggestions from entering cohort judging', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rafp-v3-extract-'))
  try {
    const source = receipt()
    const runId = 'fixture-v3', receiptId = 'fixture'
    const dir = path.join(root, 'work', 'codex-receipts', runId, 'sample', 'review-and-fix-pr')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${receiptId}.json`), JSON.stringify(source))
    const manifest = { runId, targetMetadata: { sample: { fork: source.target.repository } },
      targets: { sample: { baseSha: source.target.baseSha, headSha: source.target.headSha } },
      pluginFingerprint: null, codexJudge: { schemaSha256: source.judge.schemaSha256 } }
    const result = { codexReceiptId: receiptId,
      resultContract: { codex: { receiptSha256: contract.hashReceipt(source) } } }
    const findings = structuredV3Findings(result, root, manifest, 'sample', 'review-and-fix-pr')
    assert.deepEqual(findings.map((finding) => finding.reviewDisposition), ['confirmed', 'suggestion'])
    assert.equal(findings.filter(eligibleForCohortJudge).length, 1)
    result.resultContract.codex.receiptSha256 = '0'.repeat(64)
    assert.throws(() => structuredV3Findings(result, root, manifest, 'sample', 'review-and-fix-pr'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
