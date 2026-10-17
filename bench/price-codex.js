#!/usr/bin/env node
'use strict'

// Backfill derived estimates beside immutable results; never rerun a review or rewrite a seal.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { isDeepStrictEqual } = require('node:util')
const { readComplete, writeJsonExclusive } = require('./lib/artifacts')
const { sha256 } = require('./lib/codex-review')
const { estimateApiCost } = require('./lib/codex-pricing')
const { validateSupplement } = require('./lib/codex-cost-supplements')

function main(args = process.argv.slice(2), root = __dirname) {
  if (args.length !== 2 || args[0] !== '--run') throw new Error('usage: node bench/price-codex.js --run <completed-codex-run>')
  const { manifest, seal } = readComplete(root, args[1])
  if (manifest.platform !== 'codex') throw new Error('cost backfill requires a native Codex cohort')
  const database = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'state_5.sqlite')
  for (const cell of seal.cells) {
    const bytes = fs.readFileSync(path.join(root, 'runs', manifest.runId, cell.file))
    const record = JSON.parse(bytes)
    if (record.apiCostEstimate) continue
    const file = path.join(root, 'cost-estimates', manifest.runId, `${cell.target}--${cell.tool}.json`)
    if (fs.existsSync(file)) {
      validateSupplement(JSON.parse(fs.readFileSync(file, 'utf8')), record, bytes)
      continue
    }
    const rootAgent = record.codexReview.agents.find((agent) => agent.role === '/root')
    const cwd = execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(c.execute("SELECT cwd FROM threads WHERE id=?",(sys.argv[2],)).fetchone()[0])', database, rootAgent.threadId], { encoding: 'utf8' }).trim()
    const agents = JSON.parse(execFileSync('python3', [path.join(root, 'collect-codex-usage.py'), database, cwd, rootAgent.threadId], { encoding: 'utf8' }))
    for (const original of record.codexReview.agents) {
      const recovered = agents.find((agent) => agent.threadId === original.threadId)
      if (!recovered || Object.entries(original).some(([key, value]) => key === 'usage'
        ? Object.entries(value).some(([field, count]) => recovered.usage[field] !== count)
        : !isDeepStrictEqual(recovered[key], value))) throw new Error('Codex recovered receipt differs from sealed evidence')
    }
    const supplement = {
      schemaVersion: 1, cellId: cell.id, resultSha256: sha256(bytes),
      agents: agents.map(({ threadId, rolloutSha256, apiRequests }) => ({ threadId, rolloutSha256, apiRequests })),
      estimate: estimateApiCost(agents),
    }
    validateSupplement(supplement, record, bytes)
    writeJsonExclusive(file, supplement)
    console.log(`${cell.id}: Standard API estimate $${supplement.estimate.costUsd.toFixed(4)}`)
  }
}

module.exports = { main }
if (require.main === module) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
