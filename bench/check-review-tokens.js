#!/usr/bin/env node
'use strict'
// Compare each new review with the two matching Opus 5.5 source-plugin reviews.
const fs = require('node:fs')
const path = require('node:path')

const ROOT = __dirname
const TARGETS = ['ironweave', 'quillstone', 'tidepool']
const BASELINE_TOOLS = ['anthropic-pr-review', 'mattpocock-review']
const BASELINE_RUN = 'opus-5-5-2026-09-29'
const REVIEW_TOOL = 'review-and-fix-pr2'

function readTotal(root, run, target, tool) {
  const file = path.join(root, 'runs', run, 'results', target, `${tool}.json`)
  if (!fs.existsSync(file)) throw new Error(`missing result: ${file}`)
  const result = JSON.parse(fs.readFileSync(file, 'utf8'))
  const usage = result.transcriptUsage
  if (!usage || !Number.isSafeInteger(usage.total) || usage.total <= 0 ||
      !['input', 'output', 'cacheRead', 'cacheCreation'].every((key) =>
        Number.isSafeInteger(usage[key]) && usage[key] >= 0) ||
      usage.total !== usage.input + usage.output + usage.cacheRead + usage.cacheCreation) {
    throw new Error(`missing or invalid transcript usage: ${file}`)
  }
  return usage.total
}

function compare(root, run, baselineRun = BASELINE_RUN) {
  const rows = TARGETS.map((target) => {
    const baseline = BASELINE_TOOLS.reduce((sum, tool) => sum + readTotal(root, baselineRun, target, tool), 0)
    const actual = readTotal(root, run, target, REVIEW_TOOL)
    const limit = Math.floor(baseline * 1.2)
    return { target, baseline, limit, actual, pass: actual <= limit }
  })
  return rows
}

if (require.main === module) {
  try {
    const [run, baselineRun = BASELINE_RUN] = process.argv.slice(2)
    if (!run || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(run) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(baselineRun)) {
      throw new Error('usage: node bench/check-review-tokens.js <run-id> [baseline-run-id]')
    }
    const rows = compare(ROOT, run, baselineRun)
    for (const row of rows) console.log(`${row.target}: ${row.actual} / ${row.limit} tokens (${row.pass ? 'PASS' : 'FAIL'})`)
    if (rows.some((row) => !row.pass)) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { compare, readTotal }
