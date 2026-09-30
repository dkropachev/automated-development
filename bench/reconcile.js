#!/usr/bin/env node
'use strict'

// Build and validate the versioned, hash-bound gold standard used for model comparison.
//
//   node bench/reconcile.js --phase proposal [--id model-comparison-2026-09-30]
//   node bench/reconcile.js --phase accept [--reviewer <name>]
//   node bench/reconcile.js --phase seal
//   node bench/reconcile.js --phase validate
//
// Proposal is the only phase that invokes Claude. Accept is an explicit review acknowledgement:
// operators may correct proposal/*.json in place, then promote those exact files to canonical/.
// Seal and validate are deterministic and never invoke a model.

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  assertSafeId,
  ensureDirectorySafe,
  readComplete,
  sha256File,
  validateClaudeResponse,
  writeJsonExclusive,
} = require('./lib/artifacts')
const { checkoutPrepared } = require('./run')

const ROOT = __dirname
const DEFAULT_ID = 'model-comparison-2026-09-30'
const RECONCILER_MODEL = 'claude-opus-5-5'
const RECONCILER_EFFORT = 'high'
const CLAUDE = process.env.CLAUDE || 'claude'
const HASH = /^[0-9a-f]{64}$/
const TARGETS = ['ironweave', 'quillstone', 'tidepool']
const VERDICTS = new Set(['real', 'false-positive', 'unproven'])
const SEVERITIES = new Set(['blocker', 'high', 'medium', 'low', 'nit'])
const KINDS = new Set(['bug', 'security', 'test-gap', 'style', 'docs', 'perf', 'design', 'question'])
const SCOPES = new Set(['in-scope', 'out-of-scope'])
const REVIEW_EFFORT = 'medium'

const DEFAULT_DECLARATION = Object.freeze({
  schemaVersion: 1,
  legacyRunId: 'legacy',
  modernRunIds: ['fable-5-1-2026-09-29', 'opus-5-5-2026-09-29'],
  targets: TARGETS,
  parkedCells: ['legacy/ironweave/tob-c-review'],
  salvagedCells: [
    'legacy/ironweave/anthropic-pr-review',
    'legacy/ironweave/ce-code-review',
  ],
  expectedPhysicalFindingFiles: 58,
  expectedEvidenceCells: 57,
  expectedEligibleClaims: 403,
  expectedAllModelsMatchedCells: 17,
  expectedCurrentPairMatchedCells: 19,
})

function readJson(file) {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe JSON path: ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function canonicalString(value) {
  return JSON.stringify(canonical(value))
}

function same(left, right) {
  return canonicalString(left) === canonicalString(right)
}

function relative(root, file) {
  const value = path.relative(root, file).split(path.sep).join('/')
  if (!value || value.startsWith('../') || path.isAbsolute(value)) throw new Error(`path escapes benchmark root: ${file}`)
  return value
}

function jsonFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const rows = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`refusing symlink in benchmark inputs: ${file}`)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && entry.name.endsWith('.json')) rows.push(file)
    }
  }
  visit(dir)
  return rows
}

function normalizedDeclaration(input = DEFAULT_DECLARATION) {
  const value = canonical(input)
  if (!value || value.schemaVersion !== 1) throw new Error('invalid reconciliation declaration')
  for (const id of [value.legacyRunId, ...value.modernRunIds, ...value.targets]) assertSafeId(id, 'declaration id')
  if (new Set(value.modernRunIds).size !== value.modernRunIds.length || value.modernRunIds.length !== 2) {
    throw new Error('declaration requires exactly two unique modern cohorts')
  }
  if (new Set(value.targets).size !== value.targets.length || !value.targets.length) throw new Error('declaration targets must be unique')
  for (const field of [
    'expectedPhysicalFindingFiles', 'expectedEvidenceCells', 'expectedEligibleClaims',
    'expectedAllModelsMatchedCells', 'expectedCurrentPairMatchedCells',
  ]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw new Error(`invalid declaration ${field}`)
  }
  for (const field of ['parkedCells', 'salvagedCells']) {
    if (!Array.isArray(value[field]) || new Set(value[field]).size !== value[field].length) {
      throw new Error(`invalid declaration ${field}`)
    }
  }
  return value
}

function findingIdentity(runId, target, tool) {
  return `${runId}/${target}/${tool}`
}

function fileIdentity(file, base) {
  const rel = path.relative(base, file).split(path.sep).join('/')
  const parts = rel.split('/')
  if (parts.length !== 2 || !parts[1].endsWith('.json')) throw new Error(`invalid finding path: ${file}`)
  const target = assertSafeId(parts[0], 'finding target')
  const tool = assertSafeId(parts[1].slice(0, -5), 'finding tool')
  return { target, tool }
}

function resultMetrics(record) {
  let costUsd = record.transcriptUsage && Number.isFinite(record.transcriptUsage.costUsd)
    ? record.transcriptUsage.costUsd
    : null
  if (costUsd == null && record.modelUsage && typeof record.modelUsage === 'object') {
    const costs = Object.values(record.modelUsage).map((usage) => usage && usage.costUSD)
    if (costs.length && costs.every((cost) => Number.isFinite(cost) && cost >= 0)) costUsd = costs.reduce((sum, cost) => sum + cost, 0)
  }
  if (costUsd == null && Number.isFinite(record.reportedCostUsd)) costUsd = record.reportedCostUsd
  return {
    costUsd,
    wallMs: Number.isFinite(record.wallMs) && record.wallMs >= 0 ? record.wallMs : null,
    success: record.exitCode === 0 && record.isError !== true,
  }
}

function validateFindingShape(record, identity) {
  if (!record || record.target !== identity.target || record.tool !== identity.tool || !Array.isArray(record.findings)) {
    throw new Error(`finding identity does not match path: ${identity.target}/${identity.tool}`)
  }
  for (const [index, finding] of record.findings.entries()) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      throw new Error(`invalid finding ${identity.target}/${identity.tool}#${index}`)
    }
  }
}

function sourceCell(root, details) {
  const findingRecord = readJson(details.findingFile)
  const resultRecord = readJson(details.resultFile)
  validateFindingShape(findingRecord, details)
  if (resultRecord.target !== details.target || resultRecord.tool !== details.tool) {
    throw new Error(`result identity does not match path: ${details.target}/${details.tool}`)
  }
  const id = findingIdentity(details.runId, details.target, details.tool)
  if (findingRecord.cellId != null && findingRecord.cellId !== id) throw new Error(`finding cellId mismatch: ${id}`)
  if (resultRecord.cellId != null && resultRecord.cellId !== id) throw new Error(`result cellId mismatch: ${id}`)
  const eligible = []
  const excluded = []
  findingRecord.findings.forEach((finding, findingIndex) => {
    const entry = { cellId: id, findingIndex, finding: canonical(finding) }
    if (finding.selfRejected === true) excluded.push(entry)
    else eligible.push(entry)
  })
  const salvaged = details.salvaged
  if (Boolean(resultRecord.salvaged) !== salvaged && details.runId === 'legacy') {
    throw new Error(`legacy salvage declaration mismatch: ${id}`)
  }
  const creditEligible = !salvaged && resultMetrics(resultRecord).success
  return {
    cell: {
      id,
      runId: details.runId,
      target: details.target,
      tool: details.tool,
      modelId: details.modelId,
      historical: details.historical,
      inferredPins: details.inferredPins,
      salvaged,
      discoveryOnly: salvaged,
      creditEligible,
      complete: details.complete,
      ...resultMetrics(resultRecord),
      result: { file: relative(root, details.resultFile), sha256: sha256File(details.resultFile) },
      findings: {
        file: relative(root, details.findingFile),
        sha256: sha256File(details.findingFile),
        totalCount: findingRecord.findings.length,
        eligibleCount: eligible.length,
        selfRejectedCount: excluded.length,
      },
    },
    eligible,
    excluded,
  }
}

function coordinateKey(value) {
  return `${value.target}/${value.tool}`
}

function scopeRecord(id, label, runIds, cells, coordinates) {
  const byId = new Map(cells.map((cell) => [cell.id, cell]))
  const matchedCells = coordinates.map((coordinate) => ({
    id: `${coordinate.target}/${coordinate.tool}`,
    targetId: coordinate.target,
    toolId: coordinate.tool,
    sourceCellIds: runIds.map((runId) => findingIdentity(runId, coordinate.target, coordinate.tool)).filter((cellId) => byId.has(cellId)),
  }))
  return {
    id,
    label,
    runIds,
    modelIds: runIds.map((runId) => {
      const cell = cells.find((candidate) => candidate.runId === runId)
      return cell && cell.modelId
    }).filter(Boolean),
    matchedCellCount: coordinates.length,
    matchedCells,
    coordinates: coordinates.map((coordinate) => ({
      target: coordinate.target,
      tool: coordinate.tool,
      cellIds: runIds.map((runId) => findingIdentity(runId, coordinate.target, coordinate.tool)).filter((cellId) => byId.has(cellId)),
    })),
  }
}

function makeScopes(declaration, cohorts, cells) {
  const coordinatesForRun = new Map(cohorts.map((cohort) => [
    cohort.runId,
    new Set(cells.filter((cell) => cell.runId === cohort.runId && cell.complete).map(coordinateKey)),
  ]))
  const coordinate = (key) => {
    const [target, tool] = key.split('/')
    return { target, tool }
  }
  const pairRuns = declaration.modernRunIds
  const pairKeys = [...coordinatesForRun.get(pairRuns[0])].filter((key) => coordinatesForRun.get(pairRuns[1]).has(key)).sort()
  const allRuns = [declaration.legacyRunId, ...pairRuns]
  const allKeys = pairKeys.filter((key) => allRuns.every((runId) => {
    const cell = cells.find((candidate) => candidate.id === `${runId}/${key}`)
    return cell && cell.complete && !cell.salvaged
  }))
  if (pairKeys.length !== declaration.expectedCurrentPairMatchedCells) {
    throw new Error(`current controlled pair must contain ${declaration.expectedCurrentPairMatchedCells} matched cells, found ${pairKeys.length}`)
  }
  if (allKeys.length !== declaration.expectedAllModelsMatchedCells) {
    throw new Error(`all-model scope must contain ${declaration.expectedAllModelsMatchedCells} matched cells, found ${allKeys.length}`)
  }
  return [
    scopeRecord('all-models', `All models · ${allKeys.length} matched cells`, allRuns, cells, allKeys.map(coordinate)),
    scopeRecord('controlled-pair', `Current controlled pair · ${pairKeys.length} matched cells`, pairRuns, cells, pairKeys.map(coordinate)),
  ]
}

function controlledCoordinates(manifest) {
  return (manifest.expectedCells || []).map((cell) => `${cell.target}/${cell.tool}`).sort()
}

function assertControlledCompatibility(left, right) {
  for (const [label, leftValue, rightValue] of [
    ['target pins', left.manifest.targets, right.manifest.targets],
    ['target metadata', left.manifest.targetMetadata, right.manifest.targetMetadata],
    ['ground truth', left.manifest.groundtruth, right.manifest.groundtruth],
    ['tool configuration', left.manifest.toolConfig, right.manifest.toolConfig],
    ['cell matrix', controlledCoordinates(left.manifest), controlledCoordinates(right.manifest)],
  ]) {
    if (!same(leftValue, rightValue)) throw new Error(`modern cohort ${label} are incompatible`)
  }
  if (left.manifest.configSha256 !== right.manifest.configSha256) throw new Error('modern cohort config hashes are incompatible')
  if (left.manifest.claudeVersion !== right.manifest.claudeVersion) throw new Error('modern cohort Claude versions are incompatible')
}

function buildSourceSnapshot(root = ROOT, options = {}) {
  const declaration = normalizedDeclaration(options.declaration || DEFAULT_DECLARATION)
  const modern = declaration.modernRunIds.map((runId) => readComplete(root, runId, declaration.targets))
  const [first, second] = modern
  assertControlledCompatibility(first, second)
  const pins = canonical(first.manifest.targets)
  const targetMetadata = canonical(first.manifest.targetMetadata)
  const cohorts = [{
    runId: declaration.legacyRunId,
    modelId: 'claude-opus-5',
    modelLabel: 'Claude Opus 5',
    requestedModel: null,
    provenance: 'historical-inferred',
    controlled: false,
    pins,
    pinsInferred: true,
    manifest: null,
    complete: null,
    reviewEffort: null,
  }]
  for (const completed of modern) {
    const paths = path.join(root, 'runs', completed.manifest.runId)
    cohorts.push({
      runId: completed.manifest.runId,
      modelId: completed.manifest.requestedModel,
      modelLabel: completed.manifest.modelLabel,
      requestedModel: completed.manifest.requestedModel,
      provenance: 'controlled-recorded',
      controlled: true,
      reviewEffort: REVIEW_EFFORT,
      pins: canonical(completed.manifest.targets),
      pinsInferred: false,
      manifest: { file: relative(root, path.join(paths, 'manifest.json')), sha256: sha256File(path.join(paths, 'manifest.json')) },
      complete: { file: relative(root, path.join(paths, 'complete.json')), sha256: sha256File(path.join(paths, 'complete.json')) },
    })
  }

  const cells = []
  const excludedSources = []
  const eligible = []
  const excluded = []
  let physicalFindingFiles = 0
  const parked = new Set(declaration.parkedCells)
  const salvaged = new Set(declaration.salvagedCells)

  const legacyFindingRoot = path.join(root, 'findings')
  const legacyFiles = jsonFiles(legacyFindingRoot)
  physicalFindingFiles += legacyFiles.length
  const modernCoordinates = new Set(first.seal.cells.map(coordinateKey))
  const allowedLegacy = new Set([...modernCoordinates].map((key) => `${declaration.legacyRunId}/${key}`).concat(declaration.parkedCells))
  for (const findingFile of legacyFiles) {
    const identity = fileIdentity(findingFile, legacyFindingRoot)
    const id = findingIdentity(declaration.legacyRunId, identity.target, identity.tool)
    if (!allowedLegacy.has(id)) throw new Error(`undeclared historical finding cell: ${id}`)
    const resultFile = path.join(root, 'results', identity.target, `${identity.tool}.json`)
    if (!fs.existsSync(resultFile)) throw new Error(`missing legacy result: ${id}`)
    const source = sourceCell(root, {
      ...identity,
      runId: declaration.legacyRunId,
      modelId: 'claude-opus-5',
      historical: true,
      inferredPins: true,
      salvaged: salvaged.has(id),
      complete: !parked.has(id),
      findingFile,
      resultFile,
    })
    if (parked.has(id)) {
      excludedSources.push({ ...source.cell, excludedReason: 'parked-dnf' })
      continue
    }
    cells.push(source.cell)
    eligible.push(...source.eligible)
    excluded.push(...source.excluded)
  }
  for (const expected of parked) {
    if (!legacyFiles.some((file) => {
      const identity = fileIdentity(file, legacyFindingRoot)
      return findingIdentity(declaration.legacyRunId, identity.target, identity.tool) === expected
    })) throw new Error(`declared parked cell is missing: ${expected}`)
  }
  for (const expected of salvaged) {
    if (!cells.some((cell) => cell.id === expected && cell.salvaged)) throw new Error(`declared salvaged cell is missing: ${expected}`)
  }

  for (const completed of modern) {
    const runId = completed.manifest.runId
    const cohortRoot = path.join(root, 'runs', runId)
    physicalFindingFiles += jsonFiles(path.join(cohortRoot, 'findings')).length
    for (const sealedCell of completed.seal.cells) {
      const findingFile = path.join(cohortRoot, 'findings', sealedCell.target, `${sealedCell.tool}.json`)
      const resultFile = path.join(cohortRoot, sealedCell.file)
      const source = sourceCell(root, {
        target: sealedCell.target,
        tool: sealedCell.tool,
        runId,
        modelId: completed.manifest.requestedModel,
        historical: false,
        inferredPins: false,
        salvaged: false,
        complete: true,
        findingFile,
        resultFile,
      })
      cells.push(source.cell)
      eligible.push(...source.eligible)
      excluded.push(...source.excluded)
    }
  }
  cells.sort((left, right) => left.id.localeCompare(right.id))
  eligible.sort((left, right) => left.cellId.localeCompare(right.cellId) || left.findingIndex - right.findingIndex)
  excluded.sort((left, right) => left.cellId.localeCompare(right.cellId) || left.findingIndex - right.findingIndex)
  if (physicalFindingFiles !== declaration.expectedPhysicalFindingFiles) {
    throw new Error(`expected ${declaration.expectedPhysicalFindingFiles} physical finding files, found ${physicalFindingFiles}`)
  }
  if (cells.length !== declaration.expectedEvidenceCells) {
    throw new Error(`expected ${declaration.expectedEvidenceCells} evidence cells, found ${cells.length}`)
  }
  if (eligible.length !== declaration.expectedEligibleClaims) {
    throw new Error(`expected ${declaration.expectedEligibleClaims} eligible claims, found ${eligible.length}`)
  }
  const scopes = makeScopes(declaration, cohorts, cells)
  return { declaration, pins, targetMetadata, cohorts, cells, excludedSources, eligible, excluded, scopes }
}

function makeSourceManifest(root, id, snapshot, options = {}) {
  assertSafeId(id, 'comparison id')
  return {
    schemaVersion: 1,
    id,
    generatedAt: options.generatedAt || new Date().toISOString(),
    issueUrl: options.issueUrl || null,
    declaration: snapshot.declaration,
    targets: Object.fromEntries(snapshot.declaration.targets.map((target) => [target, {
      ...snapshot.pins[target],
      language: snapshot.targetMetadata[target].language,
    }])),
    cohorts: snapshot.cohorts,
    sources: snapshot.cells,
    excludedSources: snapshot.excludedSources,
    counts: {
      physicalFindingFiles: snapshot.declaration.expectedPhysicalFindingFiles,
      evidenceCells: snapshot.cells.length,
      eligibleClaims: snapshot.eligible.length,
      selfRejectedClaims: snapshot.excluded.length,
    },
    scopes: snapshot.scopes,
    provenance: {
      canonicalPinsFrom: snapshot.declaration.modernRunIds,
      legacyPins: 'inferred-compatible',
      selfRejectedPolicy: 'excluded',
      salvagedPolicy: 'discovery-only-no-detection-credit',
      deletedHistoricalCells: 'excluded-not-reconstructed',
    },
  }
}

function validateSourceManifestAgainstRoot(root, manifest) {
  if (!manifest || manifest.schemaVersion !== 1) throw new Error('invalid source manifest schema')
  assertSafeId(manifest.id, 'comparison id')
  if (manifest.id === DEFAULT_ID && !same(manifest.declaration, DEFAULT_DECLARATION)) {
    throw new Error('published comparison declaration was changed')
  }
  const snapshot = buildSourceSnapshot(root, { declaration: manifest.declaration })
  const expected = makeSourceManifest(root, manifest.id, snapshot, {
    generatedAt: manifest.generatedAt,
    issueUrl: manifest.issueUrl,
  })
  if (!same(manifest, expected)) throw new Error('source manifest differs from current source hashes, pins, or scope')
  return snapshot
}

function goldPaths(root, id) {
  assertSafeId(id, 'comparison id')
  const dir = path.join(root, 'gold', id)
  return {
    dir,
    sourceManifest: path.join(dir, 'source-manifest.json'),
    proposal: path.join(dir, 'proposal'),
    canonical: path.join(dir, 'canonical'),
    complete: path.join(dir, 'complete.json'),
    index: path.join(root, 'gold', 'index.json'),
  }
}

function targetEvidence(snapshot, target) {
  return snapshot.eligible.filter((entry) => {
    const cell = snapshot.cells.find((candidate) => candidate.id === entry.cellId)
    return cell && cell.target === target
  })
}

function targetSchema(target) {
  return `{
  "schemaVersion": 1,
  "target": "${target}",
  "baseSha": "<pinned base sha>",
  "headSha": "<pinned head sha>",
  "sourceManifestSha256": "<sha256>",
  "reviewed": false,
  "reconciler": {"requestedModel":"${RECONCILER_MODEL}","effort":"${RECONCILER_EFFORT}"},
  "issues": [{"id":"${target}-I001","title":"...","file":"...","line":0,"kind":"bug","severity":"high","verdict":"real","verdictReason":"...","introducedByPr":true,"scope":"in-scope","scopeReason":"..."}],
  "mappings": [{"cellId":"run/target/tool","findingIndex":0,"issueIds":["${target}-I001"]}]
}`
}

function reconciliationPrompt(target, pins, manifestHash, evidence) {
  return `You are producing the canonical gold standard for a model-comparison benchmark. The repository is checked out at the exact pinned head; inspect git diff ${pins.baseSha}...${pins.headSha} and the surrounding code.

Reconcile every eligible raw claim below. Merge semantic duplicates, split a composite raw claim across multiple canonical issues when necessary, and independently verify each claim in code. Keep real, false-positive, and unproven issues. Normalize title, location, kind, severity, scope, and verdict. Do not seed or invent an issue from a self-rejected claim; those claims were removed before this prompt.

Every input tuple {cellId,findingIndex} MUST occur exactly once in mappings. Every mapping has one or more unique issueIds. A composite claim may map once to multiple issueIds. Do not duplicate a tuple. Every issue needs at least one mapped tuple. IDs must be exactly ${target}-I001, ${target}-I002, ... in issue order. Sort mappings by cellId, then findingIndex. Write only JSON to ./reconciliation.json with this shape:

${targetSchema(target)}

Use baseSha ${pins.baseSha}, headSha ${pins.headSha}, and sourceManifestSha256 ${manifestHash}. Leave reviewed false. RAW ELIGIBLE CLAIMS:
${JSON.stringify(evidence, null, 1)}
`
}

function reconcilerArgs(prompt) {
  return [
    '-p', prompt,
    '--output-format', 'json',
    '--model', RECONCILER_MODEL,
    '--effort', RECONCILER_EFFORT,
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'WebSearch', 'WebFetch',
  ]
}

function defaultReconcileTarget(context, dependencies = {}) {
  const prepare = dependencies.checkoutPrepared || checkoutPrepared
  const run = dependencies.spawnSync || spawnSync
  const target = context.snapshot.targetMetadata[context.target]
  const checkout = prepare(context.root, target, { id: '_gold-reconcile' }, context.id, context.pins)
  const output = path.join(checkout.repo, 'reconciliation.json')
  if (fs.existsSync(output)) throw new Error(`reconciler workspace is not fresh: ${output}`)
  const result = run(CLAUDE, reconcilerArgs(reconciliationPrompt(
    context.target, context.pins, context.sourceManifestSha256, context.evidence,
  )), { cwd: checkout.repo, encoding: 'utf8', maxBuffer: 1 << 28 })
  let meta
  try { meta = JSON.parse(result.stdout) } catch (error) {
    throw new Error(`invalid reconciler response for ${context.target}: ${error.message}`, { cause: error })
  }
  validateClaudeResponse(result, meta, RECONCILER_MODEL)
  if (!fs.existsSync(output)) throw new Error(`reconciler produced no reconciliation.json for ${context.target}`)
  return {
    ...readJson(output),
    reconciler: {
      requestedModel: RECONCILER_MODEL,
      effort: RECONCILER_EFFORT,
      costUsd: meta.total_cost_usd,
      modelUsage: meta.modelUsage,
      workspace: checkout.workspace,
      reconciledAt: new Date().toISOString(),
    },
  }
}

function tupleKey(mapping) {
  return `${mapping.cellId}#${mapping.findingIndex}`
}

function validateIssue(issue, target, index) {
  const expectedId = `${target}-I${String(index + 1).padStart(3, '0')}`
  if (!issue || issue.id !== expectedId) throw new Error(`unstable canonical issue id/order: expected ${expectedId}`)
  for (const field of ['title', 'file', 'verdictReason', 'scopeReason']) {
    if (typeof issue[field] !== 'string' || (field !== 'file' && !issue[field].trim())) {
      throw new Error(`canonical issue ${issue.id} has invalid ${field}`)
    }
  }
  if (!Number.isSafeInteger(issue.line) || issue.line < 0) throw new Error(`canonical issue ${issue.id} has invalid line`)
  if (!KINDS.has(issue.kind)) throw new Error(`canonical issue ${issue.id} has invalid kind`)
  if (!SEVERITIES.has(issue.severity)) throw new Error(`canonical issue ${issue.id} has invalid severity`)
  if (!VERDICTS.has(issue.verdict)) throw new Error(`canonical issue ${issue.id} has invalid verdict`)
  if (!SCOPES.has(issue.scope)) throw new Error(`canonical issue ${issue.id} has invalid scope`)
  if (typeof issue.introducedByPr !== 'boolean') throw new Error(`canonical issue ${issue.id} has invalid introducedByPr`)
}

function validateReconciler(record, target) {
  if (!record || record.requestedModel !== RECONCILER_MODEL || record.effort !== RECONCILER_EFFORT) {
    throw new Error(`canonical target ${target} was not reconciled by ${RECONCILER_MODEL} at ${RECONCILER_EFFORT} effort`)
  }
  if (!Number.isFinite(record.costUsd) || record.costUsd < 0) throw new Error(`canonical target ${target} has invalid reconciler cost`)
  if (typeof record.workspace !== 'string' || !record.workspace || record.workspace.split('/').includes('..')) {
    throw new Error(`canonical target ${target} has invalid reconciler workspace`)
  }
  if (typeof record.reconciledAt !== 'string' || !Number.isFinite(Date.parse(record.reconciledAt))) {
    throw new Error(`canonical target ${target} has invalid reconciler timestamp`)
  }
  const usage = record.modelUsage && record.modelUsage[RECONCILER_MODEL]
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error(`canonical target ${target} has no requested-model usage`)
  const tokenFields = ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']
  if (!tokenFields.every((field) => Number.isFinite(usage[field]) && usage[field] >= 0) ||
      !tokenFields.some((field) => usage[field] > 0) || !Number.isFinite(usage.costUSD) || usage.costUSD < 0) {
    throw new Error(`canonical target ${target} has invalid requested-model usage`)
  }
  if (usage.canonicalModel != null && usage.canonicalModel !== RECONCILER_MODEL) {
    throw new Error(`canonical target ${target} reconciler canonical model mismatch`)
  }
}

function validateTargetArtifact(artifact, context, options = {}) {
  const { target, pins, sourceManifestSha256, evidence, sourceCells } = context
  if (!artifact || artifact.schemaVersion !== 1 || artifact.target !== target) throw new Error(`invalid canonical target artifact: ${target}`)
  if (artifact.baseSha !== pins.baseSha || artifact.headSha !== pins.headSha) throw new Error(`canonical target pin drift: ${target}`)
  if (artifact.sourceManifestSha256 !== sourceManifestSha256) throw new Error(`canonical source manifest hash drift: ${target}`)
  validateReconciler(artifact.reconciler, target)
  if (options.requireReviewed && artifact.reviewed !== true) throw new Error(`canonical target has not been reviewed: ${target}`)
  if (!Array.isArray(artifact.issues) || !Array.isArray(artifact.mappings)) throw new Error(`canonical target arrays are missing: ${target}`)
  artifact.issues.forEach((issue, index) => validateIssue(issue, target, index))
  const issueIds = new Set(artifact.issues.map((issue) => issue.id))
  const supported = new Set()
  const expected = new Map(evidence.map((entry) => [tupleKey(entry), entry]))
  const seen = new Set()
  let previous = null
  const cellById = new Map(sourceCells.map((cell) => [cell.id, cell]))
  for (const mapping of artifact.mappings) {
    if (!mapping || typeof mapping.cellId !== 'string' || !Number.isSafeInteger(mapping.findingIndex) || mapping.findingIndex < 0) {
      throw new Error(`invalid source mapping in ${target}`)
    }
    const key = tupleKey(mapping)
    if (previous != null && previous.localeCompare(key, 'en', { numeric: true }) >= 0) {
      throw new Error(`source mappings are not in stable cell/index order: ${target}`)
    }
    previous = key
    if (seen.has(key)) throw new Error(`duplicate source mapping: ${key}`)
    seen.add(key)
    if (!expected.has(key)) throw new Error(`mapping references excluded, missing, or cross-target finding: ${key}`)
    const cell = cellById.get(mapping.cellId)
    if (!cell || cell.target !== target) throw new Error(`cross-target source mapping: ${key}`)
    if (!Array.isArray(mapping.issueIds) || !mapping.issueIds.length || new Set(mapping.issueIds).size !== mapping.issueIds.length) {
      throw new Error(`mapping ${key} must have nonempty unique issueIds`)
    }
    const sorted = [...mapping.issueIds].sort()
    if (!same(mapping.issueIds, sorted)) throw new Error(`mapping ${key} issueIds are not sorted`)
    for (const issueId of mapping.issueIds) {
      if (!issueIds.has(issueId)) throw new Error(`mapping ${key} references missing or cross-target issue ${issueId}`)
      supported.add(issueId)
    }
  }
  const missing = [...expected.keys()].filter((key) => !seen.has(key))
  if (missing.length) throw new Error(`incomplete source coverage for ${target}: ${missing[0]}`)
  for (const issueId of issueIds) {
    if (!supported.has(issueId)) throw new Error(`canonical issue has no eligible source evidence: ${issueId}`)
  }
  return artifact
}

function ensureSourceManifest(root, id, options = {}) {
  const paths = goldPaths(root, id)
  if (fs.existsSync(paths.complete)) throw new Error(`comparison ${id} is sealed and immutable`)
  if (fs.existsSync(paths.sourceManifest)) {
    const manifest = readJson(paths.sourceManifest)
    validateSourceManifestAgainstRoot(root, manifest)
    if (options.issueUrl && manifest.issueUrl !== options.issueUrl) throw new Error('existing source manifest issueUrl differs')
    return { paths, manifest, snapshot: buildSourceSnapshot(root, { declaration: manifest.declaration }) }
  }
  const snapshot = buildSourceSnapshot(root, options)
  const manifest = makeSourceManifest(root, id, snapshot, options)
  writeJsonExclusive(paths.sourceManifest, manifest)
  return { paths, manifest, snapshot }
}

async function propose(root = ROOT, options = {}, dependencies = {}) {
  const id = options.id || DEFAULT_ID
  const { paths, manifest, snapshot } = ensureSourceManifest(root, id, options)
  const manifestHash = sha256File(paths.sourceManifest)
  const reconcile = dependencies.reconcileTarget || ((context) => defaultReconcileTarget(context, dependencies))
  ensureDirectorySafe(paths.proposal)
  for (const target of snapshot.declaration.targets) {
    const output = path.join(paths.proposal, `${target}.json`)
    const context = {
      root, id, target, pins: snapshot.pins[target], snapshot,
      sourceManifestSha256: manifestHash,
      evidence: targetEvidence(snapshot, target),
      sourceCells: snapshot.cells,
    }
    if (fs.existsSync(output)) {
      validateTargetArtifact(readJson(output), context)
      continue
    }
    const artifact = await reconcile(context)
    validateTargetArtifact(artifact, context)
    writeJsonExclusive(output, artifact)
  }
  return { id, manifest, proposals: snapshot.declaration.targets.map((target) => path.join(paths.proposal, `${target}.json`)) }
}

function accept(root = ROOT, options = {}) {
  const id = options.id || DEFAULT_ID
  const { paths, manifest, snapshot } = ensureSourceManifest(root, id, options)
  const sourceManifestSha256 = sha256File(paths.sourceManifest)
  const expectedFiles = new Set(snapshot.declaration.targets.map((target) => `${target}.json`))
  const existingFiles = fs.existsSync(paths.canonical) ? fs.readdirSync(paths.canonical).sort() : []
  if (existingFiles.some((file) => !expectedFiles.has(file) || !fs.lstatSync(path.join(paths.canonical, file)).isFile())) {
    throw new Error('canonical directory contains an undeclared entry')
  }
  let review = null
  for (const file of existingFiles) {
    const artifact = readJson(path.join(paths.canonical, file))
    if (!artifact.review || typeof artifact.review.reviewer !== 'string' || typeof artifact.review.reviewedAt !== 'string') {
      throw new Error(`existing canonical target has invalid review metadata: ${file}`)
    }
    if (review && !same(review, artifact.review)) throw new Error('existing canonical targets have inconsistent review metadata')
    review = artifact.review
  }
  if (review && options.reviewer && review.reviewer !== options.reviewer) throw new Error('existing review uses a different reviewer')
  if (review && options.reviewedAt && review.reviewedAt !== options.reviewedAt) throw new Error('existing review uses a different timestamp')
  review ||= {
    reviewer: options.reviewer || 'manual-review',
    reviewedAt: options.reviewedAt || new Date().toISOString(),
  }
  const candidates = []
  for (const target of snapshot.declaration.targets) {
    const input = path.join(paths.proposal, `${target}.json`)
    const output = path.join(paths.canonical, `${target}.json`)
    if (!fs.existsSync(input)) throw new Error(`missing proposal for review: ${target}`)
    const context = {
      target, pins: snapshot.pins[target], sourceManifestSha256,
      evidence: targetEvidence(snapshot, target), sourceCells: snapshot.cells,
    }
    const proposal = readJson(input)
    validateTargetArtifact(proposal, context)
    const canonicalArtifact = { ...proposal, reviewed: true, review }
    validateTargetArtifact(canonicalArtifact, context, { requireReviewed: true })
    candidates.push({ target, output, canonicalArtifact })
  }
  for (const { target, output, canonicalArtifact } of candidates) {
    if (fs.existsSync(output) && !same(readJson(output), canonicalArtifact)) {
      throw new Error(`canonical target already exists with different content: ${target}`)
    }
  }
  ensureDirectorySafe(paths.canonical)
  for (const { output, canonicalArtifact } of candidates) {
    if (!fs.existsSync(output)) writeJsonExclusive(output, canonicalArtifact)
  }
  return { id, manifest }
}

function validateCanonicalSet(root, id, manifest, snapshot, options = {}) {
  const paths = goldPaths(root, id)
  const sourceManifestSha256 = sha256File(paths.sourceManifest)
  const expectedFiles = snapshot.declaration.targets.map((target) => `${target}.json`).sort()
  const actualFiles = fs.existsSync(paths.canonical) ? fs.readdirSync(paths.canonical).sort() : []
  if (!same(actualFiles, expectedFiles)) throw new Error('canonical target files do not match declared targets')
  if (actualFiles.some((file) => !fs.lstatSync(path.join(paths.canonical, file)).isFile())) {
    throw new Error('canonical target directory contains a non-file entry')
  }
  const artifacts = []
  for (const target of snapshot.declaration.targets) {
    const file = path.join(paths.canonical, `${target}.json`)
    const artifact = readJson(file)
    validateTargetArtifact(artifact, {
      target, pins: snapshot.pins[target], sourceManifestSha256,
      evidence: targetEvidence(snapshot, target), sourceCells: snapshot.cells,
    }, { requireReviewed: true })
    artifacts.push({ target, file, artifact, sha256: sha256File(file) })
  }
  const ids = artifacts.flatMap(({ artifact }) => artifact.issues.map((issue) => issue.id))
  if (new Set(ids).size !== ids.length) throw new Error('canonical issue IDs are not globally unique')
  if (options.complete) {
    const expectedTargets = artifacts.map(({ target, file, sha256 }) => ({
      target, file: relative(paths.dir, file), sha256,
    }))
    if (!same(options.complete.targets, expectedTargets)) throw new Error('completion marker canonical target hashes changed')
  }
  return artifacts
}

function validateProposalSet(root, id, snapshot, canonicalArtifacts, options = {}) {
  const paths = goldPaths(root, id)
  const sourceManifestSha256 = sha256File(paths.sourceManifest)
  const expectedFiles = snapshot.declaration.targets.map((target) => `${target}.json`).sort()
  const actualFiles = fs.existsSync(paths.proposal) ? fs.readdirSync(paths.proposal).sort() : []
  if (!same(actualFiles, expectedFiles)) throw new Error('proposal target files do not match declared targets')
  if (actualFiles.some((file) => !fs.lstatSync(path.join(paths.proposal, file)).isFile())) {
    throw new Error('proposal target directory contains a non-file entry')
  }
  const proposals = []
  for (const { target, artifact: canonicalArtifact } of canonicalArtifacts) {
    const file = path.join(paths.proposal, `${target}.json`)
    const artifact = readJson(file)
    validateTargetArtifact(artifact, {
      target, pins: snapshot.pins[target], sourceManifestSha256,
      evidence: targetEvidence(snapshot, target), sourceCells: snapshot.cells,
    })
    const promoted = { ...artifact, reviewed: true, review: canonicalArtifact.review }
    if (!same(promoted, canonicalArtifact)) throw new Error(`canonical target differs from reviewed proposal: ${target}`)
    proposals.push({ target, file, sha256: sha256File(file) })
  }
  if (options.complete) {
    const expected = proposals.map(({ target, file, sha256 }) => ({
      target, file: relative(paths.dir, file), sha256,
    }))
    if (!same(options.complete.proposals, expected)) throw new Error('completion marker proposal hashes changed')
  }
  return proposals
}

function seal(root = ROOT, options = {}) {
  const id = options.id || DEFAULT_ID
  const paths = goldPaths(root, id)
  if (fs.existsSync(paths.complete)) throw new Error(`comparison ${id} is already sealed; refusing post-seal mutation`)
  if (!fs.existsSync(paths.sourceManifest)) throw new Error(`source manifest not found: ${id}`)
  const manifest = readJson(paths.sourceManifest)
  if (manifest.id !== id) throw new Error('source manifest comparison id mismatch')
  const snapshot = validateSourceManifestAgainstRoot(root, manifest)
  const artifacts = validateCanonicalSet(root, id, manifest, snapshot)
  const proposals = validateProposalSet(root, id, snapshot, artifacts)
  const complete = {
    schemaVersion: 1,
    id,
    sealedAt: options.sealedAt || new Date().toISOString(),
    sourceManifest: { file: 'source-manifest.json', sha256: sha256File(paths.sourceManifest) },
    proposals: proposals.map(({ target, file, sha256 }) => ({ target, file: relative(paths.dir, file), sha256 })),
    targets: artifacts.map(({ target, file, sha256 }) => ({ target, file: relative(paths.dir, file), sha256 })),
    counts: {
      canonicalIssues: artifacts.reduce((sum, entry) => sum + entry.artifact.issues.length, 0),
      sourceMappings: artifacts.reduce((sum, entry) => sum + entry.artifact.mappings.length, 0),
      eligibleClaims: snapshot.eligible.length,
    },
  }
  if (complete.counts.sourceMappings !== snapshot.eligible.length) throw new Error('completion mapping total differs from eligible claim count')
  writeJsonExclusive(paths.complete, complete)
  const index = { schemaVersion: 1, published: id, completeSha256: sha256File(paths.complete) }
  if (fs.existsSync(paths.index)) {
    if (!same(readJson(paths.index), index)) throw new Error('gold index already publishes a different snapshot')
  } else {
    writeJsonExclusive(paths.index, index)
  }
  return validatePublished(root, id)
}

function validateComplete(complete, id, paths, manifest, snapshot) {
  if (!complete || complete.schemaVersion !== 1 || complete.id !== id) throw new Error('invalid gold completion marker')
  if (!complete.sourceManifest || complete.sourceManifest.file !== 'source-manifest.json' ||
      complete.sourceManifest.sha256 !== sha256File(paths.sourceManifest)) {
    throw new Error('completion marker source manifest hash changed')
  }
  const artifacts = validateCanonicalSet(rootForPaths(paths), id, manifest, snapshot, { complete })
  validateProposalSet(rootForPaths(paths), id, snapshot, artifacts, { complete })
  const counts = {
    canonicalIssues: artifacts.reduce((sum, entry) => sum + entry.artifact.issues.length, 0),
    sourceMappings: artifacts.reduce((sum, entry) => sum + entry.artifact.mappings.length, 0),
    eligibleClaims: snapshot.eligible.length,
  }
  if (!same(complete.counts, counts)) throw new Error('completion marker counts changed')
  return artifacts
}

function rootForPaths(paths) {
  return path.dirname(path.dirname(paths.dir))
}

function validateSnapshotLayout(paths) {
  const expected = ['canonical', 'complete.json', 'proposal', 'source-manifest.json']
  const entries = fs.readdirSync(paths.dir).sort()
  if (!same(entries, expected)) throw new Error('sealed comparison contains an undeclared entry')
  for (const directory of [paths.canonical, paths.proposal]) {
    const stat = fs.lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('sealed comparison has an invalid artifact directory')
  }
  for (const file of [paths.sourceManifest, paths.complete]) {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('sealed comparison has an invalid artifact file')
  }
}

function enrichedMappings(snapshot, mappings) {
  const evidenceByTuple = new Map(snapshot.eligible.map((entry) => [tupleKey(entry), entry]))
  return mappings.map((mapping) => {
    const source = evidenceByTuple.get(tupleKey(mapping))
    const cell = snapshot.cells.find((candidate) => candidate.id === mapping.cellId)
    return {
      cellId: mapping.cellId,
      findingIndex: mapping.findingIndex,
      target: cell.target,
      tool: cell.tool,
      runId: cell.runId,
      modelId: cell.modelId,
      creditEligible: cell.creditEligible,
      discoveryOnly: cell.discoveryOnly,
      issueIds: mapping.issueIds,
      finding: source.finding,
    }
  })
}

function cellEvidence(snapshot) {
  return snapshot.cells.map((cell) => ({
    cellId: cell.id,
    runId: cell.id,
    cohortId: cell.runId,
    targetId: cell.target,
    toolId: cell.tool,
    modelId: cell.modelId,
    status: cell.success ? 'complete' : 'failed',
    success: cell.success,
    complete: cell.complete,
    costUsd: cell.costUsd,
    wallMs: cell.wallMs,
    salvaged: cell.salvaged,
    discoveryOnly: cell.discoveryOnly,
    creditEligible: cell.creditEligible,
    result: cell.result,
    findings: cell.findings,
  }))
}

function validatePublished(root = ROOT, requestedId = null) {
  const indexFile = path.join(root, 'gold', 'index.json')
  if (!fs.existsSync(indexFile)) throw new Error('published gold index not found')
  const index = readJson(indexFile)
  if (!index || index.schemaVersion !== 1 || typeof index.published !== 'string' || !HASH.test(index.completeSha256 || '')) {
    throw new Error('invalid published gold index')
  }
  if (requestedId && index.published !== requestedId) throw new Error(`published gold snapshot is ${index.published}, not ${requestedId}`)
  const id = assertSafeId(index.published, 'published comparison id')
  const paths = goldPaths(root, id)
  if (!fs.existsSync(paths.complete) || index.completeSha256 !== sha256File(paths.complete)) {
    throw new Error('published completion marker hash changed')
  }
  validateSnapshotLayout(paths)
  const complete = readJson(paths.complete)
  const manifest = readJson(paths.sourceManifest)
  if (manifest.id !== id) throw new Error('published source manifest id mismatch')
  const snapshot = validateSourceManifestAgainstRoot(root, manifest)
  const artifacts = validateComplete(complete, id, paths, manifest, snapshot)
  const canonicalIssues = artifacts.flatMap(({ target, artifact }) => artifact.issues.map((issue) => ({ ...issue, target })))
  const rawMappings = artifacts.flatMap(({ target, artifact }) => artifact.mappings.map((mapping) => ({ ...mapping, target })))
  const sourceMappings = enrichedMappings(snapshot, rawMappings)
  const sourceEvidence = cellEvidence(snapshot)
  return {
    id,
    index,
    manifest,
    sourceManifest: manifest,
    complete,
    canonicalIssues,
    sourceMappings,
    mappings: sourceMappings,
    sourceEvidence,
    scopes: manifest.scopes,
    cohorts: manifest.cohorts,
    provenance: manifest.provenance,
    issueUrl: manifest.issueUrl,
  }
}

function parseArgs(argv) {
  const options = { phase: null, id: DEFAULT_ID, issueUrl: null, reviewer: null }
  const value = (flag, index) => {
    const result = argv[index + 1]
    if (!result || result.startsWith('--')) throw new Error(`${flag} requires a value`)
    return result
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--phase') { options.phase = value(arg, index++); continue }
    if (arg === '--id') { options.id = assertSafeId(value(arg, index++), 'comparison id'); continue }
    if (arg === '--issue-url') { options.issueUrl = value(arg, index++); continue }
    if (arg === '--reviewer') { options.reviewer = value(arg, index++); continue }
    throw new Error(`unknown argument: ${arg}`)
  }
  if (!['proposal', 'accept', 'seal', 'validate'].includes(options.phase)) {
    throw new Error('--phase must be proposal, accept, seal, or validate')
  }
  if (options.issueUrl && !/^https:\/\//.test(options.issueUrl)) throw new Error('--issue-url must be an https URL')
  return options
}

async function main(argv = process.argv.slice(2), root = ROOT, dependencies = {}) {
  const options = parseArgs(argv)
  if (options.phase === 'proposal') return propose(root, options, dependencies)
  if (options.phase === 'accept') return accept(root, options)
  if (options.phase === 'seal') return seal(root, options)
  return validatePublished(root, options.id)
}

module.exports = {
  DEFAULT_DECLARATION,
  DEFAULT_ID,
  RECONCILER_EFFORT,
  RECONCILER_MODEL,
  accept,
  assertControlledCompatibility,
  buildSourceSnapshot,
  goldPaths,
  loadPublishedComparison: validatePublished,
  main,
  makeSourceManifest,
  parseArgs,
  propose,
  reconciliationPrompt,
  reconcilerArgs,
  seal,
  targetEvidence,
  tupleKey,
  validatePublished,
  validateSourceManifestAgainstRoot,
  validateTargetArtifact,
}

if (require.main === module) {
  main().then((result) => {
    console.log(`${result.id}: ${process.argv.includes('validate') ? 'valid' : 'ok'}`)
  }).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
