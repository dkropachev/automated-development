#!/usr/bin/env node
'use strict'

// Fail-closed quota preflight for paid benchmark calls. Claude Code's structured get_usage
// control request does not send a model prompt, so checking quota consumes no benchmark quota and
// avoids scraping the interactive /usage screen. Only normalized percentages enter the audit log.
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  acquireLocalLock,
  assertSafeId,
  ensureDirectorySafe,
  releaseLocalLock,
  sha256File,
} = require('./lib/artifacts')

const ROOT = __dirname
const FABLE_MODEL = 'claude-fable-5-1'
const MIN_CLAUDE_VERSION = Object.freeze({ major: 2, minor: 1, patch: 284 })
const INITIALIZE_REQUEST_ID = 'quota-initialize'
const USAGE_REQUEST_ID = 'quota-get-usage'
const MAX_OUTPUT = 16 * 1024 * 1024
const QUERY_TIMEOUT_MS = 30_000
const NEXT_CALL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/

const LIMITS = Object.freeze([
  Object.freeze({ label: 'Current session', threshold: 50 }),
  Object.freeze({ label: 'Current week (all models)', threshold: 90 }),
  Object.freeze({ label: 'Current week (Fable)', threshold: 90 }),
])

const QUERY_ARGS = Object.freeze([
  '--print',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--safe-mode',
  '--no-session-persistence',
  '--model', FABLE_MODEL,
  '--effort', 'medium',
])

class CliUsageError extends Error {}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function percent(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must have a finite percent from 0 through 100`)
  }
  return value
}

function resetAt(value, label, allowNull = false) {
  if (allowNull && value === null) return null
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must have a valid resets_at timestamp`)
  }
  return value
}

function normalizeUsage(rows) {
  return LIMITS.map(({ label }) => {
    const percentUsed = percent(rows[label].percent, label)
    return {
      label,
      percentUsed,
      resetsAt: resetAt(rows[label].resetsAt, label, rows[label].allowNullReset === true && percentUsed === 0),
    }
  })
}

// Parse the semantic fields returned by the get_usage control request. In particular, the Fable
// value is selected by its display name rather than by array position.
function parseStructuredUsage(payload) {
  if (!isObject(payload) || payload.rate_limits_available !== true || !isObject(payload.rate_limits)) {
    throw new Error('Claude quota response has no available rate limits')
  }
  const rateLimits = payload.rate_limits
  if (!Array.isArray(rateLimits.limits)) {
    throw new Error('Claude quota response is missing fresh raw limits')
  }
  const findOne = (description, predicate) => {
    const matches = rateLimits.limits.filter((entry) => isObject(entry) && predicate(entry))
    if (matches.length !== 1) {
      throw new Error(`Claude quota response must contain exactly one ${description} limit; found ${matches.length}`)
    }
    return matches[0]
  }
  const session = findOne('session', (entry) => entry.kind === 'session' && entry.scope === null)
  const week = findOne('weekly_all', (entry) => entry.kind === 'weekly_all' && entry.scope === null)
  const fable = findOne('Fable weekly_scoped', (entry) => (
    entry.kind === 'weekly_scoped' && isObject(entry.scope) && isObject(entry.scope.model) &&
    entry.scope.surface === null && entry.scope.model.display_name === 'Fable'
  ))
  const inactiveSession = session.percent === 0 && session.resets_at === null && session.is_active === false
  if (session.resets_at === null && !inactiveSession) {
    throw new Error('Current session may omit resets_at only when inactive at 0%')
  }
  return normalizeUsage({
    'Current session': {
      percent: session.percent, resetsAt: session.resets_at, allowNullReset: inactiveSession,
    },
    'Current week (all models)': { percent: week.percent, resetsAt: week.resets_at },
    'Current week (Fable)': { percent: fable.percent, resetsAt: fable.resets_at },
  })
}

function assertZeroControlSession(session) {
  if (!isObject(session) || session.total_cost_usd !== 0 || session.total_api_duration_ms !== 0 ||
      session.total_lines_added !== 0 || session.total_lines_removed !== 0 ||
      !Number.isFinite(session.total_duration_ms) || session.total_duration_ms < 0 ||
      !isObject(session.model_usage) || Object.keys(session.model_usage).length !== 0) {
    throw new Error('Claude quota query session does not prove zero model usage and cost')
  }
}

function assertAllNumericZero(value, name) {
  if (!isObject(value)) throw new Error(`${name} is invalid`)
  for (const amount of Object.values(value)) {
    if (isObject(amount)) assertAllNumericZero(amount, name)
    else if (typeof amount !== 'number' || !Number.isFinite(amount) || amount !== 0) throw new Error(`${name} does not prove zero usage`)
  }
}

function assertZeroResult(event) {
  if (event.subtype !== 'success' || event.is_error !== false) {
    throw new Error('Claude quota query terminal result was not successful')
  }
  if (event.total_cost_usd !== 0) throw new Error('Claude quota query result does not prove zero cost')
  if (event.duration_api_ms !== 0) {
    throw new Error('Claude quota query result has nonzero API duration')
  }
  if (!Object.hasOwn(event, 'usage')) throw new Error('Claude quota query result is missing usage evidence')
  for (const name of ['usage', 'modelUsage', 'model_usage']) {
    if (event[name] != null) assertAllNumericZero(event[name], `Claude quota query result ${name}`)
  }
}

function controlResponse(events, requestId) {
  const matches = events.filter((event) => (
    isObject(event) && event.type === 'control_response' && isObject(event.response) &&
    event.response.request_id === requestId
  ))
  if (matches.length !== 1) {
    throw new Error(`Claude control stream must contain exactly one ${requestId} response; found ${matches.length}`)
  }
  const response = matches[0].response
  if (response.subtype !== 'success' || !isObject(response.response)) {
    throw new Error(`Claude control request ${requestId} did not succeed`)
  }
  return response.response
}

function parseControlOutput(output) {
  if (typeof output !== 'string' || !output.trim()) throw new Error('Claude control stream was empty')
  const events = output.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    try {
      const event = JSON.parse(line)
      if (!isObject(event)) throw new Error('not an object')
      return event
    } catch {
      throw new Error('Claude control stream contained invalid JSON')
    }
  })
  if (events.some((event) => ['assistant', 'user'].includes(event.type))) {
    throw new Error('Claude quota query unexpectedly contained a model turn')
  }
  controlResponse(events, INITIALIZE_REQUEST_ID)
  const payload = controlResponse(events, USAGE_REQUEST_ID)
  assertZeroControlSession(payload.session)
  const results = events.filter((event) => event.type === 'result')
  if (results.length > 1) throw new Error(`Claude quota query returned ${results.length} terminal results`)
  if (results.length === 1) assertZeroResult(results[0])
  return parseStructuredUsage(payload)
}

// Retained as a fixture/parser boundary for captured or normalized /usage text. It deliberately
// keys each percentage to an exact label and bounds the Fable stanza at "What's contributing";
// unrelated percentages elsewhere in the screen are ignored.
function parseLabeledUsage(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('quota text was empty')
  const plain = text
  if (plain.includes('Refreshing')) throw new Error('quota text is still Refreshing')
  const lines = plain.split(/\r?\n/).map((line) => line.trim())
  const indexes = new Map()
  for (const { label } of LIMITS) {
    const found = []
    for (let i = 0; i < lines.length; i += 1) if (lines[i] === label) found.push(i)
    if (found.length !== 1) throw new Error(`quota text must contain exactly one ${label} label; found ${found.length}`)
    indexes.set(label, found[0])
  }
  const boundary = []
  for (let i = 0; i < lines.length; i += 1) if (lines[i] === "What's contributing") boundary.push(i)
  if (boundary.length !== 1) {
    throw new Error(`quota text must contain exactly one What's contributing boundary; found ${boundary.length}`)
  }
  const positions = LIMITS.map(({ label }) => indexes.get(label)).concat(boundary[0])
  if (!positions.every((position, index) => index === 0 || position > positions[index - 1])) {
    throw new Error('quota labels are out of order')
  }
  const values = {}
  for (let i = 0; i < LIMITS.length; i += 1) {
    const label = LIMITS[i].label
    const matches = lines.slice(positions[i] + 1, positions[i + 1])
      .map((line) => /^(\d+(?:\.\d+)?)% used$/.exec(line))
      .filter(Boolean)
    if (matches.length !== 1) {
      throw new Error(`${label} must be followed by exactly one percent used value; found ${matches.length}`)
    }
    values[label] = { percent: Number(matches[0][1]), resetsAt: '1970-01-01T00:00:00.000Z' }
  }
  return normalizeUsage(values)
}

function decide(usage) {
  if (!Array.isArray(usage)) throw new Error('normalized quota usage must be an array')
  const byLabel = new Map()
  for (const entry of usage) {
    if (!isObject(entry) || typeof entry.label !== 'string' || byLabel.has(entry.label)) {
      throw new Error('normalized quota usage contains an invalid or duplicate label')
    }
    const percentUsed = percent(entry.percentUsed, entry.label)
    byLabel.set(entry.label, {
      percentUsed,
      resetsAt: resetAt(entry.resetsAt, entry.label, entry.label === 'Current session' && percentUsed === 0),
    })
  }
  if (byLabel.size !== LIMITS.length || LIMITS.some(({ label }) => !byLabel.has(label))) {
    throw new Error('normalized quota usage does not contain the exact required labels')
  }
  const limits = LIMITS.map(({ label, threshold }) => ({
    label, ...byLabel.get(label), threshold,
  }))
  return { allowed: limits.every((entry) => entry.percentUsed <= entry.threshold), limits }
}

function resolveExecutable(command, env = process.env, cwd = process.cwd()) {
  if (typeof command !== 'string' || !command || command.includes('\0')) {
    throw new Error('CLAUDE must name one executable')
  }
  const hasSeparator = command.includes('/') || (path.sep !== '/' && command.includes(path.sep))
  const candidates = hasSeparator
    ? [path.resolve(cwd, command)]
    : String(env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command))
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      const resolved = fs.realpathSync(candidate)
      if (fs.statSync(resolved).isFile()) return resolved
    } catch {}
  }
  throw new Error('CLAUDE executable was not found or is not executable')
}

function parseClaudeVersion(value) {
  if (typeof value !== 'string') throw new Error('Claude Code returned an invalid version')
  const match = /^\s*(\d+)\.(\d+)\.(\d+)(?:\s+\(Claude Code\))?\s*$/.exec(value)
  if (!match) throw new Error('Claude Code returned an invalid version')
  const version = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
  if (!Object.values(version).every(Number.isSafeInteger)) throw new Error('Claude Code returned an invalid version')
  return version
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return 0
}

function inspectClaude(executable, dependencies = {}) {
  const run = dependencies.spawnSync || spawnSync
  const result = run(executable, ['--version'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    env: dependencies.env || process.env,
  })
  if (result.error || result.status !== 0) throw new Error('could not read Claude Code version')
  const version = String(result.stdout || result.stderr || '').trim()
  if (compareVersions(parseClaudeVersion(version), MIN_CLAUDE_VERSION) < 0) {
    throw new Error('quota gate requires Claude Code 2.1.284 or newer')
  }
  const hashFile = dependencies.sha256File || sha256File
  return { version, executableSha256: hashFile(executable) }
}

function controlInput() {
  return [
    { type: 'control_request', request_id: INITIALIZE_REQUEST_ID, request: { subtype: 'initialize' } },
    { type: 'control_request', request_id: USAGE_REQUEST_ID, request: { subtype: 'get_usage', skip_behaviors: true } },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n'
}

function queryClaudeUsage(executable, dependencies = {}) {
  const run = dependencies.spawnSync || spawnSync
  const result = run(executable, [...QUERY_ARGS], {
    encoding: 'utf8', input: controlInput(), timeout: QUERY_TIMEOUT_MS, killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT, env: dependencies.env || process.env,
  })
  if (result.error || result.status !== 0) throw new Error('Claude quota control query failed')
  return parseControlOutput(result.stdout)
}

function assertNextCall(value) {
  if (typeof value !== 'string' || !NEXT_CALL.test(value)) {
    throw new CliUsageError('--next-call must be a safe label (letters, numbers, . _ : / -)')
  }
  return value
}

function parseArgs(argv) {
  const options = { run: null, nextCall: null, final: false, help: false }
  const seen = new Set()
  const value = (name, index) => {
    const result = argv[index]
    if (!result || result.startsWith('--')) throw new CliUsageError(`${name} requires a value`)
    return result
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (seen.has(arg)) throw new CliUsageError(`duplicate option: ${arg}`)
    if (arg === '--run') { seen.add(arg); options.run = value(arg, ++i); continue }
    if (arg === '--next-call') { seen.add(arg); options.nextCall = value(arg, ++i); continue }
    if (arg === '--final') { seen.add(arg); options.final = true; continue }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    throw new CliUsageError(`unknown option: ${arg}`)
  }
  if (options.help) return options
  try { assertSafeId(options.run, 'run id') } catch (error) { throw new CliUsageError(error.message) }
  if (options.run === 'legacy') throw new CliUsageError('legacy is read-only and cannot receive quota records')
  if (options.final && options.nextCall) throw new CliUsageError('--final and --next-call are mutually exclusive')
  if (!options.final) assertNextCall(options.nextCall)
  return options
}

function buildRecord(options, decision, metadata, now = new Date()) {
  const usage = {}
  const thresholds = {}
  const resetsAt = {}
  for (const entry of decision.limits) {
    usage[entry.label] = entry.percentUsed
    thresholds[entry.label] = entry.threshold
    resetsAt[entry.label] = entry.resetsAt
  }
  return {
    schemaVersion: 1,
    timestamp: now.toISOString(),
    runId: options.run,
    kind: options.final ? 'final' : 'preflight',
    nextCall: options.final ? null : options.nextCall,
    stage: options.stage || null,
    target: options.target || null,
    tool: options.tool || null,
    usage,
    thresholds,
    resetsAt,
    allowed: decision.allowed,
    source: 'claude-control-get_usage',
    claudeVersion: metadata.version,
    claudeExecutableSha256: metadata.executableSha256,
  }
}

function paidCallBinding(request) {
  if (!isObject(request)) throw new Error('paid-call quota binding is required')
  const run = assertSafeId(request.runId, 'run id')
  if (run === 'legacy') throw new Error('legacy is read-only and cannot receive quota records')
  if (!['probe', 'review', 'extract', 'judge'].includes(request.stage)) throw new Error('paid-call quota stage is invalid')
  const probe = request.stage === 'probe'
  const target = request.target == null ? null : assertSafeId(request.target, 'quota target')
  const tool = request.tool == null ? null : assertSafeId(request.tool, 'quota tool')
  if (probe && (target != null || tool != null)) throw new Error('paid-call quota probe target and tool must be null')
  if (!probe && target == null) throw new Error(`paid-call quota ${request.stage} target is required`)
  if (['review', 'extract'].includes(request.stage) && tool == null) throw new Error(`paid-call quota ${request.stage} tool is required`)
  if (request.stage === 'judge' && tool != null) throw new Error('paid-call quota judge tool must be null')
  if (typeof request.claudeVersion !== 'string' || !request.claudeVersion) {
    throw new Error('paid-call quota manifest Claude version is required')
  }
  return {
    run,
    stage: request.stage,
    target,
    tool,
    nextCall: probe ? 'probe' : `${request.stage}:${target}${tool ? `/${tool}` : ''}`,
    claudeVersion: request.claudeVersion,
  }
}

// This is deliberately a single-use operation, not a reader for prior audit records. It resolves
// and inspects one executable, obtains fresh structured usage, durably appends that decision, and
// returns that same absolute executable path for the immediately following paid spawn.
function authorizePaidCall(root, request, dependencies = {}) {
  const binding = paidCallBinding(request)
  const env = dependencies.env || process.env
  const executable = (dependencies.resolveExecutable || resolveExecutable)(
    env.CLAUDE || 'claude', env, dependencies.cwd || process.cwd(),
  )
  if (!path.isAbsolute(executable)) throw new Error('quota authorization did not resolve an absolute Claude executable')
  const metadata = (dependencies.inspectClaude || inspectClaude)(executable, dependencies)
  if (binding.claudeVersion && metadata.version !== binding.claudeVersion) {
    throw new Error(`Claude Code version does not match cohort manifest: expected ${binding.claudeVersion}, found ${metadata.version}`)
  }
  const usage = (dependencies.queryClaudeUsage || queryClaudeUsage)(executable, dependencies)
  const decision = decide(usage)
  const now = dependencies.now ? dependencies.now() : new Date()
  const record = buildRecord({ ...binding, final: false }, decision, metadata, now)
  const appended = appendAuditRecord(root, binding.run, record, dependencies)
  if (!decision.allowed) throw new Error(`quota denied for ${binding.nextCall}: ${summary(decision)} (audit: ${path.relative(root, appended.file)})`)
  return {
    executable,
    audit: appended.file,
    record,
    quotaEvidence: appended.quotaEvidence,
    claudeVersion: metadata.version,
  }
}

function quotaRecordDigest(line) {
  return crypto.createHash('sha256').update(line).digest('hex')
}

function readAuditLines(file) {
  if (!fs.existsSync(file)) return []
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe quota log: ${file}`)
  const raw = fs.readFileSync(file, 'utf8')
  if (raw && !raw.endsWith('\n')) throw new Error(`quota log is not newline terminated: ${file}`)
  return raw ? raw.slice(0, -1).split('\n') : []
}

function appendAuditRecord(root, runId, record) {
  assertSafeId(runId, 'run id')
  const runDir = ensureDirectorySafe(path.join(root, 'runs', runId))
  const file = path.join(runDir, 'quota.jsonl')
  const complete = path.join(runDir, 'complete.json')
  const lock = acquireLocalLock(file + '.lock')
  if (!lock) throw new Error(`quota log for ${runId} is being updated; retry later`)
  try {
    if (fs.existsSync(complete)) throw new Error(`cohort ${runId} is complete; quota log is immutable`)
    const lines = readAuditLines(file)
    const records = lines.map((line, index) => {
      try { return JSON.parse(line) } catch { throw new Error(`quota log contains invalid JSON at line ${index + 1}`) }
    })
    if (records.some((entry) => entry && entry.kind === 'final')) {
      throw new Error(`quota log for ${runId} is finalized`)
    }
    const line = JSON.stringify(record)
    const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)
    const descriptor = fs.openSync(file, flags, 0o600)
    try {
      fs.writeSync(descriptor, line + '\n')
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    return {
      file,
      quotaEvidence: { file: 'quota.jsonl', line: lines.length + 1, sha256: quotaRecordDigest(line) },
    }
  } finally {
    releaseLocalLock(lock)
  }
}

function appendAudit(root, runId, record) {
  return appendAuditRecord(root, runId, record).file
}

function summary(decision) {
  return decision.limits.map((entry) => `${entry.label} ${entry.percentUsed}%/${entry.threshold}%`).join('; ')
}

function usageText() {
  return 'usage: node bench/quota.js --run <run-id> --next-call <label> | --run <run-id> --final'
}

function main(argv = process.argv.slice(2), root = ROOT, dependencies = {}) {
  const options = parseArgs(argv)
  const writeOut = dependencies.log || console.log
  const writeError = dependencies.error || console.error
  if (options.help) { writeOut(usageText()); return 0 }
  const env = dependencies.env || process.env
  const executable = (dependencies.resolveExecutable || resolveExecutable)(env.CLAUDE || 'claude', env)
  const metadata = (dependencies.inspectClaude || inspectClaude)(executable, dependencies)
  const usage = (dependencies.queryClaudeUsage || queryClaudeUsage)(executable, dependencies)
  const decision = decide(usage)
  const now = dependencies.now ? dependencies.now() : new Date()
  const record = buildRecord(options, decision, metadata, now)
  const appended = appendAuditRecord(root, options.run, record, dependencies)
  const audit = appended.file
  const status = options.final ? 'final quota snapshot' : `quota ${decision.allowed ? 'allowed' : 'denied'} for ${options.nextCall}`
  const message = `${status}: ${summary(decision)} (audit: ${path.relative(root, audit)})`
  if (decision.allowed || options.final) writeOut(message)
  else writeError(message)
  return options.final || decision.allowed ? 0 : 1
}

function cli(argv = process.argv.slice(2)) {
  try {
    return main(argv)
  } catch (error) {
    console.error(error.message)
    if (error instanceof CliUsageError) console.error(usageText())
    return error instanceof CliUsageError ? 2 : 1
  }
}

if (require.main === module) process.exitCode = cli()

module.exports = {
  INITIALIZE_REQUEST_ID,
  LIMITS,
  QUERY_ARGS,
  USAGE_REQUEST_ID,
  appendAudit,
  appendAuditRecord,
  authorizePaidCall,
  buildRecord,
  cli,
  controlInput,
  decide,
  inspectClaude,
  main,
  parseArgs,
  parseClaudeVersion,
  parseControlOutput,
  parseLabeledUsage,
  parseStructuredUsage,
  queryClaudeUsage,
  quotaRecordDigest,
  resolveExecutable,
}
