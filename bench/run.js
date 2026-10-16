'use strict'
// Run every review tool against every prepared PR, one headless `claude -p` process per pair.
//
//   node bench/run.js [--model <model>] [--run <run-id>] [--only <target>] [--tool <tool>]
//                     [--cohort-tool <tool>] [--cohort-target <target>] [--plugin-dir <dir>]
//                     [--concurrency N] [--limit-retries N] [--timeout MIN]
//                     [--max-budget-usd USD]
//                     [--include-parked] [--list]
//
// New artifacts land in bench/runs/<run-id>/results/. The original flat results directory is a
// read-only legacy cohort. Recorded cells are immutable: an existing result is always skipped.
const fs = require('node:fs')
const crypto = require('node:crypto')
const os = require('node:os')
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
  codexReceiptPath,
  ensureDirectorySafe,
  ensureManifest,
  loadModelConfig,
  manifestMetadata,
  modelById,
  parseReviewAndFixPrResultContract,
  reviewAndFixPrContractForTool,
  readManifest,
  readResultRecord,
  releaseLocalLock,
  sha256File,
  snapshotGroundtruth,
  snapshotTargetMetadata,
  validateClaudeResponse,
  validateModelUsage,
  validateResultRecord,
  validateTranscriptUsage,
  writeJsonExclusive,
  REVIEW_AND_FIX_PR_CONTRACT_V1,
  REVIEW_AND_FIX_PR_CONTRACT_V2,
  REVIEW_AND_FIX_PR_CONTRACT_V3,
} = require('./lib/artifacts')
const quota = require('./quota')
const { validateDiscoveryLedger } = require('../lib/review-discovery-ledger')
const { captureDiscoveryReceipts } = require('../lib/review-discovery-receipts')

const ROOT = __dirname
const CLAUDE = process.env.CLAUDE || 'claude'
const FABLE_MODEL = 'claude-fable-5-1'
const MIN_FABLE_CLAUDE_VERSION = Object.freeze({ major: 2, minor: 1, patch: 284 })
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PLUGIN_LIST_MAX_BUFFER = 16 * 1024 * 1024
const PLUGIN_LIST_TIMEOUT_MS = 30_000
const CODEX_JUDGE_SCHEMA = path.join(__dirname, '..', 'skills', 'review-and-fix-pr', 'codex-judge.schema.json')
const CODEX_JUDGE_V3_SCHEMA = path.join(__dirname, '..', 'skills', 'review-and-fix-pr', 'codex-judge-v3.schema.json')
const codexSchemaForContract = (contract) => contract === REVIEW_AND_FIX_PR_CONTRACT_V3
  ? CODEX_JUDGE_V3_SCHEMA : CODEX_JUDGE_SCHEMA
const PLUGIN_CONTENT_EXCLUDED = new Set([
  'bench/findings', 'bench/judgement', 'bench/logs', 'bench/results', 'bench/runs', 'bench/work',
])

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

function assertSafeDirectory(directory, label = 'directory') {
  const absolute = path.resolve(directory)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (!fs.existsSync(current)) throw new Error(`${label} does not exist: ${absolute}`)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink ${label} path: ${current}`)
    if (current !== absolute && !stat.isDirectory()) throw new Error(`${label} path component is not a directory: ${current}`)
  }
  if (!fs.lstatSync(absolute).isDirectory()) throw new Error(`${label} is not a directory: ${absolute}`)
  return absolute
}

function pluginContentExcluded(relative) {
  const slash = relative.split(path.sep).join('/')
  const parts = slash.split('/')
  if (parts.includes('.git') || parts.includes('node_modules')) return true
  return [...PLUGIN_CONTENT_EXCLUDED].some((prefix) => slash === prefix || slash.startsWith(`${prefix}/`))
}

function pluginContentFiles(directory) {
  const files = []
  const visit = (relative) => {
    const absolute = relative ? path.join(directory, relative) : directory
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = relative ? path.join(relative, entry.name) : entry.name
      if (pluginContentExcluded(child)) continue
      const file = path.join(directory, child)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error(`refusing symlink in plugin directory: ${file}`)
      if (stat.isDirectory()) visit(child)
      else if (stat.isFile()) files.push(child)
      else throw new Error(`refusing special file in plugin directory: ${file}`)
    }
  }
  visit('')
  return files
}

function pluginContentHash(directory) {
  const hash = crypto.createHash('sha256')
  for (const relative of pluginContentFiles(directory)) {
    const file = path.join(directory, relative)
    const bytes = fs.readFileSync(file)
    const executable = fs.statSync(file).mode & 0o111 ? 'x' : '-'
    const name = relative.split(path.sep).join('/')
    hash.update(`${Buffer.byteLength(name)}:${name}:${executable}:${bytes.length}:`)
    hash.update(bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function assertPluginName(value, label = 'plugin name') {
  if (typeof value !== 'string' || !PLUGIN_NAME.test(value)) throw new Error(`invalid ${label}: ${JSON.stringify(value)}`)
  return value
}

function parseInstalledPluginEntries(output, pluginName) {
  const expectedName = assertPluginName(pluginName)
  let plugins
  try { plugins = JSON.parse(output) } catch {
    throw new Error('Claude plugin discovery returned invalid JSON')
  }
  if (!Array.isArray(plugins)) throw new Error('Claude plugin discovery did not return an array')
  const matching = []
  for (const [index, plugin] of plugins.entries()) {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
      throw new Error(`Claude plugin discovery entry ${index} is malformed`)
    }
    if (typeof plugin.id !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(plugin.id)) {
      throw new Error(`Claude plugin discovery entry ${index} has an invalid id`)
    }
    if (typeof plugin.enabled !== 'boolean' || typeof plugin.projectEnabled !== 'boolean') {
      throw new Error(`Claude plugin discovery entry ${plugin.id} has unknown enabled state`)
    }
    if (plugin.id.slice(0, plugin.id.indexOf('@')) === expectedName) matching.push(plugin)
  }
  return matching.sort((left, right) => left.id.localeCompare(right.id))
}

function settingsForInstalledPluginEntries(entries) {
  const matchingIds = new Set(entries.map((entry) => entry.id))
  return {
    enabledPlugins: Object.fromEntries([...matchingIds].sort().map((id) => [id, false])),
  }
}

function parseInstalledPluginSettings(output, pluginName) {
  return settingsForInstalledPluginEntries(parseInstalledPluginEntries(output, pluginName))
}

function discoverPluginIsolationSettings(executable, pluginName, cwd, dependencies = {}) {
  const discover = dependencies.pluginListSpawnSync || spawnSync
  const runList = (args, phase) => {
    const result = discover(executable, args, {
      cwd,
      encoding: 'utf8',
      env: dependencies.env || process.env,
      maxBuffer: PLUGIN_LIST_MAX_BUFFER,
      timeout: PLUGIN_LIST_TIMEOUT_MS,
    })
    if (!result || typeof result !== 'object') throw new Error(`Claude plugin ${phase} returned no process result`)
    if (result.error) throw new Error(`Claude plugin ${phase} failed: ${result.error.message}`)
    if (result.status !== 0) {
      const detail = String(result.stderr || '').trim().slice(0, 500)
      throw new Error(`Claude plugin ${phase} exited ${result.status}${detail ? `: ${detail}` : ''}`)
    }
    if (typeof result.stdout !== 'string') throw new Error(`Claude plugin ${phase} returned no text output`)
    return result.stdout
  }
  const before = parseInstalledPluginEntries(runList(['plugin', 'list', '--json'], 'discovery'), pluginName)
  const settings = settingsForInstalledPluginEntries(before)
  const serialized = JSON.stringify(settings)
  const after = parseInstalledPluginEntries(runList(
    ['--settings', serialized, 'plugin', 'list', '--json'], 'isolation verification',
  ), pluginName)
  if (before.map((plugin) => plugin.id).join('\0') !== after.map((plugin) => plugin.id).join('\0')) {
    throw new Error('Claude plugin inventory changed during isolation verification')
  }
  const enabled = after.filter((plugin) => plugin.enabled).map((plugin) => plugin.id)
  if (enabled.length) throw new Error(`Claude ignored local plugin isolation settings for: ${enabled.join(', ')}`)
  return settings
}

function normalizePluginIsolationSettings(settings, pluginName) {
  const expectedName = assertPluginName(pluginName)
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      !settings.enabledPlugins || typeof settings.enabledPlugins !== 'object' ||
      Array.isArray(settings.enabledPlugins)) {
    throw new Error('local plugin launch requires verified plugin isolation settings')
  }
  const ids = Object.keys(settings.enabledPlugins).sort()
  for (const id of ids) {
    if (!/^[^@\s]+@[^@\s]+$/.test(id) || id.slice(0, id.indexOf('@')) !== expectedName ||
        settings.enabledPlugins[id] !== false) {
      throw new Error(`invalid local plugin isolation entry: ${JSON.stringify(id)}`)
    }
  }
  return { enabledPlugins: Object.fromEntries(ids.map((id) => [id, false])) }
}

function resolvePluginDirectory(directory, cwd = process.cwd()) {
  const absolute = assertSafeDirectory(path.resolve(cwd, directory), 'plugin directory')
  const manifestFile = path.join(absolute, '.claude-plugin', 'plugin.json')
  if (!fs.existsSync(manifestFile)) throw new Error(`plugin manifest not found: ${manifestFile}`)
  const stat = fs.lstatSync(manifestFile)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe plugin manifest: ${manifestFile}`)
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch (error) {
    throw new Error(`invalid plugin manifest ${manifestFile}: ${error.message}`, { cause: error })
  }
  if (!manifest || typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error(`plugin manifest version is required: ${manifestFile}`)
  }
  const pluginName = assertPluginName(manifest.name, 'plugin manifest name')
  const revision = spawnSync('git', ['-C', absolute, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' })
  let gitCommit = null
  if (!revision.error && revision.status === 0) {
    gitCommit = String(revision.stdout || '').trim().toLowerCase()
    if (!/^[0-9a-f]{40}$/.test(gitCommit)) throw new Error(`invalid git commit for plugin directory: ${absolute}`)
  }
  return {
    directory: absolute,
    name: pluginName,
    fingerprint: {
      version: manifest.version,
      gitCommit,
      contentSha256: pluginContentHash(absolute),
    },
  }
}

function assertPluginDirectoryCurrent(options) {
  if (!options || !options.pluginDir) return
  const current = resolvePluginDirectory(options.pluginDir)
  if (current.name !== options.pluginName ||
      JSON.stringify(current.fingerprint) !== JSON.stringify(options.pluginFingerprint)) {
    throw new Error('local plugin checkout changed after it was fingerprinted')
  }
}

function hashJson(value) {
  const canonical = (input) => Array.isArray(input) ? input.map(canonical) :
    input && typeof input === 'object'
      ? Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]))
      : input
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function codexRuntime() {
  return require('../bin/review-and-fix-pr-codex')
}

function reviewCodexContract() {
  return require('../lib/review-codex-contract')
}

function resolveExecutableFile(executable, env = process.env, dependencies = {}) {
  if (path.isAbsolute(executable)) return fs.realpathSync(executable)
  const locate = dependencies.whichSpawnSync || spawnSync
  const result = locate('which', [executable], { encoding: 'utf8', env })
  if (!result || result.error || result.status !== 0 || !String(result.stdout || '').trim()) {
    throw new Error(`could not resolve Codex executable: ${executable}`)
  }
  return fs.realpathSync(String(result.stdout).trim().split(/\r?\n/, 1)[0])
}

function normalizeCodexPreflight(preflight, env = process.env, dependencies = {}, contract = REVIEW_AND_FIX_PR_CONTRACT_V2) {
  if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight)) {
    throw new Error('Codex preflight returned no identity')
  }
  const authentication = typeof preflight.authentication === 'string' ? preflight.authentication : ''
  const authenticated = preflight.authenticated === true ||
    (!/not\s+(?:logged in|authenticated)/i.test(authentication) && /logged in|authenticated/i.test(authentication))
  let executableSha256 = preflight.executableSha256
  if (!executableSha256) {
    const executable = resolveExecutableFile(preflight.executable || env.CODEX || 'codex', env, dependencies)
    executableSha256 = sha256File(executable)
  }
  return {
    provider: 'openai',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    cliVersion: preflight.cliVersion,
    executableSha256,
    schemaSha256: sha256File(codexSchemaForContract(contract)),
    authenticated,
  }
}

function runCodexPreflight(root, env = process.env, dependencies = {}, contract = REVIEW_AND_FIX_PR_CONTRACT_V2) {
  const preflight = dependencies.preflightCodex || codexRuntime().preflightCodex
  return normalizeCodexPreflight(preflight({
    executable: env.CODEX || 'codex', env, cwd: root,
  }, dependencies), env, dependencies, contract)
}

function assertCodexJudgeCurrent(root, manifest, env = process.env, dependencies = {}) {
  if (!manifest.codexJudge) throw new Error(`cohort ${manifest.runId} is missing its Codex judge identity`)
  const contract = manifest.expectedCells.some((cell) =>
    reviewAndFixPrContractForTool(manifest, cell.tool) === REVIEW_AND_FIX_PR_CONTRACT_V3)
    ? REVIEW_AND_FIX_PR_CONTRACT_V3 : REVIEW_AND_FIX_PR_CONTRACT_V2
  const current = runCodexPreflight(root, env, dependencies, contract)
  if (JSON.stringify(current) !== JSON.stringify(manifest.codexJudge)) {
    throw new Error(`cohort ${manifest.runId} Codex judge identity changed`)
  }
  return current
}

function assertCheckoutUnchanged(checkout) {
  const head = git(checkout.repo, 'rev-parse', 'HEAD')
  const status = git(checkout.repo, 'status', '--porcelain')
  if (head !== checkout.headSha || status) throw new Error('review target changed during benchmark execution')
}

function allocateCodexReceipt(root, cohort, target, tool) {
  const receiptId = crypto.randomUUID()
  const file = codexReceiptPath(root, cohort.runId, target.id, tool.id, receiptId)
  const inputFile = file.slice(0, -'.json'.length) + '.input.json'
  const contextFile = file.slice(0, -'.json'.length) + '.context.json'
  const discoveryFile = file.slice(0, -'.json'.length) + '.discovery.json'
  const passFile = file.slice(0, -'.json'.length) + '.passes.json'
  ensureDirectorySafe(path.dirname(file))
  if (fs.existsSync(file) || fs.existsSync(inputFile) || fs.existsSync(contextFile) ||
      fs.existsSync(discoveryFile) || fs.existsSync(passFile)) {
    throw new Error(`refusing existing Codex receipt/input/context path: ${file}`)
  }
  // Unix domain socket addresses are much shorter than artifact paths on Linux.
  // Keep the broker endpoint independent of the cohort/target directory depth.
  const socketFile = path.join(os.tmpdir(), `rafp-${receiptId}.sock`)
  if (Buffer.byteLength(socketFile) > 100 || fs.existsSync(socketFile)) {
    throw new Error('cannot allocate a short, unused Codex broker socket path')
  }
  return { receiptId, file, inputFile, contextFile, discoveryFile, passFile, socketFile }
}

function jsonCommand(executable, args, cwd, label, dependencies = {}) {
  const execute = dependencies.contextSpawnSync || spawnSync
  const result = execute(executable, args, {
    cwd, encoding: 'utf8', maxBuffer: 1 << 30, env: dependencies.env || process.env,
  })
  if (!result || result.error) throw new Error(`${label} failed: ${result && result.error ? result.error.message : 'no process result'}`)
  if (result.status !== 0) throw new Error(`${label} exited ${result.status}: ${String(result.stderr || '').trim().slice(0, 1000)}`)
  let parsed
  try { parsed = JSON.parse(result.stdout) } catch { throw new Error(`${label} returned malformed JSON`) }
  if (!parsed || parsed.ok !== true) throw new Error(`${label} returned an unsuccessful result`)
  return parsed
}

function prepareCodexReviewContext(checkout, target, dependencies = {}) {
  const scope = jsonCommand(process.execPath, [
    path.join(__dirname, '..', 'bin', 'review-and-fix-pr-scope.js'),
    '--root', checkout.repo, '--repo', target.fork, '--pr', String(target.forkPr),
  ], checkout.repo, 'review scope preflight', dependencies)
  if (scope.baseSha !== checkout.baseSha || scope.prHead !== checkout.headSha) {
    throw new Error('review scope preflight differs from benchmark pins')
  }
  const inventory = jsonCommand(process.execPath, [
    path.join(__dirname, '..', 'bin', 'review-and-fix-pr-diff.js'),
    '--root', checkout.repo, '--base', scope.mergeBase, '--head', checkout.headSha,
  ], checkout.repo, 'review diff inventory', dependencies)
  const diffArgs = [
    '-C', checkout.repo, '-c', 'color.ui=false', '-c', 'diff.renames=true',
    '-c', 'diff.algorithm=myers', '-c', 'diff.context=3', '-c', 'diff.indentHeuristic=false',
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames=50%',
    '--find-copies=50%', '--find-copies-harder', '--diff-algorithm=myers',
    '--no-indent-heuristic', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/',
    `${scope.mergeBase}...${checkout.headSha}`,
  ]
  const execute = dependencies.contextSpawnSync || spawnSync
  const diff = execute('git', diffArgs, {
    cwd: checkout.repo, encoding: 'utf8', maxBuffer: 1 << 30,
    env: dependencies.env || process.env,
  })
  if (!diff || diff.error || diff.status !== 0) throw new Error('canonical review diff failed')
  const commits = Array.isArray(scope.pr && scope.pr.commits) ? scope.pr.commits : []
  const commitMessages = commits.map((commit) => {
    const headline = String(commit.messageHeadline || '')
    const body = String(commit.messageBody || '')
    return `${String(commit.oid || '')}\n${headline}${body ? `\n\n${body}` : ''}`
  })
  const baseRules = [], headRules = []
  for (const instruction of scope.instructions) {
    const exact = { path: instruction.path, oid: instruction.oid, content: instruction.content }
    if (instruction.sources.includes('base')) baseRules.push(exact)
    if (instruction.sources.includes('head')) headRules.push(exact)
  }
  const acceptanceCriteria = [
    `PR title: ${String(scope.pr.title || '')}`,
    `PR body:\n${String(scope.pr.body || '')}`,
    ...scope.issues.map((issue) =>
      `${issue.repo}#${issue.number} ${String(issue.title || '')}\n${String(issue.body || '')}`),
  ]
  return reviewCodexContract().canonical({
    repositoryIdentity: scope.repo,
    remoteIdentity: scope.remoteIdentity,
    upstreamIdentity: scope.upstreamIdentity,
    prTitle: String(scope.pr.title || ''),
    prBody: String(scope.pr.body || ''),
    acceptanceCriteria,
    commitMessages,
    canonicalDiffInventory: { inventory, patch: String(diff.stdout || '') },
    applicableBaseRules: baseRules,
    applicableHeadRules: headRules,
    linkedSources: scope.issues,
    missingSourceIndicators: {
      unavailableIssueCount: scope.unavailableIssueCount,
      truncatedIssueCount: scope.truncatedIssueCount,
      omittedIssueReferenceCount: scope.omittedIssueReferenceCount,
      ignoredCrossRepoIssueCount: scope.ignoredCrossRepoIssueCount,
      instructionOmissions: scope.instructionOmissions,
    },
  })
}

function parseArgs(argv, root = ROOT) {
  if (argv.includes('--force')) throw new Error('--force is not supported; benchmark artifacts are append-only')
  const config = loadModelConfig(root)
  const options = {
    only: null,
    onlyTool: null,
    cohortTool: null,
    cohortTarget: null,
    concurrency: 2,
    timeoutMs: 120 * 60_000,
    includeParked: false,
    limitRetries: Infinity,
    listOnly: false,
    model: config.defaultModel,
    modelExplicit: false,
    maxBudgetUsd: null,
    pluginDir: null,
    pluginFingerprint: null,
    pluginName: null,
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
    if (arg === '--cohort-tool') { options.cohortTool = assertSafeId(value(arg, i++), 'cohort tool'); continue }
    if (arg === '--cohort-target') { options.cohortTarget = assertSafeId(value(arg, i++), 'cohort target'); continue }
    if (arg === '--plugin-dir') {
      const plugin = resolvePluginDirectory(value(arg, i++))
      options.pluginDir = plugin.directory
      options.pluginFingerprint = plugin.fingerprint
      options.pluginName = plugin.name
      continue
    }
    if (arg === '--max-budget-usd') {
      options.maxBudgetUsd = Number(value(arg, i++))
      if (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd <= 0) {
        throw new Error('--max-budget-usd must be a finite positive number')
      }
      continue
    }
    if (arg === '--model') { options.model = value(arg, i++); options.modelExplicit = true; continue }
    if (arg === '--run') { options.runId = assertSafeId(value(arg, i++), 'run id'); options.runExplicit = true; continue }
    if (arg === '--concurrency') {
      const concurrency = value(arg, i++)
      options.concurrency = /^\d+$/.test(concurrency) ? Number(concurrency) : NaN
      if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 256) {
        throw new Error('--concurrency must be a positive integer no greater than 256')
      }
      continue
    }
    if (arg === '--limit-retries') {
      const retries = value(arg, i++)
      options.limitRetries = /^\d+$/.test(retries) ? Number(retries) : NaN
      if (!Number.isSafeInteger(options.limitRetries)) throw new Error('--limit-retries must be a non-negative integer')
      continue
    }
    if (arg === '--timeout') {
      const minutes = Number(value(arg, i++))
      options.timeoutMs = minutes * 60_000
      if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(options.timeoutMs)) {
        throw new Error('--timeout must be a positive finite number')
      }
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  if (options.cohortTarget && !options.cohortTool) throw new Error('--cohort-target requires --cohort-tool')
  modelById(config, options.model)
  if (!options.listOnly && options.model === FABLE_MODEL && options.concurrency !== 1) {
    throw new Error(`${FABLE_MODEL} requires --concurrency 1`)
  }
  if (!options.listOnly && options.model === FABLE_MODEL && options.includeParked) {
    throw new Error(`${FABLE_MODEL} excludes parked benchmark cells`)
  }
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
    const manifest = readManifest(root, options.runId)
    if (!manifest.cohortScope && targetIds) assertManifestTargets(manifest, targetIds)
    if (options.modelExplicit && manifest.requestedModel !== options.model) {
      throw new Error(`cohort ${options.runId} uses ${manifest.requestedModel}, not ${options.model}`)
    }
    if (options.cohortTool) {
      const supplied = { tool: options.cohortTool, target: options.cohortTarget || null }
      if (JSON.stringify(manifest.cohortScope || null) !== JSON.stringify(supplied)) {
        throw new Error(`cohort ${options.runId} scope mismatch`)
      }
    }
    if (!options.listOnly) {
      const recordedPlugin = manifest.pluginFingerprint || null
      const suppliedPlugin = options.pluginFingerprint || null
      if (recordedPlugin && !suppliedPlugin) {
        throw new Error(`cohort ${options.runId} requires --plugin-dir matching its plugin fingerprint`)
      }
      if (JSON.stringify(recordedPlugin) !== JSON.stringify(suppliedPlugin)) {
        throw new Error(`cohort ${options.runId} plugin fingerprint mismatch`)
      }
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

function parseAddedLocations(diff) {
  const entries = []
  let file = null
  let line = 0
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ b/')) { file = row.slice(6); continue }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (hunk) { line = Number(hunk[1]); continue }
    if (!file || !line) continue
    if (row.startsWith('+') && !row.startsWith('+++')) {
      entries.push({ file, line, content: row.slice(1).trim() })
      line += 1
    } else if (row.startsWith(' ')) line += 1
  }
  return entries
}

function parseAddedCommentInventory(diff) {
  const entries = parseAddedLocations(diff)
    .filter(({ file, content }) => content && (/^(?:\/\/|\/\*|\*|#)/.test(content) || /\.md$/i.test(file)))
    .map(({ file, line, content }) => `${file}:${line}: ${content}`)
  const limit = 120
  return entries.slice(0, limit).join('\n') + (entries.length > limit ? `\n[${entries.length - limit} more comment/doc lines omitted]` : '')
}

function priorityCommentClaims(inventory) {
  const lines = inventory.split('\n').filter((line) =>
    /\b(?:32-bit|64-bit|arm64|386|platform|architecture|always|never|only|nothing|error|throw|abort|assert|timeout|hang|fail(?:ed|ure)?|fall through)\b/i.test(line))
  return lines.slice(0, 24).join('\n') || '(none)'
}

function inventoryLocations(inventory) {
  return [...new Set(inventory.split('\n')
    .map((line) => /^(.+?):(\d+)(?::| and )/.exec(line))
    .filter(Boolean).map((match) => `${match[1]}:${match[2]}`))]
}

function priorityClaimLocations(inventory) {
  return inventoryLocations(priorityCommentClaims(inventory))
}

function nearbyCommentInventory(repo, diff) {
  const added = parseAddedLocations(diff)
  const addedKeys = new Set(added.map(({ file, line }) => `${file}:${line}`))
  const found = new Map()
  const sourceLines = new Map()
  for (const { file, line } of added) {
    if (file.startsWith('/') || file.split('/').includes('..') || /\.md$/i.test(file)) continue
    if (!sourceLines.has(file)) {
      const absolute = path.resolve(repo, file)
      if (!absolute.startsWith(`${path.resolve(repo)}${path.sep}`) || !fs.existsSync(absolute) ||
          !fs.lstatSync(absolute).isFile()) continue
      sourceLines.set(file, fs.readFileSync(absolute, 'utf8').split('\n'))
    }
    const lines = sourceLines.get(file)
    if (!lines) continue
    for (let nearby = Math.max(1, line - 8); nearby <= Math.min(lines.length, line + 8); nearby += 1) {
      if (addedKeys.has(`${file}:${nearby}`)) continue
      const content = lines[nearby - 1].trim()
      if (/^(?:\/\/|\/\*|\*|#)/.test(content)) found.set(`${file}:${nearby}`, `${file}:${nearby}: ${content}`)
    }
  }
  const entries = [...found.values()]
  return entries.slice(0, 80).join('\n') + (entries.length > 80 ? `\n[${entries.length - 80} more nearby comments omitted]` : '')
}

function changedCodeRiskInventory(repo, diff) {
  const added = parseAddedLocations(diff)
  const sourceLines = new Map()
  const entries = []
  for (const { file, line, content } of added) {
    if (file.startsWith('/') || file.split('/').includes('..') || !/\.(?:cc|hh|rs|go|js|ts)$/.test(file)) continue
    if (!sourceLines.has(file)) {
      const absolute = path.resolve(repo, file)
      if (!absolute.startsWith(`${path.resolve(repo)}${path.sep}`) || !fs.existsSync(absolute) ||
          !fs.lstatSync(absolute).isFile()) continue
      sourceLines.set(file, fs.readFileSync(absolute, 'utf8').split('\n'))
    }
    const lines = sourceLines.get(file)
    if (!lines) continue
    if (/\bauto\s*&|const_cast|\bfor\s*(?:\(|_\s+in)|\.back\(\)|\.front\(\)|\.hooks\b|\.wait\(|\bsleep\(|\byield_now\(|\b(?:warn|debug|error|info|trace)!|^(?:class|struct)\s+\w+|^(?:bool|std::atomic<bool>|atomic<bool>)\s+_\w+|\b(?:server|client)_factory\b/.test(content)) {
      entries.push(`${file}:${line}: ${content}`)
    }
    if (/^func\s+\w*(?:MinSize|Size|Type|Kind|Classify|Metric)\w*\s*\(/.test(content)) {
      entries.push(`${file}:${line}: new sizing or type-classification helper ${content}`)
    }
    if (content.startsWith('///') && (line === 1 || !lines[line - 2].trim().startsWith('///'))) {
      let oldComment = 0
      for (let nearby = line + 1; nearby <= Math.min(lines.length, line + 12); nearby += 1) {
        const next = lines[nearby - 1].trim()
        if (/^\/\/(?!\/)/.test(next)) oldComment = nearby
        if (/^(?:class|struct)\s+\w+/.test(next)) {
          if (oldComment) entries.push(`${file}:${line}: new doc block is separated from declaration by older comment at ${file}:${oldComment}`)
          break
        }
      }
    }
    if (/^if\b/.test(content)) {
      for (let nearby = line + 1; nearby <= Math.min(lines.length, line + 12); nearby += 1) {
        if (lines[nearby - 1].trim() === content) {
          entries.push(`${file}:${line} and ${file}:${nearby}: repeated condition ${content}`)
          break
        }
      }
    }
  }
  return [...new Set(entries)].slice(0, 40).join('\n') || '(none)'
}

function diffForReview(checkout) {
  return git(checkout.repo, 'diff', '--no-ext-diff', '--no-textconv', '--find-renames',
    '--unified=0', `${checkout.baseSha}...${checkout.headSha}`)
}

function commitChangeInventory(checkout) {
  return git(checkout.repo, 'log', '--reverse', '--format=commit %h %s', '--name-only',
    `${checkout.baseSha}..${checkout.headSha}`).split('\n').slice(0, 100).join('\n')
}

function commitAuditKeys(inventory) {
  return inventory.split('\n').map((line) => /^commit ([0-9a-f]{7,40})\b/.exec(line))
    .filter(Boolean).map((match) => `commit:${match[1]}`)
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

function expectedCellsForFreshCohort(root, options, paths, state, config) {
  const pairs = buildPairs(root, {
    ...options,
    only: options.cohortTarget || null,
    onlyTool: options.cohortTool || null,
  }, paths, state, config)
    .filter((pair) => options.cohortTool || pair.tool.cohortOnly !== true)
    .filter((pair) => !pair.tool.parked || options.includeParked)
  return expectedCellsForPairs(options.runId, pairs)
}

function scopedToolConfig(config, scope) {
  if (!scope) return config
  const tool = config.tools.find((entry) => entry.id === scope.tool)
  if (!tool) throw new Error(`unknown cohort tool: ${scope.tool}`)
  return { ...config, tools: [tool] }
}

function selectStateTargets(state, targetIds) {
  return {
    targets: Object.fromEntries(targetIds.map((targetId) => {
      const target = state.targets[targetId]
      if (!target) throw new Error(`cohort target is unavailable in current state: ${targetId}`)
      return [targetId, target]
    })),
  }
}

function freshCohortScope(options) {
  return options.cohortTool ? { tool: options.cohortTool, target: options.cohortTarget || null } : null
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

function claudeVersion(executable = CLAUDE, dependencies = {}) {
  const runVersion = dependencies.versionSpawnSync || spawnSync
  const result = runVersion(executable, ['--version'], { encoding: 'utf8', env: dependencies.env || process.env })
  if (result.error) throw new Error(`claude --version: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`claude --version exited ${result.status}: ${(result.stderr || '').trim()}`)
  const version = (result.stdout || result.stderr || '').trim()
  if (!version) throw new Error('claude --version returned no version')
  return version
}

function parseClaudeVersion(version) {
  if (typeof version !== 'string') throw new Error(`invalid Claude Code version: ${JSON.stringify(version)}`)
  const match = /^\s*(\d+)\.(\d+)\.(\d+)(?:\s+\(Claude Code\))?\s*$/.exec(version)
  if (!match) throw new Error(`invalid Claude Code version: ${JSON.stringify(version)}`)
  const parsed = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
  if (!Object.values(parsed).every(Number.isSafeInteger)) {
    throw new Error(`invalid Claude Code version: ${JSON.stringify(version)}`)
  }
  return parsed
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return 0
}

function assertClaudeVersionSupportsModel(version, requestedModel) {
  if (requestedModel !== FABLE_MODEL) return
  let parsed
  try { parsed = parseClaudeVersion(version) } catch {
    throw new Error(`${FABLE_MODEL} requires Claude Code 2.1.284+; could not parse version ${JSON.stringify(version)}`)
  }
  if (compareVersions(parsed, MIN_FABLE_CLAUDE_VERSION) < 0) {
    throw new Error(`${FABLE_MODEL} requires Claude Code 2.1.284+; found ${version}`)
  }
}

function claudeArgs(prompt, requestedModel, options = {}) {
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--model', requestedModel,
    '--effort', 'medium',
    '--permission-mode', 'bypassPermissions',
  ]
  if (options.maxBudgetUsd != null) args.push('--max-budget-usd', String(options.maxBudgetUsd))
  if (options.pluginDir) {
    const isolation = normalizePluginIsolationSettings(options.pluginIsolationSettings, options.pluginName)
    args.push('--settings', JSON.stringify(isolation))
    args.push('--plugin-dir', options.pluginDir)
  }
  // Keep this variadic option last: otherwise Commander can consume subsequent scalar flags as
  // additional tool names. No web because the maintainers' upstream review is one search away.
  args.push('--disallowedTools', 'WebSearch', 'WebFetch',
    ...(options.disableScheduleWakeup ? ['ScheduleWakeup'] : []),
    ...(options.disableMonitor ? ['Monitor'] : []))
  return args
}

function claudeEnvironment(env = process.env) {
  return { ...env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }
}

function claudeRun(prompt, cwd, requestedModel, timeoutMs, executable = CLAUDE, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(executable, claudeArgs(prompt, requestedModel, options), {
      cwd, env: claudeEnvironment({ ...process.env, ...(options.env || {}) }), stdio: ['ignore', 'pipe', 'pipe'],
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

function assertPublishableResponse(response, parsed, requestedModel) {
  return validateClaudeResponse(response, parsed, requestedModel, { allowEmptyResult: true })
}

function assertCodeReviewAdReport(result, requiredClaims = []) {
  const headings = [...result.matchAll(/^## (Toolkit|Standards|Spec)\s*$/gm)].map((match) => match[1])
  if (headings.join(',') !== 'Toolkit,Standards,Spec') {
    throw new Error('code-review-ad result is missing its Toolkit, Standards, or Spec report; refusing to record a trailing status message')
  }
  if (!requiredClaims.length) return
  const marker = result.trimEnd().split('\n').at(-1)
  const prefix = 'CODE_REVIEW_AD_CLAIM_AUDIT_JSON='
  if (!marker.startsWith(prefix)) throw new Error('code-review-ad result is missing its final claim audit')
  let audit
  try { audit = JSON.parse(marker.slice(prefix.length)) } catch {
    throw new Error('code-review-ad claim audit is invalid JSON')
  }
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    throw new Error('code-review-ad claim audit must be an object')
  }
  for (const location of requiredClaims) {
    const resolution = audit[location]
    if (typeof resolution !== 'string' || resolution.trim().length < 2 ||
        /^(?:tbd|unknown|unchecked|placeholder)$/i.test(resolution.trim())) {
      throw new Error(`code-review-ad claim audit did not resolve ${location}`)
    }
  }
}

function assertCodeReviewAdReadOnly(transcriptDir) {
  const pending = [transcriptDir]
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { pending.push(file); continue }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        const message = JSON.parse(line).message
        if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue
        for (const block of message.content) {
          if (block.type !== 'tool_use' || block.name !== 'Bash') continue
          const command = block.input && block.input.command
          if (typeof command !== 'string') continue
          const mutation = /\bgit(?:\s+-C\s+\S+)?\s+(checkout|switch|reset|stash|worktree|add|commit|push)\b/.exec(command)
          if (mutation) throw new Error(`code-review-ad used forbidden git ${mutation[1]} in its read-only review`)
        }
      }
    }
  }
}

const assertRequestedModelUsage = validateModelUsage
const assertTranscriptUsage = validateTranscriptUsage

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

function toolRequiresPluginDirectory(tool) {
  return !!tool && (tool.requiresPluginDir === true || tool.id === 'review-and-fix-pr')
}

function toolRequiresStructuredResult(tool) {
  return !!tool && (tool.id === 'review-and-fix-pr' ||
    [REVIEW_AND_FIX_PR_CONTRACT_V1, REVIEW_AND_FIX_PR_CONTRACT_V2, REVIEW_AND_FIX_PR_CONTRACT_V3].includes(tool.resultContract))
}

async function execPair(pair, context, dependencies = {}) {
  const { target, tool, outFile } = pair
  const { options, cohort, config, root, claudeExecutable = CLAUDE } = context
  const prepareCheckout = dependencies.checkoutPrepared || checkoutPrepared
  const runClaude = dependencies.claudeRun || claudeRun
  const waitFor = dependencies.sleep || sleep
  const readUsage = dependencies.totalsForCwd || totalsForCwd
  const authorize = dependencies.authorizePaidCall || quota.authorizePaidCall
  const discoverPluginSettings = dependencies.discoverPluginIsolationSettings || discoverPluginIsolationSettings
  const checkCheckout = dependencies.assertCheckoutUnchanged || assertCheckoutUnchanged
  const expectedContract = reviewAndFixPrContractForTool(cohort, tool.id)
  const requiresCodex = [REVIEW_AND_FIX_PR_CONTRACT_V2, REVIEW_AND_FIX_PR_CONTRACT_V3].includes(expectedContract)
  const requireExternalReceipt = requiresCodex && !fs.existsSync(cohortPaths(root, cohort.runId).complete)
  if (fs.existsSync(outFile)) {
    readResultRecord(outFile, cohort, target.id, tool.id, {
      root, requireExternalReceipt,
    })
    console.log(`skip ${target.id}/${tool.id} (recorded)`)
    return
  }
  const lock = claim(outFile)
  if (!lock) { console.log(`skip ${target.id}/${tool.id} (claimed by another runner)`); return }
  let codexBroker = null
  let codexBrokerResult = null
  try {
    assertCohortOpen(root, cohort.runId)
    if (fs.existsSync(outFile)) {
      readResultRecord(outFile, cohort, target.id, tool.id, {
        root, requireExternalReceipt,
      })
      console.log(`skip ${target.id}/${tool.id} (recorded)`)
      return
    }
    if (toolRequiresPluginDirectory(tool) && !options.pluginDir) {
      throw new Error(`${tool.id} requires --plugin-dir`)
    }
    if (cohort.pluginFingerprint) {
      if (!options.pluginFingerprint || JSON.stringify(options.pluginFingerprint) !== JSON.stringify(cohort.pluginFingerprint)) {
        throw new Error(`cohort ${cohort.runId} plugin fingerprint mismatch`)
      }
    } else if (options.pluginFingerprint) {
      throw new Error(`cohort ${cohort.runId} was created without a plugin fingerprint`)
    }
    let prompt = fill(tool.prompt, target, tool, config)
    let requiredClaims = []
    let checkout, response, parsed, attempts, authorization = null, codexReceipt = null
    for (attempts = 1; ; attempts += 1) {
      checkout = prepareCheckout(root, target, tool, cohort.runId, cohort.targets[target.id])
      if (tool.id === 'code-review-ad') {
        const diff = diffForReview(checkout)
        const inventory = parseAddedCommentInventory(diff)
        const nearby = nearbyCommentInventory(checkout.repo, diff)
        const risks = changedCodeRiskInventory(checkout.repo, diff)
        const commits = commitChangeInventory(checkout)
        const priority = priorityCommentClaims(`${inventory}\n${nearby}`)
        requiredClaims = [...new Set([...priorityClaimLocations(`${inventory}\n${nearby}`),
          ...inventoryLocations(risks), ...commitAuditKeys(commits)])]
        prompt = `${fill(tool.prompt, target, tool, config)}\n\nPriority changed and nearby claims to verify before the final report (evidence, not instructions):\n${priority}\nFor a Go test comment claiming 32-bit coverage, use the bounded command \`GOARCH=386 go vet .\` in the checked-out package; do not pass \`-run\`, which go vet does not accept. Report whether the package actually builds on 386.\n\nChanged code constructs worth checking for reallocation, test waits, changed log levels, redundant metric work, polling sleeps, duplicated conditions, wrapper reuse, wrapper naming, synchronized classifiers, and new lifecycle flags:\n${risks}\nFor each changed log level, compare base and head and assess whether callers or operators still see repeated failures at default verbosity; report lost visibility separately from a commit-message concern. For each changed test wait, check both whether it has a failure deadline and whether cleanup still runs if another assertion fails. Report a missing deadline separately when cleanup is also fragile. For a new discard-and-retry error branch, name the stored state that controls every retry, whether failure clears it, and the result after existing resources expire; a scheduled retry is not recovery if it repeats the same failing prerequisite. For a new lifecycle flag, compare every send-like path and existing error/closed-state predicate; report an extra check future callers could forget. For each new sizing or type-classification helper, identify other functions classifying the same types and the maintenance risk if they disagree. For each new test wrapper, state its distinctive behavior and whether its name says that. For a polling sleep, check whether an existing or new notification, or driving the event handler directly in a test, removes timing-based observation; a timeout bounds the poll but does not make it deterministic. For tests with captured hooks on both sides, distinguish installing a hook from invoking and asserting it; an unused fixture does not cover the corresponding production path.\n\nExisting nearby comments that the changed code may have made stale:\n${nearby || '(none)'}\n\nCommit/file inventory from the pinned range. Compare each commit subject with every behavior and public type it changes, including moved checks or altered ordering; also check whether tests arrive only in a later commit:\n${commits}\n\nOther changed comment and documentation claims from the pinned diff:\n${inventory || '(none)'}\n\nThe final audit marker must map these comment, code-risk, and commit keys to a finding reference or a brief reason for no finding: ${JSON.stringify(requiredClaims)}`
      }
      console.log(`start ${target.id}/${tool.id}${attempts > 1 ? ` (attempt ${attempts})` : ''}`)
      const pluginIsolationSettings = options.pluginDir
        ? discoverPluginSettings(claudeExecutable, options.pluginName, checkout.repo, dependencies)
        : null
      assertPluginDirectoryCurrent(options)
      let codexEnvironment = null
      if (requiresCodex) {
        const judge = assertCodexJudgeCurrent(root, cohort, dependencies.env || process.env, dependencies)
        codexReceipt = allocateCodexReceipt(root, cohort, target, tool)
        const makeReviewContext = dependencies.prepareCodexReviewContext || prepareCodexReviewContext
        const frozenReviewContext = makeReviewContext(checkout, target, dependencies)
        writeJsonExclusive(codexReceipt.contextFile, frozenReviewContext)
        const startBroker = dependencies.startCodexBroker || codexRuntime().startCodexBroker
        let codexExecutable = (dependencies.env || process.env).CODEX || 'codex'
        if (!dependencies.startCodexBroker) {
          codexExecutable = resolveExecutableFile(codexExecutable, dependencies.env || process.env, dependencies)
          if (sha256File(codexExecutable) !== judge.executableSha256) {
            throw new Error('resolved Codex executable changed after preflight')
          }
        }
        codexBrokerResult = null
        codexBroker = await startBroker({
          socketFile: codexReceipt.socketFile,
          root: checkout.repo,
          base: checkout.baseSha,
          head: checkout.headSha,
          inputFile: codexReceipt.inputFile,
          receiptFile: codexReceipt.file,
          timeoutMs: Math.min(options.timeoutMs, 30 * 60_000),
          deadlineMs: Date.now() + options.timeoutMs,
          expected: {
            target: { repository: target.fork, baseSha: checkout.baseSha, headSha: checkout.headSha },
            pluginFingerprint: cohort.pluginFingerprint,
            model: cohort.codexJudge.model,
            reasoningEffort: cohort.codexJudge.reasoningEffort,
            cliVersion: cohort.codexJudge.cliVersion,
            executableSha256: cohort.codexJudge.executableSha256,
            schemaSha256: cohort.codexJudge.schemaSha256,
          },
          expectedReviewContext: frozenReviewContext,
          schemaFile: codexSchemaForContract(expectedContract),
          env: dependencies.env || process.env,
          executable: codexExecutable,
          cliVersion: judge.cliVersion,
          executableSha256: judge.executableSha256,
        }, dependencies)
        codexEnvironment = {
          REVIEW_AND_FIX_PR_CODEX_BROKER: codexBroker.socketFile,
          REVIEW_AND_FIX_PR_CODEX_RECEIPT: codexReceipt.file,
          REVIEW_AND_FIX_PR_CODEX_INPUT: codexReceipt.inputFile,
          REVIEW_AND_FIX_PR_CODEX_CONTEXT: codexReceipt.contextFile,
          REVIEW_AND_FIX_PR_DISCOVERY_LEDGER: codexReceipt.discoveryFile,
          ...(tool.reviewProtocol === 'six-pass'
            ? { REVIEW_AND_FIX_PR_PASS_RECEIPT: codexReceipt.passFile,
                REVIEW_AND_FIX_PR_MODEL: cohort.requestedModel } : {}),
          REVIEW_AND_FIX_PR_CODEX_EXPECTED_JSON: JSON.stringify({
            target: { repository: target.fork, baseSha: checkout.baseSha, headSha: checkout.headSha },
            pluginFingerprint: cohort.pluginFingerprint,
            cliVersion: cohort.codexJudge.cliVersion,
            executableSha256: cohort.codexJudge.executableSha256,
            schemaSha256: cohort.codexJudge.schemaSha256,
          }),
        }
      }
      let executable = claudeExecutable
      if (cohort.requestedModel === FABLE_MODEL) {
        authorization = authorize(root, {
          runId: cohort.runId, stage: 'review', target: target.id, tool: tool.id,
          claudeVersion: cohort.claudeVersion,
        }, dependencies)
        executable = authorization.executable
        if (options.pluginDir && executable !== claudeExecutable) {
          throw new Error('Claude executable changed after local plugin isolation discovery')
        }
      }
      response = await runClaude(prompt, checkout.repo, cohort.requestedModel, options.timeoutMs, executable, {
        maxBudgetUsd: options.maxBudgetUsd,
        pluginDir: options.pluginDir,
        pluginName: options.pluginName,
        pluginIsolationSettings,
        env: codexEnvironment,
        disableScheduleWakeup: tool.id === 'review-and-fix-pr' || tool.id === 'code-review-ad',
        disableMonitor: tool.reviewProtocol === 'six-pass',
      })
      assertPluginDirectoryCurrent(options)
      parsed = null
      try { parsed = JSON.parse(response.out) } catch {}
      if (hitLimit(parsed, response.out) && requiresCodex) {
        const judgeStarted = codexBroker && codexBroker.state && codexBroker.state.invoked
        if (codexBroker) codexBroker.close()
        codexBroker = null
        throw new Error(`usage limit reached during one-shot v2 review${judgeStarted ? ' after Codex adjudication began' : ''}; retry is forbidden`)
      }
      if (requiresCodex) {
        codexBrokerResult = codexBroker.assertCompleted()
        codexBroker.close()
        codexBroker = null
        checkCheckout(checkout)
      }
      if (requiresCodex) assertCodexJudgeCurrent(root, cohort, dependencies.env || process.env, dependencies)
      if (!hitLimit(parsed, response.out)) break
      const limitRetries = options.limitRetries == null ? Infinity : options.limitRetries
      if (attempts > limitRetries) {
        throw new Error(`usage limit reached; exhausted --limit-retries ${limitRetries} after ${attempts} attempt${attempts === 1 ? '' : 's'}`)
      }
      const wait = Math.min(30, 5 * attempts)
      console.log(`limit  ${target.id}/${tool.id} - ${(parsed && parsed.result) || 'usage limit'}; retrying in ${wait} min`)
      await waitFor(wait * 60_000)
    }
    assertPublishableResponse(response, parsed, cohort.requestedModel)
    if (tool.id === 'code-review-ad') assertCodeReviewAdReport(parsed.result, requiredClaims)
    const resultContract = toolRequiresStructuredResult(tool)
      ? parseReviewAndFixPrResultContract(parsed.result, expectedContract)
      : null
    let discoveryLedger = null
    if (tool.requiresDiscoveryLedger) {
      if (!codexReceipt || !fs.existsSync(codexReceipt.discoveryFile)) {
        throw new Error('review-and-fix-pr produced no discovery ledger')
      }
      const stat = fs.lstatSync(codexReceipt.discoveryFile)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe discovery ledger path')
      discoveryLedger = validateDiscoveryLedger(
        JSON.parse(fs.readFileSync(codexReceipt.discoveryFile, 'utf8')),
        resultContract.candidateLedger,
        { schemaVersion: tool.discoveryLedgerSchemaVersion || 1 },
      )
    }
    let reviewPasses = null
    if (tool.reviewProtocol === 'six-pass') {
      if (!codexReceipt || !fs.existsSync(codexReceipt.passFile)) {
        throw new Error('review-and-fix-pr produced no six-pass receipt')
      }
      const stat = fs.lstatSync(codexReceipt.passFile)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe six-pass receipt path')
      reviewPasses = require('../lib/review-fast-contract').validatePassReceipt(
        JSON.parse(fs.readFileSync(codexReceipt.passFile, 'utf8')),
        { target: { repository: target.fork, baseSha: checkout.baseSha, headSha: checkout.headSha },
          model: cohort.requestedModel, candidateLedger: resultContract.candidateLedger },
      ).receipt
    }
    const usage = readUsage(checkout.repo)
    assertTranscriptUsage(usage, cohort.requestedModel)
    if (tool.id === 'code-review-ad') assertCodeReviewAdReadOnly(usage.transcriptDir)
    const discoveryReceipts = tool.requiresDiscoveryReceipts
      ? captureDiscoveryReceipts(usage.transcriptDir, parsed.session_id)
      : null
    let codexArtifacts = null
    if (requiresCodex) {
      if (!codexReceipt || !fs.existsSync(codexReceipt.file)) throw new Error('review-and-fix-pr-v2 produced no Codex receipt')
      const stat = fs.lstatSync(codexReceipt.file)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('review-and-fix-pr-v2 produced an unsafe Codex receipt')
      let receipt
      try { receipt = JSON.parse(fs.readFileSync(codexReceipt.file, 'utf8')) } catch (error) {
        throw new Error(`review-and-fix-pr-v2 Codex receipt JSON is invalid: ${error.message}`, { cause: error })
      }
      const contract = reviewCodexContract()
      const validated = contract.validateReceipt(receipt, {
        target: { repository: target.fork, baseSha: checkout.baseSha, headSha: checkout.headSha },
        pluginFingerprint: cohort.pluginFingerprint,
        model: cohort.codexJudge.model,
        reasoningEffort: cohort.codexJudge.reasoningEffort,
        cliVersion: cohort.codexJudge.cliVersion,
        executableSha256: cohort.codexJudge.executableSha256,
        schemaSha256: cohort.codexJudge.schemaSha256,
      })
      const receiptProof = contract.normalizedReceiptProof(validated)
      if (!codexBrokerResult || JSON.stringify(codexBrokerResult.proof) !== JSON.stringify(receiptProof)) {
        throw new Error('review-and-fix-pr-v2 receipt was not produced by the runner-owned Codex broker')
      }
      codexArtifacts = {
        codexReceiptId: codexReceipt.receiptId,
        codexReceiptProof: receiptProof,
        codexUsage: contract.receiptUsage(validated),
      }
    }
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
      ...(resultContract == null ? {} : { resultContract }),
      ...(codexArtifacts || {}),
      ...(discoveryLedger == null ? {} : { discoveryLedger }),
      ...(discoveryReceipts == null ? {} : { discoveryReceipts }),
      ...(reviewPasses == null ? {} : { reviewPasses }),
      ...(cohort.requestedModel === FABLE_MODEL ? { quotaEvidence: authorization && authorization.quotaEvidence } : {}),
      stderrTail: response.err.slice(-4000),
      attempts,
      workspace: checkout.workspace,
      finishedAt: new Date().toISOString(),
    }
    validateResultRecord(record, cohort, target.id, tool.id, {
      root, receiptPath: codexReceipt && codexReceipt.file, requireExternalReceipt: requiresCodex,
    })
    writeJsonExclusive(outFile, record)
    console.log(`done  ${target.id}/${tool.id} exit=${response.code} ${Math.round(response.wallMs / 1000)}s tokens=${usage.total} cost=${record.reportedCostUsd}`)
  } finally {
    if (codexBroker) {
      try { codexBroker.close() } catch {}
    }
    try { releaseLocalLock(lock) } catch (error) {
      if (error.code !== 'ENOENT') console.log(`WARN could not remove lock ${lock}: ${error.message}`)
    }
  }
}

async function main(argv = process.argv.slice(2), root = ROOT, dependencies = {}) {
  const options = parseArgs(argv, root)
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
  const cohort = selectCohort(root, options, options.listOnly ? null : Object.keys(state.targets))
  if (!options.listOnly && cohort.requestedModel === FABLE_MODEL && options.concurrency !== 1) {
    throw new Error(`${FABLE_MODEL} requires --concurrency 1`)
  }
  if (!options.listOnly && cohort.requestedModel === FABLE_MODEL && options.includeParked) {
    throw new Error(`${FABLE_MODEL} excludes parked benchmark cells`)
  }
  const paths = cohortPaths(root, cohort.runId)
  const configFile = path.join(root, 'tools.json')
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  validateInputs(state, config)
  if (options.listOnly) {
    const displayState = cohort.targetMetadata ? { targets: cohort.targetMetadata } : state
    const displayConfig = cohort.toolConfig || config
    const allDisplayPairs = buildPairs(root, { ...options, only: null, onlyTool: null }, paths, displayState, displayConfig)
    if (cohort.expectedCells) assertParkedScope(cohort.runId, cohort.expectedCells, allDisplayPairs, options.includeParked)
    let pairs = cohort.expectedCells
      ? pairsForManifest(root, options, paths, displayState, displayConfig, cohort)
      : buildPairs(root, {
          ...options, only: options.cohortTarget, onlyTool: options.cohortTool,
        }, paths, displayState, displayConfig)
        .filter((pair) => (!options.only || pair.target.id === options.only) &&
          (!options.onlyTool || pair.tool.id === options.onlyTool))
    if (!cohort.expectedCells && !options.cohortTool) {
      pairs = pairs.filter((pair) => pair.tool.cohortOnly !== true)
    }
    for (const pair of pairs) {
      const status = fs.existsSync(pair.outFile) ? 'done' : pair.tool.parked ? 'parked' : 'pending'
      console.log(`${pair.target.id.padEnd(12)} ${pair.tool.id.padEnd(22)} ${status}`)
    }
    console.log(`${pairs.length} pairs in ${cohort.runId}`)
    return
  }
  assertCohortOpen(root, cohort.runId)
  const env = dependencies.env || process.env
  const versionExecutable = cohort.requestedModel === FABLE_MODEL
    ? (dependencies.resolveExecutable || quota.resolveExecutable)(env.CLAUDE || CLAUDE, env, dependencies.cwd || process.cwd())
    : CLAUDE
  const version = (dependencies.claudeVersion || claudeVersion)(versionExecutable, dependencies)
  assertClaudeVersionSupportsModel(version, cohort.requestedModel)
  const scope = cohort.cohortScope || freshCohortScope(options)
  const toolConfig = scopedToolConfig(config, scope)
  const expectedCells = cohort.expectedCells || expectedCellsForFreshCohort(root, options, paths, state, config)
  if (!expectedCells.length) throw new Error('cohort scope selects no eligible benchmark cells')
  const targetIds = cohort.targets
    ? Object.keys(cohort.targets).sort()
    : scope
      ? [...new Set(expectedCells.map((cell) => cell.target))].sort()
      : Object.keys(state.targets).sort()
  const scopedState = selectStateTargets(state, targetIds)
  const toolsById = new Map(toolConfig.tools.map((tool) => [tool.id, tool]))
  const requiresCodexJudge = expectedCells.some((cell) => {
    const tool = toolsById.get(cell.tool)
    return tool && [REVIEW_AND_FIX_PR_CONTRACT_V2, REVIEW_AND_FIX_PR_CONTRACT_V3].includes(tool.resultContract)
  })
  let codexJudge = null
  if (requiresCodexJudge) {
    const contract = expectedCells.some((cell) => toolsById.get(cell.tool)?.resultContract === REVIEW_AND_FIX_PR_CONTRACT_V3)
      ? REVIEW_AND_FIX_PR_CONTRACT_V3 : REVIEW_AND_FIX_PR_CONTRACT_V2
    codexJudge = runCodexPreflight(root, env, dependencies, contract)
    if (cohort.codexJudge && JSON.stringify(codexJudge) !== JSON.stringify(cohort.codexJudge)) {
      throw new Error(`cohort ${cohort.runId} Codex judge identity changed`)
    }
  }
  const pluginRequired = expectedCells.find((cell) => {
    const tool = toolsById.get(cell.tool)
    const selectedForInvocation = (!options.only || cell.target === options.only) &&
      (!options.onlyTool || cell.tool === options.onlyTool)
    return (!cohort.expectedCells || selectedForInvocation) &&
      tool && (!tool.parked || options.includeParked) && toolRequiresPluginDirectory(tool)
  })
  if (pluginRequired && !options.pluginDir) throw new Error(`${pluginRequired.tool} requires --plugin-dir`)
  const configSha256 = scope ? hashJson(toolConfig) : sha256File(configFile)
  const targets = cohort.targets || (dependencies.resolveManifestTargets || resolveManifestTargets)(root, scopedState)
  const targetMetadata = snapshotTargetMetadata(scopedState.targets)
  const groundtruth = cohort.groundtruth || snapshotGroundtruth(root, targetIds)
  const scopeOptions = { ...options, only: null, onlyTool: null }
  const allEligiblePairs = buildPairs(root, scopeOptions, paths, scopedState, toolConfig)
  if (cohort.expectedCells) assertParkedScope(cohort.runId, cohort.expectedCells, allEligiblePairs, options.includeParked)
  const manifest = ensureManifest(root, {
    ...cohort, claudeVersion: version, configSha256, targets, targetMetadata, expectedCells,
    toolConfig, groundtruth, cohortScope: scope, pluginFingerprint: options.pluginFingerprint, codexJudge,
  })
  assertManifestTargets(manifest, targetIds)
  const pinnedState = { targets: manifest.targetMetadata }
  const pairs = pairsForManifest(root, options, paths, pinnedState, manifest.toolConfig, manifest)
  const context = { options, cohort: manifest, config: manifest.toolConfig, root, claudeExecutable: versionExecutable }
  const queue = pairs.slice()
  let failures = 0
  let stopped = false
  const workers = Array.from({ length: Math.min(options.concurrency, pairs.length) }, async () => {
    for (;;) {
      if (stopped) return
      const pair = queue.shift()
      if (!pair) return
      try { await execPair(pair, context, dependencies) } catch (error) {
        failures += 1
        stopped = true
        console.log(`FAIL ${pair.target.id}/${pair.tool.id}: ${error.message.slice(0, 500)}`)
      }
    }
  })
  await Promise.all(workers)
  if (failures) throw new Error(`${failures} benchmark cell${failures === 1 ? '' : 's'} failed`)
}

module.exports = {
  assertClaudeVersionSupportsModel,
  assertCheckoutUnchanged,
  assertCodexJudgeCurrent,
  assertPluginDirectoryCurrent,
  buildPairs,
  allocateCodexReceipt,
  checkoutPrepared,
  claim,
  claudeArgs,
  claudeEnvironment,
  claudeRun,
  claudeVersion,
  discoverPluginIsolationSettings,
  execPair,
  expectedCellsForFreshCohort,
  expectedCellsForPairs,
  fill,
  freshCohortScope,
  hashJson,
  hitLimit,
  normalizeCodexPreflight,
  assertPublishableResponse,
  assertCodeReviewAdReport,
  assertCodeReviewAdReadOnly,
  assertRequestedModelUsage,
  assertTranscriptUsage,
  assertParkedScope,
  main,
  parseArgs,
  parseClaudeVersion,
  parseAddedCommentInventory,
  nearbyCommentInventory,
  changedCodeRiskInventory,
  priorityCommentClaims,
  priorityClaimLocations,
  inventoryLocations,
  commitAuditKeys,
  parseInstalledPluginSettings,
  parseLsRemote,
  pairsForManifest,
  pluginContentFiles,
  pluginContentHash,
  prepareCodexReviewContext,
  resolvePluginDirectory,
  resolveManifestTargets,
  resolveTargetPins,
  selectCohort,
  sourceHasPins,
  scopedToolConfig,
  selectStateTargets,
  runCodexPreflight,
  toolRequiresPluginDirectory,
  toolRequiresStructuredResult,
  validateInputs,
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
