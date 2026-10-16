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
const EVALUATOR_MODEL = 'claude-sonnet-5'
const FABLE_MODEL = 'claude-fable-5-1'
const REPORTED_USAGE_NUMBER = /(?:^|_)(?:input_tokens|output_tokens|thinking_tokens|web_search_requests|web_fetch_requests)$/
const REVIEW_AND_FIX_PR_CONTRACT_V1 = 'review-and-fix-pr-v1'
const REVIEW_AND_FIX_PR_CONTRACT_V2 = 'review-and-fix-pr-v2'
const REVIEW_AND_FIX_PR_CONTRACT_V3 = 'review-and-fix-pr-v3'
// Retain the original export for callers and frozen fixtures which predate version dispatch.
const REVIEW_AND_FIX_PR_CONTRACT = REVIEW_AND_FIX_PR_CONTRACT_V1
const REVIEW_AND_FIX_PR_MARKER = 'REVIEW_AND_FIX_PR_RESULT_JSON='
const REVIEW_INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const RESERVED_FINDING_TEXT = Object.freeze([
  REVIEW_AND_FIX_PR_MARKER,
  'REVIEW_AND_FIX_PR_CODEX_RECEIPT_JSON=',
])
const REVIEW_AND_FIX_PR_MANDATORY_LENSES = Object.freeze([
  'correctness', 'spec', 'standards', 'security', 'reliability', 'contracts',
  'testing', 'performance', 'comments', 'maintainability',
])
const ownedLocks = new Map()
const MALFORMED_LOCK_GRACE_MS = 5 * 60_000

function reviewCodexContract() {
  // Load this only for v2 cells. Historical cohorts must remain readable even in installations
  // which never ran the Codex-backed contract.
  return require('../../lib/review-codex-contract')
}

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
    probe: legacy ? null : path.join(cohortRoot, 'probe.json'),
    quota: legacy ? null : path.join(cohortRoot, 'quota.jsonl'),
    results: path.join(cohortRoot, 'results'),
    findings: path.join(cohortRoot, 'findings'),
    judgement: path.join(cohortRoot, 'judgement'),
  }
}

function cellId(runId, targetId, toolId) {
  return [runId, targetId, toolId].map((value) => assertSafeId(value, 'cell id component')).join('/')
}

function manifestMetadata(manifest) {
  const metadata = {
    runId: manifest.runId,
    requestedModel: manifest.requestedModel,
    modelLabel: manifest.modelLabel,
    claudeVersion: manifest.claudeVersion,
    configSha256: manifest.configSha256,
  }
  if (manifest.pluginFingerprint != null) metadata.pluginFingerprint = canonical(manifest.pluginFingerprint)
  if (manifest.codexJudge != null) metadata.codexJudge = canonical(manifest.codexJudge)
  return metadata
}

function normalizedPluginFingerprint(fingerprint) {
  if (!fingerprint || typeof fingerprint !== 'object' || Array.isArray(fingerprint)) {
    throw new Error('manifest pluginFingerprint is invalid')
  }
  const expectedKeys = ['contentSha256', 'gitCommit', 'version']
  if (JSON.stringify(Object.keys(fingerprint).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('manifest pluginFingerprint fields are invalid')
  }
  if (typeof fingerprint.version !== 'string' || !fingerprint.version.trim()) {
    throw new Error('manifest pluginFingerprint version is required')
  }
  if (fingerprint.gitCommit !== null && !GIT_SHA.test(fingerprint.gitCommit || '')) {
    throw new Error('manifest pluginFingerprint gitCommit must be 40-hex or null')
  }
  if (!FILE_HASH.test(fingerprint.contentSha256 || '')) {
    throw new Error('manifest pluginFingerprint contentSha256 is required')
  }
  return {
    version: fingerprint.version,
    gitCommit: fingerprint.gitCommit === null ? null : fingerprint.gitCommit.toLowerCase(),
    contentSha256: fingerprint.contentSha256.toLowerCase(),
  }
}

function validCodexCliVersion(version) {
  if (typeof version !== 'string') return false
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (!match) return false
  const actual = match.slice(1).map(Number)
  const minimum = [0, 149, 0]
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index]
  }
  return true
}

function normalizedCodexJudgeIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error('manifest codexJudge is invalid')
  }
  const normalized = {
    provider: identity.provider || identity.judgeProvider,
    model: identity.model,
    reasoningEffort: identity.reasoningEffort || identity.effort,
    cliVersion: identity.cliVersion,
    executableSha256: identity.executableSha256,
    schemaSha256: identity.schemaSha256,
    authenticated: identity.authenticated,
  }
  if (normalized.provider !== 'openai' || normalized.model !== 'gpt-5.6-sol' ||
      normalized.reasoningEffort !== 'high' || normalized.authenticated !== true ||
      !validCodexCliVersion(normalized.cliVersion) ||
      !FILE_HASH.test(normalized.executableSha256 || '') || !FILE_HASH.test(normalized.schemaSha256 || '')) {
    throw new Error('manifest codexJudge identity is invalid')
  }
  return normalized
}

function normalizedCohortScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('manifest cohortScope is invalid')
  if (JSON.stringify(Object.keys(scope).sort()) !== JSON.stringify(['target', 'tool'])) {
    throw new Error('manifest cohortScope fields are invalid')
  }
  return {
    tool: assertSafeId(scope.tool, 'cohort scope tool'),
    target: scope.target == null ? null : assertSafeId(scope.target, 'cohort scope target'),
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
    if (id === 'review-and-fix-pr' && tool.resultContract != null &&
        ![REVIEW_AND_FIX_PR_CONTRACT_V1, REVIEW_AND_FIX_PR_CONTRACT_V2, REVIEW_AND_FIX_PR_CONTRACT_V3].includes(tool.resultContract)) {
      throw new Error(`manifest toolConfig review contract is invalid: ${tool.resultContract}`)
    }
    if (tool.reviewProtocol != null && tool.reviewProtocol !== 'six-pass') {
      throw new Error(`manifest toolConfig review protocol is invalid: ${tool.reviewProtocol}`)
    }
  }
  return canonical(config)
}

function reviewAndFixPrContractForTool(manifest, toolId) {
  const tools = manifest && manifest.toolConfig && manifest.toolConfig.tools
  const tool = Array.isArray(tools) ? tools.find((entry) => entry && entry.id === toolId) : null
  const declared = tool && tool.resultContract
  if ([REVIEW_AND_FIX_PR_CONTRACT_V1, REVIEW_AND_FIX_PR_CONTRACT_V2, REVIEW_AND_FIX_PR_CONTRACT_V3].includes(declared)) return declared
  // The original tool was keyed by id before resultContract was frozen in manifests. Preserve that
  // exact historical interpretation; a new undeclared contract must never silently become v2.
  if (toolId === 'review-and-fix-pr' && declared == null) return REVIEW_AND_FIX_PR_CONTRACT_V1
  return null
}

function manifestRequiresCodexJudge(manifest) {
  return Array.isArray(manifest && manifest.expectedCells) &&
    manifest.expectedCells.some((cell) => [REVIEW_AND_FIX_PR_CONTRACT_V2, REVIEW_AND_FIX_PR_CONTRACT_V3]
      .includes(reviewAndFixPrContractForTool(manifest, cell.tool)))
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
    if (manifest.cohortScope != null) {
      manifest.cohortScope = normalizedCohortScope(manifest.cohortScope)
      const scopedTools = manifest.toolConfig.tools.map((tool) => tool.id)
      if (scopedTools.length !== 1 || scopedTools[0] !== manifest.cohortScope.tool ||
          !manifest.expectedCells.every((cell) => cell.tool === manifest.cohortScope.tool)) {
        throw new Error('manifest scoped tool does not match toolConfig and expectedCells')
      }
      const scopedTargets = [...new Set(manifest.expectedCells.map((cell) => cell.target))].sort()
      if (JSON.stringify(scopedTargets) !== JSON.stringify(Object.keys(manifest.targets).sort())) {
        throw new Error('manifest scoped targets do not match targets and expectedCells')
      }
      if (manifest.cohortScope.target != null &&
          (scopedTargets.length !== 1 || scopedTargets[0] !== manifest.cohortScope.target)) {
        throw new Error('manifest scoped target does not match expectedCells')
      }
    }
    const requiresPluginFingerprint = manifest.expectedCells.some((cell) => {
      const tool = manifest.toolConfig.tools.find((entry) => entry.id === cell.tool)
      if (!tool) throw new Error(`expected cell tool is missing from toolConfig: ${cell.tool}`)
      return cell.tool === 'review-and-fix-pr' || tool.requiresPluginDir === true
    })
    if (requiresPluginFingerprint && manifest.pluginFingerprint == null) {
      throw new Error('manifest local-plugin cells require pluginFingerprint')
    }
    if (manifest.pluginFingerprint != null) {
      manifest.pluginFingerprint = normalizedPluginFingerprint(manifest.pluginFingerprint)
    }
    const requiresCodexJudge = manifestRequiresCodexJudge(manifest)
    if (requiresCodexJudge && manifest.codexJudge == null) {
      throw new Error('manifest review-and-fix-pr-v2 cells require codexJudge identity')
    }
    if (manifest.codexJudge != null) manifest.codexJudge = normalizedCodexJudgeIdentity(manifest.codexJudge)
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
  if (Object.hasOwn(expected, 'cohortScope')) {
    const wanted = expected.cohortScope == null ? null : normalizedCohortScope(expected.cohortScope)
    const actual = manifest.cohortScope == null ? null : manifest.cohortScope
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`cohort ${manifest.runId} scope mismatch`)
  }
  if (Object.hasOwn(expected, 'pluginFingerprint')) {
    const wanted = expected.pluginFingerprint == null ? null : normalizedPluginFingerprint(expected.pluginFingerprint)
    const actual = manifest.pluginFingerprint == null ? null : manifest.pluginFingerprint
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`cohort ${manifest.runId} plugin fingerprint mismatch`)
  }
  if (Object.hasOwn(expected, 'codexJudge')) {
    const wanted = expected.codexJudge == null ? null : normalizedCodexJudgeIdentity(expected.codexJudge)
    const actual = manifest.codexJudge == null ? null : manifest.codexJudge
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`cohort ${manifest.runId} Codex judge identity mismatch`)
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
  const cohortScope = metadata.cohortScope == null ? null : normalizedCohortScope(metadata.cohortScope)
  const pluginFingerprint = metadata.pluginFingerprint == null ? null : normalizedPluginFingerprint(metadata.pluginFingerprint)
  const codexJudge = metadata.codexJudge == null ? null : normalizedCodexJudgeIdentity(metadata.codexJudge)
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
    ...(cohortScope == null ? {} : { cohortScope }),
    ...(pluginFingerprint == null ? {} : { pluginFingerprint }),
    ...(codexJudge == null ? {} : { codexJudge }),
    createdAt: metadata.createdAt || new Date().toISOString(),
  }
  validateManifest(manifest)
  ensureDirectorySafe(paths.root)
  try {
    writeJsonExclusive(paths.manifest, manifest)
    return manifest
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return validateManifest(readJson(paths.manifest), {
      ...manifestMetadata(manifest), targets, targetMetadata, groundtruth, expectedCells, toolConfig,
      cohortScope, pluginFingerprint, codexJudge,
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
      cohortScope: manifest.cohortScope || null,
      pluginFingerprint: manifest.pluginFingerprint || null,
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
    if (JSON.stringify(canonical(record[key])) !== JSON.stringify(canonical(value))) {
      throw new Error(`${kind} ${key} does not match cohort manifest`)
    }
  }
  return record
}

function validateModelUsage(modelUsage, requestedModel, label = 'claude modelUsage') {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) {
    throw new Error(`${label} is invalid`)
  }
  if (!Object.hasOwn(modelUsage, requestedModel)) {
    throw new Error(`${label} is missing requested model ${requestedModel}`)
  }
  for (const [model, usage] of Object.entries(modelUsage)) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
      throw new Error(`${label} for ${model} is invalid`)
    }
    assertSafeId(usage.canonicalModel, `${label} canonicalModel for ${model}`)
    const tokenFields = Object.entries(usage).filter(([name]) => name.endsWith('Tokens'))
    if (!tokenFields.length || !tokenFields.every(([, amount]) => Number.isFinite(amount) && amount >= 0)) {
      throw new Error(`${label} token usage for ${model} must contain only finite non-negative values`)
    }
    if (!Number.isFinite(usage.costUSD) || usage.costUSD < 0) {
      throw new Error(`${label} cost usage for ${model} must be finite and non-negative`)
    }
  }
  const requestedUsage = modelUsage[requestedModel]
  if (requestedUsage.canonicalModel !== requestedModel) {
    throw new Error(`${label} canonicalModel for requested model ${requestedModel} is ${JSON.stringify(requestedUsage.canonicalModel)}`)
  }
  const billedTokenFields = new Set([
    'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'thinkingTokens',
  ])
  if (!Object.entries(requestedUsage).some(([name, amount]) => billedTokenFields.has(name) && amount > 0)) {
    throw new Error(`${label} for ${requestedModel} contains no token usage`)
  }
  return modelUsage
}

function validateReportedUsage(usage, label = 'claude reported usage') {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error(`${label} is invalid`)
  let numericFields = 0
  const visit = (value, name, field) => {
    if (REPORTED_USAGE_NUMBER.test(name)) {
      numericFields += 1
      if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be finite and non-negative`)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, '', `${field}[${index}]`))
    } else if (value && typeof value === 'object') {
      for (const [childName, child] of Object.entries(value)) visit(child, childName, `${field}.${childName}`)
    }
  }
  for (const [name, value] of Object.entries(usage)) visit(value, name, `${label}.${name}`)
  if (!numericFields) throw new Error(`${label} contains no numeric usage fields`)
  return usage
}

function validateTranscriptUsage(usage, requestedModel, label = 'claude transcript usage') {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error(`${label} is invalid`)
  for (const field of ['input', 'output', 'thinking', 'cacheRead', 'cacheCreation', 'costUsd']) {
    if (!Number.isFinite(usage[field]) || usage[field] < 0) {
      throw new Error(`${label} ${field} must be finite and non-negative`)
    }
  }
  if (!Number.isFinite(usage.total) || usage.total <= 0) throw new Error(`${label} total must be finite and positive`)
  if (usage.total !== usage.input + usage.output + usage.cacheRead + usage.cacheCreation) {
    throw new Error(`${label} total does not match token classes`)
  }
  if (!Number.isInteger(usage.sessions) || usage.sessions < 1) throw new Error(`${label} must contain at least one session`)
  if (!usage.models || typeof usage.models !== 'object' || Array.isArray(usage.models)) {
    throw new Error(`${label} models are invalid`)
  }
  if (!Object.hasOwn(usage.models, requestedModel)) throw new Error(`${label} is missing requested model ${requestedModel}`)
  for (const [model, cost] of Object.entries(usage.models)) {
    if (!Number.isFinite(cost) || cost < 0) throw new Error(`${label} cost for ${model} must be finite and non-negative`)
  }
  if (usage.byAgent != null) {
    if (typeof usage.byAgent !== 'object' || Array.isArray(usage.byAgent)) {
      throw new Error(`${label} byAgent is invalid`)
    }
    for (const [agent, tokens] of Object.entries(usage.byAgent)) {
      if (!agent || !tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
        throw new Error(`${label} byAgent entry is invalid`)
      }
      for (const field of ['input', 'output', 'cacheRead', 'cacheCreation', 'messages', 'total']) {
        if (!Number.isSafeInteger(tokens[field]) || tokens[field] < 0) {
          throw new Error(`${label} byAgent ${agent}.${field} is invalid`)
        }
      }
      if (tokens.total !== tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation) {
        throw new Error(`${label} byAgent ${agent} total does not match token classes`)
      }
    }
  }
  return usage
}

function validateClaudeResponse(response, parsed, requestedModel, options = {}) {
  if (response.error) throw new Error(`claude process failed: ${response.error.message}`, { cause: response.error })
  if (response.signal) throw new Error(`claude process ended by ${response.signal}`)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('claude returned no valid JSON result')
  const exitCode = response.code == null ? response.status : response.code
  if (exitCode !== 0) throw new Error(`claude process exited ${exitCode}`)
  if (parsed.is_error !== false) throw new Error('claude result is marked as an error')
  if (parsed.api_error_status != null) throw new Error(`claude result has API error status ${parsed.api_error_status}`)
  if (typeof parsed.result !== 'string' || (!options.allowEmptyResult && !parsed.result.trim())) {
    throw new Error(`claude result is not a${options.allowEmptyResult ? '' : ' nonempty'} string`)
  }
  if (!Number.isFinite(parsed.total_cost_usd) || parsed.total_cost_usd < 0) {
    throw new Error('claude total_cost_usd must be finite and non-negative')
  }
  validateReportedUsage(parsed.usage)
  validateModelUsage(parsed.modelUsage, requestedModel)
  return parsed
}

function validateReviewAndFixPrBaseContract(contract, schemaVersion, extraFields = []) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('review-and-fix-pr result contract must be an object')
  }
  const expectedFields = [
    'completedLenses', 'coverage', 'coverageGapCount', 'failedLenses', 'findings', 'fix',
    'fixRequested', 'schemaVersion', 'skippedLenses', 'stopReason', 'stopTrigger', 'verification',
    ...extraFields,
  ].sort()
  if (JSON.stringify(Object.keys(contract).sort()) !== JSON.stringify(expectedFields)) {
    throw new Error('review-and-fix-pr result contract fields are invalid')
  }
  const requiredValues = {
    schemaVersion,
    coverage: 'complete',
    verification: 'complete',
    fix: 'not-requested',
    stopTrigger: 'none',
    stopReason: 'completed',
    fixRequested: false,
    coverageGapCount: 0,
  }
  for (const [field, value] of Object.entries(requiredValues)) {
    if (contract[field] !== value) {
      throw new Error(`review-and-fix-pr result contract ${field} must be ${JSON.stringify(value)}`)
    }
  }
  for (const field of ['completedLenses', 'skippedLenses', 'failedLenses']) {
    if (!Array.isArray(contract[field]) || !contract[field].every((lens) => typeof lens === 'string' && lens.length > 0)) {
      throw new Error(`review-and-fix-pr result contract ${field} is invalid`)
    }
  }
  if (contract.skippedLenses.length || contract.failedLenses.length) {
    throw new Error('review-and-fix-pr result contract contains skipped or failed lenses')
  }
  if (new Set(contract.completedLenses).size !== contract.completedLenses.length) {
    throw new Error('review-and-fix-pr result contract completedLenses must be unique')
  }
  const completed = new Set(contract.completedLenses)
  const missing = REVIEW_AND_FIX_PR_MANDATORY_LENSES.filter((lens) => !completed.has(lens))
  if (missing.length) throw new Error(`review-and-fix-pr result contract is missing mandatory lenses: ${missing.join(', ')}`)
  const known = new Set(REVIEW_AND_FIX_PR_MANDATORY_LENSES)
  const extra = contract.completedLenses.filter((lens) => !known.has(lens))
  if (extra.length) throw new Error(`review-and-fix-pr result contract has unknown methodology IDs: ${extra.join(', ')}`)
  const findings = contract.findings
  const findingFields = ['confirmed', 'provisional', 'rejected', 'unresolved',
    ...(schemaVersion === 3 ? ['suggestion'] : [])].sort()
  if (!findings || typeof findings !== 'object' || Array.isArray(findings) ||
      JSON.stringify(Object.keys(findings).sort()) !== JSON.stringify(findingFields) ||
      !Object.values(findings).every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('review-and-fix-pr result contract findings are invalid')
  }
  if (findings.provisional !== findings.confirmed + findings.rejected + findings.unresolved + (findings.suggestion || 0)) {
    throw new Error('review-and-fix-pr result contract finding dispositions do not partition provisional findings')
  }
  return contract
}

function validateReviewAndFixPrV1Contract(contract) {
  return canonical(validateReviewAndFixPrBaseContract(contract, 1))
}

function validateReviewAndFixPrV2Contract(contract, schemaVersion = 2) {
  validateReviewAndFixPrBaseContract(contract, schemaVersion, ['candidateLedger', 'codex', 'newLeadResolutions'])
  if (!Array.isArray(contract.candidateLedger) || !Array.isArray(contract.newLeadResolutions)) {
    throw new Error('review-and-fix-pr v2 closure ledger is invalid')
  }
  const candidateFields = [
    'candidateId', 'claimHash', 'finalDisposition', 'judgeInvocationId', 'originInvocationId', 'verdict',
  ]
  const candidateIds = new Set()
  const claimHashes = new Set()
  const dispositionForVerdict = {
    real: 'confirmed', false_positive: 'rejected', unresolved: 'unresolved',
    ...(schemaVersion === 3 ? { suggestion: 'suggestion' } : {}),
  }
  for (const [index, candidate] of contract.candidateLedger.entries()) {
    const label = `review-and-fix-pr v2 candidate ${index + 1}`
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
        JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(candidateFields)) {
      throw new Error(`${label} fields are invalid`)
    }
    assertSafeId(candidate.candidateId, `${label} id`)
    if (!FILE_HASH.test(candidate.claimHash || '')) throw new Error(`${label} claimHash is invalid`)
    if (candidate.originInvocationId !== null && !REVIEW_INVOCATION_ID.test(candidate.originInvocationId)) {
      throw new Error(`${label} origin invocation is invalid`)
    }
    if (!REVIEW_INVOCATION_ID.test(candidate.judgeInvocationId)) throw new Error(`${label} judge invocation is invalid`)
    if (!Object.hasOwn(dispositionForVerdict, candidate.verdict) ||
        candidate.finalDisposition !== dispositionForVerdict[candidate.verdict]) {
      throw new Error(`${label} verdict and finalDisposition are inconsistent`)
    }
    if (candidate.originInvocationId === candidate.judgeInvocationId) {
      throw new Error(`${label} cannot be judged by its originating invocation`)
    }
    if (candidateIds.has(candidate.candidateId) || claimHashes.has(candidate.claimHash)) {
      throw new Error('review-and-fix-pr v2 candidates must have unique IDs and claim hashes')
    }
    candidateIds.add(candidate.candidateId)
    claimHashes.add(candidate.claimHash)
  }
  const leadFields = ['candidateId', 'claimHash', 'leadId', 'originInvocationId', 'resolution']
  const leadIds = new Set()
  for (const [index, lead] of contract.newLeadResolutions.entries()) {
    const label = `review-and-fix-pr v2 new lead ${index + 1}`
    if (!lead || typeof lead !== 'object' || Array.isArray(lead) ||
        JSON.stringify(Object.keys(lead).sort()) !== JSON.stringify(leadFields)) {
      throw new Error(`${label} fields are invalid`)
    }
    assertSafeId(lead.leadId, `${label} id`)
    if (!REVIEW_INVOCATION_ID.test(lead.originInvocationId)) throw new Error(`${label} origin invocation is invalid`)
    assertSafeId(lead.candidateId, `${label} candidate`)
    if (!FILE_HASH.test(lead.claimHash || '') || !['admitted', 'duplicate'].includes(lead.resolution)) {
      throw new Error(`${label} resolution is invalid`)
    }
    if (leadIds.has(lead.leadId)) throw new Error('review-and-fix-pr v2 new lead IDs must be unique')
    leadIds.add(lead.leadId)
    const candidate = contract.candidateLedger.find((entry) => entry.candidateId === lead.candidateId)
    if (!candidate) throw new Error(`${label} maps to a missing candidate`)
    if (lead.resolution === 'admitted' &&
        (candidate.originInvocationId !== lead.originInvocationId || candidate.claimHash !== lead.claimHash)) {
      throw new Error(`${label} admitted mapping is inconsistent`)
    }
  }
  for (const candidate of contract.candidateLedger.filter((entry) => entry.originInvocationId !== null)) {
    const matches = contract.newLeadResolutions.filter((lead) => lead.resolution === 'admitted' &&
      lead.candidateId === candidate.candidateId && lead.originInvocationId === candidate.originInvocationId &&
      lead.claimHash === candidate.claimHash)
    if (matches.length !== 1) {
      throw new Error(`review-and-fix-pr v2 candidate ${candidate.candidateId} requires exactly one admitted new lead`)
    }
  }
  const codexFields = ['cliVersion', 'model', 'provider', 'reasoningEffort', 'receiptSha256']
  if (!contract.codex || typeof contract.codex !== 'object' || Array.isArray(contract.codex) ||
      JSON.stringify(Object.keys(contract.codex).sort()) !== JSON.stringify(codexFields) ||
      contract.codex.provider !== 'openai' || contract.codex.model !== 'gpt-5.6-sol' ||
      contract.codex.reasoningEffort !== 'high' || !FILE_HASH.test(contract.codex.receiptSha256 || '') ||
      !validCodexCliVersion(contract.codex.cliVersion)) {
    throw new Error('review-and-fix-pr v2 Codex identity is invalid')
  }
  const dispositionCounts = { confirmed: 0, rejected: 0, unresolved: 0,
    ...(schemaVersion === 3 ? { suggestion: 0 } : {}) }
  for (const candidate of contract.candidateLedger) dispositionCounts[candidate.finalDisposition] += 1
  if (contract.findings.provisional !== contract.candidateLedger.length ||
      contract.findings.confirmed !== dispositionCounts.confirmed ||
      contract.findings.rejected !== dispositionCounts.rejected ||
      contract.findings.unresolved !== dispositionCounts.unresolved ||
      (schemaVersion === 3 && contract.findings.suggestion !== dispositionCounts.suggestion)) {
    throw new Error('review-and-fix-pr v2 finding counts do not match the closure ledger')
  }
  return canonical(contract)
}

function validateReviewAndFixPrContract(contract, expectedContract = null) {
  const inferred = contract && contract.schemaVersion === 3 ? REVIEW_AND_FIX_PR_CONTRACT_V3
    : contract && contract.schemaVersion === 2 ? REVIEW_AND_FIX_PR_CONTRACT_V2
      : REVIEW_AND_FIX_PR_CONTRACT_V1
  const selected = expectedContract || inferred
  if (![REVIEW_AND_FIX_PR_CONTRACT_V1, REVIEW_AND_FIX_PR_CONTRACT_V2, REVIEW_AND_FIX_PR_CONTRACT_V3].includes(selected)) {
    throw new Error(`unknown review-and-fix-pr result contract: ${JSON.stringify(selected)}`)
  }
  const expectedSchema = selected === REVIEW_AND_FIX_PR_CONTRACT_V3 ? 3
    : selected === REVIEW_AND_FIX_PR_CONTRACT_V2 ? 2 : 1
  if (!contract || contract.schemaVersion !== expectedSchema) {
    throw new Error(`review-and-fix-pr result contract schemaVersion must be ${expectedSchema}`)
  }
  return selected !== REVIEW_AND_FIX_PR_CONTRACT_V1
    ? validateReviewAndFixPrV2Contract(contract, expectedSchema)
    : validateReviewAndFixPrV1Contract(contract)
}

function parseReviewAndFixPrResultContract(result, expectedContract = null) {
  if (typeof result !== 'string') throw new Error('review-and-fix-pr result is not a string')
  const lines = result.replace(/\r\n/g, '\n').split('\n')
  const markers = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith(REVIEW_AND_FIX_PR_MARKER)) markers.push({ index, line: lines[index] })
  }
  if (markers.length !== 1) {
    throw new Error(`review-and-fix-pr result requires exactly one ${REVIEW_AND_FIX_PR_MARKER} marker`)
  }
  const marker = markers[0]
  const lastNonempty = lines.reduce((last, line, index) => line.trim() ? index : last, -1)
  if (marker.index !== lastNonempty) throw new Error('review-and-fix-pr result contract marker must be the final nonempty line')
  let parsed
  try { parsed = JSON.parse(marker.line.slice(REVIEW_AND_FIX_PR_MARKER.length)) } catch {
    throw new Error('review-and-fix-pr result contract JSON is invalid')
  }
  return validateReviewAndFixPrContract(parsed, expectedContract)
}

function codexReceiptPath(root, runId, targetId, toolId, receiptId) {
  for (const [value, label] of [
    [runId, 'receipt run id'], [targetId, 'receipt target'], [toolId, 'receipt tool'], [receiptId, 'receipt id'],
  ]) assertSafeId(value, label)
  return path.join(root, 'work', 'codex-receipts', runId, targetId, toolId, `${receiptId}.json`)
}

function validateV2ControllerStats(record, label) {
  const stats = record.subagentStats
  const byType = stats && typeof stats === 'object' && !Array.isArray(stats) && stats.by_type
  if (!byType || typeof byType !== 'object' || Array.isArray(byType)) {
    throw new Error(`${label} is missing typed subagent statistics`)
  }
  if (byType['automated-development:review-lane-controller'] !== 1) {
    throw new Error(`${label} must use exactly one review-lane-controller`)
  }
  if (!Number.isSafeInteger(stats.spawned) || stats.spawned < 9 || stats.spawned > 15) {
    throw new Error(`${label} must use between 9 and 15 Claude subagents`)
  }
  if (!Object.values(byType).every((value) => Number.isSafeInteger(value) && value >= 0) ||
      Object.values(byType).reduce((sum, value) => sum + value, 0) !== stats.spawned) {
    throw new Error(`${label} typed subagent counts do not reconcile`)
  }
  if (stats.completed !== stats.spawned || stats.failed !== 0) {
    throw new Error(`${label} has incomplete or failed Claude subagents`)
  }
  for (const field of ['killed', 'refused']) {
    if (!stats[field] || typeof stats[field] !== 'object' || Array.isArray(stats[field]) ||
        !Object.values(stats[field]).every((value) => Number.isSafeInteger(value) && value === 0)) {
      throw new Error(`${label} has ${field} Claude subagents`)
    }
  }
}

function validateEmbeddedCodexReceipt(record, manifest, targetId, toolId, contract) {
  const label = `result ${targetId}/${toolId}`
  const proof = record.codexReceiptProof
  const usage = record.codexUsage
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) ||
      !usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new Error(`${label} is missing immutable Codex receipt proof or usage`)
  }
  assertSafeId(record.codexReceiptId, `${label} receipt id`)
  if (proof.receiptSha256 !== contract.codex.receiptSha256 || proof.sourceProvider !== 'anthropic' ||
      proof.judgeProvider !== contract.codex.provider || proof.judgeModel !== contract.codex.model ||
      proof.reasoningEffort !== contract.codex.reasoningEffort || proof.cliVersion !== contract.codex.cliVersion ||
      proof.candidateCount !== contract.candidateLedger.length ||
      JSON.stringify(canonical(proof.usage)) !== JSON.stringify(canonical(usage))) {
    throw new Error(`${label} Codex receipt proof does not match the v2 marker`)
  }
  const judge = normalizedCodexJudgeIdentity(manifest.codexJudge)
  if (judge.provider !== proof.judgeProvider || judge.model !== proof.judgeModel ||
      judge.reasoningEffort !== proof.reasoningEffort || judge.cliVersion !== proof.cliVersion ||
      judge.executableSha256 !== proof.executableSha256 || judge.schemaSha256 !== proof.schemaSha256) {
    throw new Error(`${label} Codex receipt proof does not match the cohort judge identity`)
  }
  return proof
}

function readAndValidateCodexReceipt(root, record, manifest, targetId, toolId, contract, options = {}) {
  const { validateReceipt, hashReceipt, normalizedReceiptProof, receiptSummary, receiptUsage } = reviewCodexContract()
  const proof = record.codexReceiptProof
  if (!options.requireExternalReceipt) return null
  const file = options.receiptPath || codexReceiptPath(root, manifest.runId, targetId, toolId, record.codexReceiptId)
  if (!fs.existsSync(file)) {
    throw new Error(`result ${targetId}/${toolId} Codex receipt is missing`)
  }
  const receipt = readJson(file)
  const target = manifest.targetMetadata[targetId]
  const expected = {
    target: {
      repository: target && target.fork,
      baseSha: manifest.targets[targetId].baseSha,
      headSha: manifest.targets[targetId].headSha,
    },
    pluginFingerprint: manifest.pluginFingerprint,
    model: manifest.codexJudge.model,
    reasoningEffort: manifest.codexJudge.reasoningEffort,
    cliVersion: manifest.codexJudge.cliVersion,
    executableSha256: manifest.codexJudge.executableSha256,
    ...(manifest.codexJudge.schemaSha256 ? { schemaSha256: manifest.codexJudge.schemaSha256 } : {}),
  }
  const validated = validateReceipt(receipt, expected) || receipt
  const summary = receiptSummary(validated)
  const markerSummary = {
    candidateLedger: contract.candidateLedger,
    newLeadResolutions: contract.newLeadResolutions,
    codex: contract.codex,
  }
  if (JSON.stringify(canonical(summary)) !== JSON.stringify(canonical(markerSummary))) {
    throw new Error(`result ${targetId}/${toolId} Codex receipt does not match the v2 marker`)
  }
  if (hashReceipt(validated) !== contract.codex.receiptSha256 ||
      JSON.stringify(canonical(normalizedReceiptProof(validated))) !== JSON.stringify(canonical(proof)) ||
      JSON.stringify(canonical(receiptUsage(validated))) !== JSON.stringify(canonical(record.codexUsage))) {
    throw new Error(`result ${targetId}/${toolId} Codex receipt proof or usage changed`)
  }
  return validated
}

function validateResultIdentity(record, manifest, targetId, toolId) {
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

function validateResultRecord(record, manifest, targetId, toolId, options = {}) {
  validateResultIdentity(record, manifest, targetId, toolId)
  validateClaudeResponse({ code: record.exitCode, signal: record.signal }, {
    is_error: record.isError,
    api_error_status: record.apiErrorStatus,
    result: record.result,
    total_cost_usd: record.reportedCostUsd,
    usage: record.reportedUsage,
    modelUsage: record.modelUsage,
  }, manifest.requestedModel, { allowEmptyResult: true })
  validateTranscriptUsage(record.transcriptUsage, manifest.requestedModel)
  const expectedContract = reviewAndFixPrContractForTool(manifest, toolId)
  if (expectedContract) {
    const parsedContract = parseReviewAndFixPrResultContract(record.result, expectedContract)
    if (JSON.stringify(canonical(record.resultContract)) !== JSON.stringify(parsedContract)) {
      throw new Error(`result ${targetId}/${toolId} structured contract does not match report marker`)
    }
    if ([REVIEW_AND_FIX_PR_CONTRACT_V2, REVIEW_AND_FIX_PR_CONTRACT_V3].includes(expectedContract)) {
      const tool = manifest.toolConfig && manifest.toolConfig.tools.find((entry) => entry.id === toolId)
      if (tool && tool.requiresDiscoveryLedger) {
        require('../../lib/review-discovery-ledger').validateDiscoveryLedger(
          record.discoveryLedger, parsedContract.candidateLedger,
          { schemaVersion: tool.discoveryLedgerSchemaVersion || 1 },
        )
      }
      if (tool && tool.requiresDiscoveryReceipts) {
        require('../../lib/review-discovery-receipts').validateDiscoveryReceipts(record.discoveryReceipts)
      }
      if (tool && tool.reviewProtocol === 'six-pass') {
        require('../../lib/review-fast-contract').validatePassReceipt(record.reviewPasses, {
          target: { repository: manifest.targetMetadata[targetId].fork,
            baseSha: manifest.targets[targetId].baseSha, headSha: manifest.targets[targetId].headSha },
          model: manifest.requestedModel, candidateLedger: parsedContract.candidateLedger,
        })
        if (record.subagentStats?.spawned !== 0 || record.transcriptUsage.sessions < 7) {
          throw new Error(`result ${targetId}/${toolId} six-pass execution did not stay isolated`)
        }
      } else validateV2ControllerStats(record, `result ${targetId}/${toolId}`)
      validateEmbeddedCodexReceipt(record, manifest, targetId, toolId, parsedContract)
      if (options.root) {
        readAndValidateCodexReceipt(options.root, record, manifest, targetId, toolId, parsedContract, options)
      } else if (options.requireExternalReceipt) {
        throw new Error(`result ${targetId}/${toolId} cannot validate Codex receipt without benchmark root`)
      }
    }
  }
  if (manifest.requestedModel === FABLE_MODEL) validateQuotaEvidence(record.quotaEvidence, `result ${targetId}/${toolId}`)
  return record
}

function readResultRecord(file, manifest, targetId, toolId, options = {}) {
  return validateResultRecord(readJson(file), manifest, targetId, toolId, options)
}

function listResultCells(root, manifest, options = {}) {
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
      const record = validateResultRecord(readJson(absolute), manifest, target, tool, { root, ...options })
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
  // Before completion, v2 receipts remain live sealing inputs and must still be present and
  // untampered. A completed snapshot is self-contained through its immutable result proof/hash.
  const actual = listResultCells(root, manifest, { requireExternalReceipt: !fs.existsSync(paths.complete) })
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
    const cells = listResultCells(root, manifest, { requireExternalReceipt: true })
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
  for (const field of ['title', 'file', 'claim']) {
    if (RESERVED_FINDING_TEXT.some((prefix) => finding[field].includes(prefix))) {
      throw new Error(`${label}.${field} contains reserved machine receipt text`)
    }
  }
  if (finding.selfRejected != null && typeof finding.selfRejected !== 'boolean') throw new Error(`${label}.selfRejected must be boolean`)
  if (finding.reviewDisposition != null && !['confirmed', 'suggestion'].includes(finding.reviewDisposition)) {
    throw new Error(`${label}.reviewDisposition is invalid`)
  }
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
  if (typeof record.sourceReportEmpty !== 'boolean') throw new Error(`finding sourceReportEmpty is invalid: ${cell.id}`)
  if (record.sourceReportEmpty) {
    if (record.findings.length || record.extractorRequestedModel !== null || record.extractorModelUsage !== null ||
        record.extractionSkippedReason !== 'empty-source-report') {
      throw new Error(`empty-source finding provenance is invalid: ${cell.id}`)
    }
    if (manifest.requestedModel === FABLE_MODEL && record.quotaEvidence !== null) {
      throw new Error(`empty-source finding quota evidence must be null: ${cell.id}`)
    }
  } else if (record.extractionSkippedReason === 'structured-codex-receipt') {
    if (reviewAndFixPrContractForTool(manifest, cell.tool) !== REVIEW_AND_FIX_PR_CONTRACT_V3 ||
        record.extractorRequestedModel !== null || record.extractorModelUsage !== null ||
        record.findings.some((finding) => !['confirmed', 'suggestion'].includes(finding.reviewDisposition))) {
      throw new Error(`structured receipt finding provenance is invalid: ${cell.id}`)
    }
  } else {
    if (record.extractorRequestedModel !== EVALUATOR_MODEL || record.extractionSkippedReason !== null) {
      throw new Error(`finding extractor model provenance is invalid: ${cell.id}`)
    }
    validateModelUsage(record.extractorModelUsage, EVALUATOR_MODEL, `finding extractor modelUsage for ${cell.id}`)
    if (manifest.requestedModel === FABLE_MODEL) validateQuotaEvidence(record.quotaEvidence, `finding ${cell.id}`)
  }
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
  if (!Number.isInteger(record.rawFindings) || record.rawFindings < 0) throw new Error(`judgement rawFindings is invalid: ${targetId}`)
  if (record.judgeRequestedModel !== EVALUATOR_MODEL) throw new Error(`judgement model provenance is invalid: ${targetId}`)
  if (!Number.isFinite(record.judgeCostUsd) || record.judgeCostUsd < 0) throw new Error(`judgement cost is invalid: ${targetId}`)
  validateModelUsage(record.judgeModelUsage, EVALUATOR_MODEL, `judgement modelUsage for ${targetId}`)
  if (manifest.requestedModel === FABLE_MODEL) validateQuotaEvidence(record.quotaEvidence, `judgement ${targetId}`)
  validateIssues(record.issues, cells)
  return record
}

function readJudgementRecord(file, manifest, targetId, cells) {
  return validateJudgementRecord(readJson(file), manifest, targetId, cells)
}

function validateComplete(complete, manifest, seal, findings, judgements, paid = null) {
  const schema = manifest.requestedModel === FABLE_MODEL ? 2 : 1
  if (!complete || complete.schemaVersion !== schema) throw new Error('invalid complete marker schema')
  assertRecordMetadata(complete, manifest, 'complete marker')
  if (typeof complete.createdAt !== 'string' || !complete.createdAt) throw new Error('complete marker createdAt is required')
  if (complete.manifestSha256 !== manifest.sha256) throw new Error('complete marker manifest hash mismatch')
  if (complete.sealSha256 !== seal.sha256) throw new Error('complete marker seal hash mismatch')
  if (JSON.stringify(complete.findings) !== JSON.stringify(findings)) throw new Error('complete marker finding hashes mismatch')
  if (JSON.stringify(complete.judgements) !== JSON.stringify(judgements)) throw new Error('complete marker judgement hashes mismatch')
  if (schema === 2) {
    if (JSON.stringify(complete.quota) !== JSON.stringify(paid.quota)) throw new Error('complete marker quota ledger hash mismatch')
    if (JSON.stringify(complete.probe) !== JSON.stringify(paid.probe)) throw new Error('complete marker probe hash mismatch')
  }
  return complete
}

function validateQuotaEvidence(evidence, label = 'quota evidence') {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.file !== 'quota.jsonl' ||
      !Number.isInteger(evidence.line) || evidence.line < 1 || !FILE_HASH.test(evidence.sha256 || '')) {
    throw new Error(`${label} quota evidence is invalid`)
  }
  return evidence
}

function parseQuotaLedger(file, runId) {
  assertExistingPathSafe(file)
  if (!fs.existsSync(file)) throw new Error(`cohort ${runId} is missing quota.jsonl`)
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe quota log: ${file}`)
  const raw = fs.readFileSync(file, 'utf8')
  if (!raw || !raw.endsWith('\n')) throw new Error(`cohort ${runId} quota ledger is empty or not newline terminated`)
  const lines = raw.slice(0, -1).split('\n')
  const records = lines.map((line, index) => {
    let record
    try { record = JSON.parse(line) } catch { throw new Error(`quota ledger line ${index + 1} is invalid JSON`) }
    if (JSON.stringify(record) !== line) throw new Error(`quota ledger line ${index + 1} is not canonical JSON`)
    if (!record || record.schemaVersion !== 1 || record.runId !== runId || !['preflight', 'final'].includes(record.kind)) {
      throw new Error(`quota ledger line ${index + 1} has invalid identity`)
    }
    if (typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp)) ||
        record.source !== 'claude-control-get_usage' || typeof record.claudeVersion !== 'string' || !record.claudeVersion ||
        !FILE_HASH.test(record.claudeExecutableSha256 || '')) {
      throw new Error(`quota ledger line ${index + 1} has invalid metadata`)
    }
    const labels = ['Current session', 'Current week (all models)', 'Current week (Fable)']
    const thresholdPolicies = [[50, 90, 90], [95, 95, 95]]
    const recordedThresholds = labels.map((name) => record.thresholds && record.thresholds[name])
    if (!thresholdPolicies.some((policy) => JSON.stringify(policy) === JSON.stringify(recordedThresholds))) {
      throw new Error(`quota ledger line ${index + 1} has unsupported thresholds`)
    }
    for (let offset = 0; offset < labels.length; offset += 1) {
      const name = labels[offset]
      const reset = record.resetsAt && record.resetsAt[name]
      const resetIsValid = (typeof reset === 'string' && Number.isFinite(Date.parse(reset))) ||
        (name === 'Current session' && record.usage && record.usage[name] === 0 && reset === null)
      if (!record.usage || typeof record.usage[name] !== 'number' || !Number.isFinite(record.usage[name]) ||
          record.usage[name] < 0 || record.usage[name] > 100 || !record.thresholds ||
          !record.resetsAt || !resetIsValid) {
        throw new Error(`quota ledger line ${index + 1} has invalid ${name} evidence`)
      }
    }
    for (const field of ['usage', 'thresholds', 'resetsAt']) {
      if (Object.keys(record[field]).sort().join('\n') !== [...labels].sort().join('\n')) {
        throw new Error(`quota ledger line ${index + 1} has unexpected ${field} labels`)
      }
    }
    const allowed = labels.every((name, offset) => record.usage[name] <= recordedThresholds[offset])
    if (record.allowed !== allowed) throw new Error(`quota ledger line ${index + 1} has inconsistent allowed decision`)
    if (record.kind === 'final') {
      if (record.nextCall !== null || record.stage !== null || record.target !== null || record.tool !== null) {
        throw new Error(`quota ledger line ${index + 1} has invalid final binding`)
      }
    }
    return { record, line, sha256: crypto.createHash('sha256').update(line).digest('hex') }
  })
  const finals = records.map(({ record }, index) => record.kind === 'final' ? index : -1).filter((index) => index >= 0)
  if (finals.length > 1 || (finals.length === 1 && finals[0] !== records.length - 1)) {
    throw new Error(`cohort ${runId} quota ledger must have at most one final record and it must be last`)
  }
  return { raw, records, finalLine: finals.length ? finals[0] + 1 : null }
}

function quotaBinding(stage, target = null, tool = null) {
  return {
    stage,
    target,
    tool,
    nextCall: stage === 'probe' ? 'probe' : `${stage}:${target}${tool ? `/${tool}` : ''}`,
  }
}

function claimQuotaEvidence(ledger, evidence, expected, manifest, claims, label) {
  validateQuotaEvidence(evidence, label)
  const row = ledger.records[evidence.line - 1]
  if (!row || row.sha256 !== evidence.sha256) throw new Error(`${label} quota evidence does not match quota.jsonl`)
  if (claims.has(evidence.line)) throw new Error(`${label} reuses quota evidence claimed by ${claims.get(evidence.line)}`)
  const record = row.record
  if (record.kind !== 'preflight' || record.allowed !== true || record.claudeVersion !== manifest.claudeVersion ||
      record.stage !== expected.stage || record.target !== expected.target || record.tool !== expected.tool ||
      record.nextCall !== expected.nextCall) {
    throw new Error(`${label} quota evidence has a denied or mismatched paid-call binding`)
  }
  if (claims.executableSha256 && claims.executableSha256 !== record.claudeExecutableSha256) {
    throw new Error(`${label} quota evidence uses a different Claude executable`)
  }
  claims.executableSha256 = record.claudeExecutableSha256
  claims.set(evidence.line, label)
}

function validateProbeRecord(record, manifest) {
  if (!record || record.schemaVersion !== 1 || manifest.requestedModel !== FABLE_MODEL ||
      record.canonicalModel !== FABLE_MODEL || record.reply !== 'OK' ||
      typeof record.probedAt !== 'string' || !record.probedAt || !Number.isFinite(record.reportedCostUsd) ||
      record.reportedCostUsd < 0) {
    throw new Error(`cohort ${manifest.runId} has invalid Fable probe evidence`)
  }
  assertRecordMetadata(record, manifest, 'probe')
  validateReportedUsage(record.reportedUsage, 'probe reported usage')
  validateModelUsage(record.modelUsage, FABLE_MODEL, 'probe modelUsage')
  validateQuotaEvidence(record.quotaEvidence, 'probe')
  return record
}

function readProbeRecord(root, manifest) {
  const paths = cohortPaths(root, manifest.runId)
  if (!fs.existsSync(paths.probe)) throw new Error(`cohort ${manifest.runId} is missing probe.json`)
  return validateProbeRecord(readJson(paths.probe), manifest)
}

function fablePaidInputs(root, manifest, seal, findings, judgements, options = {}) {
  if (manifest.requestedModel !== FABLE_MODEL) return null
  const paths = cohortPaths(root, manifest.runId)
  const ledger = parseQuotaLedger(paths.quota, manifest.runId)
  if (options.requireFinal && ledger.finalLine == null) return null
  const probe = readProbeRecord(root, manifest)
  const claims = new Map()
  claimQuotaEvidence(ledger, probe.quotaEvidence, quotaBinding('probe'), manifest, claims, 'probe')
  for (const cell of seal.cells) {
    const result = readResultRecord(resultFileForCell(root, manifest.runId, cell), manifest, cell.target, cell.tool)
    claimQuotaEvidence(ledger, result.quotaEvidence, quotaBinding('review', cell.target, cell.tool), manifest, claims, `result ${cell.id}`)
  }
  for (const entry of findings.records) {
    if (!entry.record.sourceReportEmpty) {
      claimQuotaEvidence(ledger, entry.record.quotaEvidence,
        quotaBinding('extract', entry.cell.target, entry.cell.tool), manifest, claims, `finding ${entry.cell.id}`)
    }
  }
  for (const entry of judgements.records) {
    claimQuotaEvidence(ledger, entry.record.quotaEvidence,
      quotaBinding('judge', entry.target), manifest, claims, `judgement ${entry.target}`)
  }
  for (let index = 0; index < ledger.records.length; index += 1) {
    const record = ledger.records[index].record
    if (record.kind === 'preflight' && record.allowed === true &&
        (record.claudeVersion !== manifest.claudeVersion ||
         record.claudeExecutableSha256 !== claims.executableSha256)) {
      throw new Error(`allowed quota preflight line ${index + 1} uses different Claude metadata`)
    }
  }
  if (ledger.finalLine != null) {
    const final = ledger.records[ledger.finalLine - 1].record
    if (final.claudeVersion !== manifest.claudeVersion || final.claudeExecutableSha256 !== claims.executableSha256) {
      throw new Error(`cohort ${manifest.runId} final quota snapshot uses different Claude metadata`)
    }
  }
  return {
    quota: {
      file: 'quota.jsonl', sha256: sha256File(paths.quota),
      records: ledger.records.length, finalLine: ledger.finalLine,
    },
    probe: { file: 'probe.json', sha256: sha256File(paths.probe) },
  }
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
  const findingRecords = []
  for (const cell of seal.cells) {
    const file = findingFileForCell(root, manifest.runId, cell)
    if (!fs.existsSync(file)) return null
    const record = validateFindingRecord(readJson(file), manifest, cell)
    findings.push({ file: `findings/${cell.target}/${cell.tool}.json`, sha256: sha256File(file) })
    findingRecords.push({ cell, record })
  }
  const paths = cohortPaths(root, manifest.runId)
  const actualFindings = relativeJsonFiles(paths.findings, 'findings', true)
  if (JSON.stringify(actualFindings) !== JSON.stringify(findings.map((entry) => entry.file).sort())) {
    throw new Error(`cohort ${manifest.runId} has unexpected finding artifacts`)
  }
  const judgements = []
  const judgementRecords = []
  const targets = [...new Set(seal.cells.map((cell) => cell.target))].sort()
  for (const target of targets) {
    const file = path.join(paths.judgement, `${target}.json`)
    if (!fs.existsSync(file)) return null
    const cells = seal.cells.filter((cell) => cell.target === target)
    const record = validateJudgementRecord(readJson(file), manifest, target, cells)
    judgements.push({ file: `judgement/${target}.json`, sha256: sha256File(file) })
    judgementRecords.push({ target, record })
  }
  const actualJudgements = relativeJsonFiles(paths.judgement, 'judgement', false)
  if (JSON.stringify(actualJudgements) !== JSON.stringify(judgements.map((entry) => entry.file).sort())) {
    throw new Error(`cohort ${manifest.runId} has unexpected judgement artifacts`)
  }
  return { findings, judgements, findingRecords, judgementRecords }
}

function readComplete(root, runId, targetIds = null) {
  const { manifest, seal } = readSeal(root, runId, targetIds)
  const paths = cohortPaths(root, runId)
  if (!fs.existsSync(paths.complete)) throw new Error(`cohort ${runId} is not complete`)
  const inputs = completionInputs(root, manifest, seal)
  if (!inputs) throw new Error(`cohort ${runId} complete marker has missing artifacts`)
  const paid = fablePaidInputs(root, manifest, seal, {
    records: inputs.findingRecords,
  }, {
    records: inputs.judgementRecords,
  }, { requireFinal: true })
  if (manifest.requestedModel === FABLE_MODEL && !paid) {
    throw new Error(`cohort ${runId} complete marker has no final quota snapshot`)
  }
  return {
    manifest,
    seal,
    complete: validateComplete(readJson(paths.complete), {
      ...manifest, sha256: sha256File(paths.manifest),
    }, {
      ...seal, sha256: sha256File(paths.seal),
    }, inputs.findings, inputs.judgements, paid),
  }
}

function ensureComplete(root, runId, targetIds = null) {
  const { manifest, seal } = readSeal(root, runId, targetIds)
  const inputs = completionInputs(root, manifest, seal)
  if (!inputs) return null
  const paths = cohortPaths(root, runId)
  const paid = fablePaidInputs(root, manifest, seal, {
    records: inputs.findingRecords,
  }, {
    records: inputs.judgementRecords,
  })
  if (manifest.requestedModel === FABLE_MODEL && paid.quota.finalLine == null) return null
  const complete = {
    schemaVersion: manifest.requestedModel === FABLE_MODEL ? 2 : 1,
    ...manifestMetadata(manifest),
    createdAt: new Date().toISOString(),
    manifestSha256: sha256File(paths.manifest),
    sealSha256: sha256File(paths.seal),
    findings: inputs.findings,
    judgements: inputs.judgements,
    ...(manifest.requestedModel === FABLE_MODEL ? { quota: paid.quota, probe: paid.probe } : {}),
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
  codexReceiptPath,
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
  normalizedCohortScope,
  normalizedCodexJudgeIdentity,
  normalizedPluginFingerprint,
  parseReviewAndFixPrResultContract,
  readManifest,
  readProbeRecord,
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
  reviewAndFixPrContractForTool,
  validateFindingRecord,
  validateFinding,
  validateIssues,
  validateJudgementRecord,
  validateManifest,
  validateClaudeResponse,
  validateModelUsage,
  validateProbeRecord,
  validateQuotaEvidence,
  validateReportedUsage,
  validateReviewAndFixPrContract,
  validateResultIdentity,
  validateResultRecord,
  validateSeal,
  validateTranscriptUsage,
  writeJsonExclusive,
  REVIEW_AND_FIX_PR_CONTRACT,
  REVIEW_AND_FIX_PR_CONTRACT_V1,
  REVIEW_AND_FIX_PR_CONTRACT_V2,
  REVIEW_AND_FIX_PR_CONTRACT_V3,
  REVIEW_AND_FIX_PR_MANDATORY_LENSES,
}
