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
//   put-control --run id --lock-token token --root repo --name logical/name.json
//               --expected-head sha --base64 data
//   import-journal --run id --lock-token token --root repo --name logical/name.json
//                  --source-label label --caller-label label --kind kind --expected-id id
//                  --expected-head sha --source-phase phase [--expected-skill-status status]
//                  [--project-cwd cwd]
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
//                (--receipt-base64 data|--receipt-prefix prefix --receipt-parts count)
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
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024
const MAX_META_BYTES = 1024 * 1024
const IMPORT_KINDS = new Set(['scope', 'lens', 'gap', 'coverage-audit', 'verification', 'semantic-manifest'])
const STATE_CLAIM_LABELS = new Set([
  'claim review state', 'recover state claim', 'reclaim advanced state', 'verify advanced claim',
])
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
  'put-control': { values: ['store', 'run', 'lock-token', 'root', 'name', 'expected-head', 'base64'] },
  'import-journal': { values: ['store', 'run', 'lock-token', 'root', 'name', 'source-label',
                               'caller-label', 'kind', 'expected-id', 'expected-head', 'source-phase',
                               'expected-skill-status', 'project-cwd'] },
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
                              'receipt-base64', 'receipt-prefix', 'receipt-parts', 'response-id'] },
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

function requireRealDirectory(directory, label) {
  const resolved = path.resolve(directory)
  let stat
  try { stat = fs.lstatSync(resolved) } catch (error) {
    throw new StateError('state: cannot inspect ' + label + ': ' + String(error.message || error), 3)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new StateError('state: ' + label + ' must be a real, non-symlink directory', 3)
  }
  let real
  try { real = fs.realpathSync(resolved) } catch (error) {
    throw new StateError('state: cannot resolve ' + label + ': ' + String(error.message || error), 3)
  }
  if (real !== resolved) throw new StateError('state: ' + label + ' must be canonical and contain no symlink', 3)
  return real
}

function pinRealDirectory(directory, label) {
  const real = requireRealDirectory(directory, label)
  const stat = fs.lstatSync(real, { bigint: true })
  return { path: real, label, dev: stat.dev, ino: stat.ino }
}

function assertPinnedDirectories(pins) {
  for (const pin of pins) {
    let stat, real
    try {
      stat = fs.lstatSync(pin.path, { bigint: true })
      real = fs.realpathSync(pin.path)
    } catch (error) {
      throw new StateError('state: pinned ' + pin.label + ' became unavailable: ' +
        String(error.message || error), 3)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || real !== pin.path ||
        stat.dev !== pin.dev || stat.ino !== pin.ino) {
      throw new StateError('state: pinned ' + pin.label + ' directory identity changed during import', 3)
    }
  }
}

function stableStatEqual(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function readStableRegularFile(file, label, maxBytes, requireNewline = false) {
  let fd
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    fd = fs.openSync(file, flags)
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile()) throw new StateError('state: ' + label + ' must be a regular, non-symlink file', 3)
    if (before.size > BigInt(maxBytes)) throw new StateError('state: ' + label + ' exceeds the size limit', 3)
    const bytes = fs.readFileSync(fd)
    const after = fs.fstatSync(fd, { bigint: true })
    const current = fs.lstatSync(file, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink() || !stableStatEqual(before, after) ||
        before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size ||
        before.mtimeNs !== current.mtimeNs || before.ctimeNs !== current.ctimeNs ||
        BigInt(bytes.length) !== before.size) {
      throw new StateError('state: ' + label + ' changed while it was read', 3)
    }
    if (requireNewline && (!bytes.length || bytes[bytes.length - 1] !== 0x0a)) {
      throw new StateError('state: ' + label + ' must be newline-terminated', 3)
    }
    return bytes
  } catch (error) {
    if (error instanceof StateError) throw error
    if (error && error.code === 'ELOOP') {
      throw new StateError('state: ' + label + ' must be a regular, non-symlink file', 3)
    }
    throw new StateError('state: cannot read ' + label + ': ' + String(error.message || error), 3)
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

function parseJsonLines(bytes, label) {
  const text = bytes.toString('utf8')
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const values = []
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) throw new StateError('state: blank line in ' + label + ' at line ' + (index + 1), 3)
    values.push(parseJsonBuffer(Buffer.from(lines[index]), label + ' line ' + (index + 1), true))
  }
  return values
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

function atomicWriteImmutable(file, buffer, mode = 0o600) {
  const parent = path.dirname(file)
  ensureDirectory(parent, true)
  const temp = path.join(parent, '.' + path.basename(file) + '.tmp-' + process.pid + '-' +
    crypto.randomBytes(8).toString('hex'))
  let fd
  try {
    fd = fs.openSync(temp, 'wx', mode)
    fs.writeFileSync(fd, buffer)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    try { fs.linkSync(temp, file) } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    }
    fsyncDirectory(parent)
    return true
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
    const fromKeyHash = state.keyHash
    const timestamp = now()
    state.key = nextKey
    state.keyHash = keyHash
    state.repository = repository
    state.lineage.currentHead = head
    state.lineage.ownedCommits.push({
      from: pending.from, to: head, tree: git(root, 'rev-parse', head + '^{tree}'),
      fromKeyHash, toKeyHash: keyHash,
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

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireOpaque(value, label, max = 512) {
  if (typeof value !== 'string' || !value || value.length > max || /[\0\r\n]/.test(value)) {
    throw new StateError('state: ' + label + ' must be a non-empty string without control newlines', 3)
  }
  return value
}

function requireObject(value, label) {
  if (!isObject(value)) throw new StateError('state: imported ' + label + ' must be an object', 3)
  return value
}

function requireStringField(value, field, label, allowed = null) {
  if (typeof value[field] !== 'string' || !value[field]) {
    throw new StateError('state: imported ' + label + '.' + field + ' must be a non-empty string', 3)
  }
  if (allowed && !allowed.has(value[field])) {
    throw new StateError('state: imported ' + label + '.' + field + ' has an unsupported value', 3)
  }
}

function requireBooleanField(value, field, label) {
  if (typeof value[field] !== 'boolean') {
    throw new StateError('state: imported ' + label + '.' + field + ' must be boolean', 3)
  }
}

function requireStringArrayField(value, field, label) {
  if (!Array.isArray(value[field]) || value[field].some(item => typeof item !== 'string' || !item)) {
    throw new StateError('state: imported ' + label + '.' + field + ' must be an array of non-empty strings', 3)
  }
}

function requireSchemaStringField(value, field, label) {
  if (typeof value[field] !== 'string') {
    throw new StateError('state: imported ' + label + '.' + field + ' must be a string', 3)
  }
}

function requireSchemaStringArrayField(value, field, label) {
  if (!Array.isArray(value[field]) || value[field].some(item => typeof item !== 'string')) {
    throw new StateError('state: imported ' + label + '.' + field + ' must be an array of strings', 3)
  }
}

function requireNonnegativeIntegerField(value, field, label) {
  if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
    throw new StateError('state: imported ' + label + '.' + field + ' must be a nonnegative safe integer', 3)
  }
}

const FINDING_STRING_FIELDS = ['fingerprint', 'title', 'detail', 'primaryFile', 'symbol', 'defectClass',
  'evidence', 'trigger', 'mechanism', 'observableImpact', 'baseVsHead', 'severity', 'confidence',
  'fixSize', 'deferReason', 'blockerReason', 'scopeLabel', 'deferralQuote']
const REJECTION_STRING_FIELDS = ['fingerprint', 'title', 'detail', 'primaryFile', 'symbol', 'defectClass',
  'evidence', 'trigger', 'mechanism', 'observableImpact', 'baseVsHead', 'severity', 'confidence',
  'blockerReason', 'reason', 'kind']
const DEFECT_CLASSES = new Set(['logic', 'nil-deref', 'bounds', 'concurrency', 'resource-leak',
  'error-handling', 'security', 'api-contract', 'perf', 'regression', 'test-gap', 'docs', 'style',
  'dead-code', 'design'])
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])
const CONFIDENCES = new Set(['certain', 'likely', 'speculative'])
const FIX_SIZES = new Set(['trivial', 'small', 'medium', 'large'])
const SCOPE_LABELS = new Set(['in', 'deferred', 'out'])
const NATIVE_LENSES = new Set(['correctness', 'spec', 'standards', 'security', 'reliability', 'contracts',
  'testing', 'performance', 'comments', 'maintainability'])

function validateScopeResult(result, expectedId, identity) {
  const label = 'scope result'
  requireObject(result, label)
  if (!isObject(identity)) throw new StateError('state: scope import identity is unavailable', 3)

  const stringFields = ['repo', 'slug', 'baseRef', 'mergeBaseSha', 'headSha', 'startBranch',
    'startSha', 'repoRoot', 'intent', 'scopeFingerprint', 'intentSource', 'bodyQuality', 'prAuthor', 'ghUser',
    'blocker', 'classifyPath', 'classifyAction', 'fingerprint', 'ledgerPath', 'runDir', 'chunkerStderr', 'notes']
  for (const field of stringFields) requireSchemaStringField(result, field, label)
  for (const field of ['title', 'url']) {
    if (result[field] !== undefined) requireSchemaStringField(result, field, label)
  }
  for (const field of ['treeClean', 'headMatchesPr', 'authoredByMe', 'binOk']) {
    requireBooleanField(result, field, label)
  }
  for (const field of ['inScope', 'outOfScope', 'acceptanceCriteria', 'primaryLanguages', 'notReviewable']) {
    requireSchemaStringArrayField(result, field, label)
  }
  if (!Number.isSafeInteger(result.prNumber) || result.prNumber < 1) {
    throw new StateError('state: imported ' + label + '.prNumber must be a positive safe integer', 3)
  }
  for (const field of ['ledgerEntries', 'hunksInLedger']) requireNonnegativeIntegerField(result, field, label)
  if (!['body', 'commits', 'linked-issue', 'inferred-from-diff'].includes(result.intentSource)) {
    throw new StateError('state: imported ' + label + '.intentSource has an unsupported value', 3)
  }
  if (!['good', 'thin', 'empty'].includes(result.bodyQuality)) {
    throw new StateError('state: imported ' + label + '.bodyQuality has an unsupported value', 3)
  }
  if (!['unused', 'reused', 'needs-generation', 'failed'].includes(result.classifyAction)) {
    throw new StateError('state: imported ' + label + '.classifyAction has an unsupported value', 3)
  }

  if (!Array.isArray(result.changedFiles)) {
    throw new StateError('state: imported ' + label + '.changedFiles must be an array', 3)
  }
  result.changedFiles.forEach((file, index) => {
    const fileLabel = label + '.changedFiles[' + index + ']'
    requireObject(file, fileLabel)
    requireSchemaStringField(file, 'path', fileLabel)
    requireSchemaStringField(file, 'status', fileLabel)
    if (!['added', 'modified', 'deleted', 'renamed'].includes(file.status)) {
      throw new StateError('state: imported ' + fileLabel + '.status has an unsupported value', 3)
    }
  })

  if (!Array.isArray(result.coverageUnits)) {
    throw new StateError('state: imported ' + label + '.coverageUnits must be an array', 3)
  }
  // This is the frozen Scope-agent result, before deterministic hunk/non-text units are merged in.
  const coverageTypes = new Set(['requirement', 'contract', 'test-obligation', 'documentation-claim',
    'repository-rule'])
  result.coverageUnits.forEach((unit, index) => {
    const unitLabel = label + '.coverageUnits[' + index + ']'
    requireObject(unit, unitLabel)
    for (const field of ['id', 'type', 'path', 'symbol', 'hash', 'summary']) {
      requireSchemaStringField(unit, field, unitLabel)
    }
    if (!coverageTypes.has(unit.type)) {
      throw new StateError('state: imported ' + unitLabel + '.type has an unsupported value', 3)
    }
  })

  if (!Array.isArray(result.chunks)) {
    throw new StateError('state: imported ' + label + '.chunks must be an array', 3)
  }
  result.chunks.forEach((chunk, index) => {
    const chunkLabel = label + '.chunks[' + index + ']'
    requireObject(chunk, chunkLabel)
    for (const field of ['id', 'stage', 'lockKey', 'path']) requireSchemaStringField(chunk, field, chunkLabel)
    if (chunk.hashFile !== undefined) requireSchemaStringField(chunk, 'hashFile', chunkLabel)
    for (const field of ['files', 'wholeFiles']) requireSchemaStringArrayField(chunk, field, chunkLabel)
    for (const field of ['bytes', 'hunkCount']) requireNonnegativeIntegerField(chunk, field, chunkLabel)
  })

  if (!Array.isArray(result.applicableLenses)) {
    throw new StateError('state: imported ' + label + '.applicableLenses must be an array', 3)
  }
  result.applicableLenses.forEach((lens, index) => {
    const lensLabel = label + '.applicableLenses[' + index + ']'
    requireObject(lens, lensLabel)
    requireSchemaStringField(lens, 'lens', lensLabel)
    requireSchemaStringField(lens, 'reason', lensLabel)
    if (!NATIVE_LENSES.has(lens.lens)) {
      throw new StateError('state: imported ' + lensLabel + '.lens has an unsupported value', 3)
    }
  })

  const mismatches = []
  if (result.repo !== identity.repo) mismatches.push('repo')
  if (result.prNumber !== identity.prNumber) mismatches.push('prNumber')
  if (result.mergeBaseSha !== identity.mergeBaseSha) mismatches.push('mergeBaseSha')
  if (result.headSha !== identity.prHeadSha) mismatches.push('headSha')
  if (result.startSha !== identity.currentHeadSha) mismatches.push('startSha')
  if (result.scopeFingerprint !== identity.scopeFingerprint || result.scopeFingerprint !== expectedId) {
    mismatches.push('scopeFingerprint')
  }
  if (mismatches.length) {
    throw new StateError('state: imported ' + label + ' does not match the active checkpoint: ' +
      mismatches.join(', '), 3)
  }
}

function validateFinding(finding, label) {
  requireObject(finding, label)
  for (const field of FINDING_STRING_FIELDS) requireStringField(finding, field, label)
  requireStringArrayField(finding, 'files', label)
  requireStringArrayField(finding, 'coverageUnitIds', label)
  requireBooleanField(finding, 'defer', label)
  requireBooleanField(finding, 'releaseBlocker', label)
  if (!DEFECT_CLASSES.has(finding.defectClass) || !SEVERITIES.has(finding.severity) ||
      !CONFIDENCES.has(finding.confidence) || !FIX_SIZES.has(finding.fixSize) ||
      !SCOPE_LABELS.has(finding.scopeLabel)) {
    throw new StateError('state: imported ' + label + ' has an unsupported finding enum value', 3)
  }
}

function validateRejection(rejection, label) {
  requireObject(rejection, label)
  for (const field of REJECTION_STRING_FIELDS) requireStringField(rejection, field, label)
  requireStringArrayField(rejection, 'files', label)
  requireStringArrayField(rejection, 'coverageUnitIds', label)
  requireBooleanField(rejection, 'releaseBlocker', label)
  if (!DEFECT_CLASSES.has(rejection.defectClass) || !SEVERITIES.has(rejection.severity) ||
      !CONFIDENCES.has(rejection.confidence) || !['not-a-bug', 'out-of-scope'].includes(rejection.kind)) {
    throw new StateError('state: imported ' + label + '.kind has an unsupported value', 3)
  }
}

function validateFollowUp(followUp, label) {
  requireObject(followUp, label)
  for (const field of ['title', 'detail', 'area', 'size', 'blockerReason']) {
    requireStringField(followUp, field, label)
  }
  requireBooleanField(followUp, 'releaseBlocker', label)
  if (!['small', 'big'].includes(followUp.size)) {
    throw new StateError('state: imported ' + label + '.size has an unsupported value', 3)
  }
}

function validateReadOnlyResult(result, expectedOutcome, label) {
  requireStringField(result, 'outcome', label)
  if (result.outcome !== expectedOutcome) {
    throw new StateError('state: imported ' + label + ' must have outcome ' + expectedOutcome, 3)
  }
  if (result.commitSha !== 'none') throw new StateError('state: imported ' + label + '.commitSha must be "none"', 3)
  if (!Array.isArray(result.filesTouched) || result.filesTouched.length) {
    throw new StateError('state: imported ' + label + '.filesTouched must be empty', 3)
  }
  if (typeof result.notes !== 'string') throw new StateError('state: imported ' + label + '.notes must be a string', 3)
}

function validateLensResult(result, expectedId, expectedSkillStatus, kind) {
  const label = kind + ' result'
  requireObject(result, label)
  if (result.lens !== expectedId) throw new StateError('state: imported ' + label + '.lens does not match --expected-id', 3)
  const skillStatuses = new Set(['not-requested', 'used', 'unavailable', 'incompatible'])
  requireStringField(result, 'reviewSkillStatus', label, skillStatuses)
  if (expectedSkillStatus !== undefined && result.reviewSkillStatus !== expectedSkillStatus) {
    throw new StateError('state: imported ' + label + '.reviewSkillStatus does not match --expected-skill-status', 3)
  }
  for (const field of ['findings', 'rejected', 'followUps', 'coverageReceipts']) {
    if (!Array.isArray(result[field])) throw new StateError('state: imported ' + label + '.' + field + ' must be an array', 3)
  }
  result.findings.forEach((item, index) => validateFinding(item, label + '.findings[' + index + ']'))
  result.rejected.forEach((item, index) => validateRejection(item, label + '.rejected[' + index + ']'))
  result.followUps.forEach((item, index) => validateFollowUp(item, label + '.followUps[' + index + ']'))
  result.coverageReceipts.forEach((receipt, index) => {
    const receiptLabel = label + '.coverageReceipts[' + index + ']'
    requireObject(receipt, receiptLabel)
    for (const field of ['unitId', 'status', 'depth', 'evidence', 'reason']) {
      requireStringField(receipt, field, receiptLabel)
    }
    if (!['checked', 'not-applicable', 'blocked'].includes(receipt.status) ||
        !['surface', 'traced'].includes(receipt.depth)) {
      throw new StateError('state: imported ' + receiptLabel + ' has an unsupported status or depth', 3)
    }
  })
  validateReadOnlyResult(result, 'reviewed', label)
}

function validateCoverageAuditResult(result) {
  const label = 'coverage-audit result'
  requireObject(result, label)
  requireStringArrayField(result, 'coveredUnitIds', label)
  if (!Array.isArray(result.gaps)) throw new StateError('state: imported ' + label + '.gaps must be an array', 3)
  result.gaps.forEach((gap, index) => {
    const gapLabel = label + '.gaps[' + index + ']'
    requireObject(gap, gapLabel)
    for (const field of ['id', 'requiredLens', 'focus', 'reason']) requireStringField(gap, field, gapLabel)
    requireStringArrayField(gap, 'unitIds', gapLabel)
    if (!NATIVE_LENSES.has(gap.requiredLens)) {
      throw new StateError('state: imported ' + gapLabel + '.requiredLens has an unsupported value', 3)
    }
  })
  requireStringField(result, 'coverage', label)
  validateReadOnlyResult(result, 'audited', label)
}

function validateVerificationResult(result) {
  const label = 'verification result'
  requireObject(result, label)
  for (const field of ['confirmed', 'rejected', 'unresolved']) {
    if (!Array.isArray(result[field])) throw new StateError('state: imported ' + label + '.' + field + ' must be an array', 3)
    result[field].forEach((item, index) => {
      const itemLabel = label + '.' + field + '[' + index + ']'
      requireObject(item, itemLabel)
      for (const key of ['candidateId', 'reason', 'firstPassReason', 'secondPassReason']) {
        requireStringField(item, key, itemLabel)
      }
      validateFinding(item.finding, itemLabel + '.finding')
    })
  }
  requireStringField(result, 'coverage', label)
  validateReadOnlyResult(result, 'validated', label)
}

function validateSemanticManifestResult(result) {
  const label = 'semantic-manifest result'
  requireObject(result, label)
  if (!Array.isArray(result.coverageUnits)) {
    throw new StateError('state: imported ' + label + '.coverageUnits must be an array', 3)
  }
  const unitTypes = new Set(['requirement', 'contract', 'test-obligation', 'documentation-claim', 'repository-rule'])
  result.coverageUnits.forEach((unit, index) => {
    const unitLabel = label + '.coverageUnits[' + index + ']'
    requireObject(unit, unitLabel)
    for (const field of ['id', 'type', 'path', 'symbol', 'hash', 'summary']) requireStringField(unit, field, unitLabel)
    if (!unitTypes.has(unit.type)) throw new StateError('state: imported ' + unitLabel + '.type is unsupported', 3)
  })
  validateReadOnlyResult(result, 'refreshed', label)
}

function validateImportedResult(kind, result, expectedId, expectedSkillStatus, scopeIdentity) {
  if (kind === 'scope') validateScopeResult(result, expectedId, scopeIdentity)
  else if (kind === 'lens' || kind === 'gap') validateLensResult(result, expectedId, expectedSkillStatus, kind)
  else if (kind === 'coverage-audit') validateCoverageAuditResult(result)
  else if (kind === 'verification') validateVerificationResult(result)
  else if (kind === 'semantic-manifest') validateSemanticManifestResult(result)
  else throw new StateError('state: unsupported journal import kind', 3)
  canonical(result)
}

function validateStoredImportEnvelope(bytes, label, state, expected) {
  const envelope = parseJsonBuffer(bytes, label, true)
  if (envelope.importVersion !== 1 || !isObject(envelope.binding) || !isObject(envelope.result)) {
    throw new StateError('state: ' + label + ' is not a supported journal import envelope', 3)
  }
  const binding = envelope.binding
  if (binding.run !== state.run || binding.keyHash !== state.keyHash ||
      binding.repositoryIdentity !== state.repository.identity || binding.headSha !== expected.headSha ||
      binding.kind !== expected.kind || binding.resultId !== expected.resultId ||
      binding.artifactName !== expected.artifactName || binding.sourcePhase !== expected.sourcePhase ||
      binding.projectCwd !== expected.projectCwd) {
    throw new StateError('state: ' + label + ' binding does not match the active checkpoint', 3)
  }
  requireOpaque(binding.sourceLabel, label + ' binding.sourceLabel')
  requireOpaque(binding.sourceKey, label + ' binding.sourceKey')
  requireOpaque(binding.agentId, label + ' binding.agentId', 256)
  requireOpaque(binding.workflowId, label + ' binding.workflowId', 256)
  requireOpaque(binding.sessionId, label + ' binding.sessionId', 128)
  if (!/^wf_[A-Za-z0-9._-]{1,128}$/.test(binding.workflowId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(binding.agentId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binding.sessionId)) {
    throw new StateError('state: ' + label + ' has unsafe Workflow provenance', 3)
  }
  validateImportedResult(expected.kind, envelope.result, expected.resultId, expected.expectedSkillStatus,
    expected.scopeIdentity)
  const canonicalBytes = Buffer.from(JSON.stringify(envelope, null, 2) + '\n')
  if (!canonicalBytes.equals(bytes)) {
    throw new StateError('state: ' + label + ' does not use the immutable import encoding', 3)
  }
  return envelope
}

function pairKey(event) {
  return event.agentId + '\0' + event.key
}

function validateJournalEvents(events, label) {
  const starts = new Map()
  const terminals = new Map()
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (!['launched', 'started', 'result', 'failed'].includes(event.type)) {
      throw new StateError('state: unsupported event type in ' + label + ' at line ' + (index + 1), 3)
    }
    if (event.type === 'launched') continue
    for (const field of ['key', 'agentId']) {
      if (typeof event[field] !== 'string' || !event[field] || event[field].length > 256 || /[\0\r\n]/.test(event[field])) {
        throw new StateError('state: malformed ' + event.type + ' event in ' + label + ' at line ' + (index + 1), 3)
      }
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(event.agentId)) {
      throw new StateError('state: unsafe agentId in ' + label + ' at line ' + (index + 1), 3)
    }
    const pair = pairKey(event)
    if (event.type === 'started') {
      for (const field of ['label', 'phase']) {
        if (typeof event[field] !== 'string' || !event[field] || event[field].length > 512 || /[\0\r\n]/.test(event[field])) {
          throw new StateError('state: malformed started event in ' + label + ' at line ' + (index + 1), 3)
        }
      }
      if (starts.has(pair)) throw new StateError('state: duplicate started pair in ' + label, 3)
      starts.set(pair, event)
    } else if (!starts.has(pair)) {
      throw new StateError('state: unpaired ' + event.type + ' event in ' + label, 3)
    } else {
      if (terminals.has(pair)) throw new StateError('state: duplicate terminal event pair in ' + label, 3)
      terminals.set(pair, event.type)
      if (event.type === 'result' && !Object.prototype.hasOwnProperty.call(event, 'result')) {
        throw new StateError('state: result event in ' + label + ' is missing its result', 3)
      }
      if (event.type === 'result') canonical(event.result)
    }
  }
}

function pairedEvents(events, started) {
  const pair = pairKey(started)
  return {
    results: events.filter(event => event.type === 'result' && pairKey(event) === pair),
    failures: events.filter(event => event.type === 'failed' && pairKey(event) === pair),
  }
}

function claimResultMatches(value, expected) {
  const repository = value && value.repository
  const publicStateValue = value && value.state
  const lineage = publicStateValue && publicStateValue.lineage
  return isObject(value) && value.ok === true && value.run === expected.run &&
    value.keyHash === expected.keyHash && /^[a-f0-9]{64}$/.test(String(value.lockToken || '')) &&
    (expected.lockToken === undefined || value.lockToken === expected.lockToken) &&
    isObject(repository) && repository.identity === expected.repositoryIdentity &&
    repository.root === expected.root && repository.head === expected.head &&
    isObject(publicStateValue) && publicStateValue.keyHash === expected.keyHash &&
    isObject(lineage) && lineage.currentHead === expected.head
}

function validateAgentMeta(workflowDir, started, role) {
  const file = path.join(workflowDir, 'agent-' + started.agentId + '.meta.json')
  const bytes = readStableRegularFile(file, role + ' agent metadata', MAX_META_BYTES)
  const meta = parseJsonBuffer(bytes,
    role + ' agent metadata', true)
  if (meta.agentType !== 'workflow-subagent' || meta.description !== started.label ||
      meta.workflowPhase !== started.phase) {
    throw new StateError('state: ' + role + ' agent metadata does not match the journal start', 3)
  }
  return sha256(bytes)
}

function structuredOutputValue(input, label) {
  if (isObject(input) && Object.keys(input).length === 1 && typeof input.input === 'string') {
    return parseJsonBuffer(Buffer.from(input.input), label, true)
  }
  return requireObject(input, label)
}

function validateAgentTranscript(workflowDir, started, sessionId, projectCwd, expectedResult, role) {
  const file = path.join(workflowDir, 'agent-' + started.agentId + '.jsonl')
  const bytes = readStableRegularFile(file, role + ' agent transcript', MAX_TRANSCRIPT_BYTES, true)
  const entries = parseJsonLines(bytes, role + ' agent transcript')
  let sawBinding = false
  let lastStructured
  for (const entry of entries) {
    if (entry.agentId !== undefined && entry.agentId !== started.agentId) {
      throw new StateError('state: ' + role + ' transcript agentId does not match its journal start', 3)
    }
    if (entry.sessionId !== undefined || entry.cwd !== undefined) {
      if (entry.sessionId !== sessionId || entry.cwd !== projectCwd) {
        throw new StateError('state: ' + role + ' transcript cwd/session does not match its Workflow directory', 3)
      }
      sawBinding = true
    }
    const content = entry.message && Array.isArray(entry.message.content) ? entry.message.content : []
    for (const item of content) {
      if (isObject(item) && item.type === 'tool_use' && item.name === 'StructuredOutput') {
        lastStructured = structuredOutputValue(item.input, role + ' StructuredOutput input')
      }
    }
  }
  if (!sawBinding) throw new StateError('state: ' + role + ' transcript has no cwd/session binding', 3)
  if (expectedResult !== undefined) {
    if (!lastStructured) throw new StateError('state: ' + role + ' transcript has no StructuredOutput result', 3)
    if (canonical(lastStructured) !== canonical(expectedResult)) {
      throw new StateError('state: ' + role + ' transcript StructuredOutput does not match the journal result', 3)
    }
  }
  return sha256(bytes)
}

function safeDirectoryEntries(directory, label) {
  let entries
  try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch (error) {
    throw new StateError('state: cannot enumerate ' + label + ': ' + String(error.message || error), 3)
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}

function workflowJournalCandidates(state, options) {
  const config = requireRealDirectory(path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')),
    'Claude config directory')
  const projects = requireRealDirectory(path.join(config, 'projects'), 'Claude projects directory')
  const projectName = options.projectCwd.replace(/[^A-Za-z0-9]/g, '-')
  const projectPin = pinRealDirectory(path.join(projects, projectName), 'Workflow project')
  const projectDir = projectPin.path
  const candidates = []
  const near = []
  for (const sessionEntry of safeDirectoryEntries(projectDir, 'Workflow project directory')) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionEntry.name) || !sessionEntry.isDirectory() ||
        sessionEntry.isSymbolicLink()) continue
    assertPinnedDirectories([projectPin])
    const sessionPin = pinRealDirectory(path.join(projectDir, sessionEntry.name), 'Workflow session')
    const sessionDir = sessionPin.path
    const workflowsPath = path.join(sessionDir, 'subagents', 'workflows')
    if (!fs.existsSync(workflowsPath)) continue
    const workflowsPin = pinRealDirectory(workflowsPath, 'Workflow collection')
    const workflowsDir = workflowsPin.path
    for (const workflowEntry of safeDirectoryEntries(workflowsDir, 'Workflow collection directory')) {
      if (!/^wf_[A-Za-z0-9._-]{1,128}$/.test(workflowEntry.name) || !workflowEntry.isDirectory() ||
          workflowEntry.isSymbolicLink()) continue
      const workflowPin = pinRealDirectory(path.join(workflowsDir, workflowEntry.name), 'Workflow')
      const workflowDir = workflowPin.path
      const directoryPins = [projectPin, sessionPin, workflowsPin, workflowPin]
      const journalPath = path.join(workflowDir, 'journal.jsonl')
      if (!fs.existsSync(journalPath)) continue
      let journalBytes, events
      try {
        assertPinnedDirectories(directoryPins)
        journalBytes = readStableRegularFile(journalPath, 'Workflow journal', MAX_JOURNAL_BYTES, true)
        assertPinnedDirectories(directoryPins)
        events = parseJsonLines(journalBytes, 'Workflow journal')
      } catch (error) {
        if (error instanceof StateError) throw error
        throw error
      }
      const callerLabelStarts = events.filter(event => event.type === 'started' && event.label === options.callerLabel)
      const callerStarts = callerLabelStarts.filter(start => {
        const paired = pairedEvents(events, start)
        return !paired.results.length && !paired.failures.length
      })
      const sourceLabelStarts = events.filter(event => event.type === 'started' && event.label === options.sourceLabel)
      const exactClaimResults = []
      for (const start of events.filter(event => event.type === 'started' && STATE_CLAIM_LABELS.has(event.label))) {
        const paired = pairedEvents(events, start)
        if (paired.results.length === 1 && !paired.failures.length) {
          const value = paired.results[0].result
          if (claimResultMatches(value, { run: state.run, keyHash: state.keyHash,
            repositoryIdentity: state.repository.identity, root: options.root, head: state.lineage.currentHead,
            lockToken: options.lockToken })) exactClaimResults.push({ start, result: value })
        }
      }
      if (!callerLabelStarts.length && !sourceLabelStarts.length && !exactClaimResults.length) continue
      validateJournalEvents(events, 'Workflow journal ' + workflowEntry.name)
      if (callerStarts.length !== 1) {
        near.push({ workflowId: workflowEntry.name, reason: 'caller label is missing or ambiguous' })
        continue
      }
      const caller = callerStarts[0]
      if (!exactClaimResults.length) {
        near.push({ workflowId: workflowEntry.name, reason: 'active state claim proof is missing' })
        continue
      }
      if (sourceLabelStarts.length !== 1 || sourceLabelStarts[0].phase !== options.sourcePhase) {
        near.push({ workflowId: workflowEntry.name, reason: 'source label/phase is missing or ambiguous' })
        continue
      }
      const source = sourceLabelStarts[0]
      const sourcePaired = pairedEvents(events, source)
      if (sourcePaired.results.length !== 1 || sourcePaired.failures.length) {
        near.push({ workflowId: workflowEntry.name, reason: 'source result is missing, failed, or duplicated' })
        continue
      }
      if (exactClaimResults.some(claim => claim.start.phase !== 'Setup')) {
        near.push({ workflowId: workflowEntry.name, reason: 'state claim phase is invalid' })
        continue
      }
      assertPinnedDirectories(directoryPins)
      const callerMetaHash = validateAgentMeta(workflowDir, caller, 'caller')
      const callerTranscriptHash = validateAgentTranscript(workflowDir, caller, sessionEntry.name,
        options.projectCwd, undefined, 'caller')
      const sourceMetaHash = validateAgentMeta(workflowDir, source, 'source')
      const sourceTranscriptHash = validateAgentTranscript(workflowDir, source, sessionEntry.name, options.projectCwd,
        sourcePaired.results[0].result, 'source')
      const claimMetaHashes = exactClaimResults.map(claim => validateAgentMeta(workflowDir, claim.start, 'state claim'))
      const claimTranscriptHashes = exactClaimResults.map(claim => validateAgentTranscript(workflowDir,
        claim.start, sessionEntry.name, options.projectCwd, claim.result, 'state claim'))
      const journalAgain = readStableRegularFile(journalPath, 'Workflow journal', MAX_JOURNAL_BYTES, true)
      if (!journalAgain.equals(journalBytes) ||
          validateAgentMeta(workflowDir, caller, 'caller') !== callerMetaHash ||
          validateAgentTranscript(workflowDir, caller, sessionEntry.name, options.projectCwd,
            undefined, 'caller') !== callerTranscriptHash ||
          validateAgentMeta(workflowDir, source, 'source') !== sourceMetaHash ||
          validateAgentTranscript(workflowDir, source, sessionEntry.name, options.projectCwd,
            sourcePaired.results[0].result, 'source') !== sourceTranscriptHash ||
          exactClaimResults.some((claim, index) =>
            validateAgentMeta(workflowDir, claim.start, 'state claim') !== claimMetaHashes[index] ||
            validateAgentTranscript(workflowDir, claim.start, sessionEntry.name, options.projectCwd,
              claim.result, 'state claim') !== claimTranscriptHashes[index])) {
        throw new StateError('state: Workflow journal or agent files changed during import', 3)
      }
      assertPinnedDirectories(directoryPins)
      candidates.push({ workflowId: workflowEntry.name, sessionId: sessionEntry.name,
        source, result: sourcePaired.results[0].result })
    }
    assertPinnedDirectories([projectPin, sessionPin, workflowsPin])
  }
  assertPinnedDirectories([projectPin])
  if (candidates.length !== 1) {
    const reason = candidates.length ? 'ambiguous matching Workflow journals' :
      'no single Workflow journal contains the active caller, state claim, and source result'
    throw new StateError('state: ' + reason, 3, near.length ? { workflows: near } : undefined)
  }
  return candidates[0]
}

function pinnedWorkflowLocation(projectCwd, sessionId, workflowId) {
  const config = requireRealDirectory(path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')),
    'Claude config directory')
  const projects = requireRealDirectory(path.join(config, 'projects'), 'Claude projects directory')
  const projectName = projectCwd.replace(/[^A-Za-z0-9]/g, '-')
  const projectPin = pinRealDirectory(path.join(projects, projectName), 'stored Workflow project')
  const sessionPin = pinRealDirectory(path.join(projectPin.path, sessionId), 'stored Workflow session')
  const workflowsPin = pinRealDirectory(path.join(sessionPin.path, 'subagents', 'workflows'),
    'stored Workflow collection')
  const workflowPin = pinRealDirectory(path.join(workflowsPin.path, workflowId), 'stored Workflow')
  const pins = [projectPin, sessionPin, workflowsPin, workflowPin]
  assertPinnedDirectories(pins)
  return { workflowDir: workflowPin.path, pins }
}

function validateStoredEnvelopeProvenance(envelope, state, options) {
  const binding = envelope.binding
  const location = pinnedWorkflowLocation(options.projectCwd, binding.sessionId, binding.workflowId)
  const journalPath = path.join(location.workflowDir, 'journal.jsonl')
  const journalBytes = readStableRegularFile(journalPath, 'stored Workflow journal', MAX_JOURNAL_BYTES, true)
  assertPinnedDirectories(location.pins)
  const events = parseJsonLines(journalBytes, 'stored Workflow journal')
  validateJournalEvents(events, 'stored Workflow journal ' + binding.workflowId)
  const sourceStarts = events.filter(event => event.type === 'started' && event.agentId === binding.agentId &&
    event.key === binding.sourceKey && event.label === binding.sourceLabel && event.phase === binding.sourcePhase)
  if (sourceStarts.length !== 1) throw new StateError('state: stored orphan source start is missing or ambiguous', 3)
  const source = sourceStarts[0]
  const sourcePaired = pairedEvents(events, source)
  if (sourcePaired.results.length !== 1 || sourcePaired.failures.length ||
      canonical(sourcePaired.results[0].result) !== canonical(envelope.result)) {
    throw new StateError('state: stored orphan source result does not match its envelope', 3)
  }
  const claimProofs = []
  for (const start of events.filter(event => event.type === 'started' && STATE_CLAIM_LABELS.has(event.label))) {
    const paired = pairedEvents(events, start)
    if (start.phase === 'Setup' && paired.results.length === 1 && !paired.failures.length &&
        claimResultMatches(paired.results[0].result, { run: state.run, keyHash: binding.keyHash,
          repositoryIdentity: binding.repositoryIdentity, root: options.root, head: binding.headSha })) {
      claimProofs.push({ start, result: paired.results[0].result })
    }
  }
  if (!claimProofs.length) throw new StateError('state: stored orphan Workflow has no repository-bound state claim', 3)
  assertPinnedDirectories(location.pins)
  const sourceMetaHash = validateAgentMeta(location.workflowDir, source, 'stored source')
  const sourceTranscriptHash = validateAgentTranscript(location.workflowDir, source, binding.sessionId,
    options.projectCwd, envelope.result, 'stored source')
  const claimMetaHashes = claimProofs.map(claim =>
    validateAgentMeta(location.workflowDir, claim.start, 'stored state claim'))
  const claimTranscriptHashes = claimProofs.map(claim => validateAgentTranscript(location.workflowDir,
    claim.start, binding.sessionId, options.projectCwd, claim.result, 'stored state claim'))
  const journalAgain = readStableRegularFile(journalPath, 'stored Workflow journal', MAX_JOURNAL_BYTES, true)
  if (!journalAgain.equals(journalBytes) ||
      validateAgentMeta(location.workflowDir, source, 'stored source') !== sourceMetaHash ||
      validateAgentTranscript(location.workflowDir, source, binding.sessionId, options.projectCwd,
        envelope.result, 'stored source') !== sourceTranscriptHash ||
      claimProofs.some((claim, index) =>
        validateAgentMeta(location.workflowDir, claim.start, 'stored state claim') !== claimMetaHashes[index] ||
        validateAgentTranscript(location.workflowDir, claim.start, binding.sessionId, options.projectCwd,
          claim.result, 'stored state claim') !== claimTranscriptHashes[index])) {
    throw new StateError('state: stored Workflow provenance changed during orphan recovery', 3)
  }
  assertPinnedDirectories(location.pins)
}

function importJournalArtifact() {
  const run = validateRunId(requireArg('run'))
  const name = validateArtifactName(requireArg('name'))
  const root = requireRealDirectory(path.resolve(requireArg('root')), '--root')
  const sourceLabel = requireOpaque(requireArg('source-label'), '--source-label')
  const callerLabel = requireOpaque(requireArg('caller-label'), '--caller-label')
  const sourcePhase = requireOpaque(requireArg('source-phase'), '--source-phase', 128)
  const expectedId = requireOpaque(requireArg('expected-id'), '--expected-id')
  const expectedHead = validateSha(requireArg('expected-head'), '--expected-head')
  const kind = requireOpaque(requireArg('kind'), '--kind', 64)
  if (!IMPORT_KINDS.has(kind)) throw new StateError('state: unsupported --kind for import-journal', 3)
  const expectedSkillStatus = args['expected-skill-status'] === undefined ? undefined :
    requireOpaque(args['expected-skill-status'], '--expected-skill-status', 64)
  if (expectedSkillStatus !== undefined && !['not-requested', 'used', 'unavailable', 'incompatible'].includes(expectedSkillStatus)) {
    throw new StateError('state: unsupported --expected-skill-status', 3)
  }
  if (expectedSkillStatus !== undefined && kind !== 'lens' && kind !== 'gap') {
    throw new StateError('state: --expected-skill-status is valid only for lens/gap imports', 3)
  }
  const projectCwd = requireRealDirectory(path.resolve(args['project-cwd'] || process.cwd()), 'Workflow project cwd')
  const lockToken = requireArg('lock-token')
  const result = withMutation(run, state => {
    if (state.key.head !== expectedHead || state.lineage.currentHead !== expectedHead) {
      throw new StateError('state: --expected-head does not match the checkpoint head', 3)
    }
    const repository = validateRepository(state.key, root, state.repository || null)
    if (!repository || !state.repository || repository.identity !== state.repository.identity) {
      throw new StateError('state: journal import requires the checkpoint repository identity', 3)
    }
    const imported = workflowJournalCandidates(state, {
      sourceLabel, callerLabel, sourcePhase, projectCwd, lockToken, root,
    })
    const repositoryAfterRead = validateRepository(state.key, root, state.repository || null)
    if (!repositoryAfterRead || repositoryAfterRead.identity !== repository.identity ||
        repositoryAfterRead.head !== expectedHead) {
      throw new StateError('state: repository changed while the Workflow result was imported', 3)
    }
    const scopeIdentity = kind === 'scope' ? {
      repo: state.key.repo,
      prNumber: state.key.pr,
      mergeBaseSha: state.key.base,
      prHeadSha: state.key.prHead,
      currentHeadSha: expectedHead,
      scopeFingerprint: state.key.scopeFingerprint,
    } : undefined
    validateImportedResult(kind, imported.result, expectedId, expectedSkillStatus, scopeIdentity)
    const binding = {
      run: state.run,
      keyHash: state.keyHash,
      repositoryIdentity: state.repository.identity,
      headSha: expectedHead,
      kind,
      resultId: expectedId,
      artifactName: name,
      sourceLabel,
      sourcePhase,
      sessionId: imported.sessionId,
      projectCwd,
      workflowId: imported.workflowId,
      sourceKey: imported.source.key,
      agentId: imported.source.agentId,
    }
    const envelope = { importVersion: 1, binding, result: imported.result }
    const bytes = Buffer.from(JSON.stringify(envelope, null, 2) + '\n')
    const storedExpected = { headSha: expectedHead, kind, resultId: expectedId, artifactName: name,
      sourcePhase, projectCwd, expectedSkillStatus, scopeIdentity }
    if (state.artifacts[name]) {
      const existing = readStableRegularFile(artifactPath(run, name), 'artifact ' + name,
        MAX_JOURNAL_BYTES + MAX_META_BYTES)
      const record = state.artifacts[name]
      if (sha256(existing) !== record.sha256 || existing.length !== record.bytes) {
        throw new StateError('state: artifact integrity check failed: ' + name, 3)
      }
      if (existing.equals(bytes)) {
        return { ok: true, run, name, sha256: record.sha256, bytes: record.bytes, idempotent: true,
          recoveredOrphan: !!record.recoveredOrphan, sourceResultMatches: true,
          resultSha256: sha256(Buffer.from(canonical(imported.result))), binding }
      }
      if (!record.recoveredOrphan) {
        throw new StateError('state: artifact names are immutable; imported source or bytes differ', 3)
      }
      let recovered
      try { recovered = validateStoredImportEnvelope(existing, 'recovered artifact ' + name, state, storedExpected) } catch (error) {
        throw new StateError('state: conflicting recovered artifact: ' + name + ': ' + String(error.message || error), 3)
      }
      return { ok: true, run, name, sha256: record.sha256, bytes: record.bytes, idempotent: true,
        recoveredOrphan: true, sourceResultMatches: canonical(recovered.result) === canonical(imported.result),
        resultSha256: sha256(Buffer.from(canonical(recovered.result))), binding: recovered.binding }
    }
    const file = artifactPath(run, name, true)
    const artifactRootPin = pinRealDirectory(artifactsRoot(run), 'artifact root')
    const artifactParentPin = path.dirname(file) === artifactRootPin.path ? artifactRootPin :
      pinRealDirectory(path.dirname(file), 'artifact parent')
    const artifactPins = artifactParentPin === artifactRootPin ? [artifactRootPin] :
      [artifactRootPin, artifactParentPin]
    assertPinnedDirectories(artifactPins)
    let persistedBytes = bytes
    let persistedBinding = binding
    let persistedResult = imported.result
    let recoveredOrphan = false
    let sourceResultMatches = true
    const recoverExistingOrphan = orphan => {
      let recovered
      try { recovered = validateStoredImportEnvelope(orphan, 'orphan artifact ' + name, state, storedExpected) } catch (error) {
        throw new StateError('state: conflicting orphan artifact: ' + name + ': ' + String(error.message || error), 3)
      }
      try { validateStoredEnvelopeProvenance(recovered, state, { projectCwd, root }) } catch (error) {
        throw new StateError('state: conflicting orphan provenance: ' + name + ': ' + String(error.message || error), 3)
      }
      persistedBytes = orphan
      persistedBinding = recovered.binding
      persistedResult = recovered.result
      recoveredOrphan = true
      sourceResultMatches = canonical(recovered.result) === canonical(imported.result)
    }
    if (fs.existsSync(file)) {
      recoverExistingOrphan(readStableRegularFile(file, 'orphan artifact ' + name,
        MAX_JOURNAL_BYTES + MAX_META_BYTES, true))
    } else if (!atomicWriteImmutable(file, bytes)) {
      const racedOrphan = readStableRegularFile(file, 'raced orphan artifact ' + name,
        MAX_JOURNAL_BYTES + MAX_META_BYTES, true)
      recoverExistingOrphan(racedOrphan)
    }
    assertPinnedDirectories(artifactPins)
    const persisted = readStableRegularFile(file, 'persisted imported artifact ' + name,
      MAX_JOURNAL_BYTES + MAX_META_BYTES)
    assertPinnedDirectories(artifactPins)
    const digest = sha256(persistedBytes)
    if (persisted.length !== persistedBytes.length || sha256(persisted) !== digest ||
        !persisted.equals(persistedBytes)) {
      throw new StateError('state: persisted imported artifact failed verification: ' + name, 3)
    }
    state.artifacts[name] = Object.assign({ sha256: digest, bytes: persistedBytes.length, createdAt: now() },
      recoveredOrphan ? { recoveredOrphan: true } : {})
    return { ok: true, run, name, sha256: digest, bytes: persistedBytes.length, idempotent: false,
      recoveredOrphan, sourceResultMatches,
      resultSha256: sha256(Buffer.from(canonical(persistedResult))), binding: persistedBinding }
  })
  output(result)
}

function validateStoredControlEnvelope(bytes, label, state, expected) {
  const envelope = parseJsonBuffer(bytes, label, true)
  if (envelope.controlVersion !== 1 || !isObject(envelope.binding) || !isObject(envelope.value)) {
    throw new StateError('state: ' + label + ' is not a supported control envelope', 3)
  }
  requireExactKeys(envelope, ['controlVersion', 'binding', 'value'], label)
  requireExactKeys(envelope.binding, ['run', 'keyHash', 'repositoryIdentity', 'headSha', 'artifactName'],
    label + '.binding')
  const binding = envelope.binding
  if (binding.run !== state.run || binding.keyHash !== state.keyHash ||
      binding.repositoryIdentity !== state.repository.identity || binding.headSha !== expected.headSha ||
      binding.artifactName !== expected.artifactName) {
    throw new StateError('state: ' + label + ' binding does not match the active checkpoint', 3)
  }
  canonical(envelope.value)
  const encoded = Buffer.from(JSON.stringify(envelope, null, 2) + '\n')
  if (!encoded.equals(bytes)) throw new StateError('state: ' + label + ' is not canonically encoded', 3)
  return envelope
}

function putControlArtifact() {
  const run = validateRunId(requireArg('run'))
  const name = validateArtifactName(requireArg('name'))
  if (!name.endsWith('.json')) throw new StateError('state: put-control requires a .json artifact name', 3)
  const root = requireRealDirectory(path.resolve(requireArg('root')), '--root')
  const expectedHead = validateSha(requireArg('expected-head'), '--expected-head')
  const input = decodeBase64(requireArg('base64'), '--base64')
  if (input.length > 65536) throw new StateError('state: control value exceeds 64 KiB', 3)
  const value = parseJsonBuffer(input, '--base64 control value', true)
  const result = withMutation(run, state => {
    if (state.key.head !== expectedHead || state.lineage.currentHead !== expectedHead) {
      throw new StateError('state: --expected-head does not match the checkpoint head', 3)
    }
    const repository = validateRepository(state.key, root, state.repository || null)
    if (!repository || !state.repository || repository.identity !== state.repository.identity) {
      throw new StateError('state: put-control requires the checkpoint repository identity', 3)
    }
    const binding = { run: state.run, keyHash: state.keyHash,
      repositoryIdentity: state.repository.identity, headSha: expectedHead, artifactName: name }
    const envelope = { controlVersion: 1, binding, value }
    const bytes = Buffer.from(JSON.stringify(envelope, null, 2) + '\n')
    const currentValueSha = sha256(Buffer.from(canonical(value)))
    if (state.artifacts[name]) {
      const existing = readStableRegularFile(artifactPath(run, name), 'control artifact ' + name,
        MAX_JOURNAL_BYTES + MAX_META_BYTES, true)
      const record = state.artifacts[name]
      if (sha256(existing) !== record.sha256 || existing.length !== record.bytes) {
        throw new StateError('state: artifact integrity check failed: ' + name, 3)
      }
      if (existing.equals(bytes)) {
        return { ok: true, run, name, sha256: record.sha256, bytes: record.bytes, idempotent: true,
          recoveredOrphan: !!record.recoveredOrphan, valueMatches: true, valueSha256: currentValueSha, binding }
      }
      if (!record.recoveredOrphan) throw new StateError('state: control artifact name is immutable: ' + name, 3)
      const recovered = validateStoredControlEnvelope(existing, 'recovered control artifact ' + name,
        state, { headSha: expectedHead, artifactName: name })
      return { ok: true, run, name, sha256: record.sha256, bytes: record.bytes, idempotent: true,
        recoveredOrphan: true, valueMatches: canonical(recovered.value) === canonical(value),
        valueSha256: sha256(Buffer.from(canonical(recovered.value))), binding: recovered.binding }
    }
    const file = artifactPath(run, name, true)
    const artifactRootPin = pinRealDirectory(artifactsRoot(run), 'artifact root')
    const artifactParentPin = path.dirname(file) === artifactRootPin.path ? artifactRootPin :
      pinRealDirectory(path.dirname(file), 'artifact parent')
    const artifactPins = artifactParentPin === artifactRootPin ? [artifactRootPin] :
      [artifactRootPin, artifactParentPin]
    assertPinnedDirectories(artifactPins)
    let persistedBytes = bytes
    let persistedBinding = binding
    let persistedValue = value
    let recoveredOrphan = false
    let valueMatches = true
    const adoptOrphan = orphan => {
      let recovered
      try {
        recovered = validateStoredControlEnvelope(orphan, 'orphan control artifact ' + name,
          state, { headSha: expectedHead, artifactName: name })
      } catch (error) {
        throw new StateError('state: conflicting orphan control artifact: ' + name + ': ' +
          String(error.message || error), 3)
      }
      persistedBytes = orphan
      persistedBinding = recovered.binding
      persistedValue = recovered.value
      recoveredOrphan = true
      valueMatches = canonical(recovered.value) === canonical(value)
    }
    if (fs.existsSync(file)) {
      adoptOrphan(readStableRegularFile(file, 'orphan control artifact ' + name,
        MAX_JOURNAL_BYTES + MAX_META_BYTES, true))
    } else if (!atomicWriteImmutable(file, bytes)) {
      adoptOrphan(readStableRegularFile(file, 'raced orphan control artifact ' + name,
        MAX_JOURNAL_BYTES + MAX_META_BYTES, true))
    }
    assertPinnedDirectories(artifactPins)
    const persisted = readStableRegularFile(file, 'persisted control artifact ' + name,
      MAX_JOURNAL_BYTES + MAX_META_BYTES, true)
    assertPinnedDirectories(artifactPins)
    const digest = sha256(persistedBytes)
    if (!persisted.equals(persistedBytes) || persisted.length !== persistedBytes.length || sha256(persisted) !== digest) {
      throw new StateError('state: persisted control artifact failed verification: ' + name, 3)
    }
    state.artifacts[name] = Object.assign({ sha256: digest, bytes: persistedBytes.length, createdAt: now() },
      recoveredOrphan ? { recoveredOrphan: true } : {})
    return { ok: true, run, name, sha256: digest, bytes: persistedBytes.length, idempotent: false,
      recoveredOrphan, valueMatches, valueSha256: sha256(Buffer.from(canonical(persistedValue))),
      binding: persistedBinding }
  })
  output(result)
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

function lineageKeyHashes(state) {
  const commits = state.lineage.ownedCommits || []
  const valid = value => /^[a-f0-9]{64}$/.test(String(value || ''))
  if (!valid(state.keyHash)) throw new StateError('state: current lineage key hash is invalid', 3)
  let previousTo = null
  let mappingStarted = false
  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index]
    const hasFrom = commit.fromKeyHash !== undefined
    const hasTo = commit.toKeyHash !== undefined
    if (hasFrom !== hasTo || (hasFrom && (!valid(commit.fromKeyHash) || !valid(commit.toKeyHash)))) {
      throw new StateError('state: lineage commit key hash mapping is invalid at index ' + index, 3)
    }
    if (!hasFrom && mappingStarted) {
      throw new StateError('state: unmapped lineage commit follows mapped history at index ' + index, 3)
    }
    if (hasFrom && previousTo && commit.fromKeyHash !== previousTo) {
      throw new StateError('state: lineage commit key hash chain is broken at index ' + index, 3)
    }
    if (hasFrom) {
      mappingStarted = true
      previousTo = commit.toKeyHash
    }
  }
  const last = commits[commits.length - 1]
  if (last && last.toKeyHash !== undefined && last.toKeyHash !== state.keyHash) {
    throw new StateError('state: current key hash does not match the lineage tail', 3)
  }
  return {
    initialKeyHash: commits.length ? (commits[0].fromKeyHash || null) : state.keyHash,
    currentKeyHash: state.keyHash,
  }
}

function exportedLineageCommit(commit) {
  const exported = Object.assign({}, commit)
  if (isObject(commit.receipt)) {
    exported.receipt = commit.receipt.receiptVersion === 2
      ? Object.assign({}, commit.receipt)
      : Object.assign({ receiptVersion: 1 }, commit.receipt)
  }
  return exported
}

function exportLineage() {
  const run = validateRunId(requireArg('run'))
  const after = Number(args.after === undefined ? 0 : args.after)
  const limit = Number(args.limit === undefined ? 1 : args.limit)
  if (!Number.isSafeInteger(after) || after < 0) throw new StateError('state: --after must be a non-negative integer')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new StateError('state: --limit must be from 1 to 10')
  const state = loadState(run)
  const all = state.lineage.ownedCommits || []
  const keyHashes = lineageKeyHashes(state)
  if (after > all.length) throw new StateError('state: --after exceeds lineage length', 3)
  const commits = all.slice(after, after + limit).map(exportedLineageCommit)
  output({ ok: true, run, initialHead: state.lineage.initialHead, currentHead: state.lineage.currentHead,
    initialKeyHash: keyHashes.initialKeyHash, currentKeyHash: keyHashes.currentKeyHash,
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
  const sourceClosure = new Set()
  const closureRecords = new Set()
  let closureBytes = 0
  const MAX_DISPOSITION_CHAIN = 128
  const MAX_DISPOSITION_REFS = 4096
  const MAX_DISPOSITION_BYTES = 64 * 1024 * 1024
  const addClosure = (name, reference, label) => {
    name = validateArtifactName(name)
    if (!name.endsWith('.json')) throw new StateError('state: ' + label + ' must name a JSON artifact', 3)
    const record = state.artifacts[name]
    if (!record || (reference && (record.sha256 !== reference.sha256 || record.bytes !== reference.bytes))) {
      throw new StateError('state: ' + label + ' does not match the artifact index: ' + name, 3)
    }
    verifyArtifact(state, name)
    if (!closureRecords.has(name)) {
      closureRecords.add(name)
      closureBytes += record.bytes
      if (closureRecords.size > MAX_DISPOSITION_REFS || closureBytes > MAX_DISPOSITION_BYTES) {
        throw new StateError('state: disposition closure exceeds the count or size limit', 3)
      }
    }
    return record
  }
  const dispositionValue = (name, bytes) => {
    const stored = parseJsonBuffer(bytes, 'artifact ' + name, true)
    if (stored.controlVersion === 1) {
      if (!isObject(stored.binding) || stored.binding.artifactName !== name || !isObject(stored.value)) {
        throw new StateError('state: disposition control envelope is malformed: ' + name, 3)
      }
      return stored.value
    }
    return stored
  }
  const validateReference = (reference, label, requireBytes = true) => {
    if (label === 'source artifact reference' && Array.isArray(reference)) {
      if (reference.length !== 3 || typeof reference[0] !== 'string' ||
          typeof reference[1] !== 'string' || !Number.isSafeInteger(reference[2])) {
        throw new StateError('state: invalid compact ' + label, 3)
      }
      reference = { name: reference[0], sha256: reference[1], bytes: reference[2] }
    }
    if (!isObject(reference)) throw new StateError('state: invalid ' + label, 3)
    if (typeof reference.name !== 'string' || typeof reference.sha256 !== 'string') {
      throw new StateError('state: ' + label + ' name and sha256 must be strings', 3)
    }
    if (label === 'previousDisposition') requireExactKeys(reference, ['name', 'sha256', 'bytes'], label)
    const name = validateArtifactName(reference.name)
    if (!/^[a-f0-9]{64}$/.test(String(reference.sha256 || ''))) {
      throw new StateError('state: ' + label + ' must contain a sha256', 3)
    }
    if ((requireBytes && reference.bytes === undefined) || (reference.bytes !== undefined &&
        (!Number.isSafeInteger(reference.bytes) || reference.bytes < 0))) {
      throw new StateError('state: ' + label + ' bytes must be a non-negative integer', 3)
    }
    return { name, sha256: reference.sha256, bytes: reference.bytes }
  }
  if (latestDisposition) {
    const visited = new Set()
    let dispositionName = latestDisposition.name
    let expectedReference = null
    for (let depth = 0; dispositionName; depth++) {
      if (depth >= MAX_DISPOSITION_CHAIN) throw new StateError('state: disposition chain exceeds the depth limit', 3)
      if (visited.has(dispositionName)) throw new StateError('state: disposition chain contains a cycle', 3)
      if (!/^cycle-\d+\/dispositions(?:-attempt-\d+)?\.json$/.test(dispositionName)) {
        throw new StateError('state: previousDisposition must reference a disposition artifact', 3)
      }
      visited.add(dispositionName)
      const verified = verifyArtifact(state, dispositionName)
      if (expectedReference && (verified.record.sha256 !== expectedReference.sha256 ||
          verified.record.bytes !== expectedReference.bytes)) {
        throw new StateError('state: previousDisposition does not match the artifact index: ' + dispositionName, 3)
      }
      addClosure(dispositionName, expectedReference, 'disposition snapshot reference')
      sourceClosure.add(dispositionName)
      const disposition = dispositionValue(dispositionName, verified.bytes)
      if (disposition.snapshotVersion !== undefined &&
          (!Number.isSafeInteger(disposition.snapshotVersion) || disposition.snapshotVersion < 1)) {
        throw new StateError('state: disposition snapshotVersion must be a positive integer', 3)
      }
      if (disposition.snapshotVersion >= 3) {
        if (!Array.isArray(disposition.sourceArtifacts)) {
          throw new StateError('state: v3 disposition sourceArtifacts must be an array', 3)
        }
        for (let index = 0; index < disposition.sourceArtifacts.length; index++) {
          const reference = validateReference(disposition.sourceArtifacts[index],
            'source artifact reference', false)
          const record = state.artifacts[reference.name]
          const normalized = Object.assign({}, reference,
            reference.bytes === undefined && record ? { bytes: record.bytes } : {})
          addClosure(reference.name, normalized, 'source artifact reference')
          sourceClosure.add(reference.name)
        }
        if (disposition.previousDisposition === undefined || disposition.previousDisposition === null) break
        expectedReference = validateReference(disposition.previousDisposition, 'previousDisposition', true)
        dispositionName = expectedReference.name
      } else break
    }
  }
  const selected = jsonNames.filter(name => /^scope-[a-f0-9]{64}\.json$/.test(name) ||
    name === 'baseline.json' ||
    name === 'scope-semantic-' + state.key.head + '.json' ||
    name.startsWith('summary/') ||
    (maxCycle && name.startsWith('cycle-' + maxCycle + '/')) ||
    (latestDisposition && name === latestDisposition.name) || sourceClosure.has(name)).sort()
  const remaining = selected.filter(name => name > after)
  const artifacts = []
  let bytes = 0
  for (const name of remaining) {
    const verified = verifyArtifact(state, name)
    const value = parseJsonBuffer(verified.bytes, 'artifact ' + name)
    const artifact = { name, sha256: verified.record.sha256, bytes: verified.record.bytes, value }
    const size = Buffer.byteLength(JSON.stringify(artifact))
    if (artifacts.length && bytes + size > maxBytes) break
    artifacts.push(artifact)
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
      const expectedBytes = verifyArtifact(state, expectedName).bytes
      const storedExpected = parseJsonBuffer(expectedBytes, 'expected artifact index', true)
      const expected = storedExpected.controlVersion === 1
        ? validateStoredControlEnvelope(expectedBytes, 'expected artifact index', state,
          { headSha: state.lineage.currentHead, artifactName: expectedName }).value
        : storedExpected
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

function requireExactKeys(value, keys, label) {
  if (!isObject(value)) throw new StateError('state: ' + label + ' must be an object', 3)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (canonical(actual) !== canonical(expected)) {
    throw new StateError('state: ' + label + ' must contain exactly: ' + expected.join(', '), 3)
  }
}

function validateReceiptPath(value, label) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') ||
      /[\r\n\0]/.test(value)) throw new StateError('state: unsafe ' + label + ' ' + JSON.stringify(value), 3)
  const segments = value.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' ||
      segment.toLowerCase() === '.git')) {
    throw new StateError('state: unsafe ' + label + ' ' + JSON.stringify(value), 3)
  }
  return value
}

function validateCompactFixReceipt(receipt) {
  requireExactKeys(receipt, ['receiptVersion', 'batchId', 'allowedPaths', 'fixed', 'notABug',
    'stillOpen', 'followUps'], 'v2 fix receipt')
  if (receipt.receiptVersion !== 2 || typeof receipt.batchId !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(receipt.batchId)) {
    throw new StateError('state: v2 fix receipt has an invalid version or batchId', 3)
  }
  for (const field of ['allowedPaths', 'fixed', 'notABug', 'stillOpen', 'followUps']) {
    if (!Array.isArray(receipt[field])) throw new StateError('state: v2 fix receipt.' + field + ' must be an array', 3)
  }
  if (!receipt.allowedPaths.length) throw new StateError('state: v2 fix receipt.allowedPaths must not be empty', 3)
  const allowedPaths = receipt.allowedPaths.map((value, index) =>
    validateReceiptPath(value, 'v2 fix receipt.allowedPaths[' + index + ']'))
  if (new Set(allowedPaths).size !== allowedPaths.length) {
    throw new StateError('state: v2 fix receipt.allowedPaths must be unique', 3)
  }
  const ids = []
  const validateId = (item, label) => {
    if (!/^[a-f0-9]{64}$/.test(String(item.id || ''))) {
      throw new StateError('state: ' + label + '.id must be 64 lowercase hex characters', 3)
    }
    ids.push(item.id)
  }
  receipt.fixed.forEach((item, index) => {
    const label = 'v2 fix receipt.fixed[' + index + ']'
    requireExactKeys(item, ['id', 'changeSummary'], label)
    validateId(item, label)
    if (typeof item.changeSummary !== 'string' || !item.changeSummary) {
      throw new StateError('state: ' + label + '.changeSummary must be a non-empty string', 3)
    }
  })
  receipt.notABug.forEach((item, index) => {
    const label = 'v2 fix receipt.notABug[' + index + ']'
    requireExactKeys(item, ['id', 'reason'], label)
    validateId(item, label)
    if (typeof item.reason !== 'string' || !item.reason) {
      throw new StateError('state: ' + label + '.reason must be a non-empty string', 3)
    }
  })
  receipt.stillOpen.forEach((item, index) => {
    const label = 'v2 fix receipt.stillOpen[' + index + ']'
    requireExactKeys(item, ['id', 'whyStillHere', 'defer', 'deferReason'], label)
    validateId(item, label)
    if (typeof item.whyStillHere !== 'string' || !item.whyStillHere ||
        typeof item.defer !== 'boolean' || typeof item.deferReason !== 'string' || !item.deferReason) {
      throw new StateError('state: ' + label + ' has invalid disposition fields', 3)
    }
  })
  if (!ids.length || new Set(ids).size !== ids.length) {
    throw new StateError('state: v2 fix receipt disposition IDs must be non-empty and unique', 3)
  }
  receipt.followUps.forEach((item, index) => {
    const label = 'v2 fix receipt.followUps[' + index + ']'
    requireExactKeys(item, ['title', 'detail', 'area', 'size', 'doneNow', 'releaseBlocker', 'blockerReason'], label)
    for (const field of ['title', 'detail', 'area', 'size', 'blockerReason']) {
      if (typeof item[field] !== 'string' || !item[field]) {
        throw new StateError('state: ' + label + '.' + field + ' must be a non-empty string', 3)
      }
    }
    if (!['small', 'big'].includes(item.size) || typeof item.doneNow !== 'boolean' ||
        typeof item.releaseBlocker !== 'boolean') {
      throw new StateError('state: ' + label + ' has invalid follow-up fields', 3)
    }
  })
  return receipt
}

function validateFixReceipt(receipt) {
  if (isObject(receipt) && Object.prototype.hasOwnProperty.call(receipt, 'receiptVersion')) {
    if (receipt.receiptVersion !== 2) throw new StateError('state: unsupported fix receipt version', 3)
    return validateCompactFixReceipt(receipt)
  }
  if (!receipt || typeof receipt.batchId !== 'string' || !receipt.batchId ||
      !Array.isArray(receipt.fixed) || !Array.isArray(receipt.notABug) ||
      !Array.isArray(receipt.stillOpen) || !Array.isArray(receipt.followUps)) {
    throw new StateError('state: fix receipt is missing required disposition arrays', 3)
  }
  return receipt
}

function readInlineFixReceipt(value) {
  const bytes = decodeBase64(value, '--receipt-base64')
  if (bytes.length > 65536) throw new StateError('state: inline receipt exceeds 64 KiB', 3)
  return validateFixReceipt(parseJsonBuffer(bytes, '--receipt-base64', true))
}

function receiptAllowedPaths(receipt) {
  if (receipt.receiptVersion === 2) return receipt.allowedPaths
  return (receipt.stillOpen || []).flatMap(finding =>
    Array.isArray(finding.files) && finding.files.length ? finding.files : [finding.primaryFile]).filter(Boolean)
}

function receiptDispositionIds(receipt) {
  return ['fixed', 'notABug', 'stillOpen'].flatMap(field => (receipt[field] || []).map(item => item.id))
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
  const allowed = new Set(receiptAllowedPaths(pending.fallbackReceipt))
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
  const files = receiptAllowedPaths(receipt)
  for (const value of files) {
    const relative = validateReceiptPath(value, 'prepared finding path')
    const segments = relative.split('/')
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
    const allowed = new Set(receiptAllowedPaths(pending.fallbackReceipt))
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
  const hasInlineReceipt = args['receipt-base64'] !== undefined
  const hasStagedReceipt = args['receipt-prefix'] !== undefined || args['receipt-parts'] !== undefined
  if (hasInlineReceipt === hasStagedReceipt) {
    throw new StateError('state: prepare-head requires exactly one receipt source', 3)
  }
  const inlineReceipt = hasInlineReceipt ? readInlineFixReceipt(args['receipt-base64']) : null
  const receiptPrefix = hasStagedReceipt ? requireArg('receipt-prefix') : null
  const receiptParts = hasStagedReceipt ? requireArg('receipt-parts') : null
  if (git(root, 'rev-parse', '--verify', 'HEAD^{commit}') !== from) throw new StateError('state: HEAD does not equal prepared parent', 3)
  if (git(root, 'status', '--porcelain=v1', '-z')) throw new StateError('state: repository must be clean before preparing a fix', 3)
  const result = withMutation(run, state => {
    if (state.pendingAdvance) throw new StateError('state: another prepared head transaction is active', 4)
    if (state.key.head !== from || state.lineage.currentHead !== from) {
      throw new StateError('state: prepared parent does not match checkpoint head', 3)
    }
    validateRepository(state.key, root, state.repository || null)
    const fallbackReceipt = hasStagedReceipt ? readStagedReceipt(state, receiptPrefix, receiptParts) : inlineReceipt
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
  let receipt = hasInlineReceipt ? readInlineFixReceipt(args['receipt-base64']) : null
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
    if (pending.fallbackReceipt.receiptVersion === 2) {
      if (receipt.receiptVersion !== 2 ||
          canonical([...receiptAllowedPaths(receipt)].sort()) !==
            canonical([...receiptAllowedPaths(pending.fallbackReceipt)].sort()) ||
          canonical([...receiptDispositionIds(receipt)].sort()) !==
            canonical([...receiptDispositionIds(pending.fallbackReceipt)].sort())) {
        throw new StateError('state: final v2 receipt does not exhaust the prepared IDs and path fence', 3)
      }
    }
    if (state.key.head !== from || state.lineage.currentHead !== from) {
      throw new StateError('state: --from does not match checkpoint head', 3)
    }
    const nextKey = Object.assign({}, state.key, { head: to })
    const repository = validateRepository(nextKey, root, state.repository || null)
    const fromKeyHash = state.keyHash
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
        fromKeyHash, toKeyHash: nextHash,
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
  else if (COMMAND === 'put-control') putControlArtifact()
  else if (COMMAND === 'import-journal') importJournalArtifact()
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
