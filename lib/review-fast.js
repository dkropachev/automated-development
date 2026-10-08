'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  canonical, candidateMechanismHash, normalizeCandidate, receiptResultBinding, validateReceipt,
} = require('./review-codex-contract')
const { validateDiscoveryLedger } = require('./review-discovery-ledger')

const PASS_IDS = Object.freeze(['holistic', 'standards', 'spec-test', 'contracts', 'maintenance', 'api-commit'])
const LENSES = Object.freeze([
  'correctness', 'spec', 'standards', 'security', 'reliability',
  'contracts', 'testing', 'performance', 'comments', 'maintainability',
])
const STRUCTURED_SUFFIX = '\nReturn the required structured output with one atomic finding per distinct mechanism and exact checked evidence. Preserve every supported issue; schema is only an output format.\n'

function passPrompt(passId, context, directory) {
  if (!PASS_IDS.includes(passId)) throw new Error(`unknown review pass: ${passId}`)
  const base = fs.readFileSync(path.join(directory, `${passId}.txt`), 'utf8')
  if (!['spec-test', 'contracts', 'api-commit'].includes(passId)) return base + STRUCTURED_SUFFIX
  const frozen = canonical({ prTitle: context.prTitle, prBody: context.prBody,
    commitMessages: context.commitMessages, acceptanceCriteria: context.acceptanceCriteria })
  const opening = base.includes('<FROZEN_PR_EVIDENCE_JSON>') ? '' : '\n<FROZEN_PR_EVIDENCE_JSON>\n'
  return base + opening + JSON.stringify(frozen) + '\n</FROZEN_PR_EVIDENCE_JSON>\n' + STRUCTURED_SUFFIX
}

function normalizedPass(passId, output, metadata = {}) {
  if (!PASS_IDS.includes(passId) || !output || !Array.isArray(output.findings) ||
      typeof output.coverage !== 'string') throw new Error(`invalid structured review pass ${passId}`)
  const sourceId = `P${PASS_IDS.indexOf(passId) + 1}`
  const findings = output.findings.map((raw, index) => normalizeCandidate({
    ...raw, id: `${sourceId}-${index + 1}`, sourceIds: [sourceId],
  }, `${passId} finding ${index + 1}`))
  return { id: passId, sourceId, findings, coverage: output.coverage, ...metadata }
}

function uniqueObjects(rows) {
  return [...new Map(rows.map((row) => [JSON.stringify(canonical(row)), row])).values()]
}

function assemblePasses(passes, context, target, pluginFingerprint) {
  if (!Array.isArray(passes) || passes.length !== PASS_IDS.length ||
      PASS_IDS.some((id, index) => passes[index]?.id !== id)) {
    throw new Error('six independent review passes are required in fixed order')
  }
  const exact = new Map(), candidates = [], ledgerRows = []
  for (const pass of passes) {
    for (const raw of pass.findings) {
      const candidate = normalizeCandidate(raw)
      const hash = candidateMechanismHash(candidate)
      let existing = exact.get(hash)
      const admitted = !existing
      if (admitted) {
        existing = { ...candidate, id: `C${candidates.length + 1}` }
        candidates.push(existing)
        exact.set(hash, existing)
      } else {
        existing.locations = uniqueObjects([...existing.locations, ...candidate.locations])
        existing.evidence = uniqueObjects([...existing.evidence, ...candidate.evidence])
        existing.sourceIds = [...new Set([...existing.sourceIds, ...candidate.sourceIds])]
      }
      ledgerRows.push({ sourceId: pass.sourceId, candidateId: candidate.id,
        claim: candidate.claim, disposition: admitted ? 'admitted' : 'merged',
        reason: admitted ? 'atomic structured review lead with concrete consequence'
          : `exact basis, mechanism, defect class, and consequence as ${existing.id}`,
        canonicalId: existing.id })
    }
  }
  const ledger = validateDiscoveryLedger({ schemaVersion: 2, candidates: ledgerRows, checkedNonissues: [] },
    candidates.map((candidate) => ({ candidateId: candidate.id, originInvocationId: null })),
    { schemaVersion: 2 })
  const input = canonical({ schemaVersion: 2, contract: 'review-and-fix-pr-v3',
    sourceDisclosure: { discovery: 'Anthropic Claude', adjudication: 'OpenAI Codex' },
    target, pluginFingerprint, reviewContext: context, candidates })
  return { ledger, input }
}

function formatReport(receipt, passReceipt) {
  const normalized = validateReceipt(receipt)
  const binding = receiptResultBinding(normalized)
  const lines = [
    `Review of ${normalized.target.repository} at ${normalized.target.headSha}`,
    '',
    'Fix completeness: reviewed against PR intent and tests; see findings for remaining gaps.',
    `Coverage: six independent Claude passes completed (${passReceipt.passes.map((pass) => pass.id).join(', ')}).`,
    'OpenAI Codex independently judged every admitted candidate and new lead.',
    '',
    '### Confirmed findings',
  ]
  const confirmed = normalized.candidates.filter((candidate) => candidate.finalDisposition === 'confirmed')
  if (!confirmed.length) lines.push('None.')
  for (const candidate of confirmed) {
    const location = candidate.locations[0]
    lines.push(`- [${candidate.id}] ${candidate.claim} (${location.path}:${location.line ?? 0}; ${candidate.severity})`)
    lines.push(`  Evidence: ${candidate.reason}`)
  }
  lines.push('', '### Needs reviewer judgment')
  const suggestions = normalized.candidates.filter((candidate) => candidate.finalDisposition === 'suggestion')
  if (!suggestions.length) lines.push('None.')
  for (const candidate of suggestions) {
    const location = candidate.locations[0]
    lines.push(`- [${candidate.id}] ${candidate.claim} (${location.path}:${location.line ?? 0})`)
    lines.push(`  Codex objection or uncertainty: ${candidate.reason}`)
    lines.push(`  Affected edit: ${candidate.suggestedEdit}; consequence: ${candidate.suggestedConsequence}`)
  }
  const unresolved = normalized.candidates.filter((candidate) => candidate.finalDisposition === 'unresolved')
  if (unresolved.length) {
    lines.push('', '### Unresolved')
    for (const candidate of unresolved) lines.push(`- [${candidate.id}] ${candidate.claim}: ${candidate.reason}`)
  }
  lines.push('', `Confirmed: ${binding.findings.confirmed}; suggestions: ${binding.findings.suggestion}; rejected: ${binding.findings.rejected}; unresolved: ${binding.findings.unresolved}.`,
    'Suggestions are never fixed automatically. Coverage complete means this review protocol finished, not that the PR is bug-free.',
    '')
  const marker = { schemaVersion: 3, coverage: 'complete', verification: 'complete',
    fix: 'not-requested', stopTrigger: 'none', stopReason: 'completed', fixRequested: false,
    completedLenses: [...LENSES], skippedLenses: [], failedLenses: [], coverageGapCount: 0,
    findings: binding.findings, candidateLedger: binding.candidateLedger,
    newLeadResolutions: binding.newLeadResolutions, codex: binding.codex }
  lines.push(`REVIEW_AND_FIX_PR_RESULT_JSON=${JSON.stringify(marker)}`)
  return lines.join('\n') + '\n'
}

module.exports = { PASS_IDS, LENSES, STRUCTURED_SUFFIX, assemblePasses, formatReport, normalizedPass, passPrompt }
