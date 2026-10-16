'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateDiscoveryLedger } = require('../lib/review-discovery-ledger')

const judged = [{ candidateId: 'C1', originInvocationId: null },
  { candidateId: 'C2', originInvocationId: 'codex-invocation' }]
const ledger = {
  schemaVersion: 1,
  candidates: [
    { sourceId: 'lane-a', candidateId: 'A1', claim: 'a', disposition: 'admitted', reason: 'reachable', canonicalId: 'C1' },
    { sourceId: 'lane-b', candidateId: 'B1', claim: 'same a', disposition: 'merged', reason: 'same defect', canonicalId: 'C1' },
    { sourceId: 'lane-c', candidateId: 'D1', claim: 'not a defect', disposition: 'screened', reason: 'base parity', canonicalId: null },
  ],
  checkedNonissues: [{ sourceId: 'lane-a', observationId: 'N1', basis: 'base behavior', reason: 'unchanged' }],
}

test('discovery ledger retains admitted, merged, screened, and checked leads', () => {
  assert.equal(validateDiscoveryLedger(ledger, judged), ledger)
})

test('discovery ledger cannot omit a Claude candidate or map a screened lead to Codex', () => {
  assert.throws(() => validateDiscoveryLedger({ ...ledger, candidates: ledger.candidates.slice(1) }, judged),
    /omits admitted candidate C1/)
  const changed = JSON.parse(JSON.stringify(ledger))
  changed.candidates[2].canonicalId = 'C1'
  assert.throws(() => validateDiscoveryLedger(changed, judged), /screened lead has a canonical ID/)
})

test('schema v2 requires complete checked-nonissue evidence', () => {
  const valid = JSON.parse(JSON.stringify(ledger))
  valid.schemaVersion = 2
  assert.equal(validateDiscoveryLedger(valid, judged, { schemaVersion: 2 }), valid)
  valid.checkedNonissues[0].reason = 'see lane receipt /tmp/temporary.yaml'
  assert.throws(() => validateDiscoveryLedger(valid, judged, { schemaVersion: 2 }),
    /must preserve its basis and reason/)
  assert.equal(validateDiscoveryLedger(ledger, judged, { schemaVersion: 1 }), ledger)
})
