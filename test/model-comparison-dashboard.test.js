'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dashboard = require('../bench/dashboard')

function comparisonFixture() {
  return {
    id: 'test-gold',
    cohorts: [
      { runId: 'old', modelId: 'old-model', label: 'Old model', provenance: 'historical/inferred' },
      { runId: 'new', modelId: 'new-model', label: 'New model', provenance: 'controlled' },
    ],
    scopes: [{
      id: 'all-models',
      modelIds: ['old-model', 'new-model'],
      runIds: ['old', 'new'],
      matchedCells: [
        { id: 'alpha/tool-one', targetId: 'alpha', toolId: 'tool-one', sourceCellIds: ['old/alpha/tool-one', 'new/alpha/tool-one'] },
        { id: 'beta/tool-two', targetId: 'beta', toolId: 'tool-two', sourceCellIds: ['old/beta/tool-two', 'new/beta/tool-two'] },
      ],
    }],
    canonicalIssues: [
      { id: 'real-alpha', targetId: 'alpha', verdict: 'real', severity: 'high' },
      { id: 'real-beta', targetId: 'beta', verdict: 'real', severity: 'low' },
      { id: 'fp-alpha', targetId: 'alpha', verdict: 'false-positive', severity: 'medium' },
      { id: 'unknown-alpha', targetId: 'alpha', verdict: 'unproven', severity: 'medium' },
    ],
    sourceMappings: [
      // The stale source verdict is intentionally wrong: canonical verdicts are authoritative.
      { cellId: 'old/alpha/tool-one', findingIndex: 0, canonicalIssueId: 'real-alpha', verdict: 'false-positive' },
      { cellId: 'old/alpha/tool-one', findingIndex: 1, issueIds: ['real-alpha', 'fp-alpha', 'unknown-alpha'] },
      { cellId: 'old/beta/tool-two', findingIndex: 0, canonicalIssueId: 'real-beta' },
      { cellId: 'new/alpha/tool-one', findingIndex: 0, issueIds: ['real-alpha', 'fp-alpha', 'unknown-alpha'] },
      { cellId: 'new/beta/tool-two', findingIndex: 0, canonicalIssueId: 'real-beta' },
    ],
    sourceEvidence: [
      { cellId: 'old/alpha/tool-one', runId: 'old', targetId: 'alpha', toolId: 'tool-one', modelId: 'old-model', status: 'complete', salvaged: false, costUsd: 2, wallMs: 20 },
      { cellId: 'old/beta/tool-two', runId: 'old', targetId: 'beta', toolId: 'tool-two', modelId: 'old-model', status: 'complete', salvaged: true, costUsd: 4, wallMs: 40 },
      { cellId: 'new/alpha/tool-one', runId: 'new', targetId: 'alpha', toolId: 'tool-one', modelId: 'new-model', status: 'complete', salvaged: false, costUsd: 1, wallMs: 10 },
      { cellId: 'new/beta/tool-two', runId: 'new', targetId: 'beta', toolId: 'tool-two', modelId: 'new-model', status: 'failed', salvaged: false, costUsd: 3, wallMs: 30 },
    ],
  }
}

test('model metrics use one canonical denominator and canonical verdicts', () => {
  const result = dashboard.deriveModelMetrics(comparisonFixture(), { scopeId: 'all-models' })
  assert.equal(result.denominator, 2)
  assert.deepEqual(result.models.map((model) => model.completeness), [0.5, 0.5])

  const old = result.models[0]
  assert.equal(old.canonicalReal, 1, 'duplicate mappings and salvaged evidence must not inflate credit')
  assert.equal(old.canonicalHighMedium, 1)
  assert.equal(old.canonicalFalsePositive, 1)
  assert.equal(old.canonicalUnproven, 1)
  assert.equal(old.precision, 0.5, 'unproven issues are excluded from precision')
  assert.deepEqual(old.issueIds, ['fp-alpha', 'real-alpha', 'unknown-alpha'])
})

test('all matched attempts contribute recorded cost, runtime, and success evidence', () => {
  const result = dashboard.deriveModelMetrics(comparisonFixture())
  const old = result.models[0]
  const current = result.models[1]

  assert.equal(old.recordedTotalCostUsd, 6)
  assert.equal(old.medianRecordedCostUsd, 3)
  assert.equal(old.medianWallMs, 30)
  assert.equal(old.evidenceCount, 2)
  assert.equal(old.successRate, 1)
  assert.equal(old.realPerDollar, 1 / 6)

  assert.equal(current.recordedTotalCostUsd, 4)
  assert.equal(current.medianRecordedCostUsd, 2)
  assert.equal(current.medianWallMs, 20)
  assert.equal(current.evidenceCount, 2)
  assert.equal(current.completeEvidenceCount, 1)
  assert.equal(current.successRate, 0.5)
  assert.equal(current.canonicalReal, 1, 'a failed mapped attempt receives no finding credit')
})

test('declared source cells prevent a later same-model cohort from entering a sealed scope', () => {
  const comparison = comparisonFixture()
  comparison.sourceEvidence.push({
    cellId: 'later/alpha/tool-one', runId: 'later', cohortId: 'later', targetId: 'alpha', toolId: 'tool-one',
    modelId: 'new-model', status: 'complete', salvaged: false, costUsd: 100, wallMs: 1000,
  })
  comparison.sourceMappings.push({
    cellId: 'later/alpha/tool-one', findingIndex: 0, canonicalIssueId: 'real-beta',
  })
  const current = dashboard.deriveModelMetrics(comparison).models.find((model) => model.modelId === 'new-model')
  assert.equal(current.recordedTotalCostUsd, 4)
  assert.equal(current.evidenceCount, 2)
  assert.equal(current.canonicalReal, 1)
})

test('skill filtering changes evidence while target filtering changes the fixed denominator', () => {
  const comparison = comparisonFixture()
  const skill = dashboard.deriveModelMetrics(comparison, { toolIds: ['tool-one'] })
  assert.equal(skill.denominator, 2, 'skill selection does not redefine target-level completeness')
  assert.deepEqual(skill.models.map((model) => model.evidenceCount), [1, 1])

  const target = dashboard.deriveModelMetrics(comparison, { targetIds: ['beta'] })
  assert.equal(target.denominator, 1)
  assert.deepEqual(target.models.map((model) => model.canonicalReal), [0, 0])
  assert.deepEqual(target.models.map((model) => model.evidenceCount), [1, 1])
})

test('normalization preserves composite mappings and overlays dashboard-recorded usage', () => {
  const published = comparisonFixture()
  published.issueUrl = null
  const runs = [{
    id: 'new/alpha/tool-one', targetId: 'alpha', toolId: 'tool-one', modelId: 'new-model',
    status: 'complete', wallMs: 99, usage: { costUsd: 9 },
  }]
  const normalized = dashboard.normalizePublishedComparison(published, runs)
  const mapping = normalized.sourceMappings.find((entry) => entry.cellId === 'old/alpha/tool-one' && entry.findingIndex === 1)
  const evidence = normalized.sourceEvidence.find((entry) => entry.cellId === 'new/alpha/tool-one')

  assert.deepEqual(mapping.issueIds, ['real-alpha', 'fp-alpha', 'unknown-alpha'])
  assert.equal(mapping.canonicalIssueId, null)
  assert.equal(evidence.costUsd, 9)
  assert.equal(evidence.wallMs, 99)
  assert.equal(normalized.issueUrl, 'https://github.com/dkropachev/automated-development/issues/42')
})

test('fixture roots without a published gold index expose no model comparison', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-no-gold-'))
  try {
    assert.equal(dashboard.loadPublishedModelComparison(root), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
