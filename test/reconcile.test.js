'use strict'

const { after, test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const reconcile = require('../bench/reconcile')

const BENCH = path.join(__dirname, '..', 'bench')
const temporaries = []

after(() => {
  for (const dir of temporaries) fs.rmSync(dir, { recursive: true, force: true })
})

function copyDirectory(from, to) {
  fs.cpSync(from, to, { recursive: true, filter: (source) => !source.includes(`${path.sep}gold${path.sep}`) })
}

function sourceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-reconcile-'))
  temporaries.push(root)
  for (const name of ['findings', 'results']) copyDirectory(path.join(BENCH, name), path.join(root, name))
  for (const runId of reconcile.DEFAULT_DECLARATION.modernRunIds) {
    copyDirectory(path.join(BENCH, 'runs', runId), path.join(root, 'runs', runId))
  }
  return root
}

function sequentialArtifact(context, verdict = 'real') {
  const issues = context.evidence.map((entry, index) => ({
    id: `${context.target}-I${String(index + 1).padStart(3, '0')}`,
    title: `Canonical issue ${index + 1}`,
    file: entry.finding.file || '',
    line: Number.isSafeInteger(entry.finding.line) && entry.finding.line >= 0 ? entry.finding.line : 0,
    kind: 'bug',
    severity: 'medium',
    verdict: index === 0 ? verdict : 'real',
    verdictReason: 'Verified against the pinned code.',
    introducedByPr: true,
    scope: 'in-scope',
    scopeReason: 'The pinned change introduced the behavior.',
  }))
  return {
    schemaVersion: 1,
    target: context.target,
    baseSha: context.pins.baseSha,
    headSha: context.pins.headSha,
    sourceManifestSha256: context.sourceManifestSha256,
    reviewed: false,
    reconciler: {
      requestedModel: reconcile.RECONCILER_MODEL,
      effort: reconcile.RECONCILER_EFFORT,
      costUsd: 0.5,
      modelUsage: {
        [reconcile.RECONCILER_MODEL]: {
          inputTokens: 1, outputTokens: 2, thinkingTokens: 1,
          cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.5,
        },
      },
      workspace: `work/${context.target}/fixture`,
      reconciledAt: '2026-09-30T12:00:00.000Z',
    },
    issues,
    mappings: context.evidence.map((entry, index) => ({
      cellId: entry.cellId,
      findingIndex: entry.findingIndex,
      issueIds: [issues[index].id],
    })),
  }
}

async function sealedFixture(options = {}) {
  const root = sourceFixture()
  const calls = []
  await reconcile.propose(root, {
    id: options.id || reconcile.DEFAULT_ID,
    issueUrl: 'https://github.com/example/project/issues/123',
    generatedAt: '2026-09-30T10:00:00.000Z',
  }, {
    reconcileTarget: (context) => {
      calls.push(context.target)
      return sequentialArtifact(context, context.target === 'ironweave' ? 'false-positive' : 'real')
    },
  })
  reconcile.accept(root, {
    id: options.id || reconcile.DEFAULT_ID,
    reviewer: 'fixture-reviewer',
    reviewedAt: '2026-09-30T11:00:00.000Z',
  })
  const published = reconcile.seal(root, {
    id: options.id || reconcile.DEFAULT_ID,
    sealedAt: '2026-09-30T12:00:00.000Z',
  })
  return { root, calls, published }
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function minimalContext() {
  const cellId = 'fixture/sample/reviewer'
  return {
    target: 'sample',
    pins: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
    sourceManifestSha256: 'c'.repeat(64),
    evidence: [
      { cellId, findingIndex: 0, finding: { title: 'Composite' } },
      { cellId, findingIndex: 2, finding: { title: 'Second eligible' } },
    ],
    sourceCells: [{ id: cellId, target: 'sample' }],
  }
}

function minimalArtifact(context) {
  const issue = (number) => ({
    id: `sample-I00${number}`,
    title: `Issue ${number}`,
    file: 'src/sample.js',
    line: number,
    kind: 'bug',
    severity: 'medium',
    verdict: 'real',
    verdictReason: 'Verified.',
    introducedByPr: true,
    scope: 'in-scope',
    scopeReason: 'Introduced here.',
  })
  return {
    schemaVersion: 1,
    target: 'sample',
    baseSha: context.pins.baseSha,
    headSha: context.pins.headSha,
    sourceManifestSha256: context.sourceManifestSha256,
    reviewed: true,
    reconciler: {
      requestedModel: reconcile.RECONCILER_MODEL, effort: reconcile.RECONCILER_EFFORT,
      costUsd: 0.5,
      modelUsage: {
        [reconcile.RECONCILER_MODEL]: {
          inputTokens: 1, outputTokens: 2, thinkingTokens: 1,
          cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.5,
        },
      },
      workspace: 'work/sample/fixture', reconciledAt: '2026-09-30T12:00:00.000Z',
    },
    issues: [issue(1), issue(2)],
    mappings: [
      { cellId: 'fixture/sample/reviewer', findingIndex: 0, issueIds: ['sample-I001', 'sample-I002'] },
      { cellId: 'fixture/sample/reviewer', findingIndex: 2, issueIds: ['sample-I002'] },
    ],
  }
}

test('source manifest fixes the declared cohorts, 403 eligible claims, salvage policy, and 17/19 scopes', () => {
  const snapshot = reconcile.buildSourceSnapshot(BENCH)
  assert.equal(snapshot.cells.length, 57)
  assert.equal(snapshot.eligible.length, 403)
  assert.equal(snapshot.excluded.length, 191)
  assert.ok(snapshot.excluded.every(({ finding }) => finding.selfRejected === true))
  assert.ok(snapshot.eligible.every(({ finding }) => finding.selfRejected !== true))
  assert.deepEqual(snapshot.cohorts.map((cohort) => cohort.runId), [
    'legacy', 'fable-5-1-2026-09-29', 'opus-5-5-2026-09-29',
  ])
  const salvage = snapshot.cells.filter((cell) => cell.salvaged)
  assert.deepEqual(salvage.map((cell) => cell.id), reconcile.DEFAULT_DECLARATION.salvagedCells)
  assert.ok(salvage.every((cell) => cell.discoveryOnly && !cell.creditEligible))
  assert.equal(snapshot.cells.some((cell) => cell.id === 'legacy/ironweave/tob-c-review'), false)
  assert.deepEqual(snapshot.excludedSources.map((source) => [source.id, source.excludedReason]), [
    ['legacy/ironweave/tob-c-review', 'parked-dnf'],
  ])
  assert.deepEqual(snapshot.scopes.map(({ id, matchedCellCount }) => ({ id, matchedCellCount })), [
    { id: 'all-models', matchedCellCount: 17 },
    { id: 'controlled-pair', matchedCellCount: 19 },
  ])
  assert.equal(snapshot.scopes[0].matchedCells.some((cell) => cell.id === 'ironweave/anthropic-pr-review'), false)
  assert.equal(snapshot.scopes[1].matchedCells.some((cell) => cell.id === 'ironweave/anthropic-pr-review'), true)
  const legacySpend = snapshot.cells.filter((cell) => (
    cell.runId === 'legacy' && snapshot.scopes[0].matchedCells.some((matched) => matched.id === `${cell.target}/${cell.tool}`)
  )).reduce((sum, cell) => sum + cell.costUsd, 0)
  assert.ok(Math.abs(legacySpend - 160.5958517) < 1e-9)
})

test('controlled cohorts must share pins, prompts, matrix, configuration hash, and Claude version', () => {
  const manifest = {
    targets: { sample: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) } },
    targetMetadata: { sample: { id: 'sample' } },
    groundtruth: { sample: null },
    toolConfig: { context: 'same', tools: [{ id: 'reviewer', prompt: 'same' }] },
    expectedCells: [{ target: 'sample', tool: 'reviewer' }],
    configSha256: 'c'.repeat(64),
    claudeVersion: '1.2.3',
  }
  const left = { manifest: clone(manifest) }
  const right = { manifest: clone(manifest) }
  assert.doesNotThrow(() => reconcile.assertControlledCompatibility(left, right))
  right.manifest.toolConfig.context = 'different'
  assert.throws(() => reconcile.assertControlledCompatibility(left, right), /tool configuration/)
  right.manifest.toolConfig.context = 'same'
  right.manifest.claudeVersion = '2.0.0'
  assert.throws(() => reconcile.assertControlledCompatibility(left, right), /Claude versions/)
})

test('proposal performs exactly one explicit Opus 5.5 high-effort reconciliation per target and resumes recorded proposals', async () => {
  const root = sourceFixture()
  const calls = []
  const options = {
    id: reconcile.DEFAULT_ID,
    issueUrl: 'https://github.com/example/project/issues/123',
    generatedAt: '2026-09-30T10:00:00.000Z',
  }
  const dependencies = { reconcileTarget: (context) => {
    calls.push(context.target)
    return sequentialArtifact(context)
  } }
  await reconcile.propose(root, options, dependencies)
  assert.deepEqual(calls, ['ironweave', 'quillstone', 'tidepool'])
  await reconcile.propose(root, options, dependencies)
  assert.equal(calls.length, 3)
  const args = reconcile.reconcilerArgs('prompt')
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5')
  assert.equal(args[args.indexOf('--effort') + 1], 'high')
  assert.match(reconcile.reconciliationPrompt('sample', { baseSha: 'a', headSha: 'b' }, 'c', []), /exactly once/)
})

test('accept, seal, and validate publish a hash-bound normalized snapshot with cell-level run evidence', async () => {
  const { calls, published } = await sealedFixture()
  assert.equal(calls.length, 3)
  assert.equal(published.id, reconcile.DEFAULT_ID)
  assert.equal(published.canonicalIssues.length, 403)
  assert.equal(published.sourceMappings.length, 403)
  assert.equal(published.sourceEvidence.length, 57)
  assert.equal(published.sourceEvidence.every((row) => row.runId === row.cellId), true)
  assert.equal(published.sourceEvidence.every((row) => ['complete', 'failed'].includes(row.status)), true)
  assert.equal(published.sourceEvidence.filter((row) => row.salvaged).every((row) => !row.creditEligible), true)
  assert.equal(published.issueUrl, 'https://github.com/example/project/issues/123')
  assert.deepEqual(published.scopes.map((scope) => scope.id), ['all-models', 'controlled-pair'])
  assert.ok(published.sourceMappings.every((mapping) => mapping.finding && mapping.modelId))
  assert.equal(published.canonicalIssues.find((issue) => issue.id === 'ironweave-I001').verdict, 'false-positive')
})

test('accept validates every proposal before publishing and resumes a consistent partial write', async () => {
  const root = sourceFixture()
  const options = {
    id: reconcile.DEFAULT_ID,
    issueUrl: 'https://github.com/example/project/issues/123',
    generatedAt: '2026-09-30T10:00:00.000Z',
  }
  await reconcile.propose(root, options, { reconcileTarget: sequentialArtifact })
  const tidepool = path.join(root, 'gold', reconcile.DEFAULT_ID, 'proposal', 'tidepool.json')
  const valid = fs.readFileSync(tidepool, 'utf8')
  const invalid = JSON.parse(valid)
  invalid.issues[0].verdict = 'maybe'
  fs.writeFileSync(tidepool, JSON.stringify(invalid, null, 2) + '\n')
  assert.throws(() => reconcile.accept(root, { id: reconcile.DEFAULT_ID, reviewer: 'fixture' }), /invalid verdict/)
  assert.equal(fs.existsSync(path.join(root, 'gold', reconcile.DEFAULT_ID, 'canonical')), false)

  fs.writeFileSync(tidepool, valid)
  reconcile.accept(root, { id: reconcile.DEFAULT_ID, reviewer: 'fixture', reviewedAt: '2026-09-30T11:00:00.000Z' })
  const canonical = path.join(root, 'gold', reconcile.DEFAULT_ID, 'canonical')
  fs.unlinkSync(path.join(canonical, 'quillstone.json'))
  fs.unlinkSync(path.join(canonical, 'tidepool.json'))
  assert.doesNotThrow(() => reconcile.accept(root, { id: reconcile.DEFAULT_ID, reviewer: 'fixture' }))
  assert.deepEqual(fs.readdirSync(canonical).sort(), ['ironweave.json', 'quillstone.json', 'tidepool.json'])
})

test('composite claims map once to several issues while missing, duplicate, excluded, and cross-target tuples are rejected', () => {
  const context = minimalContext()
  const artifact = minimalArtifact(context)
  assert.equal(reconcile.validateTargetArtifact(artifact, context, { requireReviewed: true }), artifact)

  const missing = clone(artifact)
  missing.mappings.pop()
  assert.throws(() => reconcile.validateTargetArtifact(missing, context), /incomplete source coverage/)

  const duplicate = clone(artifact)
  duplicate.mappings.splice(1, 0, clone(duplicate.mappings[0]))
  assert.throws(() => reconcile.validateTargetArtifact(duplicate, context), /stable cell\/index order|duplicate source mapping/)

  const selfRejectedIndex = clone(artifact)
  selfRejectedIndex.mappings[1].findingIndex = 1
  assert.throws(() => reconcile.validateTargetArtifact(selfRejectedIndex, context), /excluded, missing, or cross-target/)

  const crossTarget = clone(artifact)
  crossTarget.mappings[1].cellId = 'fixture/elsewhere/reviewer'
  assert.throws(() => reconcile.validateTargetArtifact(crossTarget, context), /excluded, missing, or cross-target|stable cell\/index order/)
})

test('canonical validation rejects pin drift, unstable IDs/order, invalid enums, and unsupported issues', () => {
  const context = minimalContext()
  const artifact = minimalArtifact(context)

  const pins = clone(artifact)
  pins.headSha = 'd'.repeat(40)
  assert.throws(() => reconcile.validateTargetArtifact(pins, context), /pin drift/)

  const ids = clone(artifact)
  ids.issues[0].id = 'sample-I009'
  assert.throws(() => reconcile.validateTargetArtifact(ids, context), /unstable canonical issue id/)

  const order = clone(artifact)
  order.mappings.reverse()
  assert.throws(() => reconcile.validateTargetArtifact(order, context), /stable cell\/index order/)

  const verdict = clone(artifact)
  verdict.issues[0].verdict = 'probably'
  assert.throws(() => reconcile.validateTargetArtifact(verdict, context), /invalid verdict/)

  const invocation = clone(artifact)
  delete invocation.reconciler.modelUsage
  assert.throws(() => reconcile.validateTargetArtifact(invocation, context), /requested-model usage/)

  const unsupported = clone(artifact)
  unsupported.mappings.forEach((mapping) => { mapping.issueIds = ['sample-I001'] })
  assert.throws(() => reconcile.validateTargetArtifact(unsupported, context), /no eligible source evidence/)
})

test('published validation detects finding and result source tampering', async (t) => {
  await t.test('finding hash drift', async () => {
    const { root } = await sealedFixture()
    const file = path.join(root, 'findings', 'tidepool', 'builtin-code-review.json')
    fs.appendFileSync(file, ' ')
    assert.throws(() => reconcile.validatePublished(root), /source manifest differs|complete marker|hash/)
  })
  await t.test('result hash drift', async () => {
    const { root } = await sealedFixture()
    const file = path.join(root, 'results', 'quillstone', 'builtin-code-review.json')
    fs.appendFileSync(file, ' ')
    assert.throws(() => reconcile.validatePublished(root), /source manifest differs|complete marker|hash/)
  })
  await t.test('excluded parked DNF finding hash drift', async () => {
    const { root } = await sealedFixture()
    const file = path.join(root, 'findings', 'ironweave', 'tob-c-review.json')
    fs.appendFileSync(file, ' ')
    assert.throws(() => reconcile.validatePublished(root), /source manifest differs|complete marker|hash/)
  })
})

test('published validation detects canonical and completion-marker edits and seal refuses mutation', async () => {
  const { root } = await sealedFixture()
  assert.throws(() => reconcile.seal(root), /already sealed/)
  const target = path.join(root, 'gold', reconcile.DEFAULT_ID, 'canonical', 'ironweave.json')
  fs.appendFileSync(target, ' ')
  assert.throws(() => reconcile.validatePublished(root), /canonical target hashes changed|hash/)

  const second = await sealedFixture()
  const proposal = path.join(second.root, 'gold', reconcile.DEFAULT_ID, 'proposal', 'quillstone.json')
  fs.appendFileSync(proposal, ' ')
  assert.throws(() => reconcile.validatePublished(second.root), /proposal hashes changed|hash/)

  const third = await sealedFixture()
  const complete = path.join(third.root, 'gold', reconcile.DEFAULT_ID, 'complete.json')
  fs.appendFileSync(complete, ' ')
  assert.throws(() => reconcile.validatePublished(third.root), /completion marker hash changed/)

  const fourth = await sealedFixture()
  fs.writeFileSync(path.join(fourth.root, 'gold', reconcile.DEFAULT_ID, 'canonical', 'unexpected.txt'), 'extra')
  assert.throws(() => reconcile.validatePublished(fourth.root), /target files do not match|undeclared entry/)

  const fifth = await sealedFixture()
  fs.writeFileSync(path.join(fifth.root, 'gold', reconcile.DEFAULT_ID, 'unexpected.txt'), 'extra')
  assert.throws(() => reconcile.validatePublished(fifth.root), /undeclared entry/)
})

test('fixed timestamps and inputs produce deterministic sealed exports', async () => {
  const left = await sealedFixture()
  const right = await sealedFixture()
  const project = (published) => ({
    manifest: published.manifest,
    complete: published.complete,
    canonicalIssues: published.canonicalIssues,
    sourceMappings: published.sourceMappings,
    sourceEvidence: published.sourceEvidence,
  })
  assert.equal(digest(project(left.published)), digest(project(right.published)))
})
