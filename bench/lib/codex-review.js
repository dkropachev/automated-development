'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { validateRateCard, estimateApiCost } = require('./codex-pricing')
const HASH = /^[a-f0-9]{64}$/
const roles = ['spec', 'standards', 'toolkit']
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const ordered = (files) => Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
const fingerprint = (files) => sha256(JSON.stringify(ordered(files)))

function snapshotSkill(directory) {
  const files = {}
  function visit(relative) {
    for (const item of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, item.name)
      if (item.isDirectory()) visit(name)
      else if (item.isFile()) files[name] = sha256(fs.readFileSync(path.join(directory, name)))
      else throw new Error(`unsafe skill snapshot entry: ${name}`)
    }
  }
  visit('')
  return { contentSha256: fingerprint(files), files: ordered(files) }
}

function validateReviewer(reviewer) {
  if (!reviewer || typeof reviewer.version !== 'string' || !reviewer.version || !HASH.test(reviewer.executableSha256 || '') ||
      !['high', 'xhigh'].includes(reviewer.reasoningEffort) || !['high', 'xhigh'].includes(reviewer.reviewerEffort)) {
    throw new Error('invalid Codex reviewer identity')
  }
  if (JSON.stringify(reviewer.roles) !== JSON.stringify(roles)) throw new Error('Codex reviewer must run Toolkit, Standards, and Spec')
  if (reviewer.apiPricing != null) validateRateCard(reviewer.apiPricing)
  const skill = reviewer.skill
  if (!skill || !skill.files || !Object.keys(skill.files).length || !skill.files['SKILL.md'] || !skill.files['review.md']) throw new Error('missing Codex skill snapshot')
  for (const [name, hash] of Object.entries(skill.files)) {
    if (!HASH.test(hash) || name.startsWith('/') || name.split('/').some((part) => !part || ['.', '..'].includes(part)) || name.includes('\\')) throw new Error('invalid Codex skill file hash')
  }
  if (skill.contentSha256 !== fingerprint(skill.files)) throw new Error('Codex skill fingerprint mismatch')
  return reviewer
}

function transcriptUsage(agents) {
  const sum = (key) => agents.reduce((total, agent) => total + agent.usage[key], 0)
  const cacheCreation = agents.every((agent) => agent.usage.cache_write_input_tokens != null) ? sum('cache_write_input_tokens') : 0
  return {
    input: sum('input_tokens') - sum('cached_input_tokens') - cacheCreation,
    cacheRead: sum('cached_input_tokens'), output: sum('output_tokens'), thinking: sum('reasoning_output_tokens'),
    cacheCreation, total: sum('total_tokens'), costUsd: null, sessions: agents.length,
    models: Object.fromEntries([...new Set(agents.map((agent) => agent.model))].map((model) => [model, null])),
  }
}

function validateCodexResult(record, manifest) {
  const reviewer = validateReviewer(manifest.codexReviewer)
  if (record.exitCode !== 0 || record.signal != null || record.isError !== false || record.apiErrorStatus != null || typeof record.result !== 'string' || !record.result.trim()) {
    throw new Error('Codex review did not complete successfully')
  }
  for (const section of ['Toolkit', 'Standards', 'Spec']) if (!new RegExp(`^## ${section}\\s*$`, 'm').test(record.result)) throw new Error(`Codex report is missing ${section}`)
  if (typeof record.prompt !== 'string' || !record.prompt.trim() || !Number.isFinite(record.wallMs) || record.wallMs < 0 || typeof record.finishedAt !== 'string' || !Number.isFinite(Date.parse(record.finishedAt))) throw new Error('Codex execution provenance is incomplete')
  const receipt = record.codexReview
  if (!receipt || receipt.schemaVersion !== 1 || receipt.reportSha256 !== sha256(record.result) || receipt.promptSha256 !== sha256(record.prompt || '') || !Array.isArray(receipt.agents)) throw new Error('Codex review receipt hash mismatch')
  const expectedRoles = ['/root', ...reviewer.roles.map((role) => `/root/${role}`)].sort()
  if (JSON.stringify(receipt.agents.map((agent) => agent.role).sort()) !== JSON.stringify(expectedRoles) || new Set(receipt.agents.map((agent) => agent.threadId)).size !== expectedRoles.length) throw new Error('Codex review agent structure mismatch')
  for (const agent of receipt.agents) {
    if (agent.completed !== true || !agent.threadId || !HASH.test(agent.rolloutSha256 || '') || agent.model !== manifest.requestedModel || agent.reasoningEffort !== (agent.role === '/root' ? reviewer.reasoningEffort : reviewer.reviewerEffort)) throw new Error('Codex review model or effort drift')
    const usage = agent.usage
    if (usage?.cache_write_input_tokens != null && (!Number.isSafeInteger(usage.cache_write_input_tokens) || usage.cache_write_input_tokens < 0 || usage.cache_write_input_tokens + usage.cached_input_tokens > usage.input_tokens)) throw new Error('invalid Codex cache-write usage')
    for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']) {
      if (!Number.isSafeInteger(usage?.[key]) || usage[key] < 0) throw new Error(`invalid Codex token usage: ${key}`)
    }
    if (usage.total_tokens <= 0 || usage.total_tokens !== usage.input_tokens + usage.output_tokens || usage.cached_input_tokens > usage.input_tokens || usage.reasoning_output_tokens > usage.output_tokens) throw new Error('inconsistent Codex token accounting')
  }
  if (!isDeepStrictEqual(record.transcriptUsage, transcriptUsage(receipt.agents)) || record.reportedCostUsd !== null) throw new Error('Codex usage differs from frozen agent receipts')
  if (reviewer.apiPricing != null) {
    if (!isDeepStrictEqual(record.apiCostEstimate, estimateApiCost(receipt.agents, reviewer.apiPricing))) throw new Error('Codex API cost estimate differs from frozen usage or rates')
  } else if (record.apiCostEstimate != null) throw new Error('Codex API estimate has no frozen rate card')
  return record
}

module.exports = { snapshotSkill, validateReviewer, validateCodexResult, transcriptUsage, sha256 }
