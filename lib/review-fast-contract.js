'use strict'

const { PASS_IDS, assemblePasses } = require('./review-fast')
const { applyGroups, normalizeGroups } = require('./review-fast-cluster')
const { candidateClaimHash, canonical, sha256 } = require('./review-codex-contract')

const HASH = /^[0-9a-f]{64}$/
function equal(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)) }

function validatePassReceipt(receipt, expected = {}) {
  if (!receipt || receipt.schemaVersion !== 1 || !Array.isArray(receipt.passes) ||
      receipt.passes.length !== PASS_IDS.length || !receipt.target ||
      typeof receipt.model !== 'string' || !receipt.model || !receipt.cluster) {
    throw new Error('six-pass receipt is incomplete')
  }
  if (expected.target && !equal(receipt.target, expected.target)) throw new Error('six-pass target changed')
  if (expected.model && receipt.model !== expected.model) throw new Error('six-pass model changed')
  const seen = new Set()
  for (const [index, pass] of receipt.passes.entries()) {
    if (pass.id !== PASS_IDS[index] || pass.sourceId !== `P${index + 1}` ||
        pass.model !== receipt.model || !Array.isArray(pass.findings) ||
        typeof pass.coverage !== 'string' || !pass.coverage.trim() ||
        !Number.isFinite(pass.costUsd) || pass.costUsd < 0 ||
        !Number.isSafeInteger(pass.wallMs) || pass.wallMs < 0 ||
        !HASH.test(pass.resultSha256 || '') || !pass.reportedUsage) {
      throw new Error(`six-pass receipt ${PASS_IDS[index]} is invalid`)
    }
    const original = { coverage: pass.coverage,
      findings: pass.findings.map(({ id, sourceIds, ...finding }) => {
        if (seen.has(id) || !sourceIds || sourceIds.length !== 1 ||
            sourceIds[0] !== pass.sourceId) throw new Error('six-pass candidate provenance is invalid')
        seen.add(id)
        return finding
      }) }
    if (sha256(original) !== pass.resultSha256) throw new Error(`six-pass ${pass.id} output hash changed`)
    for (const finding of pass.findings) {
      if (!HASH.test(candidateClaimHash(finding))) throw new Error('six-pass candidate hash is invalid')
    }
  }
  const raw = assemblePasses(receipt.passes, {}, receipt.target, null)
  const cluster = receipt.cluster
  if (cluster.model !== 'gpt-5.6-sol' || !cluster.usage ||
      !Number.isSafeInteger(cluster.usage.totalTokens) || cluster.usage.totalTokens <= 0 ||
      !HASH.test(cluster.promptSha256 || '') || !HASH.test(cluster.traceSha256 || '') ||
      !HASH.test(cluster.resultSha256 || '') || typeof cluster.invocationId !== 'string' ||
      !cluster.invocationId || (cluster.rawResultSha256 !== undefined &&
        !HASH.test(cluster.rawResultSha256))) throw new Error('six-pass cluster proof is invalid')
  normalizeGroups({ groups: cluster.groups }, raw.input.candidates)
  if (sha256({ groups: cluster.groups }) !== cluster.resultSha256) {
    throw new Error('six-pass cluster output hash changed')
  }
  const assembled = applyGroups(raw, cluster.groups)
  if (expected.candidateLedger) {
    const wanted = assembled.input.candidates.map((candidate) => ({ id: candidate.id,
      claimHash: candidateClaimHash(candidate) }))
    const actual = expected.candidateLedger.filter((candidate) => candidate.originInvocationId === null)
      .map((candidate) => ({ id: candidate.candidateId, claimHash: candidate.claimHash }))
    if (!equal(wanted, actual)) throw new Error('six-pass candidates differ from Codex closure')
  }
  return { receipt, assembled }
}

module.exports = { validatePassReceipt }
