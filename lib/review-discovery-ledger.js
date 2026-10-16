'use strict'

const DISPOSITIONS = new Set(['admitted', 'merged', 'screened'])

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`)
  return value
}

function validateDiscoveryLedger(ledger, candidateLedger, options = {}) {
  const schemaVersion = options.schemaVersion || 1
  if (!ledger || ledger.schemaVersion !== schemaVersion || !Array.isArray(ledger.candidates) ||
      !Array.isArray(ledger.checkedNonissues)) {
    throw new Error(`discovery ledger requires schemaVersion ${schemaVersion}, candidates, and checkedNonissues`)
  }
  const judged = new Set(candidateLedger.filter((row) => row.originInvocationId == null)
    .map((row) => row.candidateId))
  const admitted = new Set()
  const seen = new Set()
  for (const [index, row] of ledger.candidates.entries()) {
    const label = `discovery ledger candidates[${index}]`
    if (!row || !DISPOSITIONS.has(row.disposition)) throw new Error(`${label} has invalid disposition`)
    nonempty(row.sourceId, `${label}.sourceId`)
    nonempty(row.candidateId, `${label}.candidateId`)
    nonempty(row.claim, `${label}.claim`)
    nonempty(row.reason, `${label}.reason`)
    const key = `${row.sourceId}\0${row.candidateId}`
    if (seen.has(key)) throw new Error(`${label} repeats a source candidate`)
    seen.add(key)
    if (row.disposition === 'screened') {
      if (row.canonicalId !== null) throw new Error(`${label} screened lead has a canonical ID`)
    } else {
      if (!judged.has(row.canonicalId)) throw new Error(`${label} refers to an unjudged canonical ID`)
      if (row.disposition === 'admitted') admitted.add(row.canonicalId)
    }
  }
  for (const id of judged) {
    if (!admitted.has(id)) throw new Error(`discovery ledger omits admitted candidate ${id}`)
  }
  for (const [index, row] of ledger.checkedNonissues.entries()) {
    const label = `discovery ledger checkedNonissues[${index}]`
    if (!row) throw new Error(`${label} is invalid`)
    nonempty(row.sourceId, `${label}.sourceId`)
    nonempty(row.observationId, `${label}.observationId`)
    nonempty(row.basis, `${label}.basis`)
    nonempty(row.reason, `${label}.reason`)
    if (schemaVersion >= 2 && /see lane receipt|per lane classification/i.test(`${row.basis} ${row.reason}`)) {
      throw new Error(`${label} must preserve its basis and reason, not a temporary receipt pointer`)
    }
  }
  return ledger
}

module.exports = { validateDiscoveryLedger }
