'use strict'
// Run every review tool against every prepared PR, one headless `claude -p` process per pair.
//
//   node bench/run.js [--model <model>] [--run <run-id>] [--only <target>] [--tool <tool>]
//                     [--concurrency N] [--timeout MIN] [--include-parked] [--list]
//
// New artifacts land in bench/runs/<run-id>/results/. The original flat results directory is a
// read-only legacy cohort. Recorded cells are immutable: an existing result is always skipped.
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { run, git, gitTry } = require('./lib/exec')
const { totalsForCwd } = require('./lib/usage')
const {
  assertSafeId,
  acquireLocalLock,
  assertCohortOpen,
  assertManifestTargets,
  cellId,
  cohortPaths,
  deriveRunId,
  ensureManifest,
  loadModelConfig,
  manifestMetadata,
  modelById,
  readManifest,
  readResultRecord,
  releaseLocalLock,
  sha256File,
  snapshotGroundtruth,
  snapshotTargetMetadata,
  writeJsonExclusive,
} = require('./lib/artifacts')

const ROOT = __dirname
const CLAUDE = process.env.CLAUDE || 'claude'

function validateInputs(state, config) {
  if (!state || !state.targets || typeof state.targets !== 'object') throw new Error('invalid state.json targets')
  for (const [key, target] of Object.entries(state.targets)) {
    assertSafeId(key, 'state target key')
    if (!target || target.id !== key) throw new Error(`state target key/id mismatch: ${key}`)
    assertSafeId(target.id, 'state target id')
  }
  if (!config || !Array.isArray(config.tools) || typeof config.context !== 'string') throw new Error('invalid tools.json')
  const ids = new Set()
  for (const tool of config.tools) {
    const id = assertSafeId(tool && tool.id, 'tool id')
    if (ids.has(id)) throw new Error(`duplicate tool id: ${id}`)
    ids.add(id)
  }
}

function parseArgs(argv, root = ROOT) {
  if (argv.includes('--force')) throw new Error('--force is not supported; benchmark artifacts are append-only')
  const config = loadModelConfig(root)
  const options = {
    only: null,
    onlyTool: null,
    concurrency: 2,
    timeoutMs: 120 * 60_000,
    includeParked: false,
    listOnly: false,
    model: config.defaultModel,
    modelExplicit: false,
    runId: null,
    runExplicit: false,
  }
  const value = (flag, index) => {
    const next = argv[index + 1]
    if (next == null || next.startsWith('--')) throw new Error(`${flag} requires a value`)
    return next
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--include-parked') { options.includeParked = true; continue }
    if (arg === '--list') { options.listOnly = true; continue }
    if (arg === '--only') { options.only = assertSafeId(value(arg, i++), 'target'); continue }
    if (arg === '--tool') { options.onlyTool = assertSafeId(value(arg, i++), 'tool'); continue }
    if (arg === '--model') { options.model = value(arg, i++); options.modelExplicit = true; continue }
    if (arg === '--run') { options.runId = assertSafeId(value(arg, i++), 'run id'); options.runExplicit = true; continue }
    if (arg === '--concurrency') {
      options.concurrency = Number(value(arg, i++))
      if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency must be a positive integer')
      continue
    }
    if (arg === '--timeout') {
      const minutes = Number(value(arg, i++))
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--timeout must be a positive number')
      options.timeoutMs = minutes * 60_000
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  modelById(config, options.model)
  if (!options.runId) options.runId = deriveRunId(options.model)
  return options
}

function selectCohort(root, options, targetIds = null) {
  const config = loadModelConfig(root)
  if (options.runId === 'legacy') {
    if (!options.listOnly) throw new Error('legacy cohort is read-only')
    return { ...config.legacyCohort, claudeVersion: null, legacy: true }
  }
  const paths = cohortPaths(root, options.runId)
  if (fs.existsSync(paths.manifest)) {
    const manifest = readManifest(root, options.runId, targetIds)
    if (options.modelExplicit && manifest.requestedModel !== options.model) {
      throw new Error(`cohort ${options.runId} uses ${manifest.requestedModel}, not ${options.model}`)
    }
    return { ...manifest, legacy: false }
  }
  const model = modelById(config, options.model)
  return {
    runId: options.runId,
    requestedModel: model.id,
    modelLabel: model.label,
    claudeVersion: null,
    legacy: false,
  }
}

function fill(template, target, tool, config) {
  const context = config.context
    .replace(/{pr}/g, target.forkPr).replace(/{fork}/g, target.fork)
    .replace(/{language}/g, target.language).replace(/{head}/g, target.forkHead)
  return template
    .replace(/{context}/g, context)
    .replace(/{pr}/g, target.forkPr).replace(/{prUrl}/g, target.forkPrUrl)
    .replace(/{fork}/g, target.fork).replace(/{language}/g, target.language)
    .replace(/{head}/g, target.forkHead).replace(/{tool}/g, tool.id)
}

function buildPairs(root, options, paths, state, config) {
  const pairs = []
  for (const target of Object.values(state.targets)) {
    if (options.only && target.id !== options.only) continue
    for (const tool of config.tools) {
      if (options.onlyTool && tool.id !== options.onlyTool) continue
      if (tool.languages && !tool.languages.includes(target.language)) continue
      const outFile = path.join(paths.results, target.id, `${tool.id}.json`)
      pairs.push({ target, tool, outFile })
    }
  }
  return pairs
}

function expectedCellsForPairs(runId, pairs) {
  return pairs.map(({ target, tool }) => ({
    id: cellId(runId, target.id, tool.id), target: target.id, tool: tool.id,
  })).sort((left, right) => left.id.localeCompare(right.id))
}

function pairsForManifest(root, options, paths, state, config, manifest) {
  const tools = new Map(config.tools.map((tool) => [tool.id, tool]))
  const pairs = []
  for (const expected of manifest.expectedCells) {
    if (options.only && expected.target !== options.only) continue
    if (options.onlyTool && expected.tool !== options.onlyTool) continue
    const target = state.targets[expected.target]
    const tool = tools.get(expected.tool)
    if (!target || !tool) throw new Error(`manifest cell is unavailable in current config: ${expected.id}`)
    if (tool.parked && !options.includeParked) continue
    pairs.push({ target, tool, outFile: path.join(paths.results, target.id, `${tool.id}.json`) })
  }
  return pairs
}

function assertParkedScope(runId, expectedCells, pairs, includeParked) {
  if (!includeParked) return
  const expectedIds = new Set(expectedCells.map((cell) => cell.id))
  const omitted = pairs.filter((pair) => pair.tool.parked)
    .map((pair) => cellId(runId, pair.target.id, pair.tool.id))
    .filter((id) => !expectedIds.has(id))
  if (omitted.length) throw new Error(`cohort ${runId} was created without parked cells: ${omitted.join(', ')}`)
}

function parseLsRemote(text, target) {
  const refs = new Map(String(text || '').trim().split('\n').filter(Boolean).map((line) => {
    const [sha, ref] = line.trim().split(/\s+/)
    return [ref, sha && sha.toLowerCase()]
  }))
  const baseSha = refs.get('refs/heads/main')
  const headSha = refs.get(`refs/heads/${target.forkHead}`)
  if (!/^[0-9a-f]{40}$/.test(baseSha || '') || !/^[0-9a-f]{40}$/.test(headSha || '')) {
    throw new Error(`prepared refs not found on ${target.fork}: main and ${target.forkHead}`)
  }
  return { baseSha, headSha }
}

function resolveTargetPins(_root, target, execute = run) {
  const remote = `git@github.com:${target.fork}.git`
  const refs = execute('git', ['ls-remote', remote, 'refs/heads/main', `refs/heads/${target.forkHead}`]).out
  return parseLsRemote(refs, target)
}

function resolveManifestTargets(root, state, execute = run) {
  return Object.fromEntries(Object.values(state.targets).map((target) => [target.id, resolveTargetPins(root, target, execute)]))
}

function sourceHasPins(source, pins) {
  return fs.existsSync(source) && [pins.baseSha, pins.headSha].every((sha) => (
    gitTry(source, 'cat-file', '-e', `${sha}^{commit}`).code === 0
  ))
}

function checkoutPrepared(root, target, tool, runId, pins) {
  if (!pins) throw new Error(`missing pinned commits for ${target.id}`)
  const base = path.join(root, 'work', target.id, 'runs', runId, tool.id)
  fs.mkdirSync(base, { recursive: true })
  const attemptDir = fs.mkdtempSync(path.join(base, 'attempt-'))
  const repo = path.join(attemptDir, 'repo')
  const localSource = path.join(root, 'work', target.id, 'src')
  if (sourceHasPins(localSource, pins)) {
    run('git', ['clone', '--quiet', localSource, repo])
  } else {
    run('git', ['clone', '--quiet', `git@github.com:${target.fork}.git`, repo])
  }
  if (![pins.baseSha, pins.headSha].every((sha) => gitTry(repo, 'cat-file', '-e', `${sha}^{commit}`).code === 0)) {
    run('git', ['fetch', '--quiet', 'origin', pins.baseSha, pins.headSha], { cwd: repo })
  }
  git(repo, 'checkout', '--quiet', '-B', 'main', pins.baseSha)
  git(repo, 'checkout', '--quiet', '-B', target.forkHead, pins.headSha)
  gitTry(repo, 'remote', 'set-url', 'origin', `git@github.com:${target.fork}.git`)
  gitTry(repo, 'config', 'user.name', 'Bench Author')
  gitTry(repo, 'config', 'user.email', 'bench@example.invalid')
  return { repo, workspace: path.relative(root, repo).split(path.sep).join('/'), ...pins }
}

function claudeVersion() {
  const result = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8' })
  if (result.error) throw new Error(`claude --version: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`claude --version exited ${result.status}: ${(result.stderr || '').trim()}`)
  const version = (result.stdout || result.stderr || '').trim()
  if (!version) throw new Error('claude --version returned no version')
  return version
}

function claudeArgs(prompt, requestedModel) {
  return [
    '-p', prompt,
    '--output-format', 'json',
    '--model', requestedModel,
    '--permission-mode', 'bypassPermissions',
    // No web: the upstream project's own PR, with the maintainers' review already on it, is one
    // search away, and a reviewer that reads it is not reviewing anything.
    '--disallowedTools', 'WebSearch', 'WebFetch',
  ]
}

function claudeRun(prompt, cwd, requestedModel, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(CLAUDE, claudeArgs(prompt, requestedModel), {
      cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = '', processError = null
    child.stdout.on('data', (data) => { out += data })
    child.stderr.on('data', (data) => { err += data })
    child.on('error', (error) => { processError = error })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, out, err, error: processError, wallMs: Date.now() - started })
    })
  })
}

function assertPublishableResponse(response, parsed) {
  if (response.error) throw new Error(`claude process failed: ${response.error.message}`, { cause: response.error })
  if (response.signal) throw new Error(`claude process ended by ${response.signal}`)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('claude returned no valid JSON result')
  return parsed
}

function claim(outFile) {
  return acquireLocalLock(outFile + '.lock')
}

const LIMIT = /hit your (session|usage) limit|usage limit reached|rate_limit_error/i
function hitLimit(parsed, out) {
  if (parsed && parsed.api_error_status === 429) return true
  const text = (parsed && parsed.result) || out || ''
  return LIMIT.test(text)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function execPair(pair, context) {
  const { target, tool, outFile } = pair
  const { options, cohort, config, root } = context
  if (fs.existsSync(outFile)) {
    readResultRecord(outFile, cohort, target.id, tool.id)
    console.log(`skip ${target.id}/${tool.id} (recorded)`)
    return
  }
  const lock = claim(outFile)
  if (!lock) { console.log(`skip ${target.id}/${tool.id} (claimed by another runner)`); return }
  try {
    assertCohortOpen(root, cohort.runId)
    if (fs.existsSync(outFile)) {
      readResultRecord(outFile, cohort, target.id, tool.id)
      console.log(`skip ${target.id}/${tool.id} (recorded)`)
      return
    }
    const prompt = fill(tool.prompt, target, tool, config)
    let checkout, response, parsed, attempts
    for (attempts = 1; ; attempts += 1) {
      checkout = checkoutPrepared(root, target, tool, cohort.runId, cohort.targets[target.id])
      console.log(`start ${target.id}/${tool.id}${attempts > 1 ? ` (attempt ${attempts})` : ''}`)
      response = await claudeRun(prompt, checkout.repo, cohort.requestedModel, options.timeoutMs)
      parsed = null
      try { parsed = JSON.parse(response.out) } catch {}
      if (!hitLimit(parsed, response.out)) break
      const wait = Math.min(30, 5 * attempts)
      console.log(`limit  ${target.id}/${tool.id} - ${(parsed && parsed.result) || 'usage limit'}; retrying in ${wait} min`)
      await sleep(wait * 60_000)
    }
    assertPublishableResponse(response, parsed)
    const usage = totalsForCwd(checkout.repo)
    const record = {
      schemaVersion: 2,
      ...manifestMetadata(cohort),
      cellId: cellId(cohort.runId, target.id, tool.id),
      target: target.id,
      language: target.language,
      fork: target.fork,
      pr: target.forkPr,
      baseSha: checkout.baseSha,
      headSha: checkout.headSha,
      tool: tool.id,
      label: tool.label,
      source: tool.source,
      prompt,
      exitCode: response.code,
      signal: response.signal,
      wallMs: response.wallMs,
      reportedCostUsd: parsed ? parsed.total_cost_usd : null,
      reportedUsage: parsed ? parsed.usage : null,
      modelUsage: parsed ? parsed.modelUsage : null,
      numTurns: parsed ? parsed.num_turns : null,
      subagentStats: parsed ? parsed.subagent_stats : null,
      sessionId: parsed ? parsed.session_id : null,
      isError: parsed ? parsed.is_error : true,
      apiErrorStatus: parsed ? parsed.api_error_status : null,
      transcriptUsage: usage,
      result: parsed ? parsed.result : null,
      stderrTail: response.err.slice(-4000),
      attempts,
      workspace: checkout.workspace,
      finishedAt: new Date().toISOString(),
    }
    writeJsonExclusive(outFile, record)
    console.log(`done  ${target.id}/${tool.id} exit=${response.code} ${Math.round(response.wallMs / 1000)}s tokens=${usage.total} cost=${record.reportedCostUsd}`)
  } finally {
    try { releaseLocalLock(lock) } catch (error) {
      if (error.code !== 'ENOENT') console.log(`WARN could not remove lock ${lock}: ${error.message}`)
    }
  }
}

async function main(argv = process.argv.slice(2), root = ROOT, dependencies = {}) {
  const options = parseArgs(argv, root)
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
  const targetIds = Object.keys(state.targets)
  const requestedPaths = cohortPaths(root, options.runId)
  const validateTargetIds = !options.listOnly && requestedPaths.manifest && fs.existsSync(requestedPaths.manifest) ? targetIds : null
  const cohort = selectCohort(root, options, validateTargetIds)
  const paths = cohortPaths(root, cohort.runId)
  const configFile = path.join(root, 'tools.json')
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  validateInputs(state, config)
  if (options.listOnly) {
    const displayState = cohort.targetMetadata ? { targets: cohort.targetMetadata } : state
    const displayConfig = cohort.toolConfig || config
    const allDisplayPairs = buildPairs(root, { ...options, only: null, onlyTool: null }, paths, displayState, displayConfig)
    if (cohort.expectedCells) assertParkedScope(cohort.runId, cohort.expectedCells, allDisplayPairs, options.includeParked)
    const pairs = cohort.expectedCells
      ? pairsForManifest(root, options, paths, displayState, displayConfig, cohort)
      : buildPairs(root, options, paths, displayState, displayConfig)
    for (const pair of pairs) {
      const status = fs.existsSync(pair.outFile) ? 'done' : pair.tool.parked ? 'parked' : 'pending'
      console.log(`${pair.target.id.padEnd(12)} ${pair.tool.id.padEnd(22)} ${status}`)
    }
    console.log(`${pairs.length} pairs in ${cohort.runId}`)
    return
  }
  assertCohortOpen(root, cohort.runId)
  const version = (dependencies.claudeVersion || claudeVersion)()
  const configSha256 = sha256File(configFile)
  const targets = cohort.targets || resolveManifestTargets(root, state)
  const targetMetadata = snapshotTargetMetadata(state.targets)
  const groundtruth = cohort.groundtruth || snapshotGroundtruth(root, targetIds)
  const scopeOptions = { ...options, only: null, onlyTool: null }
  const allEligiblePairs = buildPairs(root, scopeOptions, paths, state, config)
  const initialPairs = cohort.expectedCells ? null : allEligiblePairs
  const expectedCells = cohort.expectedCells || expectedCellsForPairs(
    cohort.runId,
    initialPairs.filter((pair) => !pair.tool.parked || options.includeParked),
  )
  if (cohort.expectedCells) assertParkedScope(cohort.runId, cohort.expectedCells, allEligiblePairs, options.includeParked)
  const manifest = ensureManifest(root, {
    ...cohort, claudeVersion: version, configSha256, targets, targetMetadata, expectedCells,
    toolConfig: config, groundtruth,
  })
  assertManifestTargets(manifest, targetIds)
  const pinnedState = { targets: manifest.targetMetadata }
  const pairs = pairsForManifest(root, options, paths, pinnedState, manifest.toolConfig, manifest)
  const context = { options, cohort: manifest, config: manifest.toolConfig, root }
  const queue = pairs.slice()
  let failures = 0
  const workers = Array.from({ length: options.concurrency }, async () => {
    for (;;) {
      const pair = queue.shift()
      if (!pair) return
      try { await execPair(pair, context) } catch (error) {
        failures += 1
        console.log(`FAIL ${pair.target.id}/${pair.tool.id}: ${error.message.slice(0, 500)}`)
      }
    }
  })
  await Promise.all(workers)
  if (failures) throw new Error(`${failures} benchmark cell${failures === 1 ? '' : 's'} failed`)
}

module.exports = {
  buildPairs,
  checkoutPrepared,
  claim,
  claudeArgs,
  claudeRun,
  claudeVersion,
  execPair,
  expectedCellsForPairs,
  fill,
  hitLimit,
  assertPublishableResponse,
  assertParkedScope,
  main,
  parseArgs,
  parseLsRemote,
  pairsForManifest,
  resolveManifestTargets,
  resolveTargetPins,
  selectCohort,
  sourceHasPins,
  validateInputs,
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
