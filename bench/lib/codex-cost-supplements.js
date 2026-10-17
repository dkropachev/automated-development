'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { readComplete, assertSafeId } = require('./artifacts')
const { sha256 } = require('./codex-review')
const { estimateApiCost } = require('./codex-pricing')

function validateSupplement(supplement, record, resultBytes) {
  if (supplement.schemaVersion !== 1 || record.platform !== 'codex' || supplement.cellId !== record.cellId ||
      supplement.resultSha256 !== sha256(resultBytes) || !Array.isArray(supplement.agents)) throw new Error('invalid Codex cost supplement reference')
  const originals = record.codexReview.agents
  if (supplement.agents.length !== originals.length || new Set(supplement.agents.map((agent) => agent.threadId)).size !== originals.length) throw new Error('Codex cost supplement agent mismatch')
  const agents = supplement.agents.map((agent) => {
    const original = originals.find((item) => item.threadId === agent.threadId)
    if (!original || original.rolloutSha256 !== agent.rolloutSha256) throw new Error('Codex cost supplement rollout hash mismatch')
    return { ...original, apiRequests: agent.apiRequests }
  })
  const estimate = estimateApiCost(agents, supplement.estimate?.rateCard)
  if (estimate.status !== 'estimated' || !isDeepStrictEqual(estimate, supplement.estimate)) throw new Error('Codex cost supplement estimate mismatch')
  return estimate
}

function loadCostSupplements(root) {
  const directory = path.join(root, 'cost-estimates')
  const estimates = new Map()
  if (!fs.existsSync(directory)) return estimates
  for (const run of fs.readdirSync(directory)) {
    assertSafeId(run, 'cost estimate run')
    const { seal } = readComplete(root, run)
    for (const name of fs.readdirSync(path.join(directory, run))) {
      if (!name.endsWith('.json')) throw new Error('unexpected Codex cost supplement file')
      const supplement = JSON.parse(fs.readFileSync(path.join(directory, run, name), 'utf8'))
      const cell = seal.cells.find((item) => item.id === supplement.cellId)
      if (!cell || name !== `${cell.target}--${cell.tool}.json` || estimates.has(cell.id)) throw new Error('unresolved Codex cost supplement cell')
      const bytes = fs.readFileSync(path.join(root, 'runs', run, cell.file))
      const record = JSON.parse(bytes)
      if (record.apiCostEstimate != null) throw new Error('Codex cost supplement conflicts with sealed estimate')
      estimates.set(cell.id, validateSupplement(supplement, record, bytes))
    }
  }
  return estimates
}

module.exports = { validateSupplement, loadCostSupplements }
