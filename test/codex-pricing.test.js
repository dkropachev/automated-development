'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { rateCard, estimateApiCost } = require('../bench/lib/codex-pricing')
const { validateSupplement } = require('../bench/lib/codex-cost-supplements')
const { sha256 } = require('../bench/lib/codex-review')

function request(input, cached, writes, output, thinking = 0) {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: writes, output_tokens: output, reasoning_output_tokens: thinking, total_tokens: input + output }
}
function agent(requests, model = 'gpt-6.1-sol') {
  return { threadId: 'thread', rolloutSha256: 'a'.repeat(64), model, apiRequests: requests,
    usage: Object.fromEntries(Object.keys(requests[0]).map((key) => [key, requests.reduce((sum, usage) => sum + usage[key], 0)])) }
}

test('API estimate charges cache writes and reasoning once, at per-request context rates', () => {
  const estimate = estimateApiCost([agent([request(1000000, 500000, 100000, 100000, 90000)])])
  // Long context: .4M * $4 + .5M * $.2 + .1M * $5 + .1M * $15.
  assert.equal(estimate.costUsd, 3.7)
  assert.equal(estimate.longContextRequests, 1)
  const short = estimateApiCost([agent([request(272000, 200000, 20000, 1000), request(272000, 200000, 20000, 1000)])])
  assert.equal(short.costUsd, 0.368)
  assert.equal(short.longContextRequests, 0, 'a large session total is not a large request')
  assert.equal(estimateApiCost([agent([request(272001, 200000, 20000, 1000)])]).costUsd, 0.363004)
  assert.equal(estimate.rateCard.serviceTier, 'standard')
})

test('estimates reject inconsistent usage and unknown rates instead of guessing', () => {
  const a = agent([request(100, 60, 10, 10, 5)])
  assert.equal(estimateApiCost([{ ...a, model: 'unpriced-model' }]).status, 'unavailable')
  assert.equal(estimateApiCost([{ ...a, apiRequests: null }]).costUsd, null)
  for (const key of Object.keys(a.usage)) {
    const bad = JSON.parse(JSON.stringify(a)); bad.usage[key]++
    assert.throws(() => estimateApiCost([bad]), /receipt/)
  }
  assert.throws(() => estimateApiCost([agent([request(10, 8, 5, 1)])]), /accounting/)
  assert.throws(() => estimateApiCost([agent([request(10, 1, 1, 1, 2)])]), /accounting/)
  const changed = rateCard(); changed.models['gpt-6.1-sol'].input = 0
  assert.throws(() => estimateApiCost([a], changed), /rate card/)
})

test('historical estimates bind to result and agent hashes without rewriting sealed data', () => {
  const a = agent([request(100, 60, 0, 10, 5)])
  const original = { ...a }; delete original.apiRequests; delete original.usage.cache_write_input_tokens
  const record = { platform: 'codex', cellId: 'run/target/tool', codexReview: { agents: [original] } }
  const bytes = JSON.stringify(record)
  const supplement = { schemaVersion: 1, cellId: record.cellId, resultSha256: sha256(bytes),
    agents: [{ threadId: a.threadId, rolloutSha256: a.rolloutSha256, apiRequests: a.apiRequests }], estimate: estimateApiCost([a]) }
  assert.equal(validateSupplement(supplement, record, bytes).costUsd, 0.000186)
  assert.equal(JSON.stringify(record), bytes)
  for (const change of [
    (s) => { s.resultSha256 = 'b'.repeat(64) },
    (s) => { s.cellId = 'other' },
    (s) => { s.agents[0].rolloutSha256 = 'b'.repeat(64) },
    (s) => { s.agents.push(s.agents[0]) },
    (s) => { s.estimate.costUsd = 0 },
    (s) => { s.agents[0].apiRequests[0].output_tokens++ },
  ]) {
    const bad = JSON.parse(JSON.stringify(supplement)); change(bad)
    assert.throws(() => validateSupplement(bad, record, bytes), /Codex/)
  }
})
