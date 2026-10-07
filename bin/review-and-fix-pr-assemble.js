#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { assembleLaneReceipts, exactlyOneRootTranscript, readLaneReceipts } =
  require('../lib/review-discovery-assembler')

function main(args = process.argv.slice(2), env = process.env) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || !args[index + 1]) throw new Error('expected --name value pairs')
    options[args[index].slice(2)] = args[index + 1]
  }
  const root = path.resolve(options.root || '')
  const inputFile = env.REVIEW_AND_FIX_PR_CODEX_INPUT
  const ledgerFile = env.REVIEW_AND_FIX_PR_DISCOVERY_LEDGER
  const contextFile = env.REVIEW_AND_FIX_PR_CODEX_CONTEXT
  if (!path.isAbsolute(inputFile || '') || !path.isAbsolute(ledgerFile || '') ||
      !path.isAbsolute(contextFile || '') || !options.root) {
    throw new Error('runner paths and --root are required')
  }
  if (fs.existsSync(inputFile) || fs.existsSync(ledgerFile)) throw new Error('refusing to overwrite assembled evidence')
  const expected = JSON.parse(env.REVIEW_AND_FIX_PR_CODEX_EXPECTED_JSON || 'null')
  if (!expected?.target) throw new Error('runner target identity is missing')
  const receipts = readLaneReceipts(options.receipts || exactlyOneRootTranscript(root, env.CLAUDE_CONFIG_DIR))
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'))
  const { input, ledger } = assembleLaneReceipts(receipts, context, expected.target,
    expected.pluginFingerprint)
  fs.writeFileSync(inputFile, JSON.stringify(input, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return { candidates: input.candidates.length, rawCandidates: ledger.candidates.length,
    checkedNonissues: ledger.checkedNonissues.length }
}

module.exports = { main }
if (require.main === module) {
  try { console.log(JSON.stringify(main())) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
