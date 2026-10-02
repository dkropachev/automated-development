'use strict'
// Run one deliberately unpublishable Claude pilot while enforcing a cumulative dollar ceiling.
//
// Pilot state lives only under ignored bench/work/pilots/<id>/. Before each process starts, the
// ledger reserves every remaining dollar. A wrapper crash therefore leaves both an open
// reservation and an exclusive lock: either one makes a later invocation fail closed instead of
// silently granting the process a fresh budget.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { totalsForCwd } = require('./lib/usage')
const { resolvePluginDirectory } = require('./run')

const ROOT = __dirname
const CLAUDE = process.env.CLAUDE || 'claude'
const BIG = 1 << 28
const NANOS_PER_USD = 1_000_000_000
const MAX_TIMEOUT_MS = 2_147_483_647
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const DISABLED_INSTALLED_PLUGIN_SETTINGS = Object.freeze({
  enabledPlugins: { 'automated-development@automated-development': false },
})

function valueAfter(argv, flag, index) {
  const value = argv[index + 1]
  if (value == null || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || value === '.' || value === '..') {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)}`)
  }
  return value
}

function usdNanos(value, label = 'USD amount') {
  const number = typeof value === 'number' ? value : Number(value)
  const nanos = Math.floor(number * NANOS_PER_USD)
  if (!Number.isFinite(number) || number <= 0 || !Number.isSafeInteger(nanos) || nanos <= 0) {
    throw new Error(`${label} must be a positive finite amount representable to USD nanos`)
  }
  return nanos
}

function costNanos(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  const nanos = Math.ceil(value * NANOS_PER_USD)
  return Number.isSafeInteger(nanos) && nanos >= 0 ? nanos : null
}

function formatUsd(nanos) {
  if (!Number.isSafeInteger(nanos) || nanos < 0) throw new Error(`invalid USD nanos: ${nanos}`)
  const whole = Math.floor(nanos / NANOS_PER_USD)
  const fraction = String(nanos % NANOS_PER_USD).padStart(9, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

function assertExistingPathSafe(target, kind, label) {
  const absolute = path.resolve(target)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (!fs.existsSync(current)) throw new Error(`${label} does not exist: ${absolute}`)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink ${label} path: ${current}`)
    if (current !== absolute && !stat.isDirectory()) {
      throw new Error(`${label} path component is not a directory: ${current}`)
    }
  }
  const stat = fs.lstatSync(absolute)
  if (kind === 'directory' && !stat.isDirectory()) throw new Error(`${label} is not a directory: ${absolute}`)
  if (kind === 'file' && !stat.isFile()) throw new Error(`${label} is not a regular file: ${absolute}`)
  return absolute
}

function ensureDirectorySafe(directory) {
  const absolute = path.resolve(directory)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (!fs.existsSync(current)) {
      try { fs.mkdirSync(current, { mode: 0o700 }) } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`refusing unsafe pilot directory path: ${current}`)
    }
  }
  return absolute
}

function fsyncDirectory(directory) {
  let descriptor
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } finally {
    if (descriptor != null) fs.closeSync(descriptor)
  }
}

function writeFileAtomic(file, content, options = {}) {
  const directory = ensureDirectorySafe(path.dirname(file))
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe output path: ${file}`)
    if (!options.replace) throw new Error(`refusing to replace pilot output: ${file}`)
  }
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`)
  let descriptor = null
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, content)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(temporary, file)
    fsyncDirectory(directory)
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor) } catch {}
    }
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  }
}

function writeLedger(file, ledger) {
  writeFileAtomic(file, JSON.stringify(ledger, null, 2) + '\n', { replace: fs.existsSync(file) })
}

function acquirePilotLock(file, dependencies = {}) {
  ensureDirectorySafe(path.dirname(file))
  const randomUUID = dependencies.randomUUID || crypto.randomUUID
  const nowMs = dependencies.nowMs || Date.now
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID(), acquiredAt: new Date(nowMs()).toISOString() }) + '\n'
  let descriptor
  try {
    descriptor = fs.openSync(file, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`pilot is locked: ${file}; a concurrent or crashed attempt fails closed`, { cause: error })
    }
    throw error
  }
  try {
    fs.writeFileSync(descriptor, owner)
    fs.fsyncSync(descriptor)
  } catch (error) {
    try { fs.closeSync(descriptor) } catch {}
    // The uncertain lock is deliberately retained. Removing it could reopen a budget after a
    // partially durable reservation.
    throw error
  }
  fs.closeSync(descriptor)
  fsyncDirectory(path.dirname(file))
  return { file, owner }
}

function releasePilotLock(lock) {
  if (!lock || !fs.existsSync(lock.file)) return false
  const stat = fs.lstatSync(lock.file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe pilot lock: ${lock.file}`)
  if (fs.readFileSync(lock.file, 'utf8') !== lock.owner) {
    throw new Error(`pilot lock ownership changed: ${lock.file}`)
  }
  fs.unlinkSync(lock.file)
  fsyncDirectory(path.dirname(lock.file))
  return true
}

function pilotPaths(root, pilotId) {
  const id = safeId(pilotId, 'pilot id')
  const pilots = path.join(root, 'work', 'pilots')
  const directory = path.join(pilots, id)
  return {
    id,
    directory,
    attempts: path.join(directory, 'attempts'),
    ledger: path.join(directory, 'ledger.json'),
    lock: path.join(directory, 'active.lock'),
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function equalJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function ledgerState(ledger, expectedId) {
  if (!ledger || ledger.schemaVersion !== 1 || ledger.pilotId !== expectedId) {
    throw new Error(`invalid pilot ledger for ${expectedId}`)
  }
  if (!Number.isSafeInteger(ledger.budgetNanos) || ledger.budgetNanos <= 0 || !Array.isArray(ledger.events)) {
    throw new Error(`invalid pilot budget ledger for ${expectedId}`)
  }
  if (!ledger.invocation || typeof ledger.invocation !== 'object' || Array.isArray(ledger.invocation)) {
    throw new Error(`invalid pilot invocation ledger for ${expectedId}`)
  }
  let committed = 0
  const open = new Map()
  let reservations = 0
  for (let index = 0; index < ledger.events.length; index += 1) {
    const event = ledger.events[index]
    if (!event || event.seq !== index + 1 || !Number.isSafeInteger(event.attempt) || event.attempt <= 0) {
      throw new Error(`invalid pilot ledger event ${index + 1}`)
    }
    if (event.type === 'reserved') {
      reservations += 1
      if (event.attempt !== reservations || open.has(event.attempt) ||
          !Number.isSafeInteger(event.ceilingNanos) || event.ceilingNanos <= 0) {
        throw new Error(`invalid pilot reservation ${event.attempt}`)
      }
      const alreadyReserved = [...open.values()].reduce((sum, value) => sum + value, 0)
      const remaining = Math.max(0, ledger.budgetNanos - committed - alreadyReserved)
      if (event.ceilingNanos !== remaining) throw new Error(`pilot reservation ${event.attempt} does not consume the remaining budget`)
      open.set(event.attempt, event.ceilingNanos)
      continue
    }
    if (event.type === 'settled') {
      const reservation = open.get(event.attempt)
      if (reservation == null || !Number.isSafeInteger(event.chargedNanos) || event.chargedNanos < 0) {
        throw new Error(`invalid pilot settlement ${event.attempt}`)
      }
      if (event.costKnown !== true && event.chargedNanos !== reservation) {
        throw new Error(`unknown pilot cost must exhaust reservation ${event.attempt}`)
      }
      open.delete(event.attempt)
      committed += event.chargedNanos
      if (!Number.isSafeInteger(committed)) throw new Error('pilot spend is not safely representable')
      continue
    }
    throw new Error(`invalid pilot ledger event type at ${index + 1}`)
  }
  const reserved = [...open.values()].reduce((sum, value) => sum + value, 0)
  return {
    attempts: reservations,
    committedNanos: committed,
    openReservations: open,
    remainingNanos: Math.max(0, ledger.budgetNanos - committed - reserved),
  }
}

function readLedger(file, pilotId) {
  if (!fs.existsSync(file)) return null
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe pilot ledger: ${file}`)
  const raw = fs.readFileSync(file, 'utf8')
  if (!raw.endsWith('\n')) throw new Error('invalid pilot ledger: missing durable newline terminator')
  let ledger
  try { ledger = JSON.parse(raw) } catch (error) {
    throw new Error(`invalid pilot ledger JSON: ${error.message}`, { cause: error })
  }
  ledgerState(ledger, pilotId)
  return ledger
}

function parseArgs(argv, workingDirectory = process.cwd()) {
  const options = {
    pilotId: null,
    cwd: null,
    pluginDir: null,
    promptFile: null,
    model: null,
    effort: null,
    timeoutMs: null,
    budgetNanos: null,
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = valueAfter(argv, flag, index)
    index += 1
    let key = flag
    if (['--id', '--pilot', '--pilot-id'].includes(flag)) key = '--id'
    if (seen.has(key)) throw new Error(`${flag} may be supplied only once`)
    seen.add(key)
    if (key === '--id') { options.pilotId = safeId(value, 'pilot id'); continue }
    if (flag === '--cwd') { options.cwd = assertExistingPathSafe(path.resolve(workingDirectory, value), 'directory', 'pilot cwd'); continue }
    if (flag === '--plugin-dir') { options.pluginDir = assertExistingPathSafe(path.resolve(workingDirectory, value), 'directory', 'plugin directory'); continue }
    if (flag === '--prompt-file') { options.promptFile = assertExistingPathSafe(path.resolve(workingDirectory, value), 'file', 'prompt file'); continue }
    if (flag === '--model') { options.model = safeId(value, 'model'); continue }
    if (flag === '--effort') { options.effort = safeId(value, 'effort'); continue }
    if (flag === '--budget-usd') { options.budgetNanos = usdNanos(value, '--budget-usd'); continue }
    if (flag === '--timeout') {
      const minutes = Number(value)
      const milliseconds = Math.ceil(minutes * 60_000)
      if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isSafeInteger(milliseconds) ||
          milliseconds <= 0 || milliseconds > MAX_TIMEOUT_MS) {
        throw new Error('--timeout must be a positive finite number of minutes within the process timeout range')
      }
      options.timeoutMs = milliseconds
      continue
    }
    throw new Error(`unknown argument: ${flag}`)
  }
  for (const [key, flag] of [
    ['pilotId', '--id'], ['cwd', '--cwd'], ['pluginDir', '--plugin-dir'],
    ['promptFile', '--prompt-file'], ['model', '--model'], ['effort', '--effort'],
    ['timeoutMs', '--timeout'], ['budgetNanos', '--budget-usd'],
  ]) {
    if (options[key] == null) throw new Error(`${flag} is required`)
  }
  return options
}

function claudeArgs(prompt, options, remainingNanos) {
  return [
    '-p', prompt,
    '--output-format', 'json',
    '--model', options.model,
    '--effort', options.effort,
    '--permission-mode', 'bypassPermissions',
    '--max-budget-usd', formatUsd(remainingNanos),
    '--settings', JSON.stringify(DISABLED_INSTALLED_PLUGIN_SETTINGS),
    '--plugin-dir', options.pluginDir,
    '--disallowedTools', 'WebSearch', 'WebFetch',
  ]
}

function validReportedCost(stdout) {
  let response
  try { response = JSON.parse(stdout) } catch { return { response: null, nanos: null } }
  if (!response || typeof response !== 'object' || Array.isArray(response)) return { response, nanos: null }
  return { response, nanos: costNanos(response.total_cost_usd) }
}

function transcriptCost(usage) {
  if (!usage || typeof usage !== 'object') return null
  const nanos = costNanos(usage.costUsd)
  if (nanos == null) return null
  // A zero from totalsForCwd with no observed session means "nothing found", not a measured free
  // call. A positive amount is useful even when a test double omits the session count.
  if (nanos === 0 && !(Number.isSafeInteger(usage.sessions) && usage.sessions > 0)) return null
  return nanos
}

function transcriptSummary(usage) {
  if (!usage || typeof usage !== 'object') return null
  const fields = ['input', 'output', 'thinking', 'cacheRead', 'cacheCreation', 'total', 'costUsd', 'sessions']
  return Object.fromEntries(fields.map((field) => [field, usage[field] == null ? null : usage[field]]))
}

function gitOutput(cwd, args, gitSpawnSync = spawnSync, options = {}) {
  const result = gitSpawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    if (options.optional) return null
    const detail = result.error ? result.error.message : String(result.stderr || '').trim()
    throw new Error(`git ${args.join(' ')} failed for pilot cwd: ${detail || `exit ${result.status}`}`)
  }
  const output = String(result.stdout || '').trim()
  if (!output && !options.optional) throw new Error(`git ${args.join(' ')} returned no pilot target identity`)
  return output || null
}

function resolveTargetIdentity(cwd, dependencies = {}) {
  const runGit = dependencies.gitSpawnSync || spawnSync
  const headSha = gitOutput(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], runGit)
  const treeSha = gitOutput(cwd, ['rev-parse', '--verify', 'HEAD^{tree}'], runGit)
  if (!/^[0-9a-f]{40}$/i.test(headSha) || !/^[0-9a-f]{40}$/i.test(treeSha)) {
    throw new Error('pilot cwd returned an invalid Git HEAD or tree identity')
  }
  let baseSha = null
  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
    const candidate = gitOutput(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], runGit, { optional: true })
    if (!candidate) continue
    baseSha = gitOutput(cwd, ['merge-base', headSha, candidate], runGit)
    break
  }
  if (baseSha == null || !/^[0-9a-f]{40}$/i.test(baseSha)) {
    throw new Error('pilot cwd has no pinned main/master merge-base identity')
  }
  const status = runGit('git', ['-C', cwd, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' })
  if (status.error || status.status !== 0) {
    const detail = status.error ? status.error.message : String(status.stderr || '').trim()
    throw new Error(`git status failed for pilot cwd: ${detail || `exit ${status.status}`}`)
  }
  if (String(status.stdout || '').trim()) {
    throw new Error('pilot cwd must be clean; tracked, staged, and untracked changes are not allowed')
  }
  return {
    headSha: headSha.toLowerCase(),
    treeSha: treeSha.toLowerCase(),
    baseSha: baseSha == null ? null : baseSha.toLowerCase(),
  }
}

function invocationSnapshot(options, prompt, plugin, targetIdentity) {
  return {
    pluginFingerprint: plugin.fingerprint,
    promptSha256: crypto.createHash('sha256').update(prompt).digest('hex'),
    targetIdentity,
    model: options.model,
    effort: options.effort,
    timeoutMs: options.timeoutMs,
  }
}

function runPilot(options, root = ROOT, dependencies = {}) {
  const paths = pilotPaths(root, options.pilotId)
  ensureDirectorySafe(paths.attempts)
  const nowMs = dependencies.nowMs || Date.now
  const lock = acquirePilotLock(paths.lock, dependencies)
  let releaseLock = true
  try {
    const prompt = fs.readFileSync(options.promptFile, 'utf8')
    const resolvePlugin = dependencies.resolvePluginDirectory || resolvePluginDirectory
    const plugin = resolvePlugin(options.pluginDir)
    if (!plugin || plugin.directory !== options.pluginDir || !plugin.fingerprint) {
      throw new Error('plugin directory resolver returned an unsafe result')
    }
    const identifyTarget = dependencies.resolveTargetIdentity || resolveTargetIdentity
    const targetIdentity = identifyTarget(options.cwd, dependencies)
    if (!targetIdentity || typeof targetIdentity !== 'object' || Array.isArray(targetIdentity)) {
      throw new Error('pilot target resolver returned an unsafe result')
    }
    const invocation = invocationSnapshot(options, prompt, plugin, targetIdentity)
    let ledger = readLedger(paths.ledger, options.pilotId)
    if (ledger) {
      if (ledger.budgetNanos !== options.budgetNanos) {
        throw new Error(`pilot ${options.pilotId} budget is immutable (${formatUsd(ledger.budgetNanos)} USD)`)
      }
      if (!equalJson(ledger.invocation, invocation)) {
        throw new Error(`pilot ${options.pilotId} invocation inputs changed; use a new pilot id`)
      }
    } else {
      ledger = {
        schemaVersion: 1,
        pilotId: options.pilotId,
        budgetNanos: options.budgetNanos,
        budgetUsd: Number(formatUsd(options.budgetNanos)),
        invocation,
        createdAt: new Date(nowMs()).toISOString(),
        events: [],
      }
    }
    const state = ledgerState(ledger, options.pilotId)
    if (state.remainingNanos <= 0) {
      throw new Error(`pilot ${options.pilotId} has no unreserved budget remaining`)
    }
    const attempt = state.attempts + 1
    const attemptName = String(attempt).padStart(4, '0')
    const attemptDirectory = path.join(paths.attempts, attemptName)
    if (fs.existsSync(attemptDirectory)) throw new Error(`pilot attempt output already exists: ${attemptDirectory}`)
    fs.mkdirSync(attemptDirectory, { mode: 0o700 })
    fsyncDirectory(paths.attempts)
    const responseFile = path.join(attemptDirectory, 'response.txt')
    const stderrFile = path.join(attemptDirectory, 'stderr.txt')
    const startedMs = nowMs()
    ledger.events.push({
      seq: ledger.events.length + 1,
      type: 'reserved',
      attempt,
      at: new Date(startedMs).toISOString(),
      sinceMs: startedMs,
      ceilingNanos: state.remainingNanos,
      ceilingUsd: Number(formatUsd(state.remainingNanos)),
      cwd: options.cwd,
      pluginDir: options.pluginDir,
      promptFile: options.promptFile,
      responseFile: path.relative(paths.directory, responseFile),
      stderrFile: path.relative(paths.directory, stderrFile),
    })
    writeLedger(paths.ledger, ledger)
    // From this point until the settlement is durable, retain the lock on every unexpected error.
    releaseLock = false

    const run = dependencies.spawnSync || spawnSync
    let result
    try {
      result = run(dependencies.executable || CLAUDE, claudeArgs(prompt, options, state.remainingNanos), {
        cwd: options.cwd,
        env: {
          ...(dependencies.env || process.env),
          CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
        },
        encoding: 'utf8',
        maxBuffer: BIG,
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
      })
    } catch (error) {
      result = { status: null, signal: null, stdout: '', stderr: '', error }
    }
    const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout || '')
    const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr || '')
    writeFileAtomic(responseFile, stdout)
    writeFileAtomic(stderrFile, stderr)

    let usage = null
    let usageError = null
    try {
      const readUsage = dependencies.totalsForCwd || totalsForCwd
      usage = readUsage(options.cwd, { since: startedMs })
    } catch (error) {
      usageError = error.message
    }
    const reported = validReportedCost(stdout)
    const reportedNanos = reported.nanos
    const transcriptNanos = transcriptCost(usage)
    const measured = [reportedNanos, transcriptNanos].filter((value) => value != null)
    const costKnown = measured.length > 0
    const chargedNanos = costKnown ? Math.max(...measured) : state.remainingNanos
    const finishedMs = nowMs()
    const timedOut = !!(result.error && result.error.code === 'ETIMEDOUT')
    ledger.events.push({
      seq: ledger.events.length + 1,
      type: 'settled',
      attempt,
      at: new Date(finishedMs).toISOString(),
      exitCode: Number.isSafeInteger(result.status) ? result.status : null,
      signal: typeof result.signal === 'string' ? result.signal : null,
      timedOut,
      processError: result.error ? String(result.error.message || result.error) : null,
      wallMs: Math.max(0, finishedMs - startedMs),
      costKnown,
      reportedCostUsd: reportedNanos == null ? null : Number(formatUsd(reportedNanos)),
      transcriptCostUsd: transcriptNanos == null ? null : Number(formatUsd(transcriptNanos)),
      transcriptUsage: transcriptSummary(usage),
      usageError,
      chargedNanos,
      chargedUsd: Number(formatUsd(chargedNanos)),
      overshootUsd: chargedNanos > state.remainingNanos
        ? Number(formatUsd(chargedNanos - state.remainingNanos))
        : 0,
      budgetRemainingUsd: Number(formatUsd(Math.max(0, state.remainingNanos - chargedNanos))),
    })
    writeLedger(paths.ledger, ledger)
    releaseLock = true
    const status = Number.isSafeInteger(result.status) ? result.status : 1
    const log = dependencies.log || console.log
    log(`pilot ${options.pilotId} attempt ${attempt}: exit=${status} cost=${formatUsd(chargedNanos)} remaining=${formatUsd(Math.max(0, state.remainingNanos - chargedNanos))}`)
    return costKnown && status === 0 && !result.error ? 0 : status || 1
  } finally {
    if (releaseLock) releasePilotLock(lock)
  }
}

function main(argv = process.argv.slice(2), root = ROOT, dependencies = {}) {
  const options = parseArgs(argv, dependencies.workingDirectory || process.cwd())
  return runPilot(options, root, dependencies)
}

module.exports = {
  acquirePilotLock,
  claudeArgs,
  costNanos,
  formatUsd,
  ledgerState,
  main,
  parseArgs,
  pilotPaths,
  readLedger,
  releasePilotLock,
  resolveTargetIdentity,
  runPilot,
  transcriptCost,
  usdNanos,
}

if (require.main === module) {
  try { process.exitCode = main() } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
