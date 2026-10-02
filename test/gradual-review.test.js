'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const WF = fs.readFileSync(path.join(ROOT, 'workflows/review-and-fix-pr.js'), 'utf8')

function extractFn(name) {
  const start = WF.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, `workflow helper ${name} is missing`)
  const open = WF.indexOf('{', start)
  let depth = 0
  for (let i = open; i < WF.length; i++) {
    if (WF[i] === '{') depth++
    else if (WF[i] === '}' && --depth === 0) return WF.slice(start, i + 1)
  }
  throw new Error(`unterminated helper ${name}`)
}

function helpers(overrides = {}) {
  const cfg = Object.assign({
    EXTRA_REVIEW_SKILLS: [],
    STOP_AT: { count: null, score: { code: null, other: null }, tokens: null },
    SEVERITY_WEIGHTS: { code: { critical: 10, high: 5, medium: 2, low: 1 },
      other: { critical: 10, high: 5, medium: 2, low: 1 } },
  }, overrides)
  const source = [
    `const EXTRA_REVIEW_SKILLS = ${JSON.stringify(cfg.EXTRA_REVIEW_SKILLS)}`,
    `const STOP_AT = ${JSON.stringify(cfg.STOP_AT)}`,
    `const SEVERITY_WEIGHTS = ${JSON.stringify(cfg.SEVERITY_WEIGHTS)}`,
    "const NATIVE_LENSES = ['correctness','spec','standards','security','reliability','contracts','testing','performance','comments','maintainability']",
    'const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }',
    'const severityRank = s => SEV_RANK[s] === undefined ? 9 : SEV_RANK[s]',
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    extractFn('plannedDiscoveryLenses'), extractFn('canonicalJson'), extractFn('sha256Utf8'),
    extractFn('canonicalJsonSha256'), extractFn('identityHex'),
    extractFn('followUpIdentity'),
    extractFn('normalizedFingerprint'), extractFn('stableRawCandidateId'), extractFn('safeFindingPath'),
    extractFn('findingPathsSafe'), extractFn('mergeFinding'),
    extractFn('findingConsumesThreshold'),
    "const CODE_DEFECT_CLASSES = new Set(['logic','nil-deref','bounds','concurrency','resource-leak','error-handling','security','api-contract','perf','regression'])",
    extractFn('defectBucket'), extractFn('scoreFindings'), extractFn('thresholdTrigger'),
    extractFn('stableClusterCandidateId'), extractFn('clusterCandidates'), extractFn('appendRawCandidateDispositions'),
    extractFn('validationDecisionMap'), extractFn('combineDoubleVerification'),
    extractFn('receiptMatrixGaps'),
    extractFn('coverageUnitSetError'),
    extractFn('deterministicManifestError'),
    extractFn('fixDispositionError'),
    extractFn('dedupeFollowUps'),
    '({ plannedDiscoveryLenses, normalizedFingerprint, stableRawCandidateId, safeFindingPath, findingPathsSafe, mergeFinding, findingConsumesThreshold, defectBucket, scoreFindings, thresholdTrigger, clusterCandidates, appendRawCandidateDispositions, validationDecisionMap, combineDoubleVerification, receiptMatrixGaps, coverageUnitSetError, deterministicManifestError, fixDispositionError, dedupeFollowUps })',
  ].join('\n')
  return vm.runInNewContext(source)
}

function finding(severity, extra = {}) {
  return Object.assign({ primaryFile: 'src/a.js', symbol: 'run', defectClass: 'logic',
    trigger: 'bad input', mechanism: 'wrong branch', observableImpact: 'wrong result',
    fingerprint: 'ignored', severity, confidence: 'likely', scopeLabel: 'in', defer: false,
    deferralQuote: 'none',
    evidence: 'src/a.js:1 return wrong', detail: 'wrong result', fixSize: 'small',
    releaseBlocker: false, blockerReason: 'none', candidateId: 'c1' }, extra)
}

test('lens plan always includes every native lens and prepends additive skills', () => {
  const plan = helpers({ EXTRA_REVIEW_SKILLS: ['matt:code-review', 'anthropic:pr-review'] })
    .plannedDiscoveryLenses({ applicableLenses: [{ lens: 'security', reason: 'untrusted input' }] })
  assert.deepEqual(Array.from(plan, x => x.lens), [
    'extra-skill-1', 'extra-skill-2', 'correctness', 'spec', 'standards', 'security',
    'reliability', 'contracts', 'testing', 'performance', 'comments', 'maintainability',
  ])
  assert.equal(plan[0].reviewSkill, 'matt:code-review')
})

test('conservative clustering keeps same-symbol defects with different mechanisms separate', () => {
  const h = helpers()
  const clustered = h.clusterCandidates([
    finding('medium', { candidateId: 'raw-1', mechanism: 'wrong branch', observableImpact: 'wrong result' }),
    finding('high', { candidateId: 'raw-2', mechanism: 'missing lock', observableImpact: 'data race' }),
    finding('high', { candidateId: 'raw-3', mechanism: 'wrong branch', observableImpact: 'wrong result' }),
  ])
  assert.equal(clustered.length, 2)
  assert.deepEqual(Array.from(clustered[0].rawCandidateIds), ['raw-1', 'raw-3'])
  const unicode = h.clusterCandidates([
    finding('medium', { candidateId: 'unicode-1', primaryFile: 'src/用户.js', symbol: '解析' }),
    finding('medium', { candidateId: 'unicode-2', primaryFile: 'src/管理员.js', symbol: '解析' }),
  ])
  assert.equal(unicode.length, 2)
  assert.notEqual(unicode[0].fingerprint, unicode[1].fingerprint)
  assert.notEqual(h.normalizedFingerprint(finding('medium', { primaryFile: 'src/é.js' })),
    h.normalizedFingerprint(finding('medium', { primaryFile: 'src/é.js' })))
  const disputed = h.clusterCandidates([
    finding('medium', { candidateId: 'raw-a', fingerprint: 'src/a.js:run:logic' }),
    finding('medium', { candidateId: 'raw-b', fingerprint: 'src/a.js:run:logic', reviewerRejected: true }),
  ])
  assert.equal(disputed[0].reviewerRejected, true)
  assert.equal(h.findingConsumesThreshold(disputed[0]), false)
  const scopeConflict = h.clusterCandidates([
    finding('medium', { candidateId: 'scope-in', scopeLabel: 'in' }),
    finding('medium', { candidateId: 'scope-out', scopeLabel: 'out' }),
  ])
  assert.equal(scopeConflict[0].scopeLabel, 'in')

  const sameDefect = [
    finding('medium', { candidateId: 'raw-z', evidence: 'src/a.js:1 short' }),
    finding('high', { candidateId: 'raw-a', evidence: 'src/a.js:1 substantially longer evidence' }),
  ]
  const forward = h.clusterCandidates(sameDefect)[0]
  const reversed = h.clusterCandidates(sameDefect.slice().reverse())[0]
  assert.equal(forward.candidateId, reversed.candidateId)
  assert.match(forward.candidateId, /^cluster-[a-f0-9]{64}$/)
  assert.deepEqual(Array.from(forward.rawCandidateIds).sort(), Array.from(reversed.rawCandidateIds).sort())
})

test('fix authorization accepts only safe repository-relative finding paths', () => {
  const h = helpers()
  assert.equal(h.findingPathsSafe(finding('medium', { files: ['src/a.js'] })), true)
  for (const file of ['/tmp/x', '../x', 'src/../x', 'src//x', 'src\\x', 'src/x\nother', '.git/config', 'src/.git/x']) {
    assert.equal(h.findingPathsSafe(finding('medium', { primaryFile: file, files: [file] })), false, file)
  }
})

test('split scoring classifies defect classes semantically and stops on OR boundary', () => {
  const h = helpers({ STOP_AT: { count: 9, score: { code: 10, other: 4 }, tokens: null } })
  assert.equal(h.defectBucket(finding('low', { defectClass: 'security' })), 'code')
  assert.equal(h.defectBucket(finding('low', { defectClass: 'design' })), 'other')
  const score = h.scoreFindings([
    finding('high', { candidateId: 'a' }), finding('high', { candidateId: 'b' }),
    finding('medium', { defectClass: 'docs', candidateId: 'c' }),
    finding('medium', { defectClass: 'test-gap', candidateId: 'd' }),
    finding('critical', { scopeLabel: 'out', candidateId: 'e' }),
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(score)), { findingCount: 4, score: { code: 10, other: 4 } })
  assert.deepEqual(JSON.parse(JSON.stringify(h.thresholdTrigger(score))), {
    primary: 'code-score', crossed: [
      { kind: 'code-score', value: 10, limit: 10 },
      { kind: 'other-score', value: 4, limit: 4 },
    ],
  })
  assert.equal(helpers({ STOP_AT: { count: 4, score: { code: null, other: null }, tokens: null } })
    .thresholdTrigger(score).primary, 'count')
})

test('raw candidate IDs and dispositions remain stable and identity-bound', () => {
  const h = helpers()
  const f = finding('high')
  const id = h.stableRawCandidateId(2, 'a'.repeat(40), 'lens:correctness', 0, f)
  assert.equal(id, h.stableRawCandidateId(2, 'a'.repeat(40), 'lens:correctness', 0, { ...f }))
  assert.notEqual(id, h.stableRawCandidateId(2, 'a'.repeat(40), 'lens:testing', 0, f))
  const clustered = h.clusterCandidates([{ ...f, candidateId: id }])[0]
  const dispositions = []
  h.appendRawCandidateDispositions(dispositions, clustered, clustered.candidateId, 'confirmed', 2)
  assert.deepEqual(JSON.parse(JSON.stringify(dispositions)), [{
    rawCandidateId: id,
    rawCandidateIdentity: h.normalizedFingerprint(f),
    clusterId: clustered.candidateId,
    status: 'confirmed',
    cycle: 2,
  }])
})

test('raw source locators replay canonical occurrence ranks instead of physical order', () => {
  const head = 'a'.repeat(40)
  const first = finding('low', { title: 'z-last', evidence: 'src/a.js:9 z' })
  const second = finding('low', { title: 'a-first', evidence: 'src/a.js:1 a' })
  const name = 'cycle-1/lenses/correctness.json'
  const value = { importVersion: 1, binding: { run: 'run-1', headSha: head,
    kind: 'lens', resultId: 'correctness', artifactName: name },
  result: { lens: 'correctness', findings: [first, second] } }
  const source = [
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    extractFn('canonicalJson'), extractFn('identityHex'), extractFn('normalizedFingerprint'),
    extractFn('stableRawCandidateId'), extractFn('stableFindingOccurrenceIndexes'),
    extractFn('normalizeSourceArtifactRef'), extractFn('sourceResultRecord'), extractFn('resolveRawLocator'),
    `const name = ${JSON.stringify(name)}, value = ${JSON.stringify(value)}`,
    "const refs = [{ name, sha256: 'b'.repeat(64), bytes: 1 }]",
    'const artifacts = new Map([[name, value]])',
    `const context = { catalog: ${JSON.stringify([first, second])} }`,
    'const ranks = stableFindingOccurrenceIndexes(value.result.findings)',
    ";({ actual: resolveRawLocator(['s', 0, 0], refs, context, 1, artifacts, 'run-1'),",
    "expected: stableRawCandidateId(1, value.binding.headSha, 'lens:correctness', ranks[0], value.result.findings[0]), ranks })",
  ].join('\n')
  const result = vm.runInNewContext(source)
  assert.notEqual(result.ranks[0], 0)
  assert.equal(result.actual, result.expected)
})

test('double verification needs two rejections and makes disagreement unresolved', () => {
  const h = helpers()
  const candidate = finding('high', { candidateId: 'cluster-1', rawCandidateIds: ['raw-1'] })
  const rejected = new Map([['cluster-1', { status: 'rejected', finding: candidate, reason: 'guard exists' }]])
  const confirmed = new Map([['cluster-1', { status: 'confirmed', finding: candidate, reason: 'guard bypassed' }]])
  assert.equal(h.combineDoubleVerification(rejected, rejected, new Set(['cluster-1'])).get('cluster-1').status, 'rejected')
  assert.equal(h.combineDoubleVerification(rejected, confirmed, new Set(['cluster-1'])).get('cluster-1').status, 'unresolved')

  const contradictory = h.validationDecisionMap([candidate], {
    confirmed: [{ candidateId: 'cluster-1', finding: candidate, reason: 'yes' }],
    rejected: [{ candidateId: 'cluster-1', finding: candidate, reason: 'no' }],
    unresolved: [],
  })
  assert.equal(contradictory.get('cluster-1').status, 'unresolved')
})

test('new API validates strictly before the first agent call and rejects removed keys', () => {
  const start = WF.indexOf('const ARGS =')
  const end = WF.indexOf('// Run every agent on one model')
  const config = WF.slice(start, end)
  const evaluate = args => vm.runInNewContext(config, { args })
  for (const args of [
    { reviewMode: 'unbounded' }, { validation: 'single' }, { maxFindings: 10 },
    { stopAt: null }, { stopAt: {} }, { stopAt: { score: {} } },
    { stopAt: { count: 0 } }, { stopAt: { tokens: 1.5 } },
    { stopAt: { score: { code: -1 } } }, { stopAt: { score: { style: 2 } } },
    { severityWeights: { high: 7 } }, { severityWeights: { code: { urgent: 3 } } },
    { verification: 'triple' }, { extraReviewSkills: 'matt' },
  ]) assert.throws(() => evaluate(args))
  assert.doesNotThrow(() => evaluate({ stopAt: { count: 10, score: { code: 20, other: 5 }, tokens: 1000 },
    severityWeights: { code: { high: 7 }, other: { low: 0 } }, verification: 'double',
    extraReviewSkills: ['matt:code-review'], model: 'test-model' }))
  assert.ok(end < WF.indexOf('await agentSafe('))
})

test('discovery drains waves of three before applying a stop and coverage has one gap round', () => {
  const loopStart = WF.indexOf('for (let li = 0; li < lensPlan.length')
  const loop = WF.slice(loopStart, WF.indexOf('for (const [key, reason]', loopStart))
  assert.match(loop, /li \+= REVIEW_CONCURRENCY/)
  assert.match(loop, /await parallel\(/)
  assert.match(loop, /thresholdTrigger\(scoreFindings\(clusterCandidates\(invocationCandidates\(\)\)\)\)/)
  assert.ok(loop.indexOf('await parallel(') < loop.indexOf('thresholdTrigger('))
  const coverage = WF.slice(WF.indexOf("phase('Coverage')"), WF.indexOf('const candidates = clusterCandidates'))
  assert.match(coverage, /coverageAuditPrompt\(scope, coverageReceipts, 'initial'\)/)
  assert.match(coverage, /gapReviewPrompt/)
  assert.match(coverage, /coverageAuditPrompt\(scope, coverageReceipts\.concat\(gapReceipts\), 'final'\)/)
  assert.doesNotMatch(coverage, /while\s*\(/)
  assert.match(WF, /const RESUME_PAGE_BYTES = 24576/)
  assert.match(WF, /resume-json[\s\S]*--max-bytes ' \+ RESUME_PAGE_BYTES/)
  assert.match(WF, /export-lineage[\s\S]*--limit 1/)
  assert.doesNotMatch(WF, /Bash\(cd .* && \*\)/)
})

test('coverage matrix merges repeated gap receipts per lens without erasing earlier units', () => {
  const h = helpers()
  const manifest = [{ id: 'u1' }, { id: 'u2' }]
  const groups = [
    { lens: 'correctness', receipts: [{ unitId: 'u1', status: 'checked', reason: 'none' }] },
    { lens: 'correctness', receipts: [{ unitId: 'u2', status: 'checked', reason: 'none' }] },
  ]
  const gaps = h.receiptMatrixGaps(manifest, groups)
  assert.equal(gaps.some(gap => gap.requiredLens === 'correctness'), false)
  assert.equal(gaps.some(gap => gap.requiredLens === 'security'), true)
})

test('semantic coverage units cannot collide or disappear behind duplicate ids', () => {
  const h = helpers()
  assert.match(h.coverageUnitSetError([{ id: 'contract:a' }, { id: 'contract:a' }]), /duplicated/)
  assert.match(h.coverageUnitSetError([{ id: 'hunk:a:hash' }], new Set(['hunk:a:hash'])), /collides/)
  assert.match(h.coverageUnitSetError([{ id: '' }]), /no stable id/)
  assert.equal(h.coverageUnitSetError([{ id: 'contract:a' }, { id: 'test:a' }]), null)
})

test('resume freezes initial semantic IDs and immutable requirements despite a changed fresh scope', () => {
  const select = vm.runInNewContext(extractFn('selectFrozenSemanticCoverage') +
    '\nselectFrozenSemanticCoverage')
  const head = 'a'.repeat(40)
  const saved = { headSha: head, coverageUnits: [
    { id: 'requirement:saved', type: 'requirement' },
    { id: 'contract:saved', type: 'contract' },
  ] }
  const fresh = [
    { id: 'requirement:changed', type: 'requirement' },
    { id: 'contract:changed', type: 'contract' },
  ]
  const sameHead = select(saved, null, fresh, head)
  assert.deepEqual(Array.from(sameHead.currentUnits, unit => unit.id), ['requirement:saved', 'contract:saved'])
  assert.deepEqual(Array.from(sameHead.immutableUnits, unit => unit.id), ['requirement:saved'])
  const advanced = select(saved, null, fresh, 'b'.repeat(40))
  assert.deepEqual(Array.from(advanced.currentUnits, unit => unit.id), ['requirement:changed', 'contract:changed'])
  assert.deepEqual(Array.from(advanced.immutableUnits, unit => unit.id), ['requirement:saved'])
  assert.match(select({ headSha: head }, null, fresh, head).error, /missing/)
})

test('deterministic manifest must account for every changed hunk exactly once', () => {
  const h = helpers()
  const hash = 'a'.repeat(64)
  const inventory = {
    changedFiles: [{ path: 'src/a.js', status: 'modified' }],
    hunks: [{ path: 'src/a.js', hash }], hunkCount: 1, zeroHunkPaths: [], structuralUnits: [],
  }
  const manifest = {
    changedFiles: inventory.changedFiles,
    chunks: [{ files: ['src/a.js'], hunkCount: 1 }], hunksInLedger: 0,
    notReviewable: [], structuralUnits: [],
    coverageUnits: [{ id: 'hunk:src/a.js:' + hash, type: 'hunk', path: 'src/a.js', hash }],
  }
  assert.equal(h.deterministicManifestError(manifest, inventory), null)
  assert.match(h.deterministicManifestError({ ...manifest, coverageUnits: [] }, inventory), /do not match/)
  assert.match(h.deterministicManifestError({ ...manifest, coverageUnits: [
    { id: 'hunk:other.js:' + hash, type: 'hunk', path: 'other.js', hash },
  ] }, inventory), /unknown-path/)
  const fakeHash = 'b'.repeat(64)
  assert.match(h.deterministicManifestError({ ...manifest, coverageUnits: [
    { id: 'hunk:src/a.js:' + fakeHash, type: 'hunk', path: 'src/a.js', hash: fakeHash },
  ] }, inventory), /hunk set/)
  assert.match(h.deterministicManifestError({ ...manifest, chunks: [{ files: ['src/a.js'], hunkCount: 2 }] }, inventory), /do not match/)
  assert.match(h.deterministicManifestError({ ...manifest, notReviewable: ['src/a.js'], chunks: [], coverageUnits: [] }, inventory), /notReviewable/)
  assert.match(h.deterministicManifestError({ ...manifest,
    changedFiles: [{ path: 'src/a.js', status: 'added' }],
  }, inventory), /changed-file list/)

  const zeroInventory = {
    changedFiles: [{ path: 'asset.bin', status: 'modified' }], hunks: [], hunkCount: 0,
    zeroHunkPaths: ['asset.bin'],
  }
  assert.equal(h.deterministicManifestError({ changedFiles: zeroInventory.changedFiles, chunks: [],
    coverageUnits: [], structuralUnits: [], hunksInLedger: 0, notReviewable: ['asset.bin'] },
  { ...zeroInventory, structuralUnits: [] }), null)
  assert.match(h.deterministicManifestError({ changedFiles: zeroInventory.changedFiles, chunks: [],
    coverageUnits: [], structuralUnits: [], hunksInLedger: 0, notReviewable: [] },
  { ...zeroInventory, structuralUnits: [] }), /notReviewable/)
})

test('fixer must disposition every finding exactly once and cannot fake no-changes', () => {
  const h = helpers()
  const batch = [finding('high', { fingerprint: 'a' }), finding('medium', { fingerprint: 'b', candidateId: 'c2' })]
  assert.match(h.fixDispositionError(batch, { outcome: 'no-changes', fixed: [], stillOpen: [], notABug: [] }), /omitted/)
  assert.match(h.fixDispositionError(batch, {
    outcome: 'no-changes', fixed: [{ fingerprint: 'a' }], stillOpen: [{ fingerprint: 'b' }], notABug: [],
  }), /claimed fixed/)
  assert.equal(h.fixDispositionError(batch, {
    outcome: 'no-changes', fixed: [], stillOpen: [{ fingerprint: 'a' }], notABug: [{ fingerprint: 'b' }],
  }), null)
})

test('finding disposition transitions keep exactly one live terminal bucket', () => {
  const source = [
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    'const knownFixed = new Map(), knownDeferred = new Map(), knownRejected = new Map(), setAside = new Map(), deferDetail = new Map()',
    'const authorDeferredKeys = new Set(), stillPresent = [], openReviewFindings = [], unresolvedFindings = []',
    'const outOfScopeFindings = [], fixLog = [], followUpsRaw = []',
    extractFn('removeFindingFrom'), extractFn('clearFindingState'), extractFn('setFindingFixed'),
    extractFn('setFindingRejected'), extractFn('setFindingSetAside'), extractFn('setFindingStillPresent'), extractFn('setFindingOpen'),
    extractFn('setFindingUnresolved'), extractFn('setFindingOutOfScope'), extractFn('deferFinding'),
    extractFn('discardBatch'),
    '({knownFixed, knownDeferred, knownRejected, stillPresent, openReviewFindings, unresolvedFindings,',
    'outOfScopeFindings, fixLog, setAside, setFindingFixed, setFindingRejected, setFindingSetAside, setFindingStillPresent,',
    'setFindingOpen, setFindingUnresolved, setFindingOutOfScope, deferFinding, discardBatch})',
  ].join('\n')
  const h = vm.runInNewContext(source)
  const f = { fingerprint: 'src/a.js:run:logic', title: 'bug', primaryFile: 'src/a.js', files: ['src/a.js'] }
  const sizes = () => [h.knownFixed.size, h.knownDeferred.size, h.knownRejected.size,
    h.stillPresent.length, h.openReviewFindings.length, h.unresolvedFindings.length, h.outOfScopeFindings.length]
  h.setFindingOpen(f); assert.deepEqual(Array.from(sizes()), [0, 0, 0, 0, 1, 0, 0])
  h.setFindingSetAside({ ...f, title: 'lead', detail: 'possible bug', evidence: 'src/a.js:1',
    severity: 'high', releaseBlocker: true, blockerReason: 'crash' }, 'not investigated')
  assert.equal(h.setAside.get('src/a.js:run:logic').primaryFile, 'src/a.js')
  assert.equal(h.setAside.get('src/a.js:run:logic').releaseBlocker, true)
  h.setFindingRejected(f.fingerprint, 'guard exists'); assert.deepEqual(Array.from(sizes()), [0, 0, 1, 0, 0, 0, 0])
  h.setFindingStillPresent(f, 'b1'); assert.deepEqual(Array.from(sizes()), [0, 0, 0, 1, 0, 0, 0])
  h.deferFinding(f, 'too large'); assert.deepEqual(Array.from(sizes()), [0, 1, 0, 0, 0, 0, 0])
  h.setFindingFixed({ fingerprint: f.fingerprint, changeSummary: 'guarded' }, 'full', 'b2')
  assert.deepEqual(Array.from(sizes()), [1, 0, 0, 0, 0, 0, 0])
  h.setFindingUnresolved(f); assert.deepEqual(Array.from(sizes()), [0, 0, 0, 0, 0, 1, 0])
  assert.equal(h.fixLog.some(entry => entry.batchId === 'b2' && entry.fingerprint === f.fingerprint), true)
  h.setFindingOutOfScope({ finding: f }); assert.deepEqual(Array.from(sizes()), [0, 0, 0, 0, 0, 0, 1])
  h.setFindingOutOfScope({ finding: f }); assert.equal(h.outOfScopeFindings.length, 1)

  const rejected = { ...f, fingerprint: 'src/a.js:rejected:logic' }
  const deferred = { ...f, fingerprint: 'src/a.js:deferred:logic' }
  const attempted = { ...f, fingerprint: 'src/a.js:attempted:logic' }
  h.setFindingRejected(rejected.fingerprint, 'guard exists')
  h.deferFinding(deferred, 'explicitly deferred')
  h.setFindingFixed({ fingerprint: attempted.fingerprint, changeSummary: 'attempted edit' }, 'full', 'b3')
  h.discardBatch('b3', [{ fingerprint: attempted.fingerprint, changeSummary: 'attempted edit' }],
    [rejected, deferred, attempted], 'build failed')
  assert.equal(h.knownRejected.has(rejected.fingerprint), true)
  assert.equal(h.knownDeferred.has(deferred.fingerprint), true)
  assert.deepEqual(Array.from(h.stillPresent, row => row.finding.fingerprint), [attempted.fingerprint])
})

test('resume revalidates restored discovery and atomically records fixer follow-ups', () => {
  assert.match(WF, /const candidatesForVerification = candidates\s/)
  assert.doesNotMatch(WF, /candidates\.filter\(candidate => !candidate\.resumedCandidate\)/)
  assert.match(WF, /followUps: expanded\.followUps \|\| \[\]/)
  assert.match(WF, /snapshotVersion: 4[\s\S]*lineageCursor/)
  assert.match(WF, /sourceArtifacts/)
  assert.match(WF, /sha256: record\.sha256/)
  assert.match(WF, /fixWindow: fixWindowValue/)
  assert.match(WF, /import-journal --store/)
  assert.match(WF, /label: plan\.callerLabel/)
  assert.match(WF, /put-control --store/)
  assert.doesNotMatch(WF, /review-and-fix-pr-state\.js'\) \+ ' put --store/)
  assert.doesNotMatch(WF, /checkpoint-parts|stage checkpoint|\scompose --store/)
  const importHelper = WF.slice(WF.indexOf('async function importJournalArtifact'),
    WF.indexOf('async function checkpointControlState'))
  assert.equal((importHelper.match(/await agentSafe\(/g) || []).length, 1)
  assert.doesNotMatch(WF, /stageFixReceipt|receipt-prefix|receipt-parts/)
  assert.match(WF, /prepare-head[\s\S]{0,800}--receipt-base64/)
  assert.match(WF, /advance-head[\s\S]{0,800}--receipt-base64/)
  assert.match(WF, /const nonDerivableCoverageGaps = coverageGaps\.filter/)
  const noChanges = WF.slice(WF.lastIndexOf("if (res.outcome === 'no-changes')"),
    WF.lastIndexOf("if (res.outcome === 'no-changes')") + 1200)
  assert.match(noChanges, /checkpointDispositionState/)
  assert.match(WF, /prepareFixTransaction\(batchId, headSha, batches\[bi\]\)[\s\S]{0,500}fixerPrompt/)
  assert.match(WF, /c' \+ reviewCycle \+ '-w' \+ fixWindow \+ '-full-b'/)
  assert.doesNotMatch(WF, /findingStopTrigger && skippedLenses\.length/)
  assert.match(WF, /sealable = [\s\S]{0,220}stillPresent\.length === 0/)
  assert.match(WF, /build coverage manifest'[\s\S]{0,180}bashCommandClamp:[\s\S]{0,120}requireToolScope: true/)
  assert.match(WF, /rejection\.kind === 'out-of-scope'\) setFindingSetAside/)
  assert.match(WF, /missingImmutableUnits[\s\S]{0,500}coverage-error/)
  assert.match(WF, /semanticRecoveryImport = planJournalImport/)
  assert.match(WF, /importJournalArtifact\(semanticRefreshImport, semanticManifest\)/)
  assert.match(WF, /snapshot\.immutableSemanticUnits[\s\S]{0,120}immutableSemanticUnits =/)
  assert.match(WF, /const frozenScopeImport = planJournalImport\([\s\S]{0,240}'scope'/)
  assert.match(WF, /importJournalArtifact\(frozenScopeImport, frozenScopeSourceResult\)/)
  assert.doesNotMatch(WF, /checkpointState\('scope-' \+ stateClaim\.keyHash/)
  assert.match(WF, /importedReviewSource[\s\S]{0,180}'semantic-manifest'/)
  assert.match(WF, /claim-result --store/)
  assert.match(WF, /transactionId\.slice\(0, 16\)/)
  assert.match(WF, /--allowed-files-base64/)
  assert.match(WF, /terminalCycleCap = stopReason === 'cycle-cap'/)
  assert.match(WF, /normalizeFindingScope\(f, scope\)/)
  assert.match(WF, /current\.baselineLintOk === false/)
  assert.match(WF, /if \(base\.baselineLintOk === false\) base\.lintCmd = 'none'/)
  assert.match(WF, /const remainingChecks = \[base\.buildCmd, base\.lintCmd, base\.testCmd\]/)
  assert.match(WF, /const savedLocalCommits = ownedCommits\.map/)
  assert.match(WF, /ownedCommits\.push\(\{ from: oldHeadSha, to: res\.commitSha[\s\S]{0,300}lineageKeyHashByHead\.set/)
  assert.match(WF, /LOCAL COMMITS CREATED/)
  assert.match(WF, /reportState\.stopReason = 'state-seal-failed'/)
  assert.match(WF, /const statusSaved = await stateLifecycle/)
  assert.match(WF, /const unlocked = await stateLifecycle/)
  assert.ok(WF.lastIndexOf("refreshTranscriptTokens(scope, 'terminal exit')") < WF.indexOf('const sealable ='))
  assert.ok(WF.indexOf('const sealable =') < WF.lastIndexOf("' complete --store '"))
  assert.doesNotMatch(WF.slice(WF.lastIndexOf("' complete --store '")), /refreshTranscriptTokens\(scope, 'terminal exit'\)/)
  assert.match(WF, /const frozenScopeSourceResult = JSON\.parse\(JSON\.stringify\(scope\)\)/)
  assert.match(WF, /scope\.scopeFingerprint !== scopeProof\.scopeFingerprint/)
  assert.match(WF, /frozenScope\.outOfScope[\s\S]{0,160}scopeProof\.verifiedDeferrals/)
  assert.match(WF, /baseline-unavailable[\s\S]{0,500}No fixer ran and nothing was committed/)
  assert.doesNotMatch(WF, /baseline agent returned nothing - continuing UNVALIDATED/)
  assert.match(WF, /const cumulativeUnverified = new Map\(\)/)
  assert.match(WF, /VERIFICATION_MODE === 'none'[\s\S]{0,180}cumulativeUnverified\.set/)
  assert.match(WF, /candidate-identity-conflict/)
  assert.doesNotMatch(WF, /candidateId: 'cycle-' \+ reviewCycle \+ '-raw-' \+ \(rawCandidates\.length/)
  assert.match(WF, /reportingLenses: \['recovery'\][\s\S]{0,100}resumedCandidate: true/)
  for (const field of ['rawCandidateIds', 'reviewerRejected', 'validationDisagreement', 'supportingEvidence']) {
    assert.match(WF, new RegExp('delete copy\\.' + field))
  }
})

test('latest artifact lookup returns the artifact value while record lookup retains metadata', () => {
  const legacy = { headSha: 'a'.repeat(40), result: { lens: 'correctness' } }
  const imported = { importVersion: 1, binding: { headSha: 'b'.repeat(40) }, result: { lens: 'correctness' } }
  const source = [
    `const resumedArtifacts = new Map(${JSON.stringify([
      ['cycle-1/lenses/correctness.json', legacy],
      ['cycle-1/lenses/correctness-attempt-2.json', imported],
    ])})`,
    `const resumedArtifactRecords = new Map(${JSON.stringify([
      ['cycle-1/lenses/correctness-attempt-2.json', { sha256: 'c'.repeat(64), bytes: 123 }],
    ])})`,
    extractFn('latestArtifact'), extractFn('latestArtifactEntry'),
    "({ value: latestArtifact('cycle-1/lenses/correctness.json'), entry: latestArtifactEntry('cycle-1/lenses/correctness.json') })",
  ].join('\n')
  const restored = vm.runInNewContext(source)
  assert.deepEqual(JSON.parse(JSON.stringify(restored.value)), imported)
  assert.equal(restored.entry.attempt, 2)
  assert.equal(restored.entry.sha256, 'c'.repeat(64))
  assert.equal(restored.entry.bytes, 123)
})

test('control envelopes unwrap only with exact repository and lineage bindings', () => {
  const head = 'a'.repeat(40), keyHash = 'b'.repeat(64)
  const envelope = { controlVersion: 1, binding: { run: 'run-1', keyHash,
    repositoryIdentity: 'repo-id', headSha: head, artifactName: 'baseline.json' },
    value: { headSha: head, base: { mode: 'none' } } }
  const source = [
    "const stateClaim = { run: 'run-1', repository: { identity: 'repo-id' } }",
    `const lineageKeyHashByHead = new Map(${JSON.stringify([[head, keyHash]])})`,
    extractFn('controlArtifactValue'),
    `const envelope = ${JSON.stringify(envelope)};`,
    ";({ valid: controlArtifactValue('baseline.json', envelope),",
    "  wrongName: controlArtifactValue('scope.json', envelope),",
    "  wrongRepo: controlArtifactValue('baseline.json', { ...envelope, binding: { ...envelope.binding, repositoryIdentity: 'other' } }) })",
  ].join('\n')
  const result = vm.runInNewContext(source)
  assert.equal(result.valid.base.mode, 'none')
  assert.equal(result.wrongName, null)
  assert.equal(result.wrongRepo, null)
})

test('frozen scope restores source-backed and legacy semantics without accepting wrong identity', () => {
  const head = 'a'.repeat(40), fingerprint = 'b'.repeat(64)
  const scope = {
    repo: 'owner/repo', prNumber: 7, mergeBaseSha: 'c'.repeat(40), headSha: head, startSha: head,
    scopeFingerprint: fingerprint, intent: 'original semantic interpretation',
    coverageUnits: [{ id: 'requirement:1', type: 'requirement', path: 'none', symbol: 'file-level',
      hash: 'none', summary: 'original requirement' }],
  }
  const imported = { importVersion: 1, binding: { headSha: head, kind: 'scope',
    resultId: fingerprint, sourcePhase: 'Scope' }, result: scope }
  const legacy = { scope, stateKey: { scopeFingerprint: fingerprint, base: scope.mergeBaseSha, prHead: head } }
  const source = [
    `const canonicalInitialHead = ${JSON.stringify(head)}`,
    `const stateKey = ${JSON.stringify({ repo: scope.repo, pr: scope.prNumber, base: scope.mergeBaseSha,
      prHead: head, scopeFingerprint: fingerprint })}`,
    'const importedArtifactResult = (value, expected) => value && value.importVersion === 1 && value.binding &&',
    '  value.binding.headSha === expected.headSha && value.binding.kind === expected.kind &&',
    '  value.binding.resultId === expected.resultId && value.binding.sourcePhase === expected.sourcePhase',
    '    ? value.result : null',
    extractFn('frozenScopeArtifactResult'),
    `const imported = ${JSON.stringify(imported)}, legacy = ${JSON.stringify(legacy)}`,
    `;({ imported: frozenScopeArtifactResult('scope-${'d'.repeat(64)}.json', imported),`,
    `legacy: frozenScopeArtifactResult('scope-${'e'.repeat(64)}.json', legacy),`,
    `wrongHead: frozenScopeArtifactResult('scope-${'f'.repeat(64)}.json',`,
    "  { ...imported, binding: { ...imported.binding, headSha: '9'.repeat(40) } }),",
    "wrongFingerprint: frozenScopeArtifactResult('scope-' + '1'.repeat(64) + '.json',",
    "  { ...imported, result: { ...imported.result, scopeFingerprint: '8'.repeat(64) } }) })",
  ].join('\n')
  const result = vm.runInNewContext(source)
  assert.equal(result.imported.intent, scope.intent)
  assert.equal(result.imported.coverageUnits[0].summary, 'original requirement')
  assert.equal(result.legacy.intent, scope.intent)
  assert.equal(result.wrongHead, null)
  assert.equal(result.wrongFingerprint, null)
})

test('v3 reconstruction reproduces imported review evidence and compact dispositions', () => {
  const head = 'a'.repeat(40)
  const run = 'run-1'
  const first = finding('high', { fingerprint: 'src/a.js:run:logic', candidateId: undefined,
    files: ['src/a.js'], coverageUnitIds: ['u1'] })
  const second = finding('medium', { fingerprint: 'src/b.js:test:test-gap', candidateId: undefined,
    primaryFile: 'src/b.js', files: ['src/b.js'], symbol: 'testRun', defectClass: 'test-gap',
    mechanism: 'missing assertion', observableImpact: 'regression escapes', coverageUnitIds: ['u2'] })
  const envelope = (kind, resultId, result) => ({ importVersion: 1,
    binding: { run, keyHash: 'b'.repeat(64), repositoryIdentity: 'repo', headSha: head,
      kind, resultId, sourceLabel: 'source-' + resultId, sourcePhase: kind === 'verification' ? 'Validate' : 'Review',
      workflowId: 'wf', sourceKey: 'key-' + resultId, agentId: 'agent-' + resultId }, result })
  const artifacts = [
    ['cycle-2/lenses/correctness.json', envelope('lens', 'correctness', {
      lens: 'correctness', findings: [first], rejected: [], followUps: [{ title: 'follow', detail: 'd', area: 'a' }],
      coverageReceipts: [{ unitId: 'u1' }],
    })],
    ['cycle-2/gaps/g1.json', envelope('gap', 'gap-g1', {
      lens: 'gap-g1', findings: [second], rejected: [], followUps: [], coverageReceipts: [{ unitId: 'u2' }],
    })],
    ['cycle-2/coverage/initial-audit.json', envelope('coverage-audit', 'initial', {
      gaps: [{ id: 'old-gap' }],
    })],
    ['cycle-2/coverage/final-audit.json', envelope('coverage-audit', 'final', {
      gaps: [{ id: 'remaining-gap' }],
    })],
    ['cycle-2/verification/first.json', envelope('verification', 'first', {
      confirmed: [{ candidateId: 'placeholder', finding: first }], rejected: [], unresolved: [],
    })],
  ]
  for (const [name, value] of artifacts) value.binding.artifactName = name
  const refs = artifacts.map(([name], index) => ({ name, sha256: String(index + 1).repeat(64).slice(0, 64),
    bytes: 100 + index }))
  const records = refs.map(ref => [ref.name, { sha256: ref.sha256, bytes: ref.bytes }])
  const source = [
    "const stateClaim = { run: 'run-1' }, resumedArtifacts = new Map()",
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    extractFn('canonicalJson'), extractFn('sha256Utf8'), extractFn('canonicalJsonSha256'),
    extractFn('identityHex'), extractFn('normalizedFingerprint'), extractFn('stableRawCandidateId'),
    extractFn('stableFindingOccurrenceIndexes'),
    extractFn('reconstructionFindingKey'), extractFn('sourceResultRecord'), extractFn('normalizeSourceArtifactRef'),
    extractFn('reconstructReviewSourceState'), extractFn('resolveRawLocator'),
    extractFn('canonicalJson'), extractFn('sha256Utf8'),
    `const COMPACT_FINDING_STATE_FIELDS = ${JSON.stringify([
      'title', 'detail', 'primaryFile', 'files', 'symbol', 'defectClass', 'evidence', 'supportingEvidence',
      'trigger', 'mechanism', 'observableImpact', 'baseVsHead', 'coverageUnitIds', 'severity', 'confidence',
      'fixSize', 'defer', 'deferReason', 'releaseBlocker', 'blockerReason', 'scopeLabel', 'deferralQuote',
      'validationStatus', 'validationReason', 'whyStillHere',
    ])}`,
    extractFn('applyCompactFindingStateDelta'),
    extractFn('decodeCompactDispositionSnapshot'),
    `const refs = ${JSON.stringify(refs)}`,
    `const values = new Map(${JSON.stringify(artifacts)})`,
    `const records = new Map(${JSON.stringify(records)})`,
    `const rebuilt = reconstructReviewSourceState(refs, values, records, ${JSON.stringify(run)})`,
    'const context = { catalog: rebuilt.rawCandidates.map(candidate => ({ ...candidate })),',
    `  catalogHeads: [${JSON.stringify(head)}, ${JSON.stringify(head)}],`,
    '  rawLocations: rebuilt.rawLocations, reviewSources: rebuilt }',
    'const snapshot = { sourceArtifacts: refs, live: { rejected: [], rejectedHints: [], setAside: [], deferred: [],',
    `  stillPresent: [], open: [[0, 'eligible; confirmed', ${JSON.stringify(head)}, { set: { validationStatus: 'eligible; confirmed' }, unset: [] }]],`,
    `  unresolved: [[1, 'needs another check', ${JSON.stringify(head)}, { set: { validationReason: 'needs another check' }, unset: [] }]], outOfScope: [] },`,
    "  cumulative: { candidates: [[0, 'high', 'likely', 'logic', 'in', 0, 0], [1, 'medium', 'likely', 'test-gap', 'in', 0, 0]],",
    "    confirmed: [[0, 'high', 'likely', 'logic', 'in', 0, 0]], unverified: [] },",
    `  rawDispositions: [[['s', 0, 0], 'confirmed', 2, ${JSON.stringify('cluster-' + 'a'.repeat(64))}], [['s', 1, 0], 'unresolved', 2, ${JSON.stringify('cluster-' + 'b'.repeat(64))}]] }`,
    `const decoded = decodeCompactDispositionSnapshot(snapshot, context, values, ${JSON.stringify(run)})`,
    ';({ rebuilt, decoded })',
  ].join('\n')
  const result = vm.runInNewContext(source)
  assert.deepEqual(Array.from(result.rebuilt.completedLenses), ['correctness', 'gap-g1'])
  assert.equal(result.rebuilt.rawCandidates.length, 2)
  assert.match(result.rebuilt.rawCandidates[0].candidateId, /^raw:c2:h/)
  assert.deepEqual(Array.from(result.rebuilt.coverageReceipts, row => row.receipts[0].unitId), ['u1', 'u2'])
  assert.equal(result.rebuilt.followUps[0].title, 'follow')
  assert.equal(result.rebuilt.verification.first.confirmed.length, 1)
  assert.deepEqual(Array.from(result.rebuilt.coverage.activeGaps, gap => gap.id), ['remaining-gap'])
  assert.equal(result.decoded.live.open[0].validationStatus, 'eligible; confirmed')
  assert.equal(result.decoded.live.unresolved[0].validationReason, 'needs another check')
  assert.deepEqual(Array.from(result.decoded.cumulative.candidates, item => item.severity), ['high', 'medium'])
  assert.deepEqual(Array.from(result.decoded.rawDispositions, item => item.status), ['confirmed', 'unresolved'])
  assert.equal(result.decoded.rawDispositions[0].rawCandidateId, result.rebuilt.rawCandidates[0].candidateId)
  assert.deepEqual(Array.from(result.decoded.reviewSources.coverage.activeGaps, gap => gap.id), ['remaining-gap'])
})

test('v3 live finding restoration stays bound to the latest head occurrence', () => {
  const oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40)
  const oldFinding = finding('critical', { candidateId: 'old', files: ['src/old.js'],
    evidence: 'src/old.js:1 stale', detail: 'stale occurrence' })
  const newFinding = finding('low', { candidateId: 'new', files: ['src/new.js'],
    evidence: 'src/new.js:9 current', detail: 'current occurrence', validationStatus: 'eligible; confirmed' })
  const stateFields = ['title', 'detail', 'primaryFile', 'files', 'symbol', 'defectClass', 'evidence',
    'supportingEvidence', 'trigger', 'mechanism', 'observableImpact', 'baseVsHead', 'coverageUnitIds',
    'severity', 'confidence', 'fixSize', 'defer', 'deferReason', 'releaseBlocker', 'blockerReason',
    'scopeLabel', 'deferralQuote', 'validationStatus', 'validationReason', 'whyStillHere']
  const source = [
    `const COMPACT_FINDING_STATE_FIELDS = ${JSON.stringify(stateFields)}`,
    extractFn('canonicalJson'), extractFn('compactFindingStateDelta'), extractFn('applyCompactFindingStateDelta'),
    "const stateClaim = { run: 'run-1' }, resumedArtifacts = new Map()",
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    extractFn('canonicalJson'), extractFn('sha256Utf8'), extractFn('canonicalJsonSha256'),
    extractFn('identityHex'), extractFn('normalizedFingerprint'), extractFn('stableRawCandidateId'),
    extractFn('reconstructionFindingKey'), extractFn('sourceResultRecord'), extractFn('resolveRawLocator'),
    extractFn('decodeCompactDispositionSnapshot'),
    `const oldFinding = ${JSON.stringify(oldFinding)}, newFinding = ${JSON.stringify(newFinding)}`,
    'const delta = compactFindingStateDelta(newFinding, newFinding)',
    `const context = { catalog: [oldFinding, newFinding], catalogHeads: [${JSON.stringify(oldHead)}, ${JSON.stringify(newHead)}],`,
    '  reviewSources: { marker: true } }',
    `const snapshot = { sourceArtifacts: [], live: { rejected: [], rejectedHints: [], setAside: [], deferred: [], stillPresent: [],
      open: [[1, 'eligible; confirmed', ${JSON.stringify(newHead)}, delta]], unresolved: [], outOfScope: [] },
      cumulative: { candidates: [], confirmed: [], unverified: [] }, rawDispositions: [] }`,
    "const decoded = decodeCompactDispositionSnapshot(snapshot, context, new Map(), 'run-1')",
    ';decoded.live.open[0]',
  ].join('\n')
  const restored = vm.runInNewContext(source)
  assert.deepEqual(Array.from(restored.files), ['src/new.js'])
  assert.equal(restored.severity, 'low')
  assert.equal(restored.evidence, 'src/new.js:9 current')
  assert.doesNotMatch(JSON.stringify(restored), /old\.js|stale occurrence/)
})

test('v3 disposition deltas remain under the relay cap across 20 findings and cycles', () => {
  const head = 'a'.repeat(40)
  const findings = Array.from({ length: 20 }, (_, index) => finding(index % 2 ? 'medium' : 'high', {
    candidateId: 'cluster-' + String(index).padStart(2, '0'), symbol: 'symbol-' + index,
    trigger: 'trigger-' + index, mechanism: 'mechanism-' + index,
    observableImpact: 'impact-' + index, files: ['src/file-' + index + '.js'],
  }))
  const source = [
    extractFn('canonicalJson'), extractFn('sha256Utf8'), extractFn('canonicalJsonSha256'),
    extractFn('identityHex'), extractFn('normalizedFingerprint'), extractFn('reconstructionFindingKey'),
    `const LIVE_HEAD_INDEX = ${JSON.stringify({ rejected: 2, rejectedHints: 2, setAside: 2,
      deferred: 3, stillPresent: 4, open: 2, unresolved: 2, outOfScope: 3 })}`,
    extractFn('emptyDispositionMaterialized'), extractFn('dispositionLiveKey'),
    extractFn('materializeDispositionFull'), extractFn('dispositionDelta'),
    extractFn('applyDispositionDelta'), extractFn('fullDispositionFromMaterialized'),
    `const head = ${JSON.stringify(head)}, catalog = ${JSON.stringify(findings)}, catalogHeads = Array(20).fill(head)`,
    'const context = { catalog, catalogHeads }',
    'let previous = emptyDispositionMaterialized(), replayed = emptyDispositionMaterialized(), previousRef = null',
    'const snapshots = []',
    'for (let cycle = 1; cycle <= 20; cycle++) {',
    '  const open = []; const candidates = []; const rawDispositions = []; const extraFollowUps = []',
    '  for (let index = 0; index < 20; index++) {',
    "    open.push([index, 'eligible; confirmed', head, { set: {}, unset: [] }])",
    "    candidates.push([index, catalog[index].severity, 'likely', 'logic', 'in', 0, 0])",
    "    rawDispositions.push([['c', index, 'recovery', head], 'confirmed', 1, 'cluster-' + String(index).padStart(64, '0')])",
    '  }',
    '  const full = { live: { rejected: [], rejectedHints: [], setAside: [], deferred: [], stillPresent: [],',
    '    open, unresolved: [], outOfScope: [] }, cumulative: { candidates, confirmed: candidates, unverified: [] },',
    '    rawDispositions, extraFollowUps }',
    '  const current = materializeDispositionFull(full, context); const delta = dispositionDelta(previous, current)',
    "  const ref = { name: 'cycle-' + cycle + '/dispositions.json', sha256: String(cycle).padStart(64, '0'), bytes: 400 }",
    "  const sourceArtifacts = Array.from({ length: cycle === 1 ? 13 : 1 }, (_, sourceIndex) => ([",
    "    'cycle-' + cycle + '/lenses/l' + sourceIndex + '.json', 'c'.repeat(64), 100]))",
    "  snapshots.push({ snapshotVersion: 3, headSha: head, keyHash: 'b'.repeat(64), lineageCursor: cycle - 1,",
    '    fixWindow: 1, previousDisposition: previousRef, sourceArtifacts, delta })',
    '  if (!applyDispositionDelta(replayed, delta, context)) throw new Error("delta failed")',
    '  previous = current; previousRef = ref',
    '}',
    ';({ snapshots, finalExpected: fullDispositionFromMaterialized(previous), finalActual: fullDispositionFromMaterialized(replayed) })',
  ].join('\n')
  const result = vm.runInNewContext(source)
  for (const snapshot of result.snapshots) {
    const encodedBytes = Buffer.from(JSON.stringify(snapshot)).toString('base64').length
    assert.ok(encodedBytes <= 8192, 'encoded disposition bytes: ' + encodedBytes)
    assert.ok(snapshot.sourceArtifacts.length <= 13)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(result.finalActual)), JSON.parse(JSON.stringify(result.finalExpected)))
  assert.equal(result.snapshots[0].previousDisposition, null)
  assert.equal(result.snapshots[19].previousDisposition.name, 'cycle-19/dispositions.json')
  assert.match(WF, /visited\.has\(name\)/)
  assert.match(WF, /record\.sha256 !== expected\.sha256 \|\| record\.bytes !== expected\.bytes/)
})

test('mixed v3/v4 disposition chain resolves oldest-to-newest and rejects hash mismatches or cycles', () => {
  const rootName = 'cycle-1/dispositions.json', nextName = 'cycle-2/dispositions.json'
  const rootRef = { name: rootName, sha256: 'a'.repeat(64), bytes: 300 }
  const sourceOne = { name: 'cycle-1/lenses/a.json', sha256: 'c'.repeat(64), bytes: 100 }
  const sourceTwo = { name: 'cycle-2/lenses/b.json', sha256: 'd'.repeat(64), bytes: 110 }
  const emptyDelta = { h: [], ls: [], ld: [], cs: [], r: [], rr: 0, fs: [], fd: [] }
  const root = { snapshotVersion: 3, sourceArtifacts: [sourceOne], previousDisposition: null,
    delta: { ...emptyDelta, fs: [{ title: 'first' }] } }
  const next = { snapshotVersion: 4, sourceArtifacts: [sourceTwo], previousDisposition: rootRef,
    delta: { ...emptyDelta, fs: [{ title: 'second' }] } }
  const run = (rootValue, nextValue) => vm.runInNewContext([
    `const resumedArtifacts = new Map(${JSON.stringify([[rootName, { value: rootValue }],
      [nextName, { value: nextValue }], [sourceOne.name, {}], [sourceTwo.name, {}]])})`,
    `const resumedArtifactRecords = new Map(${JSON.stringify([[rootName, { sha256: rootRef.sha256, bytes: rootRef.bytes }],
      [nextName, { sha256: 'b'.repeat(64), bytes: 320 }], [sourceOne.name, sourceOne], [sourceTwo.name, sourceTwo]])})`,
    'const LIVE_HEAD_INDEX = { rejected: 2, rejectedHints: 2, setAside: 2, deferred: 3, stillPresent: 4, open: 2, unresolved: 2, outOfScope: 3 }',
    extractFn('canonicalJson'), extractFn('sha256Utf8'), extractFn('canonicalJsonSha256'),
    extractFn('normalizeSourceArtifactRef'),
    extractFn('emptyDispositionMaterialized'), extractFn('applyDispositionDelta'),
    'const dispositionSnapshotValue = (name, stored) => stored && stored.value',
    'const buildReconstructionContext = () => ({ catalog: [] })',
    'const materializeDispositionFull = () => null', extractFn('resolveDispositionChain'),
    `resolveDispositionChain(${JSON.stringify(nextName)})`,
  ].join('\n'))
  const resolved = run(root, next)
  assert.deepEqual(Array.from(resolved.sourceArtifacts, ref => ref.name), [sourceOne.name, sourceTwo.name])
  assert.deepEqual(Array.from(resolved.materialized.followUps.values(), item => item.title), ['first', 'second'])
  assert.equal(run(root, { ...next, previousDisposition: { ...rootRef, sha256: 'e'.repeat(64) } }), null)
  assert.equal(run({ ...root, previousDisposition: { name: nextName, sha256: 'b'.repeat(64), bytes: 320 } }, next), null)
})

test('verification-none receipt candidates rebuild per head without semantic cross-head merging', () => {
  const oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40)
  const oldFinding = finding('critical', { files: ['src/a.js', 'src/old.js'], evidence: 'src/old.js:1 stale' })
  const newFinding = finding('low', { files: ['src/a.js', 'src/new.js'], evidence: 'src/new.js:9 current' })
  const envelope = (head, result) => ({ importVersion: 1, binding: { run: 'run-1', headSha: head,
    kind: 'lens', resultId: 'correctness' }, result })
  const artifacts = [
    ['cycle-1/lenses/correctness.json', envelope(oldHead, { lens: 'correctness', findings: [oldFinding] })],
    ['cycle-2/lenses/correctness.json', envelope(newHead, { lens: 'correctness', findings: [newFinding] })],
  ]
  for (const [name, value] of artifacts) value.binding.artifactName = name
  const source = [
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    'const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }',
    'const severityRank = s => SEV_RANK[s] === undefined ? 9 : SEV_RANK[s]',
    extractFn('canonicalJson'), extractFn('sha256Utf8'), extractFn('canonicalJsonSha256'),
    extractFn('identityHex'), extractFn('normalizedFingerprint'), extractFn('stableRawCandidateId'),
    extractFn('stableFindingOccurrenceIndexes'),
    extractFn('mergeFinding'), extractFn('stableClusterCandidateId'), extractFn('clusterCandidates'), extractFn('sourceResultRecord'),
    extractFn('normalizeSourceArtifactRef'), extractFn('exactArtifactAttempt'),
    extractFn('latestLogicalReceiptSources'), extractFn('reconstructReceiptCandidates'),
    `const artifacts = new Map(${JSON.stringify(artifacts)})`,
    `reconstructReceiptCandidates(${JSON.stringify(artifacts.map(([name]) => ({ name,
      sha256: 'f'.repeat(64), bytes: 1 })))}, artifacts, 'run-1')`,
  ].join('\n')
  const candidates = vm.runInNewContext(source)
  assert.equal(candidates.length, 2)
  const old = candidates.find(candidate => candidate.files.includes('src/old.js'))
  const current = candidates.find(candidate => candidate.files.includes('src/new.js'))
  assert.deepEqual(Array.from(old.files), ['src/a.js', 'src/old.js'])
  assert.equal(old.severity, 'critical')
  assert.deepEqual(Array.from(current.files), ['src/a.js', 'src/new.js'])
  assert.equal(current.severity, 'low')
})

test('verification-none same-defect replay is equivalent under reversed lens order', () => {
  const head = 'a'.repeat(40)
  const first = finding('medium', { files: ['src/a.js'], evidence: 'src/a.js:1 short' })
  const second = finding('high', { files: ['src/a.js'], evidence: 'src/a.js:1 substantially longer evidence' })
  const entry = (lens, findingValue) => {
    const name = 'cycle-1/lenses/' + lens + '.json'
    return [name, { importVersion: 1, binding: { run: 'run-1', headSha: head, kind: 'lens',
      resultId: lens, artifactName: name }, result: { lens, findings: [findingValue] } }]
  }
  const artifacts = [entry('correctness', first), entry('security', second)]
  const source = [
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    'const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }',
    'const severityRank = s => SEV_RANK[s] === undefined ? 9 : SEV_RANK[s]',
    extractFn('canonicalJson'), extractFn('sha256Utf8'), extractFn('canonicalJsonSha256'),
    extractFn('identityHex'), extractFn('normalizedFingerprint'), extractFn('stableRawCandidateId'),
    extractFn('stableFindingOccurrenceIndexes'),
    extractFn('mergeFinding'), extractFn('stableClusterCandidateId'), extractFn('clusterCandidates'),
    extractFn('sourceResultRecord'), extractFn('normalizeSourceArtifactRef'), extractFn('exactArtifactAttempt'),
    extractFn('latestLogicalReceiptSources'), extractFn('reconstructReceiptCandidates'),
    `const values = new Map(${JSON.stringify(artifacts)})`,
    `const forwardRefs = ${JSON.stringify(artifacts.map(([name]) => ({ name,
      sha256: 'f'.repeat(64), bytes: 1 })))}`,
    "const forward = reconstructReceiptCandidates(forwardRefs, values, 'run-1')[0]",
    "const reversed = reconstructReceiptCandidates(forwardRefs.slice().reverse(), values, 'run-1')[0]",
    ';({ forward, reversed })',
  ].join('\n')
  const result = vm.runInNewContext(source)
  assert.equal(result.forward.candidateId, result.reversed.candidateId)
  assert.equal(result.forward.severity, result.reversed.severity)
  assert.equal(result.forward.evidence, result.reversed.evidence)
  assert.deepEqual(Array.from(result.forward.rawCandidateIds).sort(),
    Array.from(result.reversed.rawCandidateIds).sort())
})

test('receipt reconstruction uses only the latest immutable attempt for each logical source', () => {
  const head = 'a'.repeat(40)
  const first = finding('high', { primaryFile: 'src/a.js', files: ['src/a.js'], symbol: 'a' })
  const second = finding('medium', { primaryFile: 'src/b.js', files: ['src/b.js'], symbol: 'b' })
  const envelope = findings => ({ importVersion: 1, binding: { run: 'run-1', headSha: head,
    kind: 'lens', resultId: 'correctness' }, result: { lens: 'correctness', findings } })
  const artifacts = [
    ['cycle-1/lenses/correctness.json', envelope([first, second])],
    ['cycle-1/lenses/correctness-attempt-2.json', envelope([second, first])],
  ]
  for (const [name, value] of artifacts) value.binding.artifactName = name
  const source = [
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    'const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }',
    'const severityRank = s => SEV_RANK[s] === undefined ? 9 : SEV_RANK[s]',
    extractFn('canonicalJson'), extractFn('sha256Utf8'), extractFn('canonicalJsonSha256'),
    extractFn('identityHex'), extractFn('normalizedFingerprint'), extractFn('stableRawCandidateId'),
    extractFn('stableFindingOccurrenceIndexes'),
    extractFn('mergeFinding'), extractFn('stableClusterCandidateId'), extractFn('clusterCandidates'), extractFn('sourceResultRecord'),
    extractFn('normalizeSourceArtifactRef'), extractFn('exactArtifactAttempt'),
    extractFn('latestLogicalReceiptSources'), extractFn('reconstructReceiptCandidates'),
    `const artifacts = new Map(${JSON.stringify(artifacts)})`,
    `reconstructReceiptCandidates(${JSON.stringify(artifacts.map(([name]) => ({ name,
      sha256: 'f'.repeat(64), bytes: 1 })))}, artifacts, 'run-1')`,
  ].join('\n')
  const candidates = vm.runInNewContext(source)
  assert.equal(candidates.length, 2)
  assert.match(candidates[0].candidateId, /^cluster-[a-f0-9]{64}$/)
  assert.match(candidates[0].rawCandidateIds[0], /^raw:c1:/)
  assert.equal(candidates[0].primaryFile, 'src/b.js')
  assert.match(candidates[1].candidateId, /^cluster-[a-f0-9]{64}$/)
  assert.match(candidates[1].rawCandidateIds[0], /^raw:c1:/)
  assert.equal(candidates[1].primaryFile, 'src/a.js')
  assert.notEqual(candidates[0].candidateId, candidates[1].candidateId)
})

test('authenticated gap identities ending in failure or attempt suffix remain valid sources', () => {
  const head = 'a'.repeat(40)
  const entry = (name, resultId) => [name, { importVersion: 1, binding: {
    run: 'run-1', headSha: head, kind: 'gap', resultId, artifactName: name,
  }, result: { lens: resultId, findings: [] } }]
  const artifacts = [
    entry('cycle-1/gaps/cache-failure.json', 'gap-cache-failure'),
    entry('cycle-1/gaps/retry-attempt-2.json', 'gap-retry-attempt-2'),
    entry('cycle-1/gaps/retry-attempt-2-attempt-2.json', 'gap-retry-attempt-2'),
  ]
  const source = [
    "const stateClaim = { run: 'run-1' }, resumedArtifacts = new Map()",
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    extractFn('normalizeSourceArtifactRef'), extractFn('exactArtifactAttempt'), extractFn('latestLogicalReceiptSources'),
    `const values = new Map(${JSON.stringify(artifacts)})`,
    `latestLogicalReceiptSources(${JSON.stringify(artifacts.map(([name]) => ({ name,
      sha256: 'f'.repeat(64), bytes: 1 })))}, values, 'run-1')`,
  ].join('\n')
  const selected = vm.runInNewContext(source)
  assert.deepEqual(Array.from(selected, ref => ref.name).sort(), [
    'cycle-1/gaps/cache-failure.json',
    'cycle-1/gaps/retry-attempt-2-attempt-2.json',
  ])
})

test('receipt reconstruction applies double verification in first-then-challenge order', () => {
  const head = 'a'.repeat(40)
  const raw = finding('high', { files: ['src/a.js'], evidence: 'src/a.js:1 raw' })
  const sourceName = 'lens:correctness'
  const rawIdSource = [extractFn('identityHex'), extractFn('normalizedFingerprint'), extractFn('stableRawCandidateId'),
    `stableRawCandidateId(1, ${JSON.stringify(head)}, ${JSON.stringify(sourceName)}, 0, ${JSON.stringify(raw)})`,
  ].join('\n')
  const rawId = vm.runInNewContext(rawIdSource)
  const candidateId = helpers().clusterCandidates([{ ...raw, candidateId: rawId }])[0].candidateId
  const first = { ...raw, severity: 'medium', evidence: 'src/a.js:2 first', fixSize: 'large' }
  const challenge = { ...raw, severity: 'low', evidence: 'src/a.js:3 challenge', fixSize: 'trivial' }
  const envelope = (kind, resultId, result) => ({ importVersion: 1,
    binding: { run: 'run-1', headSha: head, kind, resultId }, result })
  const artifacts = [
    ['cycle-1/lenses/correctness.json', envelope('lens', 'correctness', { lens: 'correctness', findings: [raw] })],
    // Lexical export order puts challenge before first; reconstruction must override that order.
    ['cycle-1/verification/challenge.json', envelope('verification', 'challenge', {
      confirmed: [{ candidateId, finding: challenge }], rejected: [], unresolved: [] })],
    ['cycle-1/verification/first.json', envelope('verification', 'first', {
      confirmed: [{ candidateId, finding: first }], rejected: [], unresolved: [] })],
  ]
  for (const [name, value] of artifacts) value.binding.artifactName = name
  const source = [
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    'const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }',
    'const severityRank = s => SEV_RANK[s] === undefined ? 9 : SEV_RANK[s]',
    extractFn('canonicalJson'), extractFn('sha256Utf8'), extractFn('canonicalJsonSha256'),
    extractFn('identityHex'), extractFn('normalizedFingerprint'), extractFn('stableRawCandidateId'),
    extractFn('stableFindingOccurrenceIndexes'),
    extractFn('mergeFinding'), extractFn('stableClusterCandidateId'), extractFn('clusterCandidates'), extractFn('sourceResultRecord'),
    extractFn('normalizeSourceArtifactRef'), extractFn('exactArtifactAttempt'),
    extractFn('latestLogicalReceiptSources'), extractFn('reconstructReceiptCandidates'),
    `const artifacts = new Map(${JSON.stringify(artifacts)})`,
    `reconstructReceiptCandidates(${JSON.stringify(artifacts.map(([name]) => ({ name,
      sha256: 'f'.repeat(64), bytes: 1 })))}, artifacts, 'run-1')`,
  ].join('\n')
  const candidates = vm.runInNewContext(source)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].severity, 'low')
  assert.equal(candidates[0].evidence, 'src/a.js:3 challenge')
  assert.equal(candidates[0].fixSize, 'trivial')
})

test('v3 imported sources are bound to the trusted lineage head-key mapping', () => {
  const firstHead = 'a'.repeat(40), secondHead = 'b'.repeat(40)
  const firstKey = 'c'.repeat(64), secondKey = 'd'.repeat(64)
  const source = [extractFn('trustedLineageKeyHashes'), extractFn('validateImportedSourceBinding'),
    `const lineage = ${JSON.stringify({ initialHead: firstHead, currentHead: secondHead,
      initialKeyHash: firstKey, currentKeyHash: secondKey,
      ownedCommits: [{ from: firstHead, to: secondHead, fromKeyHash: firstKey, toKeyHash: secondKey }] })}`,
    'const hashes = trustedLineageKeyHashes(lineage)',
    `const value = ${JSON.stringify({ importVersion: 1, binding: { run: 'run-1', keyHash: firstKey,
      repositoryIdentity: 'repo-identity', headSha: firstHead, kind: 'lens', resultId: 'correctness' }, result: {} })}`,
    'const ref = { name: "cycle-1/lenses/correctness.json" }',
    "const valid = validateImportedSourceBinding(ref, value, 'run-1', hashes)",
    'const wrong = validateImportedSourceBinding(ref,',
    "  { ...value, binding: { ...value.binding, keyHash: 'e'.repeat(64) } }, 'run-1', hashes)",
    ';({ hashes, valid, wrong })',
  ].join('\n')
  const result = vm.runInNewContext(source)
  assert.equal(result.hashes.get(firstHead), firstKey)
  assert.equal(result.hashes.get(secondHead), secondKey)
  assert.equal(result.valid.repositoryIdentity, 'repo-identity')
  assert.equal(result.wrong, null)

  const mixedSource = [extractFn('trustedLineageKeyHashes'),
    `trustedLineageKeyHashes(${JSON.stringify({ initialHead: '1'.repeat(40), currentHead: '3'.repeat(40),
      initialKeyHash: null, currentKeyHash: secondKey, ownedCommits: [
        { from: '1'.repeat(40), to: '2'.repeat(40) },
        { from: '2'.repeat(40), to: '3'.repeat(40), fromKeyHash: firstKey, toKeyHash: secondKey },
      ] })})`,
  ].join('\n')
  const mixed = vm.runInNewContext(mixedSource)
  assert.equal(mixed.get('2'.repeat(40)), firstKey)
  assert.equal(mixed.get('3'.repeat(40)), secondKey)
})

test('ordinary imported artifact restore accepts the key bound to its expected lineage head', () => {
  const oldHead = 'a'.repeat(40), currentHead = 'b'.repeat(40)
  const oldKey = 'c'.repeat(64), currentKey = 'd'.repeat(64)
  const value = { importVersion: 1, binding: { run: 'run-1', keyHash: oldKey,
    repositoryIdentity: 'repo', headSha: oldHead, kind: 'lens', resultId: 'correctness',
    sourceLabel: 'source', sourcePhase: 'Review', workflowId: 'workflow', sourceKey: 'key', agentId: 'agent' },
    result: { lens: 'correctness' } }
  const source = [
    "const stateClaim = { run: 'run-1', keyHash: " + JSON.stringify(currentKey) + ' };',
    `const lineageKeyHashByHead = new Map(${JSON.stringify([[oldHead, oldKey], [currentHead, currentKey]])});`,
    extractFn('importedArtifactResult'),
    `const value = ${JSON.stringify(value)};`,
    `;({ restored: importedArtifactResult(value, ${JSON.stringify({ headSha: oldHead, kind: 'lens',
      resultId: 'correctness', sourcePhase: 'Review' })}), rejected: importedArtifactResult(value,
      ${JSON.stringify({ headSha: currentHead, kind: 'lens', resultId: 'correctness', sourcePhase: 'Review' })}) })`,
  ].join('\n')
  const result = vm.runInNewContext(source)
  assert.equal(result.restored.lens, 'correctness')
  assert.equal(result.rejected, null)
})

test('workflow canonical result digest matches the trusted helper for nested Unicode JSON', () => {
  const source = [extractFn('canonicalJson'), extractFn('sha256Utf8'),
    '({ canonicalJson, sha256Utf8, canonicalJsonSha256: value => sha256Utf8(canonicalJson(value)) })',
  ].join('\n')
  const digest = vm.runInNewContext(source)
  const fixtures = [
    { z: ['用户', { beta: true, alpha: 7 }], a: 'e\u0301', emoji: '🧪' },
    { nested: { d: null, c: [0, -1, 1.25] }, empty: {}, bool: false },
  ]
  for (const value of fixtures) {
    const expectedCanonical = JSON.stringify(value, Object.keys(value).sort())
    const helperCanonical = value => {
      if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return JSON.stringify(value)
      if (Array.isArray(value)) return '[' + value.map(helperCanonical).join(',') + ']'
      return '{' + Object.keys(value).sort()
        .map(key => JSON.stringify(key) + ':' + helperCanonical(value[key])).join(',') + '}'
    }
    assert.notEqual(expectedCanonical.length, 0)
    const canonical = helperCanonical(value)
    assert.equal(digest.canonicalJson(value), canonical)
    assert.equal(digest.canonicalJsonSha256(value),
      crypto.createHash('sha256').update(Buffer.from(canonical)).digest('hex'))
  }
})

test('compact v2 fix receipts expand exactly and fail closed on missing, ambiguous, or oversized state', () => {
  const first = finding('high', { candidateId: 'cluster-raw:c2:hhead:first', files: ['src/a.js'],
    coverageUnitIds: ['u1'] })
  const second = finding('medium', { candidateId: 'cluster-raw:c2:hhead:second',
    fingerprint: 'ignored-2', primaryFile: 'src/b.js', files: ['src/b.js'], symbol: 'other',
    mechanism: 'missing guard', observableImpact: 'throws', coverageUnitIds: ['u2'] })
  const fixerResult = {
    fixed: [{ fingerprint: first.fingerprint, changeSummary: 'guarded input' }],
    notABug: [],
    stillOpen: [{ ...second, whyStillHere: 'needs redesign', defer: true, deferReason: 'too large' }],
    followUps: [{ title: 'Add fuzzing', detail: 'exercise invalid inputs', area: 'tests', size: 'big',
      doneNow: false, releaseBlocker: false, blockerReason: 'none' }],
  }
  const source = [
    'const MAX_CONTROL_BASE64_BYTES = 8192',
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    'const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }',
    'const severityRank = s => SEV_RANK[s] === undefined ? 9 : SEV_RANK[s]',
    extractFn('canonicalJson'), extractFn('sha256Utf8'), extractFn('canonicalJsonSha256'),
    extractFn('utf8Base64'), extractFn('identityHex'), extractFn('normalizedFingerprint'),
    extractFn('safeFindingPath'), extractFn('mergeFinding'), extractFn('compactFindingId'),
    extractFn('buildCompactFixReceipt'), extractFn('inlineCompactFixReceipt'),
    extractFn('expandCompactFixReceipt'),
    `const batch = ${JSON.stringify([first, second])}`,
    `const result = ${JSON.stringify(fixerResult)}`,
    "const receipt = buildCompactFixReceipt('c2-w1-full-b1', batch, result)",
    'const expanded = expandCompactFixReceipt(receipt, batch)',
    'const missing = expandCompactFixReceipt(receipt, [batch[0]])',
    'const ambiguous = expandCompactFixReceipt(receipt, [batch[0], { ...batch[0], detail: "different" }, batch[1]])',
    'const oversized = inlineCompactFixReceipt({ ...receipt, followUps: [{ ...receipt.followUps[0], detail: "x".repeat(10000) }] })',
    `const oldOccurrence = ${JSON.stringify({ ...first, candidateId: 'cluster-old-head', severity: 'critical',
      files: ['src/a.js', 'src/old-helper.js'], evidence: 'src/old-helper.js:1 stale' })}`,
    `const newOccurrence = ${JSON.stringify({ ...first, candidateId: 'cluster-new-head', severity: 'low',
      files: ['src/a.js', 'src/new-helper.js'], evidence: 'src/new-helper.js:9 current' })}`,
    "const latestReceipt = buildCompactFixReceipt('c3-w1-full-b1', [newOccurrence], { fixed: [], notABug: [],",
    "  stillOpen: [{ ...newOccurrence, whyStillHere: 'current head', defer: false, deferReason: 'none' }], followUps: [] })",
    'const latestExpanded = expandCompactFixReceipt(latestReceipt, [oldOccurrence, newOccurrence])',
    ';({ receipt, expanded, missing, ambiguous, oversized, encoded: inlineCompactFixReceipt(receipt),',
    '  firstId: compactFindingId(batch[0]), secondId: compactFindingId(batch[1]), latestExpanded })',
  ].join('\n')
  const result = vm.runInNewContext(source)
  assert.equal(result.receipt.receiptVersion, 2)
  assert.deepEqual(Array.from(result.receipt.allowedPaths), ['src/a.js', 'src/b.js'])
  assert.equal(result.receipt.fixed[0].id, result.firstId)
  assert.equal(result.receipt.stillOpen[0].id, result.secondId)
  assert.match(result.encoded, /^[A-Za-z0-9+/]+=*$/)
  assert.equal(result.expanded.fixed[0].fingerprint, helpers().normalizedFingerprint(first))
  assert.equal(result.expanded.stillOpen[0].primaryFile, 'src/b.js')
  assert.equal(result.expanded.stillOpen[0].severity, 'medium')
  assert.equal(result.expanded.stillOpen[0].whyStillHere, 'needs redesign')
  assert.equal(result.missing, null)
  assert.equal(result.ambiguous, null)
  assert.equal(result.oversized, null)
  assert.deepEqual(Array.from(result.latestExpanded.stillOpen[0].files), ['src/a.js', 'src/new-helper.js'])
  assert.equal(result.latestExpanded.stillOpen[0].severity, 'low')
  assert.equal(result.latestExpanded.stillOpen[0].evidence, 'src/new-helper.js:9 current')
})

test('v4 disposition overlays source-backed prose and retain genuine overrides under the relay cap', () => {
  const base = finding('low', { evidence: 'src/a.js:1 ' + 'e'.repeat(240),
    reason: 'source rejection ' + 'r'.repeat(320) })
  const source = [
    extractFn('canonicalJson'), extractFn('sha256Utf8'),
    `const COMPACT_FINDING_STATE_FIELDS = ${JSON.stringify([
      'title', 'detail', 'primaryFile', 'files', 'symbol', 'defectClass', 'evidence',
      'supportingEvidence', 'trigger', 'mechanism', 'observableImpact', 'baseVsHead',
      'coverageUnitIds', 'severity', 'confidence', 'fixSize', 'defer', 'deferReason',
      'releaseBlocker', 'blockerReason', 'scopeLabel', 'deferralQuote', 'validationStatus',
      'validationReason', 'whyStillHere',
    ])}`,
    extractFn('compactFindingStateDelta'), extractFn('sourceBackedFindingStateDelta'),
    extractFn('sourceBackedReason'), extractFn('applyCompactFindingStateDelta'),
    `const base = ${JSON.stringify(base)}`,
    "const exact = { ...base, supportingEvidence: [base.evidence], validationReason: 'discovery did not complete' }",
    'const sourceEvidenceIndex = new Map([[base.evidence, 0]])',
    'const compact = sourceBackedFindingStateDelta(base, exact, sourceEvidenceIndex)',
    'const sourceEvidence = [base.evidence]',
    'const restored = applyCompactFindingStateDelta(base, compact, true, sourceEvidence)',
    "const laterBase = { ...base, evidence: 'later and longer evidence' }",
    'const restoredAfterLaterSource = applyCompactFindingStateDelta(laterBase, compact, true, sourceEvidence)',
    "const override = sourceBackedFindingStateDelta(base, { ...exact, supportingEvidence: [base.evidence, 'other'] })",
    ';({ base, compact, restored, restoredAfterLaterSource, override, derivedReason: sourceBackedReason(base, base.reason),',
    "  overrideReason: sourceBackedReason(base, 'different reason') })",
  ].join('\n')
  const result = vm.runInNewContext(source)
  assert.equal(result.compact.set.supportingEvidence.e, 0)
  assert.deepEqual(Array.from(result.restored.supportingEvidence), [base.evidence])
  assert.deepEqual(Array.from(result.restoredAfterLaterSource.supportingEvidence), [base.evidence])
  assert.deepEqual(Array.from(result.override.set.supportingEvidence), [base.evidence, 'other'])
  assert.equal(result.derivedReason, null)
  assert.equal(result.overrideReason, 'different reason')

  const head = 'a'.repeat(40)
  const emptyDelta = { set: {}, unset: [] }
  const live = {
    rejected: Array.from({ length: 8 }, (_, index) => [index, null, head, emptyDelta]),
    rejectedHints: [], setAside: [], deferred: [], stillPresent: [], open: [],
    unresolved: Array.from({ length: 13 }, (_, index) => [index,
      'discovery did not complete, so validation was not started', head,
      { set: { supportingEvidence: { e: index } }, unset: [] }]),
    outOfScope: [],
  }
  const rows = Array.from({ length: 13 }, (_, index) => [index, 'low', 'likely', 'logic', 'in', 0, 0])
  const snapshot = { snapshotVersion: 4, headSha: head, keyHash: 'b'.repeat(64), lineageCursor: 0,
    fixWindow: 1, previousDisposition: null,
    sourceArtifacts: Array.from({ length: 3 }, (_, index) => [
      `cycle-1/lenses/l${index}.json`, 'c'.repeat(64), 20000 + index]),
    delta: { h: [head], ls: Object.entries(live).flatMap(([bucket, values]) =>
      values.map(row => [bucket, row])), ld: [], cs: rows.map(row => [row, null, null]),
    r: rows.map((row, index) => [['s', index % 3, index], 'unresolved', 1,
      'cluster-' + String(index).padStart(64, '0')]), rr: 0, fs: [], fd: [] } }
  const encodedSnapshotBytes = Buffer.from(JSON.stringify(snapshot)).toString('base64').length
  assert.ok(encodedSnapshotBytes <= 8192, 'encoded v4 disposition bytes: ' + encodedSnapshotBytes)
})

test('lineage receipt replay requires an explicit valid v1 or v2 discriminator', () => {
  const fullFinding = finding('high', { title: 'Legacy issue', files: ['src/a.js'],
    coverageUnitIds: ['u1'], baseVsHead: 'introduced on head', deferReason: 'none',
    whyStillHere: 'not fixed' })
  const validV1 = { receiptVersion: 1, batchId: 'legacy-b1', fixed: [], notABug: [],
    stillOpen: [fullFinding], followUps: [] }
  const malformedV1 = { receiptVersion: 1, batchId: 'legacy-b1', fixed: [], notABug: [],
    stillOpen: [{ id: 'a'.repeat(64), whyStillHere: 'not fixed', defer: false, deferReason: 'none' }],
    followUps: [] }
  const omittedV2 = { batchId: 'compact-b1', allowedPaths: ['src/a.js'],
    fixed: [{ id: 'a'.repeat(64), changeSummary: 'changed' }], notABug: [], stillOpen: [], followUps: [] }
  const source = [
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    'const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }',
    extractFn('safeFindingPath'), extractFn('findingPathsSafe'), extractFn('validateLegacyFixReceipt'),
    'let statePersistenceFailed = false, absorbed = []; const log = () => {}',
    'const immutableReceiptCandidates = () => []; const expandCompactFixReceipt = () => null',
    'const absorbFix = value => absorbed.push(value)', extractFn('replayReceipt'),
    `const validV1 = ${JSON.stringify(validV1)}, malformedV1 = ${JSON.stringify(malformedV1)}, omittedV2 = ${JSON.stringify(omittedV2)}`,
    'const omittedOk = replayReceipt({ from: "a".repeat(40), receipt: omittedV2 })',
    'const omittedState = { failed: statePersistenceFailed, absorbed: absorbed.length }',
    'statePersistenceFailed = false; absorbed = []',
    'const malformedOk = replayReceipt({ from: "a".repeat(40), receipt: malformedV1 })',
    'const malformedState = { failed: statePersistenceFailed, absorbed: absorbed.length }',
    'statePersistenceFailed = false; absorbed = []',
    'const validOk = replayReceipt({ from: "a".repeat(40), receipt: validV1 })',
    ';({ omittedOk, omittedState, malformedOk, malformedState, validOk, failed: statePersistenceFailed, absorbed })',
  ].join('\n')
  const result = vm.runInNewContext(source)
  assert.equal(result.omittedOk, false)
  assert.deepEqual(JSON.parse(JSON.stringify(result.omittedState)), { failed: true, absorbed: 0 })
  assert.equal(result.malformedOk, false)
  assert.deepEqual(JSON.parse(JSON.stringify(result.malformedState)), { failed: true, absorbed: 0 })
  assert.equal(result.validOk, true)
  assert.equal(result.failed, false)
  assert.equal(result.absorbed.length, 1)
  assert.equal(result.absorbed[0].stillOpen[0].primaryFile, 'src/a.js')
  assert.match(WF, /receiptVersion: \{ type: 'integer', enum: \[1, 2\] \}/)
  assert.match(WF, /required: \['receiptVersion', 'batchId', 'fixed', 'notABug', 'stillOpen', 'followUps'\]/)
})

test('follow-ups are reconciled deterministically', () => {
  const duplicateRows = [
    { title: 'Add timeout test', area: 'client', detail: 'exercise retry expiry', stage: 'reliability',
      size: 'big', releaseBlocker: false, blockerReason: 'none' },
    { title: 'Add timeout test!', area: 'client', detail: 'exercise retry expiry', stage: 'testing',
      size: 'small', releaseBlocker: false, blockerReason: 'later' },
    { title: 'Add timeout test', area: 'client', detail: 'exercise retry expiry', stage: 'correctness',
      size: 'big', releaseBlocker: true, blockerReason: 'hangs' },
  ]
  const result = helpers().dedupeFollowUps(duplicateRows)
  const reversed = helpers().dedupeFollowUps(duplicateRows.slice().reverse())
  assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(reversed)))
  assert.equal(result.followUps.length, 1)
  assert.equal(result.followUps[0].mergedFrom, 3)
  assert.equal(result.followUps[0].priority, 'should-block-merge')
  assert.equal(result.followUps[0].raisedInStages, 'correctness, reliability, testing')
  assert.equal(result.followUps[0].blockerReason, 'hangs; later')
  const noBlocker = helpers().dedupeFollowUps(duplicateRows.slice(0, 2)).followUps[0]
  assert.equal(noBlocker.priority, 'before-merge')
  const distinct = helpers().dedupeFollowUps([
    { title: 'Add regression test', area: 'client', detail: 'exercise retry expiry', stage: 'reliability' },
    { title: 'Add regression test', area: 'client', detail: 'exercise cancellation cleanup', stage: 'testing' },
  ])
  assert.equal(distinct.followUps.length, 2)
  const unicode = helpers().dedupeFollowUps([
    { title: '修复用户', area: '用户', stage: 'correctness', size: 'big' },
    { title: '修复管理员', area: '管理员', stage: 'security', size: 'big' },
  ])
  assert.equal(unicode.followUps.length, 2)
})
