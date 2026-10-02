'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
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
    extractFn('plannedDiscoveryLenses'), extractFn('identityHex'),
    extractFn('followUpIdentity'),
    extractFn('normalizedFingerprint'), extractFn('stableRawCandidateId'), extractFn('safeFindingPath'),
    extractFn('findingPathsSafe'), extractFn('mergeFinding'),
    extractFn('findingConsumesThreshold'),
    "const CODE_DEFECT_CLASSES = new Set(['logic','nil-deref','bounds','concurrency','resource-leak','error-handling','security','api-contract','perf','regression'])",
    extractFn('defectBucket'), extractFn('scoreFindings'), extractFn('thresholdTrigger'),
    extractFn('clusterCandidates'), extractFn('appendRawCandidateDispositions'),
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
    clusterId: 'cluster-' + id,
    status: 'confirmed',
    cycle: 2,
  }])
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
  assert.match(WF, /resume-json[\s\S]*--max-bytes 196608/)
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
  assert.match(WF, /followUps: res\.followUps \|\| \[\]/)
  assert.match(WF, /snapshotVersion: 2[\s\S]*lineageCursor/)
  assert.match(WF, /stageFixReceipt\(batchId, fixReceipt\)/)
  assert.doesNotMatch(WF, /advance-head[\s\S]{0,600}--receipt-base64/)
  assert.match(WF, /failedGapReviews: coverageGaps\.filter/)
  const noChanges = WF.slice(WF.lastIndexOf("if (res.outcome === 'no-changes')"),
    WF.lastIndexOf("if (res.outcome === 'no-changes')") + 1200)
  assert.match(noChanges, /if \(!await checkpointState/)
  assert.match(WF, /prepareFixTransaction\(batchId, headSha, batches\[bi\]\)[\s\S]{0,500}fixerPrompt/)
  assert.match(WF, /c' \+ reviewCycle \+ '-w' \+ fixWindow \+ '-full-b'/)
  assert.doesNotMatch(WF, /findingStopTrigger && skippedLenses\.length/)
  assert.match(WF, /sealable = [\s\S]{0,220}stillPresent\.length === 0/)
  assert.match(WF, /build coverage manifest'[\s\S]{0,180}bashCommandClamp:[\s\S]{0,120}requireToolScope: true/)
  assert.match(WF, /rejection\.kind === 'out-of-scope'\) setFindingSetAside/)
  assert.match(WF, /missingImmutableUnits[\s\S]{0,500}coverage-error/)
  assert.match(WF, /immutableSemanticUnits,[\s\S]{0,300}coverageGaps/)
  assert.match(WF, /snapshot\.immutableSemanticUnits[\s\S]{0,120}immutableSemanticUnits =/)
  assert.match(WF, /claim-result --store/)
  assert.match(WF, /transactionId\.slice\(0, 16\)/)
  assert.match(WF, /--allowed-files-base64/)
  assert.match(WF, /terminalCycleCap = stopReason === 'cycle-cap'/)
  assert.match(WF, /normalizeFindingScope\(f, scope\)/)
  assert.match(WF, /current\.baselineLintOk === false/)
  assert.match(WF, /if \(base\.baselineLintOk === false\) base\.lintCmd = 'none'/)
  assert.match(WF, /const remainingChecks = \[base\.buildCmd, base\.lintCmd, base\.testCmd\]/)
  assert.match(WF, /const savedLocalCommits = ownedCommits\.map/)
  assert.match(WF, /LOCAL COMMITS CREATED/)
  assert.match(WF, /reportState\.stopReason = 'state-seal-failed'/)
  assert.match(WF, /const statusSaved = await stateLifecycle/)
  assert.match(WF, /const unlocked = await stateLifecycle/)
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

test('follow-ups are reconciled deterministically', () => {
  const result = helpers().dedupeFollowUps([
    { title: 'Add timeout test', area: 'client', detail: 'exercise retry expiry', stage: 'reliability', size: 'small' },
    { title: 'Add timeout test!', area: 'client', detail: 'exercise retry expiry', stage: 'testing', size: 'small', releaseBlocker: true, blockerReason: 'hangs' },
  ])
  assert.equal(result.followUps.length, 1)
  assert.equal(result.followUps[0].mergedFrom, 2)
  assert.equal(result.followUps[0].priority, 'should-block-merge')
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
