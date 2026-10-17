'use strict'

const { isDeepStrictEqual } = require('node:util')

// Versioned API rate cards. Retain old cards so sealed estimates remain reproducible.
const STANDARD_2026_10_17 = {
  id: 'openai-api-standard-2026-10-17',
  checkedAt: '2026-10-17',
  source: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
  currency: 'USD', serviceTier: 'standard', unit: 'per-million-tokens',
  models: {
    'gpt-6.1-sol': {
      input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10,
      longContextThreshold: 272000,
      longContext: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 15 },
    },
  },
}
const KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
const round = (value) => Math.round(value * 1e9) / 1e9

function rateCard() { return structuredCloneCard(STANDARD_2026_10_17) }
function structuredCloneCard(value) { return JSON.parse(JSON.stringify(value)) }

function validateRateCard(card) {
  if (!isDeepStrictEqual(card, STANDARD_2026_10_17)) throw new Error('unknown or altered Codex API rate card')
  return card
}

function validateRequest(usage) {
  for (const key of KEYS) {
    if (!Number.isSafeInteger(usage?.[key]) || usage[key] < 0) throw new Error(`invalid Codex API usage: ${key}`)
  }
  if (usage.input_tokens < usage.cached_input_tokens + usage.cache_write_input_tokens ||
      usage.reasoning_output_tokens > usage.output_tokens || usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
    throw new Error('inconsistent Codex API token accounting')
  }
}

function estimateApiCost(agents, card = rateCard()) {
  validateRateCard(card)
  const base = {
    schemaVersion: 1, kind: 'api-equivalent', rateCard: card,
    assumptions: 'Standard API tier, global processing, token charges only; independent of subscription billing. Reasoning is included in output.',
  }
  const unavailable = (reason) => ({ ...base, status: 'unavailable', costUsd: null, reason })
  if (!Array.isArray(agents) || !agents.length) return unavailable('No agent usage receipts')
  const models = {}
  let requestCount = 0
  let longContextRequests = 0
  for (const agent of agents) {
    const modelRates = card.models[agent.model]
    if (!modelRates) return unavailable(`No API rate card for ${agent.model}`)
    if (!Array.isArray(agent.apiRequests) || !agent.apiRequests.length) return unavailable('Per-request usage or cache-write accounting is unavailable')
    const totals = Object.fromEntries(KEYS.map((key) => [key, 0]))
    for (const usage of agent.apiRequests) {
      validateRequest(usage)
      for (const key of KEYS) totals[key] += usage[key]
      const long = usage.input_tokens > modelRates.longContextThreshold
      const rates = long ? modelRates.longContext : modelRates
      const uncached = usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens
      const cost = (uncached * rates.input + usage.cached_input_tokens * rates.cacheRead +
        usage.cache_write_input_tokens * rates.cacheWrite + usage.output_tokens * rates.output) / 1e6
      models[agent.model] = (models[agent.model] || 0) + cost
      requestCount++
      if (long) longContextRequests++
    }
    for (const key of KEYS) {
      // Historical receipts omitted cache writes; supplements recover them from hashed logs.
      if (key === 'cache_write_input_tokens' && agent.usage[key] == null) continue
      if (totals[key] !== agent.usage[key]) throw new Error(`Codex API request totals differ from receipt: ${key}`)
    }
  }
  const costUsd = round(Object.values(models).reduce((sum, value) => sum + value, 0))
  return { ...base, status: 'estimated', costUsd, models: Object.fromEntries(Object.entries(models).map(([model, cost]) => [model, round(cost)])), requestCount, longContextRequests }
}

module.exports = { rateCard, validateRateCard, estimateApiCost }
