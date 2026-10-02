'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const METER = path.join(ROOT, 'bin', 'review-and-fix-pr-meter.js')

function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, `workflow helper ${name} is missing`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`unterminated workflow helper ${name}`)
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
}

test('workflow meter resolves a unique cwd and counts every transcript token class once per request', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-meter-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const cwd = path.join(temp, 'repo')
  const config = path.join(temp, 'claude')
  fs.mkdirSync(cwd)
  const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-')
  const workflow = path.join(config, 'projects', slug, 'session-1', 'subagents', 'workflows', 'wf-current')
  writeJsonl(path.join(workflow, 'journal.jsonl'), [{ type: 'started', label: 'review' }])
  fs.writeFileSync(path.join(workflow, 'agent-a.meta.json'), JSON.stringify({
    description: 'measure transcript tokens review wave 1', workflowPhase: 'Setup',
  }))
  const message = (requestId, usage) => ({
    type: 'assistant', requestId, message: { id: requestId, usage },
  })
  writeJsonl(path.join(workflow, 'agent-a.jsonl'), [
    message('r1', { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 }),
    // Same request/content-block duplication: keep the complete row with larger output only once.
    message('r1', { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 }),
    message('r2', { input_tokens: 11, output_tokens: 13, cache_read_input_tokens: 17, cache_creation_input_tokens: 19 }),
  ])

  const result = spawnSync(process.execPath, [METER, '--cwd', cwd, '--summary-only'], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config },
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.workflowDir, workflow)
  assert.deepEqual(report.tokens, {
    input: 13, output: 22, cacheRead: 22, cacheCreation: 26, total: 83,
    tailReserve: 8239, effectiveTotal: 8322,
  })
  assert.deepEqual(report.totals, { agents: 1, requests: 2, output: 22, ite: 158 })
  assert.equal(Object.hasOwn(report, 'agents'), false)

  const detailed = spawnSync(process.execPath, [METER, '--dir', workflow], { encoding: 'utf8' })
  assert.equal(detailed.status, 0, detailed.stderr)
  assert.equal(JSON.parse(detailed.stdout).agents[0].tokens, 83)
})

test('workflow source refreshes transcript totals before every paid agent wave and fails closed', () => {
  const workflow = fs.readFileSync(path.join(ROOT, 'workflows', 'review-and-fix-pr.js'), 'utf8')
  assert.match(workflow, /Workflow budget\.spent\(\) counts output tokens only/)
  assert.match(workflow, /review-and-fix-pr-meter\.js'[\s\S]*--cwd/)
  assert.match(workflow, /measuredTranscriptTokens = Math\.max/)
  assert.match(workflow, /transcript token meter failed closed/)
  assert.match(workflow, /await refreshTranscriptTokens\(scope, 'review wave '/)
  assert.match(workflow, /await refreshTranscriptTokens\(scope, 'coverage audit'\)/)
  assert.match(workflow, /await refreshTranscriptTokens\(scope, 'coverage gap wave '/)
  assert.match(workflow, /await refreshTranscriptTokens\(scope, 'final coverage re-audit'\)/)
  assert.match(workflow, /await refreshTranscriptTokens\(scope, 'finding verification'\)/)
  assert.match(workflow, /await refreshTranscriptTokens\(scope, 'independent verification challenge'\)/)
  assert.match(workflow, /await refreshTranscriptTokens\(scope, 'fix batch '/)
  assert.match(workflow, /await refreshTranscriptTokens\(scope, 'post-fix coverage rebuild'\)/)
  assert.match(workflow, /await refreshTranscriptTokens\(scope, 'terminal report'\)/)
  assert.match(workflow, /await refreshTranscriptTokens\(scope, 'terminal exit'\)/)
  assert.match(workflow, /tokens\.effectiveTotal === tokens\.total \+ tokens\.tailReserve/)
  assert.match(workflow, /measuredTranscriptTokens \|\| 0, tokens\.effectiveTotal/)

  const postFixStart = workflow.indexOf("refreshTranscriptTokens(scope, 'post-fix coverage rebuild')")
  const postFixCheck = workflow.indexOf('const postFixCircuit = mustStop()', postFixStart)
  const rebuildAgent = workflow.indexOf('deterministicManifest = await agentSafe(', postFixCheck)
  assert.ok(postFixStart > 0 && postFixStart < postFixCheck && postFixCheck < rebuildAgent,
    'post-fix meter and circuit check must precede coverage rebuild agents')

  const terminalStart = workflow.indexOf('const terminalPreMeterCircuit = mustStop()')
  const terminalRefresh = workflow.indexOf("refreshTranscriptTokens(scope, 'terminal exit')", terminalStart)
  const sealChoice = workflow.indexOf('const sealable =', terminalRefresh)
  const sealCommand = workflow.lastIndexOf("' complete --store '")
  assert.ok(terminalStart > 0 && terminalStart < terminalRefresh && terminalRefresh < sealChoice &&
    sealChoice < sealCommand, 'terminal meter must precede complete/cycle-cap sealing')
})

test('terminal metering includes cycle-cap and meter failure cannot remain publishable', () => {
  const workflow = fs.readFileSync(path.join(ROOT, 'workflows', 'review-and-fix-pr.js'), 'utf8')
  const helpers = vm.runInNewContext([
    extractFn(workflow, 'shouldRefreshTerminalTokens'),
    extractFn(workflow, 'terminalCircuitState'),
    '({ shouldRefreshTerminalTokens, terminalCircuitState })',
  ].join('\n'))
  assert.equal(helpers.shouldRefreshTerminalTokens(1_000_000, 'cycle-cap', null), true)
  assert.equal(helpers.shouldRefreshTerminalTokens(1_000_000, 'completed', 'token-cap'), false)
  assert.equal(helpers.shouldRefreshTerminalTokens(1_000_000, 'agent-cap', null), false)
  assert.equal(helpers.shouldRefreshTerminalTokens(null, 'cycle-cap', null), false)
  assert.deepEqual(JSON.parse(JSON.stringify(
    helpers.terminalCircuitState('completed', 'complete', 'token-cap'))), {
    stopReason: 'token-cap', coverageStatus: 'partial-stop',
  })
  // Cycle exhaustion is already a non-publishable terminal result; metering must not relabel it.
  assert.deepEqual(JSON.parse(JSON.stringify(
    helpers.terminalCircuitState('cycle-cap', 'partial-stop', 'token-cap'))), {
    stopReason: 'cycle-cap', coverageStatus: 'partial-stop',
  })
})
