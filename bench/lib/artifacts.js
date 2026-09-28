'use strict'

// Immutable benchmark-cohort metadata, paths, sealing, and exclusive artifact publication.
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const GIT_SHA = /^[0-9a-f]{40}$/i
const FILE_HASH = /^[0-9a-f]{64}$/
const FINDING_KINDS = new Set(['bug', 'security', 'test-gap', 'style', 'docs', 'perf', 'design', 'question'])
const SEVERITIES = new Set(['blocker', 'high', 'medium', 'low', 'nit'])
const VERDICTS = new Set(['real', 'false-positive', 'unproven'])
const SCOPES = new Set(['in-scope', 'out-of-scope'])
const ownedLocks = new Map()
const MALFORMED_LOCK_GRACE_MS = 5 * 60_000

function readJson(file) {
  assertExistingPathSafe(file)
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe JSON path: ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function assertExistingPathSafe(target) {
  const absolute = path.resolve(target)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (!fs.existsSync(current)) break
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink path: ${current}`)
    if (current !== absolute && !stat.isDirectory()) throw new Error(`path component is not a directory: ${current}`)
  }
}

function ensureDirectorySafe(dir) {
  const absolute = path.resolve(dir)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (!fs.existsSync(current)) {
      try { fs.mkdirSync(current) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`refusing unsafe directory path: ${current}`)
  }
  return absolute
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function assertSafeId(value, name = 'id') {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') {
    throw new Error(`invalid ${name}: ${JSON.stringify(value)}`)
  }
  return value
}

function loadModelConfig(root = ROOT) {
  const config = readJson(path.join(root, 'models.json'))
  if (config.schemaVersion !== 1 || !Array.isArray(config.models)) throw new Error('invalid models.json')
  assertSafeId(config.defaultModel, 'default model')
  const ids = new Set()
  for (const model of config.models) {
    assertSafeId(model && model.id, 'model id')
    if (!model.label || ids.has(model.id)) throw new Error(`invalid model entry: ${model && model.id}`)
    ids.add(model.id)
  }
  if (!ids.has(config.defaultModel)) throw new Error(`default model is not registered: ${config.defaultModel}`)
  const legacy = config.legacyCohort
  if (!legacy || legacy.runId !== 'legacy' || legacy.requestedModel !== null || !legacy.observedModel || !legacy.modelLabel) {
    throw new Error('invalid legacy cohort metadata')
  }
  assertSafeId(legacy.observedModel, 'legacy observed model')
  if (!ids.has(legacy.observedModel)) throw new Error(`legacy observed model is not registered: ${legacy.observedModel}`)
  return config
}

function modelById(config, id) {
  assertSafeId(id, 'model')
  const model = config.models.find((entry) => entry.id === id)
  if (!model) throw new Error(`unknown model: ${id}`)
  return model
}

function deriveRunId(model) {
  return assertSafeId(model, 'model')
}

function defaultRunId(root = ROOT) {
  return deriveRunId(loadModelConfig(root).defaultModel)
}

function cohortPaths(root = ROOT, runId = defaultRunId(root)) {
  assertSafeId(runId, 'run id')
  const legacy = runId === 'legacy'
  if (!legacy) {
    assertExistingPathSafe(path.join(root, 'runs'))
    assertExistingPathSafe(path.join(root, 'runs', runId))
    for (const name of ['results', 'findings', 'judgement']) assertExistingPathSafe(path.join(root, 'runs', runId, name))
  }
  const cohortRoot = legacy ? root : path.join(root, 'runs', runId)
  return {
    runId,
    root: cohortRoot,
    manifest: legacy ? null : path.join(cohortRoot, 'manifest.json'),
    seal: legacy ? null : path.join(cohortRoot, 'seal.json'),
    sealLock: legacy ? null : path.join(cohortRoot, 'seal.json.lock'),
    complete: legacy ? null : path.join(cohortRoot, 'complete.json'),
    results: path.join(cohortRoot, 'results'),
    findings: path.join(cohortRoot, 'findings'),
    judgement: path.join(cohortRoot, 'judgement'),
  }
}

function cellId(runId, targetId, toolId) {
  return [runId, targetId, toolId].map((value) => assertSafeId(value, 'cell id component')).join('/')
}

function manifestMetadata(manifest) {
  return {
    runId: manifest.runId,
    requestedModel: manifest.requestedModel,
    modelLabel: manifest.modelLabel,
    claudeVersion: manifest.claudeVersion,
    configSha256: manifest.configSha256,
  }
}

function normalizedExpectedCells(runId, cells) {
  if (!Array.isArray(cells) || !cells.length) throw new Error('manifest expectedCells are required')
  let previous = null
  const seen = new Set()
  return cells.map((cell) => {
    const target = assertSafeId(cell && cell.target, 'expected cell target')
    const tool = assertSafeId(cell && cell.tool, 'expected cell tool')
    const id = cellId(runId, target, tool)
    if (cell.id != null && cell.id !== id) throw new Error(`invalid expected cell id: ${cell.id}`)
    if (seen.has(id) || (previous && previous.localeCompare(id) >= 0)) throw new Error('manifest expectedCells must be unique and sorted')
    seen.add(id)
    previous = id
    return { id, target, tool }
  })
}

function normalizedToolConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.context !== 'string' || !Array.isArray(config.tools)) {
    throw new Error('manifest toolConfig is invalid')
  }
  const ids = new Set()
  for (const tool of config.tools) {
    const id = assertSafeId(tool && tool.id, 'toolConfig tool id')
    if (ids.has(id) || typeof tool.prompt !== 'string') throw new Error(`manifest toolConfig entry is invalid: ${id}`)
    ids.add(id)
  }
  return canonical(config)
}

function normalizedPins(targets) {
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) throw new Error('manifest targets are required')
  const entries = Object.entries(targets).sort(([left], [right]) => left.localeCompare(right))
  if (!entries.length) throw new Error('manifest targets are required')
  return Object.fromEntries(entries.map(([targetId, pins]) => {
    assertSafeId(targetId, 'manifest target id')
    if (!pins || !GIT_SHA.test(pins.baseSha) || !GIT_SHA.test(pins.headSha)) {
      throw new Error(`manifest target ${targetId} requires 40-hex baseSha and headSha`)
    }
    return [targetId, { baseSha: pins.baseSha.toLowerCase(), headSha: pins.headSha.toLowerCase() }]
  }))
}

function snapshotTargetMetadata(stateTargets) {
  return Object.fromEntries(Object.values(stateTargets).sort((left, right) => left.id.localeCompare(right.id)).map((target) => {
    assertSafeId(target.id, 'state target id')
    return [target.id, canonical(target)]
  }))
}

function normalizedTargetMetadata(metadata, targetIds) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('manifest targetMetadata is required')
  const expected = [...targetIds].sort()
  const actual = Object.keys(metadata).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('manifest targetMetadata keys must match targets')
  return Object.fromEntries(actual.map((targetId) => {
    assertSafeId(targetId, 'manifest metadata target id')
    const source = metadata[targetId]
    if (!source || source.id !== targetId) throw new Error(`manifest targetMetadata id mismatch: ${targetId}`)
    return [targetId, canonical(source)]
  }))
}

function normalizedGroundtruth(groundtruth, targetIds) {
  if (!groundtruth || typeof groundtruth !== 'object' || Array.isArray(groundtruth)) throw new Error('manifest groundtruth is required')
  const expected = [...targetIds].sort()
  const actual = Object.keys(groundtruth).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('manifest groundtruth keys must match targets')
  return Object.fromEntries(actual.map((targetId) => {
    const value = groundtruth[targetId]
    if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(`manifest groundtruth must be an object or null: ${targetId}`)
    }
    return [targetId, value === null ? null : canonical(value)]
  }))
}

function snapshotGroundtruth(root, targetIds) {
  return Object.fromEntries([...targetIds].sort().map((targetId) => {
    assertSafeId(targetId, 'groundtruth target id')
    const file = path.join(root, 'groundtruth', `${targetId}.json`)
    return [targetId, fs.existsSync(file) ? canonical(readJson(file)) : null]
  }))
}

function assertManifestTargets(manifest, targetIds) {
  const expected = [...targetIds].map((id) => assertSafeId(id, 'state target id')).sort()
  const actual = Object.keys(normalizedPins(manifest.targets)).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`cohort ${manifest.runId} target set mismatch: expected ${expected.join(',')}, found ${actual.join(',')}`)
  }
  normalizedTargetMetadata(manifest.targetMetadata, actual)
  return manifest
}

function validateManifest(manifest, expected = {}, options = {}) {
  const unpinned = manifest && manifest.schemaVersion === 1
  if (!manifest || (manifest.schemaVersion !== 2 && !(options.allowUnpinned && unpinned))) {
    throw new Error('invalid cohort manifest schema')
  }
  assertSafeId(manifest.runId, 'manifest run id')
  if (manifest.runId === 'legacy') throw new Error('legacy cohort is read-only')
  assertSafeId(manifest.requestedModel, 'manifest requested model')
  if (typeof manifest.modelLabel !== 'string' || !manifest.modelLabel) throw new Error('manifest modelLabel is required')
  if (typeof manifest.claudeVersion !== 'string' || !manifest.claudeVersion) throw new Error('manifest claudeVersion is required')
  if (typeof manifest.createdAt !== 'string' || !manifest.createdAt) throw new Error('manifest createdAt is required')
  if (!unpinned) {
    if (!FILE_HASH.test(manifest.configSha256 || '')) throw new Error('manifest configSha256 is required')
    manifest.targets = normalizedPins(manifest.targets)
    manifest.targetMetadata = normalizedTargetMetadata(manifest.targetMetadata, Object.keys(manifest.targets))
    manifest.groundtruth = normalizedGroundtruth(manifest.groundtruth, Object.keys(manifest.targets))
    manifest.expectedCells = normalizedExpectedCells(manifest.runId, manifest.expectedCells)
    manifest.toolConfig = normalizedToolConfig(manifest.toolConfig)
    for (const cell of manifest.expectedCells) {
      if (!manifest.targets[cell.target]) throw new Error(`expected cell target is not pinned: ${cell.target}`)
    }
  }
  for (const key of ['runId', 'requestedModel', 'modelLabel', 'claudeVersion', 'configSha256']) {
    if (expected[key] != null && manifest[key] !== expected[key]) {
      throw new Error(`cohort ${manifest.runId} ${key} mismatch: expected ${JSON.stringify(expected[key])}, found ${JSON.stringify(manifest[key])}`)
    }
  }
  if (expected.targets) {
    const wanted = normalizedPins(expected.targets)
    if (JSON.stringify(manifest.targets) !== JSON.stringify(wanted)) throw new Error(`cohort ${manifest.runId} target pins mismatch`)
  }
  if (expected.targetMetadata) {
    const wanted = normalizedTargetMetadata(expected.targetMetadata, Object.keys(manifest.targets))
    if (JSON.stringify(manifest.targetMetadata) !== JSON.stringify(wanted)) throw new Error(`cohort ${manifest.runId} target metadata mismatch`)
  }
  if (expected.groundtruth) {
    const wanted = normalizedGroundtruth(expected.groundtruth, Object.keys(manifest.targets))
    if (JSON.stringify(manifest.groundtruth) !== JSON.stringify(wanted)) throw new Error(`cohort ${manifest.runId} groundtruth mismatch`)
  }
  if (expected.expectedCells) {
    const wanted = normalizedExpectedCells(manifest.runId, expected.expectedCells)
    if (JSON.stringify(manifest.expectedCells) !== JSON.stringify(wanted)) throw new Error(`cohort ${manifest.runId} expected cells mismatch`)
  }
  if (expected.toolConfig) {
    const wanted = normalizedToolConfig(expected.toolConfig)
    if (JSON.stringify(manifest.toolConfig) !== JSON.stringify(wanted)) throw new Error(`cohort ${manifest.runId} tool config mismatch`)
  }
  if (expected.targetIds) assertManifestTargets(manifest, expected.targetIds)
  return manifest
}

function readManifest(root, runId, targetIds = null) {
  const paths = cohortPaths(root, runId)
  if (!paths.manifest || !fs.existsSync(paths.manifest)) throw new Error(`cohort manifest not found: ${runId}`)
  return validateManifest(readJson(paths.manifest), { runId, targetIds })
}

function ensureManifest(root, metadata) {
  assertSafeId(metadata.runId, 'run id')
  if (metadata.runId === 'legacy') throw new Error('legacy cohort is read-only')
  const model = assertSafeId(metadata.requestedModel, 'requested model')
  if (!metadata.modelLabel || !metadata.claudeVersion) throw new Error('modelLabel and claudeVersion are required')
  if (!FILE_HASH.test(metadata.configSha256 || '')) throw new Error('configSha256 is required')
  const targets = normalizedPins(metadata.targets)
  const targetMetadata = normalizedTargetMetadata(metadata.targetMetadata, Object.keys(targets))
  const groundtruth = normalizedGroundtruth(metadata.groundtruth, Object.keys(targets))
  const expectedCells = normalizedExpectedCells(metadata.runId, metadata.expectedCells)
  const toolConfig = normalizedToolConfig(metadata.toolConfig)
  const paths = cohortPaths(root, metadata.runId)
  const manifest = {
    schemaVersion: 2,
    runId: metadata.runId,
    requestedModel: model,
    modelLabel: metadata.modelLabel,
    claudeVersion: metadata.claudeVersion,
    configSha256: metadata.configSha256,
    targets,
    targetMetadata,
    groundtruth,
    expectedCells,
    toolConfig,
    createdAt: metadata.createdAt || new Date().toISOString(),
  }
  ensureDirectorySafe(paths.root)
  try {
    writeJsonExclusive(paths.manifest, manifest)
    return manifest
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return validateManifest(readJson(paths.manifest), {
      ...manifestMetadata(manifest), targets, targetMetadata, groundtruth, expectedCells, toolConfig,
    })
  }
}

function hasLegacyArtifacts(root) {
  return ['results', 'findings', 'judgement'].some((name) => fs.existsSync(path.join(root, name)))
}

function discoverCohorts(root = ROOT) {
  const config = loadModelConfig(root)
  const cohorts = []
  if (hasLegacyArtifacts(root)) {
    const legacy = config.legacyCohort
    cohorts.push({ ...legacy, legacy: true, claudeVersion: null, paths: cohortPaths(root, legacy.runId) })
  }
  const runs = path.join(root, 'runs')
  if (!fs.existsSync(runs)) return cohorts
  for (const entry of fs.readdirSync(runs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue
    const file = path.join(runs, entry.name, 'manifest.json')
    if (!fs.existsSync(file)) continue
    // Schema v1 discovery keeps early development fixtures/display working. Execution requires v2
    // through readManifest, so an unpinned cohort can never gain more artifacts.
    const manifest = validateManifest(readJson(file), { runId: entry.name }, { allowUnpinned: true })
    cohorts.push({
      ...manifestMetadata(manifest),
      label: manifest.modelLabel,
      observedModel: null,
      legacy: false,
      createdAt: manifest.createdAt,
      manifestSchemaVersion: manifest.schemaVersion,
      pinnedTargets: manifest.targets || null,
      targetMetadata: manifest.targetMetadata || null,
      groundtruth: manifest.groundtruth || null,
      expectedCells: manifest.expectedCells || null,
      toolConfig: manifest.toolConfig || null,
      sealed: fs.existsSync(path.join(runs, entry.name, 'seal.json')),
      paths: cohortPaths(root, manifest.runId),
    })
  }
  return cohorts
}

function writeJsonExclusive(file, value) {
  const dir = path.dirname(file)
  ensureDirectorySafe(dir)
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const temporary = path.join(dir, `.${path.basename(file)}.tmp-${suffix}`)
  let descriptor = null
  let operationError = null
  try {
    descriptor = fs.openSync(temporary, 'wx')
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.linkSync(temporary, file)
  } catch (error) {
    operationError = error
  }
  if (descriptor != null) {
    try { fs.closeSync(descriptor) } catch (error) { if (!operationError) operationError = error }
  }
  let cleanupError = null
  try { fs.unlinkSync(temporary) } catch (error) {
    if (error.code !== 'ENOENT') cleanupError = error
  }
  if (operationError) throw operationError
  if (cleanupError && !fs.existsSync(file)) throw cleanupError
}

function lockOwner() {
  return JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }) + '\n'
}

function parseLockOwner(raw) {
  try {
    const trimmed = raw.trim()
    const owner = /^\d+$/.test(trimmed)
      ? { pid: Number(trimmed), hostname: os.hostname(), legacy: true }
      : JSON.parse(trimmed)
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.hostname !== 'string') return null
    return owner
  } catch { return null }
}

function staleLocalOwner(raw) {
  const owner = parseLockOwner(raw)
  if (!owner || owner.hostname !== os.hostname()) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

function readLock(file) {
  try {
    assertExistingPathSafe(file)
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) return null
    return fs.readFileSync(file, 'utf8')
  } catch { return null }
}

function publishLock(file, owner) {
  const temporary = `${file}.candidate-${process.pid}-${crypto.randomUUID()}`
  let descriptor = null
  let acquired = false
  try {
    descriptor = fs.openSync(temporary, 'wx')
    fs.writeFileSync(descriptor, owner)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.linkSync(temporary, file)
    acquired = true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  } finally {
    if (descriptor != null) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch {}
  }
  return acquired
}

function waitForOwner(file, owner) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (readLock(file) === owner) return true
  }
  return false
}

function abandonedLock(file, raw) {
  if (staleLocalOwner(raw)) return true
  if (parseLockOwner(raw)) return false
  try {
    const stat = fs.lstatSync(file)
    return stat.isFile() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs >= MALFORMED_LOCK_GRACE_MS
  } catch { return false }
}

function restoreMovedFile(file, quarantine) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      fs.renameSync(quarantine, file)
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
    }
  }
  return false
}

function moveObservedFile(file, observedRaw, quarantine) {
  try {
    fs.renameSync(file, quarantine)
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) return false
    throw error
  }
  if (readLock(quarantine) === observedRaw) return true
  restoreMovedFile(file, quarantine)
  return false
}

function removeStaleRecoveryMarker(marker) {
  if (!fs.existsSync(marker)) return true
  const observedRaw = readLock(marker)
  if (!observedRaw || !abandonedLock(marker, observedRaw)) return false
  const quarantine = `${marker}.abandoned-${crypto.randomUUID()}`
  if (!moveObservedFile(marker, observedRaw, quarantine)) return false
  try { fs.unlinkSync(quarantine) } catch (error) { if (error.code !== 'ENOENT') throw error }
  return true
}

function acquireRecoveryMarker(marker) {
  if (!removeStaleRecoveryMarker(marker)) return null
  const owner = lockOwner()
  if (!publishLock(marker, owner)) return null
  // A delayed observer of an older stale marker may move this one, notice its token changed, then
  // restore it. Wait for that restoration before touching the canonical lock.
  if (!waitForOwner(marker, owner)) return null
  return owner
}

function releaseOwnedFile(file, owner) {
  if (readLock(file) !== owner) return false
  try { fs.unlinkSync(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function recoverStaleLock(file, observedRaw, owner) {
  const marker = `${file}.reclaim`
  const markerOwner = acquireRecoveryMarker(marker)
  if (!markerOwner) return false
  let acquired = false
  const quarantine = `${file}.stale-${crypto.randomUUID()}`
  try {
    if (readLock(file) !== observedRaw || !abandonedLock(file, observedRaw)) return false
    if (!moveObservedFile(file, observedRaw, quarantine)) return false
    // A contender may have passed its first marker check before marker publication. Its second
    // check removes its own candidate. Never unlink an unknown canonical owner here.
    if (fs.existsSync(file) || !publishLock(file, owner)) return false
    acquired = true
    try { fs.unlinkSync(quarantine) } catch (error) { if (error.code !== 'ENOENT') throw error }
    return true
  } finally {
    releaseOwnedFile(marker, markerOwner)
    if (!acquired && fs.existsSync(quarantine) && !fs.existsSync(file)) restoreMovedFile(file, quarantine)
  }
}

function acquireLocalLock(file, hooks = {}) {
  ensureDirectorySafe(path.dirname(file))
  const marker = `${file}.reclaim`
  if (!removeStaleRecoveryMarker(marker) || fs.existsSync(marker)) return null
  const owner = lockOwner()
  if (publishLock(file, owner)) {
    // Recovery marker appearing after first check means a reclaimer observed the previous owner.
    // Remove only our own candidate, never whatever path may replace it.
    if (fs.existsSync(marker)) {
      releaseOwnedFile(file, owner)
      return null
    }
    ownedLocks.set(file, owner)
    return file
  }
  const observedRaw = readLock(file)
  if (!observedRaw || !abandonedLock(file, observedRaw)) return null
  if (hooks.afterObserveAbandoned) hooks.afterObserveAbandoned({ file, observedRaw })
  if (!recoverStaleLock(file, observedRaw, owner)) return null
  ownedLocks.set(file, owner)
  return file
}

function releaseLocalLock(file) {
  const owner = ownedLocks.get(file)
  if (!owner) return false
  ownedLocks.delete(file)
  if (readLock(file) !== owner) return false
  try { fs.unlinkSync(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function localLockHeld(file) {
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.reclaim`)) return false
  const acquired = acquireLocalLock(file)
  if (!acquired) return true
  releaseLocalLock(acquired)
  return false
}

function assertCohortOpen(root, runId) {
  const paths = cohortPaths(root, runId)
  if (runId === 'legacy') throw new Error('legacy cohort is read-only')
  if (localLockHeld(paths.sealLock)) throw new Error(`cohort ${runId} is being sealed; retry later`)
  // Seal must be checked after its lock. If sealing finishes between these reads, final seal is
  // visible; if it starts afterwards, it sees caller's already-held result lock and aborts.
  if (fs.existsSync(paths.seal)) throw new Error(`cohort ${runId} is sealed; use a new --run for more results`)
}

function sha256File(file) {
  assertExistingPathSafe(file)
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function assertRecordMetadata(record, manifest, kind = 'record') {
  for (const [key, value] of Object.entries(manifestMetadata(manifest))) {
    if (record[key] !== value) throw new Error(`${kind} ${key} does not match cohort manifest`)
  }
  return record
}

function validateResultRecord(record, manifest, targetId, toolId) {
  if (!record || record.schemaVersion !== 2) throw new Error(`result schemaVersion is invalid: ${targetId}/${toolId}`)
  assertRecordMetadata(record, manifest, `result ${targetId}/${toolId}`)
  if (record.target !== targetId || record.tool !== toolId) throw new Error(`result identity does not match path: ${targetId}/${toolId}`)
  if (record.cellId !== cellId(manifest.runId, targetId, toolId)) throw new Error(`result cellId does not match cohort: ${targetId}/${toolId}`)
  const pins = manifest.targets[targetId]
  if (!pins || record.baseSha !== pins.baseSha || record.headSha !== pins.headSha) {
    throw new Error(`result git pins do not match manifest: ${targetId}/${toolId}`)
  }
  return record
}

function readResultRecord(file, manifest, targetId, toolId) {
  return validateResultRecord(readJson(file), manifest, targetId, toolId)
}

function listResultCells(root, manifest) {
  const paths = cohortPaths(root, manifest.runId)
  if (!fs.existsSync(paths.results)) return []
  const cells = []
  for (const targetEntry of fs.readdirSync(paths.results, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!targetEntry.isDirectory()) continue
    const target = assertSafeId(targetEntry.name, 'result target')
    if (!manifest.targets[target]) throw new Error(`result target is not in manifest: ${target}`)
    const dir = path.join(paths.results, target)
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
      const tool = assertSafeId(file.slice(0, -5), 'result tool')
      const absolute = path.join(dir, file)
      const record = validateResultRecord(readJson(absolute), manifest, target, tool)
      const relative = `results/${target}/${file}`
      cells.push({
        id: record.cellId,
        target,
        tool,
        file: relative,
        sha256: sha256File(absolute),
      })
    }
  }
  return cells.sort((left, right) => left.file.localeCompare(right.file))
}

function assertExpectedResults(cells, manifest) {
  const actual = cells.map(({ id, target, tool }) => ({ id, target, tool }))
  if (JSON.stringify(actual) !== JSON.stringify(manifest.expectedCells)) {
    const actualIds = new Set(actual.map((cell) => cell.id))
    const expectedIds = new Set(manifest.expectedCells.map((cell) => cell.id))
    const missing = [...expectedIds].filter((id) => !actualIds.has(id))
    const extra = [...actualIds].filter((id) => !expectedIds.has(id))
    throw new Error(`cohort ${manifest.runId} results incomplete: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`)
  }
  return cells
}

function validateSeal(seal, manifest) {
  if (!seal || seal.schemaVersion !== 1 || !Array.isArray(seal.cells) || !seal.cells.length) throw new Error('invalid cohort seal schema')
  assertRecordMetadata(seal, manifest, 'seal')
  if (typeof seal.createdAt !== 'string' || !seal.createdAt) throw new Error('seal createdAt is required')
  let previous = null
  const seen = new Set()
  for (const cell of seal.cells) {
    const target = assertSafeId(cell && cell.target, 'seal target')
    const tool = assertSafeId(cell && cell.tool, 'seal tool')
    if (!manifest.targets[target]) throw new Error(`sealed target is not in manifest: ${target}`)
    const expectedId = cellId(manifest.runId, target, tool)
    const expectedFile = `results/${target}/${tool}.json`
    if (cell.id !== expectedId || cell.file !== expectedFile || !FILE_HASH.test(cell.sha256)) throw new Error(`invalid sealed cell: ${expectedId}`)
    if (seen.has(cell.id) || (previous && previous.localeCompare(cell.file) >= 0)) throw new Error('sealed cells must be unique and sorted')
    seen.add(cell.id)
    previous = cell.file
  }
  return seal
}

function readSeal(root, runId, targetIds = null) {
  const manifest = readManifest(root, runId, targetIds)
  const paths = cohortPaths(root, runId)
  if (!fs.existsSync(paths.seal)) throw new Error(`cohort ${runId} is not sealed; run bench/extract first`)
  const seal = validateSeal(readJson(paths.seal), manifest)
  const actual = listResultCells(root, manifest)
  assertExpectedResults(actual, manifest)
  if (JSON.stringify(actual) !== JSON.stringify(seal.cells)) throw new Error(`sealed results changed for cohort ${runId}`)
  return { manifest, seal }
}

function resultLockFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const locks = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) locks.push(...resultLockFiles(file))
    else if (entry.name.endsWith('.json.lock')) locks.push(file)
    else if (entry.name.endsWith('.json.lock.reclaim')) locks.push(file.slice(0, -'.reclaim'.length))
  }
  return [...new Set(locks)].sort()
}

function activeResultLocks(dir) {
  const active = []
  for (const file of resultLockFiles(dir)) {
    const acquired = acquireLocalLock(file)
    if (!acquired) active.push(file)
    else releaseLocalLock(acquired)
  }
  return active
}

function ensureSeal(root, runId, targetIds = null) {
  const manifest = readManifest(root, runId, targetIds)
  const paths = cohortPaths(root, runId)
  if (fs.existsSync(paths.seal)) return readSeal(root, runId, targetIds)
  const lock = acquireLocalLock(paths.sealLock)
  if (!lock) {
    if (fs.existsSync(paths.seal)) return readSeal(root, runId, targetIds)
    throw new Error(`cohort ${runId} is being sealed; retry later`)
  }
  try {
    if (fs.existsSync(paths.seal)) return readSeal(root, runId, targetIds)
    const active = activeResultLocks(paths.results)
    if (active.length) throw new Error(`cohort ${runId} has ${active.length} active result run(s); retry extraction later`)
    const cells = listResultCells(root, manifest)
    assertExpectedResults(cells, manifest)
    const seal = { schemaVersion: 1, ...manifestMetadata(manifest), createdAt: new Date().toISOString(), cells }
    try { writeJsonExclusive(paths.seal, seal) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    return readSeal(root, runId, targetIds)
  } finally {
    try { releaseLocalLock(lock) } catch {}
  }
}

function resultFileForCell(root, runId, cell) {
  const paths = cohortPaths(root, runId)
  return path.join(paths.results, cell.target, `${cell.tool}.json`)
}

function findingFileForCell(root, runId, cell) {
  const paths = cohortPaths(root, runId)
  return path.join(paths.findings, cell.target, `${cell.tool}.json`)
}

function assertString(value, field, options = {}) {
  if (typeof value !== 'string' || (options.nonempty && !value.trim()) || (options.max && value.length > options.max)) {
    throw new Error(`${field} must be ${options.nonempty ? 'a nonempty ' : ''}string${options.max ? ` <=${options.max} chars` : ''}`)
  }
}

function validateFinding(finding, label = 'finding') {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) throw new Error(`${label} must be an object`)
  assertString(finding.title, `${label}.title`, { nonempty: true, max: 90 })
  assertString(finding.file, `${label}.file`)
  if (!Number.isInteger(finding.line) || finding.line < 0) throw new Error(`${label}.line must be a nonnegative integer`)
  if (!SEVERITIES.has(finding.severity)) throw new Error(`${label}.severity is invalid`)
  if (!FINDING_KINDS.has(finding.kind)) throw new Error(`${label}.kind is invalid`)
  assertString(finding.claim, `${label}.claim`)
  if (finding.selfRejected != null && typeof finding.selfRejected !== 'boolean') throw new Error(`${label}.selfRejected must be boolean`)
  return finding
}

function validateFindingRecord(record, manifest, cell) {
  if (!record || record.schemaVersion !== 2) throw new Error(`finding schemaVersion is invalid: ${cell.id}`)
  assertRecordMetadata(record, manifest, `finding ${cell.target}/${cell.tool}`)
  if (record.target !== cell.target || record.tool !== cell.tool || record.cellId !== cell.id) {
    throw new Error(`finding identity does not match sealed cell: ${cell.id}`)
  }
  const pins = manifest.targets[cell.target]
  if (record.baseSha !== pins.baseSha || record.headSha !== pins.headSha) throw new Error(`finding git pins do not match manifest: ${cell.id}`)
  if (record.sourceResultSha256 !== cell.sha256) throw new Error(`finding source hash does not match seal: ${cell.id}`)
  if (!Array.isArray(record.findings) || record.extractError != null) throw new Error(`finding extraction is not successful: ${cell.id}`)
  record.findings.forEach((finding, index) => validateFinding(finding, `${cell.id} finding ${index + 1}`))
  return record
}

function readFindingRecord(file, manifest, cell) {
  return validateFindingRecord(readJson(file), manifest, cell)
}

function validateIssue(issue, index, knownCells) {
  const label = `issue ${index + 1}`
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new Error(`${label} must be an object`)
  assertString(issue.id, `${label}.id`, { nonempty: true })
  assertString(issue.title, `${label}.title`, { nonempty: true, max: 90 })
  assertString(issue.file, `${label}.file`)
  if (!Number.isInteger(issue.line) || issue.line < 0) throw new Error(`${label}.line must be a nonnegative integer`)
  if (!FINDING_KINDS.has(issue.kind)) throw new Error(`${label}.kind is invalid`)
  if (!SEVERITIES.has(issue.severity)) throw new Error(`${label}.severity is invalid`)
  if (!VERDICTS.has(issue.verdict)) throw new Error(`${label}.verdict is invalid`)
  assertString(issue.verdictReason, `${label}.verdictReason`)
  if (typeof issue.introducedByPr !== 'boolean') throw new Error(`${label}.introducedByPr must be boolean`)
  if (!SCOPES.has(issue.scope)) throw new Error(`${label}.scope is invalid`)
  assertString(issue.scopeReason, `${label}.scopeReason`)
  const knownTools = new Set([...knownCells].map((id) => id.slice(id.lastIndexOf('/') + 1)))
  if (!Array.isArray(issue.reportedBy) || !issue.reportedBy.length || !issue.reportedBy.every((id) => knownTools.has(id)) || new Set(issue.reportedBy).size !== issue.reportedBy.length) {
    throw new Error(`${label}.reportedBy must name unique known tools`)
  }
  if (!Array.isArray(issue.reportedByRuns) || !issue.reportedByRuns.length || !issue.reportedByRuns.every((id) => knownCells.has(id)) || new Set(issue.reportedByRuns).size !== issue.reportedByRuns.length) {
    throw new Error(`${label}.reportedByRuns must name known cells`)
  }
  if (!issue.reportedAs || typeof issue.reportedAs !== 'object' || Array.isArray(issue.reportedAs)) throw new Error(`${label}.reportedAs is invalid`)
  if (!issue.reportedAsByRun || typeof issue.reportedAsByRun !== 'object' || Array.isArray(issue.reportedAsByRun)) throw new Error(`${label}.reportedAsByRun is invalid`)
  for (const [key, value] of Object.entries(issue.reportedAs)) {
    if (!knownTools.has(key)) throw new Error(`${label}.reportedAs names unknown tool: ${key}`)
    assertString(value, `${label}.reportedAs.${key}`)
  }
  for (const [key, value] of Object.entries(issue.reportedAsByRun)) {
    if (!knownCells.has(key)) throw new Error(`${label}.reportedAsByRun names unknown cell: ${key}`)
    assertString(value, `${label}.reportedAsByRun.${key}`)
  }
  if (!issue.reportedBy.every((id) => Object.hasOwn(issue.reportedAs, id))) throw new Error(`${label}.reportedAs is incomplete`)
  if (!issue.reportedByRuns.every((id) => Object.hasOwn(issue.reportedAsByRun, id))) throw new Error(`${label}.reportedAsByRun is incomplete`)
  return issue
}

function validateIssues(issues, cells) {
  if (!Array.isArray(issues)) throw new Error('judgement issues must be an array')
  const knownCells = new Set(cells.map((cell) => cell.id))
  const ids = new Set()
  for (let index = 0; index < issues.length; index += 1) {
    validateIssue(issues[index], index, knownCells)
    if (ids.has(issues[index].id)) throw new Error(`duplicate judgement issue id: ${issues[index].id}`)
    ids.add(issues[index].id)
  }
  return issues
}

function validateJudgementRecord(record, manifest, targetId, cells) {
  if (!record || record.schemaVersion !== 2) throw new Error(`judgement schemaVersion is invalid: ${targetId}`)
  assertRecordMetadata(record, manifest, `judgement ${targetId}`)
  if (record.target !== targetId) throw new Error(`judgement target mismatch: ${targetId}`)
  const pins = manifest.targets[targetId]
  if (!pins || record.baseSha !== pins.baseSha || record.headSha !== pins.headSha) throw new Error(`judgement git pins mismatch: ${targetId}`)
  validateIssues(record.issues, cells)
  return record
}

function readJudgementRecord(file, manifest, targetId, cells) {
  return validateJudgementRecord(readJson(file), manifest, targetId, cells)
}

function validateComplete(complete, manifest, seal, findings, judgements) {
  if (!complete || complete.schemaVersion !== 1) throw new Error('invalid complete marker schema')
  assertRecordMetadata(complete, manifest, 'complete marker')
  if (typeof complete.createdAt !== 'string' || !complete.createdAt) throw new Error('complete marker createdAt is required')
  if (complete.manifestSha256 !== manifest.sha256) throw new Error('complete marker manifest hash mismatch')
  if (complete.sealSha256 !== seal.sha256) throw new Error('complete marker seal hash mismatch')
  if (JSON.stringify(complete.findings) !== JSON.stringify(findings)) throw new Error('complete marker finding hashes mismatch')
  if (JSON.stringify(complete.judgements) !== JSON.stringify(judgements)) throw new Error('complete marker judgement hashes mismatch')
  return complete
}

function relativeJsonFiles(base, prefix, nested) {
  if (!fs.existsSync(base)) return []
  const files = []
  for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const file = path.join(base, entry.name)
    if (nested && entry.isDirectory()) {
      assertSafeId(entry.name, `${prefix} target`)
      for (const child of fs.readdirSync(file, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (child.isFile() && child.name.endsWith('.json')) files.push(`${prefix}/${entry.name}/${child.name}`)
      }
    } else if (!nested && entry.isFile() && entry.name.endsWith('.json')) files.push(`${prefix}/${entry.name}`)
  }
  return files
}

function completionInputs(root, manifest, seal) {
  const findings = []
  for (const cell of seal.cells) {
    const file = findingFileForCell(root, manifest.runId, cell)
    if (!fs.existsSync(file)) return null
    validateFindingRecord(readJson(file), manifest, cell)
    findings.push({ file: `findings/${cell.target}/${cell.tool}.json`, sha256: sha256File(file) })
  }
  const paths = cohortPaths(root, manifest.runId)
  const actualFindings = relativeJsonFiles(paths.findings, 'findings', true)
  if (JSON.stringify(actualFindings) !== JSON.stringify(findings.map((entry) => entry.file).sort())) {
    throw new Error(`cohort ${manifest.runId} has unexpected finding artifacts`)
  }
  const judgements = []
  const targets = [...new Set(seal.cells.map((cell) => cell.target))].sort()
  for (const target of targets) {
    const file = path.join(paths.judgement, `${target}.json`)
    if (!fs.existsSync(file)) return null
    const cells = seal.cells.filter((cell) => cell.target === target)
    validateJudgementRecord(readJson(file), manifest, target, cells)
    judgements.push({ file: `judgement/${target}.json`, sha256: sha256File(file) })
  }
  const actualJudgements = relativeJsonFiles(paths.judgement, 'judgement', false)
  if (JSON.stringify(actualJudgements) !== JSON.stringify(judgements.map((entry) => entry.file).sort())) {
    throw new Error(`cohort ${manifest.runId} has unexpected judgement artifacts`)
  }
  return { findings, judgements }
}

function readComplete(root, runId, targetIds = null) {
  const { manifest, seal } = readSeal(root, runId, targetIds)
  const paths = cohortPaths(root, runId)
  if (!fs.existsSync(paths.complete)) throw new Error(`cohort ${runId} is not complete`)
  const inputs = completionInputs(root, manifest, seal)
  if (!inputs) throw new Error(`cohort ${runId} complete marker has missing artifacts`)
  return {
    manifest,
    seal,
    complete: validateComplete(readJson(paths.complete), {
      ...manifest, sha256: sha256File(paths.manifest),
    }, {
      ...seal, sha256: sha256File(paths.seal),
    }, inputs.findings, inputs.judgements),
  }
}

function ensureComplete(root, runId, targetIds = null) {
  const { manifest, seal } = readSeal(root, runId, targetIds)
  const inputs = completionInputs(root, manifest, seal)
  if (!inputs) return null
  const paths = cohortPaths(root, runId)
  const complete = {
    schemaVersion: 1,
    ...manifestMetadata(manifest),
    createdAt: new Date().toISOString(),
    manifestSha256: sha256File(paths.manifest),
    sealSha256: sha256File(paths.seal),
    findings: inputs.findings,
    judgements: inputs.judgements,
  }
  try { writeJsonExclusive(paths.complete, complete) } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return readComplete(root, runId, targetIds)
}

module.exports = {
  acquireLocalLock,
  assertCohortOpen,
  assertExpectedResults,
  assertManifestTargets,
  assertRecordMetadata,
  assertSafeId,
  cellId,
  cohortPaths,
  defaultRunId,
  deriveRunId,
  discoverCohorts,
  ensureManifest,
  ensureComplete,
  ensureDirectorySafe,
  ensureSeal,
  findingFileForCell,
  listResultCells,
  loadModelConfig,
  manifestMetadata,
  modelById,
  readManifest,
  readResultRecord,
  readComplete,
  readFindingRecord,
  readJudgementRecord,
  readSeal,
  releaseLocalLock,
  resultFileForCell,
  sha256File,
  snapshotGroundtruth,
  snapshotTargetMetadata,
  validateFindingRecord,
  validateFinding,
  validateIssues,
  validateJudgementRecord,
  validateManifest,
  validateResultRecord,
  validateSeal,
  writeJsonExclusive,
}
