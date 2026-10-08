'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { normalizeAttribution } = require('../bench/judge')

test('judge attribution resolves only sealed candidate-qualified cell IDs', () => {
  const cell = 'run/ironweave/review-and-fix-pr'
  const blob = [{ cellId: cell, tool: 'review-and-fix-pr', candidateId: 'C3' },
    { cellId: cell, tool: 'review-and-fix-pr', candidateId: 'C4' }]
  const [issue] = normalizeAttribution([{
    title: 'real issue', reportedBy: ['review-and-fix-pr'],
    reportedByRuns: [`${cell}#C3`, `${cell}#unknown`],
    reportedAs: {}, reportedAsByRun: {
      [`${cell}#C3`]: 'first wording', [`${cell}#C4`]: 'second wording',
      [`${cell}#unknown`]: 'unsealed wording',
    },
  }], blob, 'run', 'ironweave')
  assert.deepEqual(issue.reportedByRuns, [cell])
  assert.deepEqual(issue.reportedAsByRun, { [cell]: 'first wording; second wording' })
  assert.equal(issue.reportedAs['review-and-fix-pr'], 'first wording; second wording')
})
