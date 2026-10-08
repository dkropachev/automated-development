'use strict'

const { canonical, normalizeCandidate } = require('./review-codex-contract')
const { validateDiscoveryLedger } = require('./review-discovery-ledger')

function clusterPrompt(candidates, template) {
  const rows = candidates.map((candidate) => ({ id: candidate.id, claim: candidate.claim,
    basisType: candidate.basisType, basis: candidate.basis, mechanism: candidate.mechanisms[0],
    consequence: candidate.consequence, defectClass: candidate.defectClass,
    category: candidate.category, locations: candidate.locations }))
  return template + JSON.stringify(rows) + '\n</CANDIDATES_JSON>\n'
}

function normalizeGroups(output, candidates) {
  if (!output || !Array.isArray(output.groups) || !output.groups.length) {
    throw new Error('semantic clusters are missing')
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const seen = new Set()
  const groups = output.groups.map((group, index) => {
    if (!group || typeof group.representativeId !== 'string' || !Array.isArray(group.memberIds) ||
        !group.memberIds.length || typeof group.reason !== 'string' || !group.reason.trim() ||
        !group.memberIds.includes(group.representativeId)) {
      throw new Error(`semantic cluster ${index + 1} is invalid`)
    }
    const representative = byId.get(group.representativeId)
    if (!representative) throw new Error('semantic cluster representative is unknown')
    const paths = new Set([...representative.locations, ...representative.evidence].map((item) => item.path))
    for (const id of group.memberIds) {
      const member = byId.get(id)
      if (!member || seen.has(id)) throw new Error(`semantic cluster member ${id} is missing or repeated`)
      if (![...member.locations, ...member.evidence].some((item) => paths.has(item.path))) {
        throw new Error(`semantic cluster ${id} lacks a shared source path with its representative`)
      }
      seen.add(id)
    }
    return { representativeId: group.representativeId, memberIds: [...group.memberIds],
      reason: group.reason }
  })
  if (seen.size !== byId.size) throw new Error('semantic clusters do not partition all candidates')
  return groups
}

function refineGroups(output, candidates) {
  if (!output || !Array.isArray(output.groups)) throw new Error('semantic clusters are missing')
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const groups = []
  for (const group of output.groups) {
    const representative = byId.get(group?.representativeId)
    if (!representative || !Array.isArray(group.memberIds) ||
        !group.memberIds.includes(group.representativeId)) {
      throw new Error('semantic cluster representative is invalid')
    }
    const paths = new Set([...representative.locations, ...representative.evidence]
      .map((item) => item.path))
    const shared = [], detached = []
    for (const id of group.memberIds) {
      const member = byId.get(id)
      if (!member) throw new Error(`semantic cluster member ${id} is unknown`)
      const destination = [...member.locations, ...member.evidence]
        .some((item) => paths.has(item.path)) ? shared : detached
      destination.push(id)
    }
    groups.push({ ...group, memberIds: shared })
    for (const id of detached) groups.push({ representativeId: id, memberIds: [id],
      reason: 'separate lead: no shared source path with proposed representative' })
  }
  return normalizeGroups({ groups }, candidates)
}

function uniqueObjects(rows) {
  return [...new Map(rows.map((row) => [JSON.stringify(canonical(row)), row])).values()]
}

function applyGroups(assembled, groups) {
  const normalized = normalizeGroups({ groups }, assembled.input.candidates)
  const byId = new Map(assembled.input.candidates.map((candidate) => [candidate.id, candidate]))
  const canonicalFor = new Map(), candidates = []
  for (const group of normalized) {
    const representative = byId.get(group.representativeId)
    const merged = { ...representative, locations: [], evidence: [], sourceIds: [] }
    for (const id of group.memberIds) {
      const member = byId.get(id)
      canonicalFor.set(id, representative.id)
      merged.locations.push(...member.locations)
      merged.evidence.push(...member.evidence)
      merged.sourceIds.push(...member.sourceIds)
    }
    merged.locations = uniqueObjects(merged.locations)
    merged.evidence = uniqueObjects(merged.evidence)
    merged.sourceIds = [...new Set(merged.sourceIds)]
    candidates.push(normalizeCandidate(merged))
  }
  const ledgerRows = assembled.ledger.candidates.map((row) => {
    const canonicalId = canonicalFor.get(row.canonicalId)
    const admitted = row.disposition === 'admitted' && row.canonicalId === canonicalId
    return { ...row, canonicalId, disposition: admitted ? 'admitted' : 'merged',
      reason: admitted ? row.reason : `semantic cluster represented by ${canonicalId}` }
  })
  const ledger = validateDiscoveryLedger({ ...assembled.ledger, candidates: ledgerRows },
    candidates.map((candidate) => ({ candidateId: candidate.id, originInvocationId: null })),
    { schemaVersion: 2 })
  return { input: { ...assembled.input, candidates }, ledger, groups: normalized }
}

module.exports = { applyGroups, clusterPrompt, normalizeGroups, refineGroups }
