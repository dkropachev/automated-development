#!/usr/bin/env node
'use strict'

// Make one minimal, quota-gated Fable call and immutably record exact-model evidence.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  acquireLocalLock,
  assertCohortOpen,
  assertSafeId,
  cohortPaths,
  manifestMetadata,
  readManifest,
  readProbeRecord,
  releaseLocalLock,
  validateClaudeResponse,
  validateProbeRecord,
  writeJsonExclusive,
} = require('./lib/artifacts')
const quota = require('./quota')

const ROOT = __dirname
const FABLE_MODEL = 'claude-fable-5-1'
const PROMPT = 'Reply with exactly OK.'

function parseArgs(argv) {
  let runId = null
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--run' || runId !== null || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('usage: node bench/probe.js --run <run-id>')
    }
    runId = assertSafeId(argv[++index], 'run id')
  }
  if (!runId || runId === 'legacy') throw new Error('usage: node bench/probe.js --run <run-id>')
  return { runId }
}

function probeArgs() {
  return [
    '-p', PROMPT,
    '--output-format', 'json',
    '--model', FABLE_MODEL,
    '--effort', 'medium',
    '--tools', '',
    '--no-session-persistence',
  ]
}

function main(argv = process.argv.slice(2), root = ROOT, dependencies = {}) {
  const { runId } = parseArgs(argv)
  const manifest = readManifest(root, runId)
  if (manifest.requestedModel !== FABLE_MODEL) throw new Error(`probe requires a ${FABLE_MODEL} cohort`)
  const paths = cohortPaths(root, runId)
  if (fs.existsSync(paths.probe)) {
    readProbeRecord(root, manifest)
    console.log(`skip probe ${runId} (recorded)`)
    return paths.probe
  }
  const lock = acquireLocalLock(paths.probe + '.lock')
  if (!lock) throw new Error(`probe for ${runId} is claimed by another process`)
  try {
    assertCohortOpen(root, runId)
    if (fs.existsSync(paths.probe)) {
      readProbeRecord(root, manifest)
      return paths.probe
    }
    const authorize = dependencies.authorizePaidCall || quota.authorizePaidCall
    const authorization = authorize(root, {
      runId, stage: 'probe', target: null, tool: null, claudeVersion: manifest.claudeVersion,
    }, dependencies)
    if (!path.isAbsolute(authorization.executable)) throw new Error('probe authorization did not return an absolute Claude executable')
    const run = dependencies.spawnSync || spawnSync
    const response = run(authorization.executable, probeArgs(), {
      cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      timeout: 5 * 60_000, env: dependencies.env || process.env,
    })
    let parsed
    try { parsed = JSON.parse(response.stdout) } catch (error) {
      throw new Error(`invalid Fable probe response: ${error.message}`, { cause: error })
    }
    validateClaudeResponse(response, parsed, FABLE_MODEL)
    if (parsed.result !== 'OK') throw new Error(`Fable probe reply was not exactly OK: ${JSON.stringify(parsed.result)}`)
    const usage = parsed.modelUsage[FABLE_MODEL]
    if (!usage || usage.canonicalModel !== FABLE_MODEL) throw new Error('Fable probe did not resolve to the canonical requested model')
    const record = {
      schemaVersion: 1,
      ...manifestMetadata(manifest),
      canonicalModel: usage.canonicalModel,
      reply: parsed.result,
      reportedCostUsd: parsed.total_cost_usd,
      reportedUsage: parsed.usage,
      modelUsage: parsed.modelUsage,
      quotaEvidence: authorization.quotaEvidence,
      probedAt: new Date().toISOString(),
    }
    validateProbeRecord(record, manifest)
    writeJsonExclusive(paths.probe, record)
    console.log(`probe ${runId}: ${record.canonicalModel} OK`)
    return paths.probe
  } finally {
    releaseLocalLock(lock)
  }
}

module.exports = { FABLE_MODEL, PROMPT, main, parseArgs, probeArgs }

if (require.main === module) {
  try { main() } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
