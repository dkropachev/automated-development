'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { projectsRoot, slugFor } = require('../bench/lib/usage')
const { candidateMechanismHash, canonical, normalizeCandidate } = require('./review-codex-contract')
const { validateDiscoveryLedger } = require('./review-discovery-ledger')

const CORE_SOURCES = new Set(['S1', 'S2', 'S3', 'S4', 'S5', 'S6'])
const LANE_KEYS = [
  'id', 'claim', 'basisType', 'basis', 'mechanisms', 'consequence', 'defectClass',
  'category', 'locations', 'evidence',
]

function exactlyOneRootTranscript(root, configDir) {
  const directory = path.join(projectsRoot(configDir), slugFor(root))
  if (!fs.existsSync(directory)) throw new Error('Claude transcript directory is missing')
  const files = fs.readdirSync(directory).filter((file) => /^[a-f0-9-]{36}\.jsonl$/i.test(file))
  if (files.length !== 1) throw new Error(`expected one root Claude transcript, found ${files.length}`)
  return path.join(directory, files[0].slice(0, -6), 'subagents')
}

function finalText(file) {
  let final = null
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type !== 'assistant' || event.message?.stop_reason !== 'end_turn') continue
    const text = event.message.content?.filter((item) => item.type === 'text')
      .map((item) => item.text).join('\n')
    if (typeof text === 'string' && text.trim()) final = text.trim()
  }
  return final
}

function readLaneReceipts(directory) {
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('lane transcripts directory is invalid')
  const receipts = []
  for (const file of fs.readdirSync(directory).sort()) {
    if (!/^agent-[a-f0-9]+\.jsonl$/i.test(file)) continue
    const absolute = path.join(directory, file)
    const stat = fs.lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe lane transcript')
    const text = finalText(absolute)
    if (!text || !/\bsource_id\b/.test(text)) continue
    let receipt
    try { receipt = JSON.parse(text) } catch {
      throw new Error(`lane receipt in ${file} is not one JSON object`)
    }
    receipts.push(receipt)
  }
  return receipts
}

function uniqueObjects(rows) {
  return [...new Map(rows.map((row) => [JSON.stringify(canonical(row)), row])).values()]
}

function assembleLaneReceipts(receipts, reviewContext, target, pluginFingerprint) {
  if (!Array.isArray(receipts)) throw new Error('lane receipts must be an array')
  const seenSources = new Set(), seenRaw = new Set(), exact = new Map()
  const candidates = [], ledgerRows = [], checkedNonissues = []
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
        !/^S[1-9][0-9]*$/.test(receipt.source_id || '') || seenSources.has(receipt.source_id) ||
        !Array.isArray(receipt.findings) || !Array.isArray(receipt.checked_nonissues)) {
      throw new Error('lane receipt source or arrays are invalid')
    }
    seenSources.add(receipt.source_id)
    for (const raw of receipt.findings) {
      const candidate = normalizeCandidate(Object.fromEntries(LANE_KEYS.map((field) => [field,
        field === 'id' ? raw.candidate_id : raw[field]]).concat([['sourceIds', [receipt.source_id]]])),
      `lane ${receipt.source_id} candidate`)
      const rawKey = `${receipt.source_id}\0${raw.candidate_id}`
      if (seenRaw.has(rawKey)) throw new Error(`duplicate raw candidate ${rawKey}`)
      seenRaw.add(rawKey)
      const hash = candidateMechanismHash(candidate)
      let admitted = exact.get(hash)
      const first = !admitted
      if (first) {
        admitted = { ...candidate, id: `C${candidates.length + 1}` }
        exact.set(hash, admitted)
        candidates.push(admitted)
      } else {
        admitted.locations = uniqueObjects([...admitted.locations, ...candidate.locations])
        admitted.evidence = uniqueObjects([...admitted.evidence, ...candidate.evidence])
        admitted.sourceIds = [...new Set([...admitted.sourceIds, receipt.source_id])]
      }
      ledgerRows.push({ sourceId: receipt.source_id, candidateId: raw.candidate_id,
        claim: candidate.claim, disposition: first ? 'admitted' : 'merged',
        reason: first ? 'atomic lead with concrete consequence'
          : `exact basis, mechanism, defect class, and consequence as ${admitted.id}`,
        canonicalId: admitted.id })
    }
    for (const observation of receipt.checked_nonissues) {
      if (!observation || typeof observation.observation_id !== 'string' ||
          typeof observation.basis !== 'string' || !observation.basis.trim() ||
          typeof observation.reason !== 'string' || !observation.reason.trim()) {
        throw new Error('checked nonissue needs an ID, basis, and reason')
      }
      checkedNonissues.push({ sourceId: receipt.source_id,
        observationId: observation.observation_id, basis: observation.basis, reason: observation.reason })
    }
  }
  for (const source of CORE_SOURCES) if (!seenSources.has(source)) throw new Error(`missing core lane ${source}`)
  const ledger = validateDiscoveryLedger({ schemaVersion: 2, candidates: ledgerRows, checkedNonissues },
    candidates.map((candidate) => ({ candidateId: candidate.id, originInvocationId: null })),
    { schemaVersion: 2 })
  const input = canonical({ schemaVersion: 2, contract: 'review-and-fix-pr-v3',
    sourceDisclosure: { discovery: 'Anthropic Claude', adjudication: 'OpenAI Codex' },
    target, pluginFingerprint, reviewContext, candidates })
  return { ledger, input }
}

module.exports = { assembleLaneReceipts, exactlyOneRootTranscript, finalText, readLaneReceipts }
