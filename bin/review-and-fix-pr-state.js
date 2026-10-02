#!/usr/bin/env node
'use strict'
// Durable, hash-bound checkpoints for review-and-fix-pr.
//
// Large or repository-derived values are passed in files/stdin, never interpolated into a shell:
//
//   nonce
//   claim-result --response-id id
//   claim  (--key-file key.json|--key-base64 base64) [--root repo] [--owner label]
//   init   (--key-file key.json|--key-base64 base64) [--root repo] [--run id] [--owner label]
//   put    --run id --lock-token token --name logical/name.json (--file p|--stdin|--base64 data)
//   get    --run id --name logical/name.json (--out p|--base64)
//   list   --run id
//   export-json --run id --prefix discovery/
//   validate --run id [--root repo]
//   status --run id [--lock-token token --set status [--meta-file meta.json]]
//   complete --run id --lock-token token [--status complete] [--summary-file summary.json]
//   touch  --run id --lock-token token
//   unlock --run id --lock-token token
//   resume (--key-file key.json|--key-base64 base64) [--root repo]
//   prepare-head --run id --lock-token token --root repo --from sha --batch id
//                --receipt-prefix prefix --receipt-parts count
//   abort-head --run id --lock-token token --root repo --tx-id id
//   advance-head --run id --lock-token token --root repo --from sha --to sha
//                (--receipt-base64 data|--receipt-prefix prefix --receipt-parts count)
//   diff-files --root repo --base sha --head sha
//   prune [--days 7]
//
// All commands also accept --store. The default is ~/.claude/review-and-fix-pr/runs.

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { diffInventory } = require('./review-and-fix-pr-diff')

const SCHEMA_VERSION = 2
const DEFAULT_PRUNE_DAYS = 7
const DEFAULT_LEASE_SECONDS = 6 * 60 * 60
const MIN_LEASE_SECONDS = 1
const MAX_LEASE_SECONDS = 7 * 24 * 60 * 60
const COMMAND = process.argv[2] || ''

class StateError extends Error {
  constructor(message, code = 2, details = undefined) {
    super(message)
    this.code = code
    this.details = details
  }
}

const SPECS = {
  nonce: { values: ['store'] },
  'claim-result': { values: ['store', 'response-id'] },
  'action-result': { values: ['store', 'response-id'] },
  claim: { values: ['store', 'key-file', 'key-base64', 'root', 'run', 'owner', 'lease-seconds', 'response-id'] },
  init: { values: ['store', 'key-file', 'key-base64', 'root', 'run', 'owner', 'lease-seconds', 'response-id'] },
  put: { values: ['store', 'run', 'lock-token', 'name', 'file', 'base64', 'expected-sha256', 'response-id'], bools: ['stdin'] },
  get: { values: ['store', 'run', 'name', 'out'], bools: ['base64'] },
  list: { values: ['store', 'run'] },
  'export-json': { values: ['store', 'run', 'prefix'] },
  'resume-json': { values: ['store', 'run', 'after', 'max-bytes'] },
  'export-lineage': { values: ['store', 'run', 'after', 'limit'] },
  validate: { values: ['store', 'run', 'root'] },
  status: { values: ['store', 'run', 'lock-token', 'set', 'meta-file', 'response-id'] },
  complete: { values: ['store', 'run', 'lock-token', 'status', 'summary-file', 'expected-index', 'root', 'response-id'] },
  abandon: { values: ['store', 'run', 'lock-token', 'status', 'response-id'] },
  touch: { values: ['store', 'run', 'lock-token', 'response-id'] },
  'assert-repo': { values: ['store', 'run', 'lock-token', 'root', 'response-id'] },
  unlock: { values: ['store', 'run', 'lock-token', 'response-id'] },
  resume: { values: ['store', 'key-file', 'key-base64', 'root'] },
  'prepare-head': { values: ['store', 'run', 'lock-token', 'root', 'from', 'batch',
                              'receipt-prefix', 'receipt-parts', 'response-id'] },
  'seal-head': { values: ['store', 'run', 'root', 'tx-id', 'paths-base64'] },
  'abort-head': { values: ['store', 'run', 'lock-token', 'root', 'tx-id', 'response-id'] },
  'ack-head': { values: ['store', 'run', 'lock-token', 'tx-id', 'response-id'] },
  'advance-head': { values: ['store', 'run', 'lock-token', 'root', 'from', 'to', 'receipt-base64',
                              'receipt-prefix', 'receipt-parts', 'tx-id', 'response-id'] },
  'diff-files': { values: ['store', 'root', 'base', 'head'] },
  'repo-status': { values: ['store', 'root'] },
  prune: { values: ['store', 'days'] },
}

function parseArgs(command) {
  const spec = SPECS[command]
  if (!spec) throw new StateError('state: unknown command ' + JSON.stringify(command || '(missing)'))
  const values = new Set(spec.values || [])
  const bools = new Set(spec.bools || [])
  const result = {}
  const seen = new Set()
  for (let i = 3; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (!arg.startsWith('--')) throw new StateError('state: unexpected positional argument ' + JSON.stringify(arg))
    const name = arg.slice(2)
    if (seen.has(name)) throw new StateError('state: duplicate --' + name)
    seen.add(name)
    if (bools.has(name)) { result[name] = true; continue }
    if (!values.has(name)) throw new StateError('state: unsupported --' + name + ' for ' + command)
    const value = process.argv[++i]
    if (value === undefined || value.startsWith('--')) throw new StateError('state: --' + name + ' requires a value')
    result[name] = value
  }
  return result
}

const args = parseArgs(COMMAND)
const now = () => new Date().toISOString()
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const tokenHash = token => sha256('review-and-fix-pr-state-lock\0' + token)
const hostName = os.hostname()

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StateError('state: JSON contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (!value || typeof value !== 'object') throw new StateError('state: unsupported JSON value')
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
}

function parseJsonBuffer(buffer, label, objectOnly = false) {
  let value
  try { value = JSON.parse(buffer.toString('utf8')) } catch (error) {
    throw new StateError('state: invalid JSON in ' + label + ': ' + String(error.message || error))
  }
  if (objectOnly && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new StateError('state: ' + label + ' must contain a JSON object')
  }
  canonical(value)
  return value
}

function readRegularFile(file, label) {
  let stat
  try { stat = fs.lstatSync(file) } catch (error) {
    throw new StateError('state: cannot read ' + label + ': ' + String(error.message || error))
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new StateError('state: ' + label + ' must be a regular, non-symlink file')
  return fs.readFileSync(file)
}

function decodeBase64(value, label) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(String(value))) {
    throw new StateError('state: ' + label + ' is not canonical base64')
  }
  return Buffer.from(value, 'base64')
}

function requireArg(name) {
  const value = args[name]
  if (!value) throw new StateError('state: --' + name + ' is required')
  return value
}

function validateRunId(run) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(run || ''))) {
    throw new StateError('state: --run must be 1-128 characters from [A-Za-z0-9._-]')
  }
  return String(run)
}

function validateStatus(status) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(String(status || ''))) {
    throw new StateError('state: status must be 1-64 lowercase letters, digits, or hyphens')
  }
  return String(status)
}

function validateSha(value, label) {
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(String(value || ''))) {
    throw new StateError('state: ' + label + ' must be a full lowercase Git object ID')
  }
  return String(value)
}

function storePath() {
  const requested = args.store || path.join(os.homedir(), '.claude', 'review-and-fix-pr', 'runs')
  const repoStore = /^@repo\/([A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+)$/.exec(requested)
  const store = path.resolve(repoStore
    ? path.join(os.homedir(), '.claude', 'review-and-fix-pr', repoStore[1], 'runs')
    : requested)
  if (store === path.parse(store).root) throw new StateError('state: --store may not be a filesystem root')
  return store
}

const STORE = storePath()

function fsyncDirectory(directory) {
  let fd
  try {
    fd = fs.openSync(directory, 'r')
    fs.fsyncSync(fd)
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR'].includes(error.code)) throw error
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

function ensureDirectory(directory, recursive = false) {
  if (fs.existsSync(directory)) return false
  const parent = path.dirname(directory)
  try { fs.mkdirSync(directory, { recursive, mode: 0o700 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StateError('state: expected a real directory: ' + directory, 3)
  if (fs.existsSync(parent)) fsyncDirectory(parent)
  return true
}

function ensureStore() {
  ensureDirectory(STORE, true)
  let cursor = STORE
  const root = path.parse(STORE).root
  while (cursor !== root) {
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new StateError('state: --store path must contain only real directories: ' + cursor, 3)
    }
    cursor = path.dirname(cursor)
  }
  if (fs.realpathSync(STORE) !== STORE) throw new StateError('state: --store must be a canonical path without symlinks', 3)
  ensureDirectory(path.join(STORE, '.key-locks'))
  ensureDirectory(path.join(STORE, '.claim-responses'))
}

function validateResponseId(value) {
  if (!/^[a-f0-9]{64}$/.test(String(value || ''))) {
    throw new StateError('state: --response-id must be 64 lowercase hex characters')
  }
  return String(value)
}

function claimResponsePath(value) {
  return path.join(STORE, '.claim-responses', validateResponseId(value) + '.json')
}

function runPath(run) {
  return path.join(STORE, validateRunId(run))
}

function statePath(run) {
  return path.join(runPath(run), 'state.json')
}

function atomicWrite(file, buffer, mode = 0o600) {
  const parent = path.dirname(file)
  ensureDirectory(parent, true)
  const temp = path.join(parent, '.' + path.basename(file) + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex'))
  let fd
  try {
    fd = fs.openSync(temp, 'wx', mode)
    fs.writeFileSync(fd, buffer)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temp, file)
    fsyncDirectory(parent)
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(temp) } catch {}
  }
}

function stateIntegrity(state) {
  const unsigned = Object.assign({}, state)
  delete unsigned.integrity
  return sha256(Buffer.from(canonical(unsigned)))
}

function saveState(state, preserveUpdatedAt = false) {
  if (!preserveUpdatedAt) state.updatedAt = now()
  state.integrity = stateIntegrity(state)
  atomicWrite(statePath(state.run), Buffer.from(JSON.stringify(state, null, 2) + '\n'))
}

function loadState(run) {
  run = validateRunId(run)
  const file = statePath(run)
  const state = parseJsonBuffer(readRegularFile(file, 'state for run ' + run), 'state for run ' + run, true)
  if (state.schemaVersion !== SCHEMA_VERSION) throw new StateError('state: unsupported state schema for run ' + run)
  if (state.run !== run) throw new StateError('state: run ID mismatch in ' + file)
  if (!/^[a-f0-9]{64}$/.test(String(state.integrity || '')) || state.integrity !== stateIntegrity(state)) {
    throw new StateError('state: state integrity check failed for run ' + run, 3)
  }
  if (!state.key || typeof state.key !== 'object' || Array.isArray(state.key)) throw new StateError('state: invalid key for run ' + run, 3)
  if (computeKeyHash(state.key, state.repository || null) !== state.keyHash) throw new StateError('state: key hash mismatch for run ' + run, 3)
  if (!state.artifacts || typeof state.artifacts !== 'object' || Array.isArray(state.artifacts)) {
    throw new StateError('state: invalid artifact index for run ' + run, 3)
  }
  return state
}

function readKey() {
  const sources = [args['key-file'] ? 'file' : null, args['key-base64'] !== undefined ? 'base64' : null].filter(Boolean)
  if (sources.length !== 1) throw new StateError('state: exactly one of --key-file or --key-base64 is required')
  const bytes = args['key-file']
    ? readRegularFile(args['key-file'], '--key-file')
    : decodeBase64(args['key-base64'], '--key-base64')
  return parseJsonBuffer(bytes, args['key-file'] ? '--key-file' : '--key-base64', true)
}

function computeKeyHash(key, repository) {
  return sha256(Buffer.from(canonical({ key, repositoryIdentity: repository ? repository.identity : null })))
}

function validateArtifactName(name) {
  name = String(name || '')
  if (!name || name.length > 512 || name.includes('\\') || name.includes('\0')) {
    throw new StateError('state: invalid artifact --name')
  }
  const segments = name.split('/')
  if (segments.some(segment => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment) || segment === '.' || segment === '..')) {
    throw new StateError('state: artifact --name must use safe slash-separated segments')
  }
  return name
}

function validateArtifactPrefix(prefix) {
  prefix = String(prefix || '')
  if (!prefix || prefix.length > 512 || prefix.includes('\\') || prefix.includes('\0')) {
    throw new StateError('state: invalid artifact --prefix')
  }
  const withoutTrailingSlash = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  validateArtifactName(withoutTrailingSlash)
  return prefix
}

function artifactsRoot(run, create = false) {
  const root = path.join(runPath(run), 'artifacts')
  if (create) ensureDirectory(root)
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StateError('state: artifact root is not a safe directory', 3)
  }
  return root
}

function artifactPath(run, name, createParents = false) {
  name = validateArtifactName(name)
  const root = artifactsRoot(run, createParents)
  const target = path.resolve(root, ...name.split('/'))
  if (!target.startsWith(root + path.sep)) throw new StateError('state: artifact path escapes run directory', 3)
  let cursor = root
  const segments = name.split('/').slice(0, -1)
  for (const segment of segments) {
    cursor = path.join(cursor, segment)
    if (!fs.existsSync(cursor)) {
      if (!createParents) break
      ensureDirectory(cursor)
    }
    const stat = fs.lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StateError('state: unsafe artifact directory for ' + name, 3)
  }
  return target
}

function verifyArtifact(state, name) {
  const record = state.artifacts[name]
  if (!record || typeof record !== 'object') throw new StateError('state: no artifact named ' + name)
  const file = artifactPath(state.run, name)
  let stat
  try { stat = fs.lstatSync(file) } catch {
    throw new StateError('state: artifact is missing: ' + name, 3)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new StateError('state: artifact is not a regular file: ' + name, 3)
  const bytes = fs.readFileSync(file)
  const actual = sha256(bytes)
  if (actual !== record.sha256 || bytes.length !== record.bytes) {
    throw new StateError('state: artifact integrity check failed: ' + name, 3, { expected: record.sha256, actual })
  }
  return { bytes, record }
}

function verifyArtifacts(state) {
  const names = Object.keys(state.artifacts).sort()
  for (const name of names) verifyArtifact(state, name)
  return names
}

function processStartId(pid) {
  if (process.platform !== 'linux') return null
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
    const close = stat.lastIndexOf(')')
    return stat.slice(close + 2).split(/\s+/)[19] || null
  } catch { return null }
}

function processOwnsLock(owner) {
  if (!owner || owner.host !== hostName || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return null
  try { process.kill(owner.pid, 0) } catch (error) {
    if (error.code === 'ESRCH') return false
    return null
  }
  if (owner.processStartId && processStartId(owner.pid) !== owner.processStartId) return false
  return true
}

function readDirectoryLockOwner(lock) {
  try { return parseJsonBuffer(readRegularFile(path.join(lock, 'owner.json'), 'lock owner'), 'lock owner', true) } catch { return null }
}

function removeOwnedDirectoryLock(lock, token) {
  const owner = readDirectoryLockOwner(lock)
  if (!owner || owner.token !== token) return false
  const quarantine = lock + '.released-' + token.slice(0, 12) + '-' + crypto.randomBytes(4).toString('hex')
  try { fs.renameSync(lock, quarantine) } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  fsyncDirectory(path.dirname(lock))
  fs.rmSync(quarantine, { recursive: true, force: false })
  fsyncDirectory(path.dirname(lock))
  return true
}

function acquireDirectoryLock(lock) {
  ensureDirectory(path.dirname(lock), true)
  const token = crypto.randomBytes(16).toString('hex')
  const owner = {
    token, pid: process.pid, host: hostName, processStartId: processStartId(process.pid), createdAt: now(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  }
  for (let attempt = 0; attempt < 500; attempt++) {
    const candidate = lock + '.candidate-' + token + '-' + crypto.randomBytes(4).toString('hex')
    try {
      fs.mkdirSync(candidate, { mode: 0o700 })
      atomicWrite(path.join(candidate, 'owner.json'), Buffer.from(JSON.stringify(owner) + '\n'))
      try {
        // A valid lock is non-empty, so POSIX refuses replacing it. An empty directory left by an
        // older crashed implementation is safe to replace because it never represented ownership.
        fs.renameSync(candidate, lock)
        fsyncDirectory(path.dirname(lock))
        return token
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      }
    } finally {
      try { fs.rmSync(candidate, { recursive: true, force: true }) } catch {}
    }
    try {
      const stat = fs.lstatSync(lock)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StateError('state: unsafe lock path ' + lock, 3)
      const existing = readDirectoryLockOwner(lock)
      const live = processOwnsLock(existing)
      if (existing && (live === false || (live === null && Date.parse(existing.expiresAt) <= Date.now())) &&
          removeOwnedDirectoryLock(lock, existing.token)) continue
    } catch (inner) {
      if (inner instanceof StateError) throw inner
      if (inner.code === 'ENOENT') continue
    }
    if (attempt === 499) throw new StateError('state: lock is busy: ' + path.basename(lock), 4)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}

function releaseDirectoryLock(lock, token) {
  if (!token) return
  if (!removeOwnedDirectoryLock(lock, token) && fs.existsSync(lock)) {
    throw new StateError('state: refused to release a lock owned by another process', 4)
  }
}

function keyLockPath(keyHash) {
  return path.join(STORE, '.key-locks', keyHash + '.lock')
}

function leasePath(run) {
  return path.join(runPath(run), '.lease')
}

function mutationLockPath(run) {
  return path.join(runPath(run), '.mutation.lock')
}

function activeKeyMarker(run, keyHash) {
  if (!/^[a-f0-9]{64}$/.test(String(keyHash || ''))) throw new StateError('state: invalid active key hash', 3)
  return path.join(runPath(run), '.active-key-' + keyHash)
}

function writeActiveKey(state) {
  const dir = runPath(state.run)
  const marker = activeKeyMarker(state.run, state.keyHash)
  // Create and fsync the new discoverability marker before removing the old one. A crash can leave
  // both (which is repairable from state/transaction proof), but can never make a live run vanish.
  if (!fs.existsSync(marker)) atomicWrite(marker, Buffer.from(state.run + '\n'))
  for (const name of fs.readdirSync(dir)) {
    if (/^\.active-key-[a-f0-9]{64}$/.test(name) && name !== '.active-key-' + state.keyHash) {
      fs.unlinkSync(path.join(dir, name))
    }
  }
  fsyncDirectory(dir)
}

function removeActiveKeys(run) {
  const dir = runPath(run)
  for (const name of fs.readdirSync(dir)) {
    if (/^\.active-key-[a-f0-9]{64}$/.test(name)) fs.unlinkSync(path.join(dir, name))
  }
  fsyncDirectory(dir)
}

function parseLeaseSeconds() {
  const seconds = args['lease-seconds'] === undefined ? DEFAULT_LEASE_SECONDS : Number(args['lease-seconds'])
  if (!Number.isSafeInteger(seconds) || seconds < MIN_LEASE_SECONDS || seconds > MAX_LEASE_SECONDS) {
    throw new StateError('state: --lease-seconds must be an integer from ' + MIN_LEASE_SECONDS + ' to ' + MAX_LEASE_SECONDS)
  }
  return seconds
}

function leaseExpired(state, at = Date.now()) {
  return !state.lock || !state.lock.expiresAt || Date.parse(state.lock.expiresAt) <= at
}

function writeLease(state, create) {
  const directory = leasePath(state.run)
  if (create) {
    if (fs.existsSync(directory)) throw new StateError('state: run lease already exists', 4)
    ensureDirectory(directory)
  }
  if (!fs.existsSync(directory)) throw new StateError('state: run lease is missing', 4)
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StateError('state: unsafe run lease', 3)
  atomicWrite(path.join(directory, 'owner.json'), Buffer.from(JSON.stringify({
    tokenHash: state.lock.tokenHash,
    owner: state.lock.owner,
    touchedAt: state.lock.touchedAt,
    expiresAt: state.lock.expiresAt,
  }) + '\n'))
}

function releaseLease(run, expectedTokenHash, strict = true) {
  const directory = leasePath(run)
  if (!fs.existsSync(directory)) return false
  let owner = null
  try {
    owner = parseJsonBuffer(readRegularFile(path.join(directory, 'owner.json'), 'lease owner'), 'lease owner', true)
  } catch (error) {
    if (strict) throw error
  }
  if (owner && owner.tokenHash !== expectedTokenHash) {
    if (strict) throw new StateError('state: refused to release a lease owned by another claimant', 4)
    return false
  }
  const quarantine = directory + '.released-' + crypto.randomBytes(8).toString('hex')
  fs.renameSync(directory, quarantine)
  fsyncDirectory(path.dirname(directory))
  fs.rmSync(quarantine, { recursive: true, force: false })
  fsyncDirectory(path.dirname(directory))
  return true
}

function requireToken(state) {
  const token = requireArg('lock-token')
  if (!state.lock || state.lock.tokenHash !== tokenHash(token)) throw new StateError('state: invalid or expired --lock-token', 4)
  if (leaseExpired(state)) throw new StateError('state: run lease expired; claim it again', 4)
  if (!fs.existsSync(leasePath(state.run))) throw new StateError('state: run lease is missing', 4)
}

function withMutation(run, fn) {
  run = validateRunId(run)
  const lock = mutationLockPath(run)
  const mutexToken = acquireDirectoryLock(lock)
  try {
    const state = loadState(run)
    requireToken(state)
    if (state.terminal) throw new StateError('state: run is sealed and cannot be changed')
    const timestamp = now()
    state.lock.touchedAt = timestamp
    state.lock.expiresAt = new Date(Date.now() + state.lock.leaseSeconds * 1000).toISOString()
    const result = fn(state)
    saveState(state)
    if (state.lock) writeLease(state, false)
    if (result && result.state) result.state = publicState(state)
    return result
  } finally {
    releaseDirectoryLock(lock, mutexToken)
  }
}

function git(root, ...gitArgs) {
  try {
    return execFileSync('git', ['-C', root, ...gitArgs], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim()
  } catch (error) {
    throw new StateError('state: git check failed: ' + String(error.stderr || error.message || error).trim().slice(0, 500), 3)
  }
}

function gitRawExact(root, ...gitArgs) {
  try {
    return execFileSync('git', ['-C', root, ...gitArgs], { encoding: 'utf8', maxBuffer: 1 << 26 })
  } catch (error) {
    throw new StateError('state: git check failed: ' + String(error.stderr || error.message || error).trim().slice(0, 500), 3)
  }
}

function validateRepository(key, root, expectedBinding = null) {
  if (!root) return null
  root = fs.realpathSync(path.resolve(root))
  const top = fs.realpathSync(git(root, 'rev-parse', '--show-toplevel'))
  if (top !== root) throw new StateError('state: --root must be the repository top level', 3, { root, top })
  const commonValue = git(root, 'rev-parse', '--git-common-dir')
  const gitCommonDir = fs.realpathSync(path.resolve(root, commonValue))
  const rootStat = fs.statSync(root)
  const gitStat = fs.statSync(gitCommonDir)
  const bindingValue = {
    root,
    gitCommonDir,
    rootDevice: String(rootStat.dev),
    rootInode: String(rootStat.ino),
    gitDevice: String(gitStat.dev),
    gitInode: String(gitStat.ino),
  }
  const identity = sha256(Buffer.from(canonical(bindingValue)))
  if (expectedBinding && (expectedBinding.identity !== identity || expectedBinding.root !== root || expectedBinding.gitCommonDir !== gitCommonDir)) {
    throw new StateError('state: repository identity does not match checkpoint', 3)
  }
  if (typeof key.head !== 'string') throw new StateError('state: key must contain top-level "head" when --root is used')
  const expected = validateSha(key.head, 'key.head')
  const head = git(root, 'rev-parse', '--verify', 'HEAD^{commit}')
  if (head !== expected) throw new StateError('state: repository HEAD does not match key.head', 3, { expected, actual: head })
  const dirty = git(root, 'status', '--porcelain=v1', '-z')
  if (dirty) throw new StateError('state: repository is dirty; checkpoint resume is unsafe', 3)
  return Object.assign(bindingValue, { identity, head, clean: true })
}

function scanRuns(keyHash) {
  ensureStore()
  const matches = []
  for (const entry of fs.readdirSync(STORE, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) continue
    const file = statePath(entry.name)
    if (!fs.existsSync(activeKeyMarker(entry.name, keyHash))) continue
    if (!fs.existsSync(file)) throw new StateError('state: active run is missing state: ' + entry.name, 3)
    const state = loadState(entry.name)
    if (state.terminal) {
      removeActiveKeys(entry.name)
      continue
    }
    if (state.keyHash !== keyHash) throw new StateError('state: active key marker disagrees with run ' + entry.name, 3)
    matches.push(state)
  }
  return matches.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.run.localeCompare(a.run))
}

function publicState(state) {
  return {
    run: state.run,
    keyHash: state.keyHash,
    status: state.status,
    terminal: !!state.terminal,
    locked: !!state.lock,
    leaseExpiresAt: state.lock ? state.lock.expiresAt : null,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    artifacts: Object.keys(state.artifacts).length,
    lineage: {
      initialHead: state.lineage.initialHead,
      currentHead: state.lineage.currentHead,
      total: (state.lineage.ownedCommits || []).length,
    },
  }
}

function newRunId() {
  return 'r-' + now().replace(/[^0-9]/g, '').slice(0, 17) + '-' + crypto.randomBytes(8).toString('hex')
}

function createRun(key, keyHash, repository, requestedRun, owner, leaseSeconds) {
  const run = validateRunId(requestedRun || newRunId())
  const dir = runPath(run)
  if (fs.existsSync(dir)) throw new StateError('state: run already exists: ' + run)
  ensureDirectory(dir)
  ensureDirectory(path.join(dir, 'artifacts'))
  const token = crypto.randomBytes(32).toString('hex')
  const timestamp = now()
  const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString()
  const state = {
    schemaVersion: SCHEMA_VERSION,
    run,
    key,
    keyHash,
    repository,
    status: 'in-progress',
    terminal: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    lock: { tokenHash: tokenHash(token), owner: owner || '', acquiredAt: timestamp, touchedAt: timestamp, expiresAt, leaseSeconds },
    lineage: { initialHead: typeof key.head === 'string' ? key.head : null, currentHead: typeof key.head === 'string' ? key.head : null, ownedCommits: [] },
    artifacts: {},
    statusHistory: [{ status: 'in-progress', at: timestamp }],
  }
  saveState(state, true)
  writeActiveKey(state)
  return { state, token }
}

function lockExisting(inputState, owner, leaseSeconds) {
  const run = inputState.run
  const mutex = mutationLockPath(run)
  const mutexToken = acquireDirectoryLock(mutex)
  try {
    const state = loadState(run)
    if (state.lock && !leaseExpired(state) && fs.existsSync(leasePath(run))) {
      throw new StateError('state: matching run is already locked: ' + run, 4)
    }
    if (state.lock) {
      if (fs.existsSync(leasePath(run))) releaseLease(run, state.lock.tokenHash, false)
      state.lock = null
    } else if (fs.existsSync(leasePath(run))) {
      const orphan = parseJsonBuffer(readRegularFile(path.join(leasePath(run), 'owner.json'), 'lease owner'), 'lease owner', true)
      releaseLease(run, orphan.tokenHash)
    }
    if (state.pendingAdvance) {
      const root = state.repository && state.repository.root
      if (!root || git(root, 'rev-parse', '--verify', 'HEAD^{commit}') !== state.pendingAdvance.from ||
          git(root, 'status', '--porcelain=v1', '-z')) {
        throw new StateError('state: prepared fix transaction requires commit recovery or manual dirty-tree inspection', 4)
      }
      state.pendingAdvance = null
    }
    verifyArtifacts(state)
    const token = crypto.randomBytes(32).toString('hex')
    const timestamp = now()
    state.lock = {
      tokenHash: tokenHash(token), owner: owner || '', acquiredAt: timestamp, touchedAt: timestamp,
      expiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString(), leaseSeconds,
    }
    saveState(state)
    writeActiveKey(state)
    return { state, token }
  } finally {
    releaseDirectoryLock(mutex, mutexToken)
  }
}

function pruneStore(days, report = true) {
  ensureStore()
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new StateError('state: --days must be an integer from 1 to 3650')
  const cutoff = Date.now() - days * 24 * 3600 * 1000
  const removed = [], skipped = []
  for (const entry of fs.readdirSync(STORE, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) continue
    const file = statePath(entry.name)
    if (!fs.existsSync(file)) continue
    let mutexToken
    let mutex
    try {
      mutex = mutationLockPath(entry.name)
      mutexToken = acquireDirectoryLock(mutex)
      const state = loadState(entry.name)
      if (state.terminal || fs.statSync(file).mtimeMs >= cutoff) continue
      if (state.lock && !leaseExpired(state) && fs.existsSync(leasePath(entry.name))) {
        skipped.push({ run: entry.name, reason: 'active lease' })
        continue
      }
      if (!state.lock && fs.existsSync(leasePath(entry.name))) {
        skipped.push({ run: entry.name, reason: 'orphan lease requires manual inspection' })
        continue
      }
      if (state.lock && fs.existsSync(leasePath(entry.name))) releaseLease(entry.name, state.lock.tokenHash)
      const dir = runPath(entry.name)
      if (path.dirname(dir) !== STORE) throw new StateError('state: refused unsafe prune target', 3)
      const quarantine = path.join(STORE, '.pruned-' + entry.name + '-' + crypto.randomBytes(8).toString('hex'))
      fs.renameSync(dir, quarantine)
      fsyncDirectory(STORE)
      releaseDirectoryLock(path.join(quarantine, path.basename(mutex)), mutexToken)
      mutexToken = null
      fs.rmSync(quarantine, { recursive: true, force: false })
      fsyncDirectory(STORE)
      removed.push(entry.name)
    } catch (error) {
      skipped.push({ run: entry.name, reason: String(error.message || error) })
    } finally {
      if (mutexToken) try { releaseDirectoryLock(mutex, mutexToken) } catch {}
    }
  }
  const result = { ok: true, days, removed, skipped }
  if (report) output(result)
  return result
}

function recoverPendingAdvance(key, keyHash, repository, root) {
  if (!root) return null
  const head = key.head
  const trailers = commitTrailers(root, head)
  const runValue = trailers['Review-And-Fix-Run']
  const txId = trailers['Review-And-Fix-Transaction']
  if (!runValue && !txId) return null
  if (!runValue || !txId) throw new StateError('state: incomplete review transaction trailers on HEAD', 3)
  const run = validateRunId(runValue)
  if (!/^[a-f0-9]{64}$/.test(txId)) throw new StateError('state: invalid review transaction trailer on HEAD', 3)
  const runDirectory = runPath(run)
  if (!fs.existsSync(runDirectory) || !fs.readdirSync(runDirectory).some(name => /^\.active-key-[a-f0-9]{64}$/.test(name))) {
    return null
  }
  const mutex = mutationLockPath(run)
  const mutexToken = acquireDirectoryLock(mutex)
  try {
    const state = loadState(run)
    const already = (state.lineage.ownedCommits || []).find(commit => commit.transactionId === txId && commit.to === head)
    if (already) {
      if (state.terminal) return null
      if (state.keyHash !== keyHash || canonical(state.key) !== canonical(key)) {
        return null
      }
      if (state.advanceHandoff === txId) {
        if (state.lock && fs.existsSync(leasePath(run))) releaseLease(run, state.lock.tokenHash, false)
        state.lock = null
        state.advanceHandoff = null
        saveState(state)
      }
      writeActiveKey(state)
      return state
    }
    const pending = verifyPreparedCommit(state, root, head, txId)
    const nextKey = Object.assign({}, state.key, { head })
    if (canonical(nextKey) !== canonical(key)) {
      throw new StateError('state: prepared transaction configuration does not match requested run', 3)
    }
    validateRepository(nextKey, root, state.repository || null)
    if (!repository || repository.identity !== state.repository.identity) {
      throw new StateError('state: prepared transaction repository identity mismatch', 3)
    }
    if (computeKeyHash(nextKey, repository) !== keyHash) {
      throw new StateError('state: prepared transaction key hash mismatch', 3)
    }
    const timestamp = now()
    state.key = nextKey
    state.keyHash = keyHash
    state.repository = repository
    state.lineage.currentHead = head
    state.lineage.ownedCommits.push({
      from: pending.from, to: head, tree: git(root, 'rev-parse', head + '^{tree}'),
      commitSha256: sha256(Buffer.from(git(root, 'cat-file', 'commit', head))), recordedAt: timestamp,
      transactionId: txId, receipt: pending.fallbackReceipt,
      recovered: true,
    })
    state.pendingAdvance = null
    if (state.lock) {
      if (fs.existsSync(leasePath(run))) releaseLease(run, state.lock.tokenHash, false)
      state.lock = null
    }
    saveState(state)
    writeActiveKey(state)
    return state
  } finally {
    releaseDirectoryLock(mutex, mutexToken)
  }
}

function issueNonce() {
  ensureStore()
  const responses = path.join(STORE, '.claim-responses')
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const name of fs.readdirSync(responses)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const file = path.join(responses, name)
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file) } catch {}
  }
  output({ ok: true, nonce: crypto.randomBytes(32).toString('hex') })
}

function claimResult() {
  ensureStore()
  const file = claimResponsePath(requireArg('response-id'))
  const value = parseJsonBuffer(readRegularFile(file, 'claim response'), 'claim response', true)
  const mutex = mutationLockPath(value.run)
  const mutexToken = acquireDirectoryLock(mutex)
  try {
    const state = loadState(value.run)
    if (!state.lock || state.lock.tokenHash !== tokenHash(value.lockToken)) {
      throw new StateError('state: journaled claim is no longer active', 4)
    }
    if (!fs.existsSync(leasePath(state.run))) writeLease(state, true)
  } finally {
    releaseDirectoryLock(mutex, mutexToken)
  }
  output(value)
}

function actionResult() {
  ensureStore()
  const file = claimResponsePath(requireArg('response-id'))
  const value = parseJsonBuffer(readRegularFile(file, 'action response'), 'action response', true)
  output(value)
}

function claim(alwaysFresh) {
  ensureStore()
  pruneStore(DEFAULT_PRUNE_DAYS, false)
  const key = readKey()
  const repository = validateRepository(key, args.root)
  const keyHash = computeKeyHash(key, repository)
  const leaseSeconds = parseLeaseSeconds()
  const keyLock = keyLockPath(keyHash)
  const keyLockToken = acquireDirectoryLock(keyLock)
  try {
    const recovered = recoverPendingAdvance(key, keyHash, repository, args.root)
    const matches = scanRuns(keyHash)
    if (alwaysFresh && matches.some(state => state.lock && !leaseExpired(state) && fs.existsSync(leasePath(state.run)))) {
      const active = matches.find(state => state.lock && !leaseExpired(state) && fs.existsSync(leasePath(state.run)))
      throw new StateError('state: matching run is already locked: ' + active.run, 4)
    }
    let claimed, resumed = false
    if (recovered) { claimed = lockExisting(recovered, args.owner, leaseSeconds); resumed = true }
    else if (!alwaysFresh && matches.length) { claimed = lockExisting(matches[0], args.owner, leaseSeconds); resumed = true }
    else claimed = createRun(key, keyHash, repository, args.run, args.owner, leaseSeconds)
    const response = Object.assign({
      ok: true,
      run: claimed.state.run,
      resumed,
      keyHash: claimed.state.keyHash,
      lockToken: claimed.token,
      runDir: runPath(claimed.state.run),
      status: claimed.state.status,
      state: publicState(claimed.state),
    }, repository ? { repository } : {})
    if (args['response-id']) {
      try {
        atomicWrite(claimResponsePath(args['response-id']), Buffer.from(JSON.stringify(response, null, 2) + '\n'))
      } catch (error) {
        const mutex = mutationLockPath(claimed.state.run)
        const mutexToken = acquireDirectoryLock(mutex)
        try {
          const state = loadState(claimed.state.run)
          if (state.lock && state.lock.tokenHash === tokenHash(claimed.token)) {
            if (fs.existsSync(leasePath(state.run))) releaseLease(state.run, state.lock.tokenHash, false)
            state.lock = null
            saveState(state)
          }
        } finally {
          releaseDirectoryLock(mutex, mutexToken)
        }
        throw error
      }
    }
    writeLease(claimed.state, true)
    output(response)
  } finally {
    releaseDirectoryLock(keyLock, keyLockToken)
  }
}

function putArtifact() {
  const run = validateRunId(requireArg('run'))
  const name = validateArtifactName(requireArg('name'))
  const sources = [args.file ? 'file' : null, args.stdin ? 'stdin' : null, args.base64 !== undefined ? 'base64' : null].filter(Boolean)
  if (sources.length !== 1) throw new StateError('state: put requires exactly one of --file, --stdin, or --base64')
  let bytes
  if (args.file) bytes = readRegularFile(args.file, '--file')
  else if (args.stdin) bytes = fs.readFileSync(0)
  else {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.base64)) {
      throw new StateError('state: --base64 is not canonical base64')
    }
    bytes = Buffer.from(args.base64, 'base64')
  }
  const digest = sha256(bytes)
  if (args['expected-sha256'] && args['expected-sha256'] !== digest) {
    throw new StateError('state: input does not match --expected-sha256', 3, { expected: args['expected-sha256'], actual: digest })
  }
  const result = withMutation(run, state => {
    if (state.artifacts[name]) {
      const existing = verifyArtifact(state, name)
      if (existing.record.sha256 !== digest || existing.record.bytes !== bytes.length) {
        throw new StateError('state: artifact names are immutable; use a new --name')
      }
      return { ok: true, run, name, sha256: digest, bytes: bytes.length, idempotent: true }
    }
    const file = artifactPath(run, name, true)
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new StateError('state: unsafe orphan artifact: ' + name, 3)
      const orphan = fs.readFileSync(file)
      if (sha256(orphan) !== digest) throw new StateError('state: conflicting orphan artifact: ' + name, 3)
    } else atomicWrite(file, bytes)
    const timestamp = now()
    state.artifacts[name] = { sha256: digest, bytes: bytes.length, createdAt: timestamp }
    return { ok: true, run, name, sha256: digest, bytes: bytes.length, idempotent: false }
  })
  output(result)
}

function getArtifact() {
  const run = validateRunId(requireArg('run'))
  const name = validateArtifactName(requireArg('name'))
  if (!!args.out === !!args.base64) throw new StateError('state: get requires exactly one of --out or --base64')
  const state = loadState(run)
  const { bytes, record } = verifyArtifact(state, name)
  if (args.out) atomicWrite(path.resolve(args.out), bytes)
  output(Object.assign({ ok: true, run, name, sha256: record.sha256, bytes: record.bytes }, args.out ? { out: path.resolve(args.out) } : { base64: bytes.toString('base64') }))
}

function listArtifacts() {
  const run = validateRunId(requireArg('run'))
  const state = loadState(run)
  const names = verifyArtifacts(state)
  output({ ok: true, state: publicState(state), artifacts: names.map(name => Object.assign({ name }, state.artifacts[name])) })
}

function exportJsonArtifacts() {
  const run = validateRunId(requireArg('run'))
  const requestedPrefix = requireArg('prefix')
  const prefix = requestedPrefix === '*' ? '' : validateArtifactPrefix(requestedPrefix)
  const state = loadState(run)
  const names = Object.keys(state.artifacts).filter(name => name.startsWith(prefix) && name.endsWith('.json')).sort()
  const artifacts = names.map(name => {
    const { bytes } = verifyArtifact(state, name)
    return { name, value: parseJsonBuffer(bytes, 'artifact ' + name) }
  })
  output({ ok: true, run, artifacts })
}

function exportLineage() {
  const run = validateRunId(requireArg('run'))
  const after = Number(args.after === undefined ? 0 : args.after)
  const limit = Number(args.limit === undefined ? 1 : args.limit)
  if (!Number.isSafeInteger(after) || after < 0) throw new StateError('state: --after must be a non-negative integer')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new StateError('state: --limit must be from 1 to 10')
  const state = loadState(run)
  const all = state.lineage.ownedCommits || []
  if (after > all.length) throw new StateError('state: --after exceeds lineage length', 3)
  const commits = all.slice(after, after + limit)
  output({ ok: true, run, initialHead: state.lineage.initialHead, currentHead: state.lineage.currentHead,
    total: all.length, after, nextAfter: after + commits.length, commits })
}

function resumeJsonArtifacts() {
  const run = validateRunId(requireArg('run'))
  const after = args.after && args.after !== 'none' ? validateArtifactName(args.after) : ''
  const maxBytes = Number(args['max-bytes'] || 196608)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 32768 || maxBytes > 524288) {
    throw new StateError('state: --max-bytes must be from 32768 to 524288')
  }
  const state = loadState(run)
  const jsonNames = Object.keys(state.artifacts).filter(name => name.endsWith('.json'))
  let maxCycle = 0
  for (const name of jsonNames) {
    const match = /^cycle-(\d+)\//.exec(name)
    if (match) maxCycle = Math.max(maxCycle, Number(match[1]))
  }
  let latestDisposition = null
  for (const name of jsonNames) {
    const match = /^cycle-(\d+)\/dispositions(?:-attempt-(\d+))?\.json$/.exec(name)
    if (!match) continue
    const rank = [Number(match[1]), Number(match[2] || 1)]
    if (!latestDisposition || rank[0] > latestDisposition.rank[0] ||
        (rank[0] === latestDisposition.rank[0] && rank[1] > latestDisposition.rank[1])) {
      latestDisposition = { name, rank }
    }
  }
  const selected = jsonNames.filter(name => /^scope-[a-f0-9]{64}\.json$/.test(name) ||
    name === 'baseline.json' ||
    name === 'scope-semantic-' + state.key.head + '.json' ||
    name.startsWith('summary/') ||
    (maxCycle && name.startsWith('cycle-' + maxCycle + '/')) ||
    (latestDisposition && name === latestDisposition.name)).sort()
  const remaining = selected.filter(name => name > after)
  const artifacts = []
  let bytes = 0
  for (const name of remaining) {
    const value = parseJsonBuffer(verifyArtifact(state, name).bytes, 'artifact ' + name)
    const size = Buffer.byteLength(JSON.stringify({ name, value }))
    if (artifacts.length && bytes + size > maxBytes) break
    artifacts.push({ name, value })
    bytes += size
  }
  const last = artifacts.length ? artifacts[artifacts.length - 1].name : after
  const hasMore = remaining.some(name => name > last)
  output({ ok: true, run, maxCycle, artifacts, nextAfter: hasMore ? last : 'none', selected: selected.length })
}

function validateRun() {
  const run = validateRunId(requireArg('run'))
  const state = loadState(run)
  const names = verifyArtifacts(state)
  const repository = validateRepository(state.key, args.root, state.repository || null)
  output(Object.assign({ ok: true, state: publicState(state), validatedArtifacts: names.length }, repository ? { repository } : {}))
}

function showOrSetStatus() {
  const run = validateRunId(requireArg('run'))
  if (!args.set) {
    if (args['lock-token'] || args['meta-file']) throw new StateError('state: --lock-token/--meta-file require --set')
    const state = loadState(run)
    output({ ok: true, state: publicState(state) })
    return
  }
  const status = validateStatus(args.set)
  let meta
  if (args['meta-file']) meta = parseJsonBuffer(readRegularFile(args['meta-file'], '--meta-file'), '--meta-file', true)
  const result = withMutation(run, state => {
    const timestamp = now()
    state.status = status
    const item = { status, at: timestamp }
    if (meta !== undefined) { item.meta = meta; state.meta = meta }
    state.statusHistory.push(item)
    return { ok: true, state: publicState(state) }
  })
  output(result)
}

function unlockRun() {
  const run = validateRunId(requireArg('run'))
  const mutex = mutationLockPath(run)
  const mutexToken = acquireDirectoryLock(mutex)
  let result
  try {
    const state = loadState(run)
    requireToken(state)
    releaseLease(run, state.lock.tokenHash)
    state.lock = null
    saveState(state)
    result = { ok: true, state: publicState(state) }
  } finally {
    releaseDirectoryLock(mutex, mutexToken)
  }
  output(result)
}

function touchRun() {
  const run = validateRunId(requireArg('run'))
  const result = withMutation(run, state => {
    return { ok: true, state: publicState(state) }
  })
  output(result)
}

function assertRepository() {
  const run = validateRunId(requireArg('run'))
  const root = requireArg('root')
  const result = withMutation(run, state => {
    const repository = validateRepository(state.key, root, state.repository || null)
    return { ok: true, state: publicState(state), repository }
  })
  output(result)
}

function completeRun() {
  const run = validateRunId(requireArg('run'))
  const status = validateStatus(args.status || 'complete')
  let summary
  if (args['summary-file']) summary = parseJsonBuffer(readRegularFile(args['summary-file'], '--summary-file'), '--summary-file', true)
  const mutex = mutationLockPath(run)
  const mutexToken = acquireDirectoryLock(mutex)
  let result
  try {
    const state = loadState(run)
    requireToken(state)
    if (state.pendingAdvance || state.advanceHandoff) {
      throw new StateError('state: cannot complete while a head transaction is pending acknowledgement', 4)
    }
    if (state.repository && !args.root) throw new StateError('state: --root is required to complete a repository-bound run', 3)
    if (state.repository) validateRepository(state.key, args.root, state.repository)
    const names = verifyArtifacts(state)
    if (args['expected-index']) {
      const expectedName = validateArtifactName(args['expected-index'])
      const expected = parseJsonBuffer(verifyArtifact(state, expectedName).bytes, 'expected artifact index', true)
      if (!Array.isArray(expected.artifacts) || expected.artifacts.some(name => typeof name !== 'string')) {
        throw new StateError('state: expected artifact index is malformed', 3)
      }
      const actual = names.filter(name => name !== expectedName).sort()
      const wanted = [...new Set(expected.artifacts)].sort()
      const missing = wanted.filter(name => !actual.includes(name))
      if (missing.length) {
        throw new StateError('state: persisted artifacts are missing workflow-required entries: ' + missing.join(', '), 3)
      }
    }
    const timestamp = now()
    releaseLease(run, state.lock.tokenHash)
    state.status = status
    state.terminal = true
    state.sealedAt = timestamp
    state.lock = null
    if (summary !== undefined) state.summary = summary
    state.statusHistory.push({ status, at: timestamp, terminal: true })
    saveState(state)
    removeActiveKeys(run)
    result = { ok: true, state: publicState(state), validatedArtifacts: names.length }
  } finally {
    releaseDirectoryLock(mutex, mutexToken)
  }
  output(result)
}

function abandonRun() {
  const run = validateRunId(requireArg('run'))
  const status = validateStatus(args.status || 'abandoned')
  const mutex = mutationLockPath(run)
  const mutexToken = acquireDirectoryLock(mutex)
  let result
  try {
    const state = loadState(run)
    requireToken(state)
    const timestamp = now()
    releaseLease(run, state.lock.tokenHash)
    state.status = status
    state.terminal = true
    state.sealedAt = timestamp
    state.lock = null
    state.statusHistory.push({ status, at: timestamp, terminal: true, artifactsVerified: false })
    saveState(state)
    removeActiveKeys(run)
    result = { ok: true, state: publicState(state), artifactsVerified: false }
  } finally {
    releaseDirectoryLock(mutex, mutexToken)
  }
  output(result)
}

function resumeRun() {
  ensureStore()
  const key = readKey()
  const repository = validateRepository(key, args.root)
  const keyHash = computeKeyHash(key, repository)
  const matches = scanRuns(keyHash)
  if (!matches.length) {
    output({ ok: true, found: false, keyHash })
    return
  }
  const state = matches[0]
  const names = verifyArtifacts(state)
  output(Object.assign({ ok: true, found: true, state: publicState(state), runDir: runPath(state.run), validatedArtifacts: names.length }, repository ? { repository } : {}))
}

function diffFiles() {
  const root = fs.realpathSync(path.resolve(requireArg('root')))
  const base = validateSha(requireArg('base'), '--base')
  const head = validateSha(requireArg('head'), '--head')
  const inventory = diffInventory(root, base, head)
  output(Object.assign({ ok: true, count: inventory.changedFiles.length }, inventory))
}

function repositoryStatus() {
  const root = fs.realpathSync(path.resolve(requireArg('root')))
  const top = fs.realpathSync(git(root, 'rev-parse', '--show-toplevel'))
  if (top !== root) throw new StateError('state: --root must be repository top level', 3)
  const head = git(root, 'rev-parse', '--verify', 'HEAD^{commit}')
  const dirty = gitRawExact(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
  output({ ok: true, root, head, clean: dirty.length === 0, dirtyEntries: dirty ? dirty.split('\0').filter(Boolean).length : 0 })
}

function validateFixReceipt(receipt) {
  if (!receipt || typeof receipt.batchId !== 'string' || !receipt.batchId ||
      !Array.isArray(receipt.fixed) || !Array.isArray(receipt.notABug) ||
      !Array.isArray(receipt.stillOpen) || !Array.isArray(receipt.followUps)) {
    throw new StateError('state: fix receipt is missing required disposition arrays', 3)
  }
  return receipt
}

function readStagedReceipt(state, prefix, partCount) {
  prefix = validateArtifactName(prefix)
  const count = Number(partCount)
  if (!Number.isSafeInteger(count) || count < 1 || count > 4096) {
    throw new StateError('state: --receipt-parts must be an integer from 1 to 4096', 3)
  }
  const parts = []
  let bytes = 0
  for (let index = 0; index < count; index++) {
    const name = prefix + '/' + String(index).padStart(4, '0') + '.part'
    const part = verifyArtifact(state, name).bytes
    bytes += part.length
    if (bytes > 131072) throw new StateError('state: staged receipt exceeds 128 KiB', 3)
    parts.push(part)
  }
  return validateFixReceipt(parseJsonBuffer(Buffer.concat(parts), 'staged receipt', true))
}

function commitTrailers(root, sha) {
  const body = git(root, 'show', '-s', '--format=%B', sha)
  const values = {}
  for (const line of body.split(/\r?\n/)) {
    const match = /^(Review-And-Fix-Run|Review-And-Fix-Transaction):\s*(\S+)\s*$/.exec(line)
    if (match) values[match[1]] = match[2]
  }
  return values
}

function verifyPreparedCommit(state, root, to, txId) {
  const pending = state.pendingAdvance
  if (!pending || pending.txId !== txId) throw new StateError('state: no matching prepared head transaction', 3)
  if (!Array.isArray(pending.validatedPaths) || !pending.validatedSnapshots) {
    throw new StateError('state: prepared transaction was never sealed after validation', 3)
  }
  const parents = git(root, 'rev-list', '--parents', '-n', '1', to).split(/\s+/)
  if (parents.length !== 2 || parents[1] !== pending.from) {
    throw new StateError('state: prepared commit must be a non-merge direct child of its parent', 3)
  }
  const trailers = commitTrailers(root, to)
  if (trailers['Review-And-Fix-Run'] !== state.run || trailers['Review-And-Fix-Transaction'] !== txId) {
    throw new StateError('state: commit is missing its prepared review transaction trailers', 3)
  }
  const allowed = new Set((pending.fallbackReceipt.stillOpen || []).flatMap(finding =>
    Array.isArray(finding.files) && finding.files.length ? finding.files : [finding.primaryFile]).filter(Boolean))
  const committed = gitRawExact(root, 'diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', '-z', to)
    .split('\0').filter(Boolean)
  const outside = committed.filter(file => !allowed.has(file))
  if (outside.length) throw new StateError('state: prepared commit touched undeclared path(s): ' + outside.join(', '), 3)
  if (canonical([...committed].sort()) !== canonical([...pending.validatedPaths].sort())) {
    throw new StateError('state: committed path set differs from validated transaction', 3)
  }
  if (canonical(transactionPathSnapshots(root, pending.validatedPaths, to)) !== canonical(pending.validatedSnapshots)) {
    throw new StateError('state: committed content differs from validated transaction', 3)
  }
  return pending
}

function validateTransactionPaths(root, receipt) {
  root = fs.realpathSync(path.resolve(root))
  const files = (receipt.stillOpen || []).flatMap(finding =>
    Array.isArray(finding.files) && finding.files.length ? finding.files : [finding.primaryFile])
  for (const value of files) {
    const relative = String(value || '')
    const segments = relative.split('/')
    if (!relative || path.isAbsolute(relative) || relative.includes('\\') || /[\r\n\0]/.test(relative) ||
        segments.some(segment => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) {
      throw new StateError('state: unsafe prepared finding path ' + JSON.stringify(relative), 3)
    }
    const target = path.resolve(root, relative)
    if (!target.startsWith(root + path.sep)) throw new StateError('state: prepared finding path escapes repository', 3)
    let cursor = root
    for (const segment of segments) {
      cursor = path.join(cursor, segment)
      if (!fs.existsSync(cursor)) break
      const stat = fs.lstatSync(cursor)
      if (stat.isSymbolicLink() || fs.realpathSync(cursor) !== cursor) {
        throw new StateError('state: prepared finding path crosses a symlink', 3)
      }
    }
  }
}

function transactionPathSnapshots(root, paths, commit = null) {
  const snapshots = []
  for (const relative of [...paths].sort()) {
    if (commit) {
      const rows = gitRawExact(root, '--literal-pathspecs', 'ls-tree', '-z', commit, '--', relative)
        .split('\0').filter(Boolean)
      if (!rows.length) { snapshots.push([relative, { kind: 'missing' }]); continue }
      if (rows.length !== 1 || !rows[0].endsWith('\t' + relative)) {
        throw new StateError('state: ambiguous committed path ' + relative, 3)
      }
      const fields = rows[0].slice(0, rows[0].indexOf('\t')).split(/\s+/)
      snapshots.push([relative, { kind: 'file', mode: fields[0], oid: fields[2] }])
      continue
    }
    const target = path.resolve(root, relative)
    if (!fs.existsSync(target)) { snapshots.push([relative, { kind: 'missing' }]); continue }
    const stat = fs.lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new StateError('state: validated path is not a regular file: ' + relative, 3)
    }
    snapshots.push([relative, { kind: 'file', mode: stat.mode & 0o111 ? '100755' : '100644',
      oid: git(root, 'hash-object', '--path=' + relative, '--', relative) }])
  }
  return snapshots
}

function parseStatusPaths(root) {
  const fields = gitRawExact(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
    .split('\0').filter(Boolean)
  const paths = []
  for (let index = 0; index < fields.length; index++) {
    const row = fields[index]
    if (row.length < 4) throw new StateError('state: malformed git status output', 3)
    paths.push(row.slice(3))
    if (/[RC]/.test(row.slice(0, 2))) {
      const source = fields[++index]
      if (!source) throw new StateError('state: malformed rename/copy status output', 3)
      paths.push(source)
    }
  }
  return [...new Set(paths)].sort()
}

function sealPreparedHead() {
  const run = validateRunId(requireArg('run'))
  const root = fs.realpathSync(path.resolve(requireArg('root')))
  const txId = requireArg('tx-id')
  const decoded = parseJsonBuffer(decodeBase64(requireArg('paths-base64'), '--paths-base64'), '--paths-base64')
  if (!Array.isArray(decoded) || decoded.some(value => typeof value !== 'string')) {
    throw new StateError('state: --paths-base64 must encode a JSON string array', 3)
  }
  const paths = [...new Set(decoded)].sort()
  const mutex = mutationLockPath(run)
  const mutexToken = acquireDirectoryLock(mutex)
  let result
  try {
    const state = loadState(run)
    const pending = state.pendingAdvance
    if (!pending || pending.txId !== txId) throw new StateError('state: no matching prepared head transaction', 3)
    if (pending.validatedAt) throw new StateError('state: prepared transaction validation seal is single-use', 4)
    if (!state.repository || state.repository.root !== root) throw new StateError('state: prepared repository binding mismatch', 3)
    if (git(root, 'rev-parse', '--verify', 'HEAD^{commit}') !== pending.from) {
      throw new StateError('state: HEAD moved before validation seal', 3)
    }
    validateTransactionPaths(root, pending.fallbackReceipt)
    const allowed = new Set((pending.fallbackReceipt.stillOpen || []).flatMap(finding => finding.files || []))
    if (paths.some(file => !allowed.has(file))) throw new StateError('state: validated paths exceed transaction fence', 3)
    if (canonical(parseStatusPaths(root)) !== canonical(paths)) {
      throw new StateError('state: validated paths do not equal measured dirty paths', 3)
    }
    pending.validatedPaths = paths
    pending.validatedSnapshots = transactionPathSnapshots(root, paths)
    pending.validatedAt = now()
    saveState(state)
    result = { ok: true, run, txId, paths: paths.length }
  } finally {
    releaseDirectoryLock(mutex, mutexToken)
  }
  output(result)
}

function prepareHead() {
  const run = validateRunId(requireArg('run'))
  const root = fs.realpathSync(path.resolve(requireArg('root')))
  const from = validateSha(requireArg('from'), '--from')
  const batchId = requireArg('batch')
  if (!/^[A-Za-z0-9_.-]+$/.test(batchId)) throw new StateError('state: --batch must be a safe identifier', 3)
  if (git(root, 'rev-parse', '--verify', 'HEAD^{commit}') !== from) throw new StateError('state: HEAD does not equal prepared parent', 3)
  if (git(root, 'status', '--porcelain=v1', '-z')) throw new StateError('state: repository must be clean before preparing a fix', 3)
  const result = withMutation(run, state => {
    if (state.pendingAdvance) throw new StateError('state: another prepared head transaction is active', 4)
    if (state.key.head !== from || state.lineage.currentHead !== from) {
      throw new StateError('state: prepared parent does not match checkpoint head', 3)
    }
    validateRepository(state.key, root, state.repository || null)
    const fallbackReceipt = readStagedReceipt(state, requireArg('receipt-prefix'), requireArg('receipt-parts'))
    validateTransactionPaths(root, fallbackReceipt)
    if (fallbackReceipt.batchId !== batchId) throw new StateError('state: fallback receipt batch does not match --batch', 3)
    const txId = crypto.randomBytes(32).toString('hex')
    state.pendingAdvance = { txId, batchId, from, fallbackReceipt, preparedAt: now() }
    return { ok: true, state: publicState(state), txId, batchId, from }
  })
  output(result)
}

function abortHead() {
  const run = validateRunId(requireArg('run'))
  const root = fs.realpathSync(path.resolve(requireArg('root')))
  const txId = requireArg('tx-id')
  const result = withMutation(run, state => {
    if (!state.pendingAdvance || state.pendingAdvance.txId !== txId) {
      throw new StateError('state: no matching prepared head transaction', 3)
    }
    if (git(root, 'rev-parse', '--verify', 'HEAD^{commit}') !== state.pendingAdvance.from) {
      throw new StateError('state: prepared transaction may have committed; refusing to discard recovery evidence', 3)
    }
    state.pendingAdvance = null
    return { ok: true, state: publicState(state), aborted: true }
  })
  output(result)
}

function acknowledgeHead() {
  const run = validateRunId(requireArg('run'))
  const txId = requireArg('tx-id')
  const mutex = mutationLockPath(run)
  const mutexToken = acquireDirectoryLock(mutex)
  let result
  try {
    const state = loadState(run)
    requireToken(state)
    if (state.advanceHandoff !== txId || !(state.lineage.ownedCommits || [])
      .some(commit => commit.transactionId === txId)) {
      throw new StateError('state: no matching advanced-head handoff', 3)
    }
    const previousTokenHash = state.lock.tokenHash
    state.advanceHandoff = null
    state.lock = null
    saveState(state)
    writeActiveKey(state)
    releaseLease(run, previousTokenHash)
    result = { ok: true, state: publicState(state), acknowledged: true }
  } finally {
    releaseDirectoryLock(mutex, mutexToken)
  }
  output(result)
}

function advanceHead() {
  const run = validateRunId(requireArg('run'))
  const root = path.resolve(requireArg('root'))
  const from = validateSha(requireArg('from'), '--from')
  const to = validateSha(requireArg('to'), '--to')
  const txId = requireArg('tx-id')
  if (!/^[a-f0-9]{64}$/.test(txId)) throw new StateError('state: --tx-id must be 64 lowercase hex characters', 3)
  const hasInlineReceipt = args['receipt-base64'] !== undefined
  const hasStagedReceipt = args['receipt-prefix'] !== undefined || args['receipt-parts'] !== undefined
  if (hasInlineReceipt === hasStagedReceipt) {
    throw new StateError('state: advance-head requires exactly one receipt source', 3)
  }
  let receipt = hasInlineReceipt
    ? parseJsonBuffer(decodeBase64(args['receipt-base64'], '--receipt-base64'), '--receipt-base64', true)
    : null
  const receiptPrefix = hasStagedReceipt ? requireArg('receipt-prefix') : null
  const receiptParts = hasStagedReceipt ? requireArg('receipt-parts') : null
  const resolvedFrom = git(root, 'rev-parse', '--verify', from + '^{commit}')
  const resolvedTo = git(root, 'rev-parse', '--verify', to + '^{commit}')
  if (resolvedFrom !== from || resolvedTo !== to) throw new StateError('state: --from/--to must be canonical full commit IDs', 3)
  const current = git(root, 'rev-parse', '--verify', 'HEAD^{commit}')
  if (current !== to) throw new StateError('state: repository HEAD does not equal --to', 3)
  if (git(root, 'status', '--porcelain=v1', '-z')) throw new StateError('state: repository is dirty after workflow commit', 3)
  const parents = git(root, 'rev-list', '--parents', '-n', '1', to).split(/\s+/)
  if (parents.length !== 2 || parents[1] !== from) {
    throw new StateError('state: --to must be a non-merge direct child of --from', 3)
  }

  const mutex = mutationLockPath(run)
  const mutexToken = acquireDirectoryLock(mutex)
  let result
  try {
    const state = loadState(run)
    requireToken(state)
    if (state.terminal) throw new StateError('state: run is sealed and cannot be changed')
    const existing = (state.lineage.ownedCommits || []).find(commit => commit.transactionId === txId && commit.to === to)
    if (existing) {
      writeActiveKey(state)
      result = { ok: true, state: publicState(state), from, to, idempotent: true }
      output(result)
      return
    }
    const pending = verifyPreparedCommit(state, root, to, txId)
    if (pending.from !== from) throw new StateError('state: --from does not match prepared transaction', 3)
    receipt = hasStagedReceipt ? readStagedReceipt(state, receiptPrefix, receiptParts) : validateFixReceipt(receipt)
    if (receipt.batchId !== pending.batchId) throw new StateError('state: final receipt batch does not match prepared transaction', 3)
    if (state.key.head !== from || state.lineage.currentHead !== from) {
      throw new StateError('state: --from does not match checkpoint head', 3)
    }
    const nextKey = Object.assign({}, state.key, { head: to })
    const repository = validateRepository(nextKey, root, state.repository || null)
    const nextHash = computeKeyHash(nextKey, repository)
    const lock = keyLockPath(nextHash)
    const lockToken = acquireDirectoryLock(lock)
    try {
      const collision = scanRuns(nextHash).find(other => other.run !== run)
      if (collision) throw new StateError('state: another incomplete run already owns the advanced key: ' + collision.run, 4)
      const timestamp = now()
      state.key = nextKey
      state.keyHash = nextHash
      state.repository = repository
      state.lineage.currentHead = to
      state.lineage.ownedCommits.push({
        from, to, tree: git(root, 'rev-parse', to + '^{tree}'),
        commitSha256: sha256(Buffer.from(git(root, 'cat-file', 'commit', to))), recordedAt: timestamp,
        transactionId: txId, receipt,
      })
      state.pendingAdvance = null
      state.advanceHandoff = txId
      state.lock.touchedAt = timestamp
      state.lock.expiresAt = new Date(Date.now() + state.lock.leaseSeconds * 1000).toISOString()
      saveState(state)
      writeActiveKey(state)
      writeLease(state, false)
      result = { ok: true, state: publicState(state), from, to }
    } finally {
      releaseDirectoryLock(lock, lockToken)
    }
  } finally {
    releaseDirectoryLock(mutex, mutexToken)
  }
  output(result)
}

function output(value) {
  const journalCommands = new Set(['put', 'status', 'complete', 'abandon', 'touch', 'assert-repo', 'unlock',
    'prepare-head', 'abort-head', 'ack-head', 'advance-head'])
  let rendered = value
  if (args['response-id'] && journalCommands.has(COMMAND)) {
    ensureStore()
    rendered = Object.assign({}, value, { responseId: validateResponseId(args['response-id']) })
    atomicWrite(claimResponsePath(args['response-id']), Buffer.from(JSON.stringify(rendered, null, 2) + '\n'))
  }
  process.stdout.write(JSON.stringify(rendered, null, 2) + '\n')
}

try {
  if (COMMAND === 'nonce') issueNonce()
  else if (COMMAND === 'claim-result') claimResult()
  else if (COMMAND === 'action-result') actionResult()
  else if (COMMAND === 'claim') claim(false)
  else if (COMMAND === 'init') claim(true)
  else if (COMMAND === 'put') putArtifact()
  else if (COMMAND === 'get') getArtifact()
  else if (COMMAND === 'list') listArtifacts()
  else if (COMMAND === 'export-json') exportJsonArtifacts()
  else if (COMMAND === 'resume-json') resumeJsonArtifacts()
  else if (COMMAND === 'export-lineage') exportLineage()
  else if (COMMAND === 'validate') validateRun()
  else if (COMMAND === 'status') showOrSetStatus()
  else if (COMMAND === 'complete') completeRun()
  else if (COMMAND === 'abandon') abandonRun()
  else if (COMMAND === 'touch') touchRun()
  else if (COMMAND === 'assert-repo') assertRepository()
  else if (COMMAND === 'unlock') unlockRun()
  else if (COMMAND === 'resume') resumeRun()
  else if (COMMAND === 'prepare-head') prepareHead()
  else if (COMMAND === 'seal-head') sealPreparedHead()
  else if (COMMAND === 'abort-head') abortHead()
  else if (COMMAND === 'ack-head') acknowledgeHead()
  else if (COMMAND === 'advance-head') advanceHead()
  else if (COMMAND === 'diff-files') diffFiles()
  else if (COMMAND === 'repo-status') repositoryStatus()
  else if (COMMAND === 'prune') pruneStore(args.days === undefined ? DEFAULT_PRUNE_DAYS : Number(args.days))
  else throw new StateError('state: unknown command ' + JSON.stringify(COMMAND || '(missing)'))
} catch (error) {
  const code = error instanceof StateError ? error.code : 1
  output(Object.assign({ ok: false, error: String(error.message || error) }, error.details === undefined ? {} : { details: error.details }))
  process.exitCode = code
}
