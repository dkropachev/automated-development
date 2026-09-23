'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const WF = fs.readFileSync(path.join(ROOT, 'workflows/review-and-fix-pr.js'), 'utf8')

function extractFn(name) {
  let start = WF.indexOf('function ' + name + '(')
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
    REVIEW_SKILL: null, REVIEW_MODE: 'bounded', MAX_FINDINGS: 10,
    MAX_MAJOR_FINDINGS: 2, MAX_SEVERITY_SCORE: 10,
    SEVERITY_WEIGHTS: { critical: 10, high: 5, medium: 2, low: 1 },
  }, overrides)
  const source = [
    `const REVIEW_SKILL = ${JSON.stringify(cfg.REVIEW_SKILL)}`,
    `const REVIEW_MODE = ${JSON.stringify(cfg.REVIEW_MODE)}`,
    `const MAX_FINDINGS = ${JSON.stringify(cfg.MAX_FINDINGS)}`,
    `const MAX_MAJOR_FINDINGS = ${JSON.stringify(cfg.MAX_MAJOR_FINDINGS)}`,
    `const MAX_SEVERITY_SCORE = ${JSON.stringify(cfg.MAX_SEVERITY_SCORE)}`,
    `const SEVERITY_WEIGHTS = ${JSON.stringify(cfg.SEVERITY_WEIGHTS)}`,
    "const NATIVE_LENSES = ['correctness','security','reliability','contracts','testing','performance','comments','maintainability']",
    'const ADDITIONAL_LENS_ORDER = NATIVE_LENSES.slice(1)',
    'const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }',
    'const severityRank = s => SEV_RANK[s] === undefined ? 9 : SEV_RANK[s]',
    "const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:.\\/]+/g, '-').replace(/^-+|-+$/g, '')",
    extractFn('plannedDiscoveryLenses'), extractFn('normalizedFingerprint'), extractFn('mergeFinding'),
    extractFn('findingConsumesThreshold'), extractFn('scoreFindings'), extractFn('thresholdTrigger'),
    extractFn('dedupeFollowUps'),
    '({ plannedDiscoveryLenses, normalizedFingerprint, mergeFinding, findingConsumesThreshold, scoreFindings, thresholdTrigger, dedupeFollowUps })',
  ].join('\n')
  return vm.runInNewContext(source)
}

function finding(severity, extra = {}) {
  return Object.assign({ primaryFile: 'src/a.js', symbol: 'run', defectClass: 'logic',
    fingerprint: 'ignored:by:normalization', severity, confidence: 'likely', scopeLabel: 'in',
    defer: false, evidence: 'src/a.js:1 return wrong', detail: 'wrong result', fixSize: 'small',
    releaseBlocker: false, blockerReason: 'none' }, extra)
}

test('lens selection starts correctly and follows consequence order', () => {
  const scope = { applicableLenses: [
    { lens: 'maintainability', reason: 'refactor' }, { lens: 'testing', reason: 'behavior changed' },
    { lens: 'correctness', reason: 'always' }, { lens: 'security', reason: 'untrusted input' },
  ] }
  assert.deepEqual(Array.from(helpers().plannedDiscoveryLenses(scope), x => x.lens),
    ['correctness', 'security', 'testing', 'maintainability'])
  assert.deepEqual(Array.from(helpers({ REVIEW_SKILL: 'plugin:review' }).plannedDiscoveryLenses(scope), x => x.lens),
    ['selected-skill', 'security', 'testing', 'maintainability'])
})

test('fingerprints deduplicate and retain cautious strongest merged result', () => {
  const h = helpers()
  const first = h.mergeFinding(null, finding('medium'), 'correctness', false)
  const merged = h.mergeFinding(first, finding('high', { evidence: 'src/a.js:1 a much stronger quoted proof',
    defer: true, deferReason: 'migration required' }), 'reliability', false)
  assert.equal(merged.fingerprint, 'src/a.js:run:logic')
  assert.equal(merged.severity, 'high')
  assert.equal(merged.defer, true)
  assert.deepEqual(Array.from(merged.reportingLenses), ['correctness', 'reliability'])
  assert.equal(h.scoreFindings([first, merged]).findingCount, 1, 'the cautious deferred duplicate is not counted')
  const byFingerprint = new Map([[first.fingerprint, first]])
  byFingerprint.set(merged.fingerprint, merged)
  assert.equal(h.scoreFindings([...byFingerprint.values()]).findingCount, 0, 'deferred duplicate consumes no threshold')
})

test('threshold scoring filters residual findings and stops on exact boundaries', () => {
  const h = helpers()
  const ignored = [
    finding('critical', { scopeLabel: 'out' }), finding('critical', { scopeLabel: 'deferred' }),
    finding('critical', { defer: true }), finding('critical', { reviewerRejected: true }),
    finding('critical', { confidence: 'speculative' }),
  ]
  assert.deepEqual(JSON.parse(JSON.stringify(h.scoreFindings(ignored))),
    { findingCount: 0, majorCount: 0, severityScore: 0 })
  assert.equal(h.scoreFindings([finding('critical')]).severityScore, 10)
  assert.equal(h.scoreFindings([finding('high'), finding('high')]).severityScore, 10)
  assert.equal(h.scoreFindings(Array.from({ length: 5 }, () => finding('medium'))).severityScore, 10)
  assert.match(h.thresholdTrigger(h.scoreFindings([finding('critical')])), /maxSeverityScore.*10 >= 10/)
  assert.match(h.thresholdTrigger(h.scoreFindings([finding('high'), finding('high')])), /maxMajorFindings.*2 >= 2/)
  assert.equal(helpers({ REVIEW_MODE: 'unbounded' }).thresholdTrigger({ findingCount: 999, majorCount: 999, severityScore: 999 }), null)
})

test('follow-ups are reconciled without launching an LLM agent', () => {
  const result = helpers().dedupeFollowUps([
    { title: 'Add timeout test', area: 'client', stage: 'reliability', size: 'small' },
    { title: 'Add timeout test!', area: 'client', stage: 'testing', size: 'small', releaseBlocker: true, blockerReason: 'hangs' },
  ])
  assert.equal(result.followUps.length, 1)
  assert.equal(result.followUps[0].mergedFrom, 2)
  assert.equal(result.followUps[0].priority, 'should-block-merge')
  const followupSection = WF.slice(WF.indexOf("phase('Follow-ups')"), WF.indexOf("phase('Report')"))
  assert.doesNotMatch(followupSection, /agentSafe\(/)
})

test('advanced argument validation runs before the first agent call', () => {
  const start = WF.indexOf('const ARGS =')
  const end = WF.indexOf('// Run every agent on one model')
  const config = WF.slice(start, end)
  const evaluate = args => vm.runInNewContext(config, { args })
  for (const args of [
    { reviewMode: 'other' }, { validation: 'triple' }, { maxFindings: 0 },
    { maxMajorFindings: -1 }, { maxSeverityScore: 1.5 }, { maxFindings: '10' },
    { reviewMode: 'bounded', maxFindings: null, maxMajorFindings: null, maxSeverityScore: null },
    { severityWeights: { urgent: 3 } }, { severityWeights: { high: -1 } },
  ]) assert.throws(() => evaluate(args))
  assert.doesNotThrow(() => evaluate({ reviewMode: 'unbounded', maxFindings: null,
    maxMajorFindings: null, maxSeverityScore: null, severityWeights: { high: 7 } }))
  assert.ok(end < WF.indexOf('await agentSafe('), 'configuration validation must precede the first spawn')
})

test('active discovery is sequential, stays stopped after validation, and reports partial review', () => {
  const loop = WF.slice(WF.indexOf('for (let li = 0; li < lensPlan.length'), WF.indexOf('for (const [key, reason]'))
  assert.match(loop, /await agentSafe\(discoveryPrompt/)
  assert.doesNotMatch(loop, /parallel\(/)
  assert.match(loop, /thresholdTrigger\(provisionalScore\)/)
  const validation = WF.slice(WF.indexOf("phase('Validate')"), WF.indexOf('const classifyRetained'))
  assert.doesNotMatch(validation, /discoveryPrompt|lensPlan\.push|li--/)
  assert.match(WF, /VALIDATION_MODE !== 'off' && !validationCircuit/)
  assert.match(WF, /PARTIAL REVIEW: known findings were reviewed\/fixed, but the PR was not exhaustively reviewed/)
  assert.match(WF, /VALIDATION_MODE === 'off'/)
  assert.match(WF, /fixEligible = confirmed\.filter/)
})
