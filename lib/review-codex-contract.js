'use strict'

const crypto = require('node:crypto')

const CONTRACT_V2 = 'review-and-fix-pr-v2'
const RECEIPT_SCHEMA_VERSION = 1
const JUDGE_MODEL = 'gpt-5.6-sol'
const JUDGE_REASONING_EFFORT = 'high'
const MIN_CODEX_CLI_VERSION = '0.149.0'
const HASH = /^[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{40}$/
const CANDIDATE_ID = /^[A-Za-z][A-Za-z0-9._-]*$/
const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const VERDICTS = new Set(['real', 'false_positive', 'unresolved'])
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'nit'])
const SCOPES = new Set(['in', 'deferred', 'out'])
const FINAL_DISPOSITIONS = new Set(['confirmed', 'rejected', 'unresolved'])
const CATEGORIES = new Set([
  'runtime', 'security', 'docs', 'comments', 'tests', 'standards', 'maintainability',
  'compatibility', 'contracts', 'performance', 'correctness',
])
const BASIS_TYPES = new Set(['claim', 'rule', 'trigger'])

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function sha256(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : JSON.stringify(canonical(value))
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function normalizedSemanticText(value) {
  return requiredString(value, 'semantic text').normalize('NFC').trim().replace(/\s+/g, ' ')
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} fields are invalid`)
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`)
  return value
}

function nullableString(value, label) {
  if (value !== null) requiredString(value, label)
  return value
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}`)
  return value
}

function stringArray(value, label, options = {}) {
  if (!Array.isArray(value) || (!options.empty && value.length === 0) ||
      !value.every((entry) => typeof entry === 'string' && entry.trim())) {
    throw new Error(`${label} must be ${options.empty ? 'an' : 'a nonempty'} array of nonempty strings`)
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must be unique`)
  return value
}

function normalizeLocation(location, label) {
  exactKeys(location, ['line', 'path'], label)
  requiredString(location.path, `${label}.path`)
  if (location.path.startsWith('/') || location.path.includes('\\') || /^[A-Za-z]:/.test(location.path) ||
      location.path.split('/').some((part) => part === '.' || part === '..' || part === '')) {
    throw new Error(`${label}.path must be a safe repository-relative or @virtual path`)
  }
  if (location.line !== null) integer(location.line, `${label}.line`, 1)
  return { path: location.path, line: location.line }
}

function normalizeEvidence(evidence, label) {
  exactKeys(evidence, ['detail', 'line', 'path'], label)
  requiredString(evidence.path, `${label}.path`)
  if (evidence.path.startsWith('/') || evidence.path.includes('\\') || /^[A-Za-z]:/.test(evidence.path) ||
      evidence.path.split('/').some((part) => part === '.' || part === '..' || part === '')) {
    throw new Error(`${label}.path must be a safe repository-relative or @virtual path`)
  }
  if (evidence.line !== null) integer(evidence.line, `${label}.line`, 1)
  requiredString(evidence.detail, `${label}.detail`)
  return { path: evidence.path, line: evidence.line, detail: evidence.detail }
}

function normalizeCandidate(candidate, label = 'candidate', options = {}) {
  const keys = [
    'basis', 'basisType', 'category', 'claim', 'consequence', 'defectClass',
    'evidence', 'locations', 'mechanisms',
  ]
  if (options.withId !== false) keys.push('id')
  if (options.withSources !== false) keys.push('sourceIds')
  if (options.withDuplicate) keys.push('duplicateOfCandidateId')
  exactKeys(candidate, keys, label)
  const normalized = {}
  if (options.withId !== false) {
    if (typeof candidate.id !== 'string' || !CANDIDATE_ID.test(candidate.id)) throw new Error(`${label}.id is invalid`)
    normalized.id = candidate.id
  }
  normalized.claim = requiredString(candidate.claim, `${label}.claim`)
  if (!BASIS_TYPES.has(candidate.basisType)) throw new Error(`${label}.basisType is invalid`)
  normalized.basisType = candidate.basisType
  normalized.basis = requiredString(candidate.basis, `${label}.basis`)
  if (!Array.isArray(candidate.mechanisms) || candidate.mechanisms.length !== 1 ||
      typeof candidate.mechanisms[0] !== 'string' || !candidate.mechanisms[0].trim()) {
    throw new Error(`${label} must contain exactly one atomic mechanism`)
  }
  normalized.mechanisms = [candidate.mechanisms[0]]
  normalized.consequence = requiredString(candidate.consequence, `${label}.consequence`)
  normalized.defectClass = requiredString(candidate.defectClass, `${label}.defectClass`)
  if (!CATEGORIES.has(candidate.category)) throw new Error(`${label}.category is invalid`)
  normalized.category = candidate.category
  if (!Array.isArray(candidate.locations) || candidate.locations.length === 0) {
    throw new Error(`${label}.locations must be nonempty`)
  }
  normalized.locations = candidate.locations.map((entry, index) => normalizeLocation(entry, `${label}.locations[${index}]`))
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) {
    throw new Error(`${label}.evidence must be nonempty`)
  }
  normalized.evidence = candidate.evidence.map((entry, index) => normalizeEvidence(entry, `${label}.evidence[${index}]`))
  if (options.withSources !== false) normalized.sourceIds = stringArray(candidate.sourceIds, `${label}.sourceIds`)
  if (options.withDuplicate) {
    if (typeof candidate.duplicateOfCandidateId !== 'string' ||
        (candidate.duplicateOfCandidateId && !CANDIDATE_ID.test(candidate.duplicateOfCandidateId))) {
      throw new Error(`${label}.duplicateOfCandidateId is invalid`)
    }
    normalized.duplicateOfCandidateId = candidate.duplicateOfCandidateId
  }
  return normalized
}

function sanitizedCandidate(candidate, options = {}) {
  const normalized = normalizeCandidate(candidate, options.label || 'candidate', {
    withId: options.withId !== false,
    withSources: options.withSources !== false,
    withDuplicate: options.withDuplicate === true,
  })
  delete normalized.sourceIds
  return normalized
}

function candidateClaimHash(candidate) {
  const normalized = sanitizedCandidate(candidate, {
    withId: candidate.id !== undefined,
    withSources: candidate.sourceIds !== undefined,
    withDuplicate: candidate.duplicateOfCandidateId !== undefined,
  })
  delete normalized.id
  delete normalized.duplicateOfCandidateId
  delete normalized.locations
  delete normalized.evidence
  for (const field of ['claim', 'basis', 'consequence', 'defectClass']) {
    normalized[field] = normalizedSemanticText(normalized[field])
  }
  normalized.mechanisms = normalized.mechanisms.map(normalizedSemanticText)
  return sha256(normalized)
}

function sameMechanism(left, right) {
  return left.basisType === right.basisType &&
    normalizedSemanticText(left.defectClass) === normalizedSemanticText(right.defectClass) &&
    normalizedSemanticText(left.basis) === normalizedSemanticText(right.basis) &&
    normalizedSemanticText(left.mechanisms[0]) === normalizedSemanticText(right.mechanisms[0]) &&
    normalizedSemanticText(left.consequence) === normalizedSemanticText(right.consequence)
}

function candidateMechanismHash(candidate) {
  const normalized = sanitizedCandidate(candidate, {
    withId: candidate.id !== undefined,
    withSources: candidate.sourceIds !== undefined,
    withDuplicate: candidate.duplicateOfCandidateId !== undefined,
  })
  return sha256({
    basisType: normalized.basisType,
    basis: normalizedSemanticText(normalized.basis),
    mechanism: normalizedSemanticText(normalized.mechanisms[0]),
    consequence: normalizedSemanticText(normalized.consequence),
    defectClass: normalizedSemanticText(normalized.defectClass),
  })
}

function normalizePluginFingerprint(value, label = 'pluginFingerprint') {
  if (value === null) return null
  exactKeys(value, ['contentSha256', 'gitCommit', 'version'], label)
  requiredString(value.version, `${label}.version`)
  if (value.gitCommit !== null && !SHA.test(value.gitCommit || '')) throw new Error(`${label}.gitCommit is invalid`)
  if (!HASH.test(value.contentSha256 || '')) throw new Error(`${label}.contentSha256 is invalid`)
  return {
    version: value.version,
    gitCommit: value.gitCommit,
    contentSha256: value.contentSha256,
  }
}

function normalizeTarget(target, label = 'target') {
  exactKeys(target, ['baseSha', 'headSha', 'repository'], label)
  requiredString(target.repository, `${label}.repository`)
  if (!SHA.test(target.baseSha || '') || !SHA.test(target.headSha || '')) throw new Error(`${label} pins are invalid`)
  return { repository: target.repository, baseSha: target.baseSha, headSha: target.headSha }
}

function normalizeUsage(usage, label = 'usage') {
  exactKeys(usage, [
    'cacheWriteInputTokens', 'cachedInputTokens', 'inputTokens', 'outputTokens',
    'reasoningOutputTokens', 'totalTokens',
  ], label)
  for (const key of Object.keys(usage)) integer(usage[key], `${label}.${key}`)
  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    throw new Error(`${label}.totalTokens does not equal input plus output`)
  }
  return { ...usage }
}

function normalizeJudge(judge, label = 'judge') {
  exactKeys(judge, [
    'authenticated', 'cliVersion', 'executableSha256', 'model', 'provider',
    'reasoningEffort', 'schemaSha256',
  ], label)
  if (judge.provider !== 'OpenAI Codex') throw new Error(`${label}.provider must disclose OpenAI Codex`)
  if (judge.model !== JUDGE_MODEL) throw new Error(`${label}.model must be ${JUDGE_MODEL}`)
  if (judge.reasoningEffort !== JUDGE_REASONING_EFFORT) {
    throw new Error(`${label}.reasoningEffort must be ${JUDGE_REASONING_EFFORT}`)
  }
  requiredString(judge.cliVersion, `${label}.cliVersion`)
  const cliMatch = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(judge.cliVersion)
  if (!cliMatch) throw new Error(`${label}.cliVersion is invalid`)
  const actual = cliMatch.slice(1).map(Number)
  const minimum = MIN_CODEX_CLI_VERSION.split('.').map(Number)
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] === minimum[index]) continue
    if (actual[index] < minimum[index]) throw new Error(`${label}.cliVersion must be ${MIN_CODEX_CLI_VERSION}+`)
    break
  }
  if (judge.authenticated !== true) throw new Error(`${label}.authenticated must be true`)
  if (!HASH.test(judge.executableSha256 || '')) throw new Error(`${label}.executableSha256 is invalid`)
  if (!HASH.test(judge.schemaSha256 || '')) throw new Error(`${label}.schemaSha256 is invalid`)
  return { ...judge }
}

function normalizeReceiptCandidate(candidate, label) {
  exactKeys(candidate, [
    'basis', 'basisType', 'category', 'claim', 'claimHash', 'consequence', 'defectClass', 'evidence',
    'finalDisposition', 'id', 'judgmentInvocationId', 'locations', 'mechanism',
    'originInvocationId', 'reason', 'scope', 'severity', 'sourceEvidence', 'verdict',
  ], label)
  if (!CANDIDATE_ID.test(candidate.id || '')) throw new Error(`${label}.id is invalid`)
  if (!HASH.test(candidate.claimHash || '')) throw new Error(`${label}.claimHash is invalid`)
  const atomic = normalizeCandidate({
    id: candidate.id,
    claim: candidate.claim,
    basisType: candidate.basisType,
    basis: candidate.basis,
    mechanisms: [candidate.mechanism],
    consequence: candidate.consequence,
    defectClass: candidate.defectClass,
    category: candidate.category,
    locations: candidate.locations,
    evidence: candidate.evidence,
  }, label, { withSources: false })
  if (candidate.claimHash !== candidateClaimHash(atomic)) throw new Error(`${label}.claimHash does not match its claim`)
  nullableString(candidate.originInvocationId, `${label}.originInvocationId`)
  if (candidate.originInvocationId !== null && !INVOCATION_ID.test(candidate.originInvocationId)) {
    throw new Error(`${label}.originInvocationId is invalid`)
  }
  if (!INVOCATION_ID.test(candidate.judgmentInvocationId || '')) throw new Error(`${label}.judgmentInvocationId is invalid`)
  if (!VERDICTS.has(candidate.verdict)) throw new Error(`${label}.verdict is invalid`)
  if (!SEVERITIES.has(candidate.severity)) throw new Error(`${label}.severity is invalid`)
  if (!SCOPES.has(candidate.scope)) throw new Error(`${label}.scope is invalid`)
  requiredString(candidate.reason, `${label}.reason`)
  if (!Array.isArray(candidate.sourceEvidence) || candidate.sourceEvidence.length === 0) {
    throw new Error(`${label}.sourceEvidence must be nonempty`)
  }
  const sourceEvidence = candidate.sourceEvidence.map((entry, index) =>
    normalizeEvidence(entry, `${label}.sourceEvidence[${index}]`))
  const allowedEvidenceLocations = new Set([...atomic.locations, ...atomic.evidence]
    .map((entry) => `${entry.path}\0${entry.line == null ? '' : entry.line}`))
  if (sourceEvidence.some((entry) =>
    !allowedEvidenceLocations.has(`${entry.path}\0${entry.line == null ? '' : entry.line}`))) {
    throw new Error(`${label}.sourceEvidence is not bound to an admitted evidence location`)
  }
  if (!FINAL_DISPOSITIONS.has(candidate.finalDisposition)) throw new Error(`${label}.finalDisposition is invalid`)
  const expectedDisposition = candidate.verdict === 'real' ? 'confirmed'
    : candidate.verdict === 'false_positive' ? 'rejected' : 'unresolved'
  if (candidate.finalDisposition !== expectedDisposition) {
    throw new Error(`${label}.finalDisposition does not match verdict`)
  }
  return {
    id: atomic.id,
    claim: atomic.claim,
    basisType: atomic.basisType,
    basis: atomic.basis,
    mechanism: atomic.mechanisms[0],
    consequence: atomic.consequence,
    defectClass: atomic.defectClass,
    category: atomic.category,
    locations: atomic.locations,
    evidence: atomic.evidence,
    claimHash: candidate.claimHash,
    originInvocationId: candidate.originInvocationId,
    judgmentInvocationId: candidate.judgmentInvocationId,
    verdict: candidate.verdict,
    severity: candidate.severity,
    scope: candidate.scope,
    reason: candidate.reason,
    sourceEvidence,
    finalDisposition: candidate.finalDisposition,
  }
}

function normalizeInvocation(invocation, label) {
  exactKeys(invocation, [
    'candidateIds', 'id', 'model', 'newLeadHashes', 'promptSha256', 'resultSha256', 'sequence',
    'traceSha256', 'usage', 'webAttempted', 'writeAttempted',
  ], label)
  if (!INVOCATION_ID.test(invocation.id || '')) throw new Error(`${label}.id is invalid`)
  integer(invocation.sequence, `${label}.sequence`, 1)
  stringArray(invocation.candidateIds, `${label}.candidateIds`, { empty: true })
  if (invocation.model !== JUDGE_MODEL) throw new Error(`${label}.model must be ${JUDGE_MODEL}`)
  if (!HASH.test(invocation.traceSha256 || '') || !HASH.test(invocation.resultSha256 || '') ||
      !HASH.test(invocation.promptSha256 || '')) {
    throw new Error(`${label} hashes are invalid`)
  }
  stringArray(invocation.newLeadHashes, `${label}.newLeadHashes`, { empty: true })
  if (!invocation.newLeadHashes.every((hash) => HASH.test(hash))) throw new Error(`${label}.newLeadHashes are invalid`)
  if (invocation.writeAttempted !== false) throw new Error(`${label} attempted a write`)
  if (invocation.webAttempted !== false) throw new Error(`${label} attempted web search`)
  return { ...invocation, usage: normalizeUsage(invocation.usage, `${label}.usage`) }
}

function normalizeLeadResolution(resolution, label) {
  exactKeys(resolution, [
    'basis', 'basisType', 'category', 'claimHash', 'consequence', 'defectClass', 'mechanism',
    'mechanismHash', 'originInvocationId', 'resolution', 'targetCandidateId',
  ], label)
  if (!HASH.test(resolution.claimHash || '')) throw new Error(`${label}.claimHash is invalid`)
  if (!HASH.test(resolution.mechanismHash || '')) throw new Error(`${label}.mechanismHash is invalid`)
  for (const field of ['basis', 'consequence', 'defectClass', 'mechanism']) {
    requiredString(resolution[field], `${label}.${field}`)
  }
  if (!BASIS_TYPES.has(resolution.basisType) || !CATEGORIES.has(resolution.category)) {
    throw new Error(`${label} mechanism identity is invalid`)
  }
  const resolutionMechanismHash = sha256({
    basisType: resolution.basisType,
    basis: normalizedSemanticText(resolution.basis),
    mechanism: normalizedSemanticText(resolution.mechanism),
    consequence: normalizedSemanticText(resolution.consequence),
    defectClass: normalizedSemanticText(resolution.defectClass),
  })
  if (resolution.mechanismHash !== resolutionMechanismHash) {
    throw new Error(`${label}.mechanismHash does not match the emitted lead`)
  }
  if (!INVOCATION_ID.test(resolution.originInvocationId || '')) throw new Error(`${label}.originInvocationId is invalid`)
  if (!['admitted', 'duplicate'].includes(resolution.resolution)) throw new Error(`${label}.resolution is invalid`)
  if (!CANDIDATE_ID.test(resolution.targetCandidateId || '')) throw new Error(`${label}.targetCandidateId is invalid`)
  return { ...resolution }
}

function validateReceipt(receipt, expected = {}) {
  exactKeys(receipt, [
    'candidates', 'contract', 'counts', 'createdAt', 'inputSha256', 'invocations', 'judge', 'newLeadResolutions',
    'pendingCandidateIds', 'pluginFingerprint', 'schemaVersion', 'sourceDisclosure', 'status', 'target',
  ], 'Codex receipt')
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) throw new Error('Codex receipt schemaVersion is invalid')
  if (receipt.contract !== CONTRACT_V2) throw new Error(`Codex receipt contract must be ${CONTRACT_V2}`)
  if (receipt.status !== 'complete') throw new Error('Codex receipt has pending verification work')
  if (!HASH.test(receipt.inputSha256 || '')) throw new Error('Codex receipt inputSha256 is invalid')
  exactKeys(receipt.sourceDisclosure, ['adjudication', 'discovery'], 'Codex receipt sourceDisclosure')
  if (receipt.sourceDisclosure.discovery !== 'Anthropic Claude' ||
      receipt.sourceDisclosure.adjudication !== 'OpenAI Codex') {
    throw new Error('Codex receipt must disclose Anthropic Claude discovery and OpenAI Codex adjudication')
  }
  const target = normalizeTarget(receipt.target, 'Codex receipt target')
  const pluginFingerprint = normalizePluginFingerprint(receipt.pluginFingerprint, 'Codex receipt pluginFingerprint')
  const judge = normalizeJudge(receipt.judge, 'Codex receipt judge')
  if (!Array.isArray(receipt.invocations) || receipt.invocations.length === 0) {
    throw new Error('Codex receipt must contain at least one invocation')
  }
  const invocations = receipt.invocations.map((entry, index) => normalizeInvocation(entry, `Codex receipt invocations[${index}]`))
  const invocationIds = new Set()
  const invocationSequences = new Map()
  for (const [index, invocation] of invocations.entries()) {
    if (invocationIds.has(invocation.id)) throw new Error(`duplicate Codex invocation ID: ${invocation.id}`)
    invocationIds.add(invocation.id)
    invocationSequences.set(invocation.id, invocation.sequence)
    if (invocation.sequence !== index + 1) throw new Error('Codex receipt invocation sequence is not contiguous')
  }
  if (!Array.isArray(receipt.candidates)) throw new Error('Codex receipt candidates must be an array')
  const candidates = receipt.candidates.map((entry, index) => normalizeReceiptCandidate(entry, `Codex receipt candidates[${index}]`))
  const ids = new Set(), claimHashes = new Set()
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) throw new Error(`duplicate candidate ID: ${candidate.id}`)
    if (claimHashes.has(candidate.claimHash)) throw new Error(`duplicate candidate claim hash: ${candidate.claimHash}`)
    ids.add(candidate.id)
    claimHashes.add(candidate.claimHash)
    if (!invocationIds.has(candidate.judgmentInvocationId)) {
      throw new Error(`candidate ${candidate.id} references an unknown judgment invocation`)
    }
    if (candidate.originInvocationId !== null && !invocationIds.has(candidate.originInvocationId)) {
      throw new Error(`candidate ${candidate.id} references an unknown origin invocation`)
    }
    if (candidate.originInvocationId === candidate.judgmentInvocationId) {
      throw new Error(`candidate ${candidate.id} was judged by its originating invocation`)
    }
    if (candidate.originInvocationId !== null &&
        invocationSequences.get(candidate.judgmentInvocationId) <= invocationSequences.get(candidate.originInvocationId)) {
      throw new Error(`candidate ${candidate.id} was not judged after its originating invocation`)
    }
    const invocation = invocations.find((entry) => entry.id === candidate.judgmentInvocationId)
    if (!invocation.candidateIds.includes(candidate.id)) {
      throw new Error(`candidate ${candidate.id} is missing from its judgment invocation`)
    }
  }
  for (const invocation of invocations) {
    for (const candidateId of invocation.candidateIds) {
      const candidate = candidates.find((entry) => entry.id === candidateId)
      if (!candidate) throw new Error(`invocation ${invocation.id} references a missing candidate ${candidateId}`)
      if (candidate.judgmentInvocationId !== invocation.id) {
        throw new Error(`candidate ${candidateId} appears in duplicate judgment invocations`)
      }
    }
  }
  if (!Array.isArray(receipt.newLeadResolutions)) throw new Error('Codex receipt newLeadResolutions must be an array')
  const resolutions = receipt.newLeadResolutions.map((entry, index) =>
    normalizeLeadResolution(entry, `Codex receipt newLeadResolutions[${index}]`))
  const resolutionsByOriginAndHash = new Set()
  for (const resolution of resolutions) {
    const key = `${resolution.originInvocationId}\0${resolution.claimHash}`
    if (resolutionsByOriginAndHash.has(key)) throw new Error('duplicate new-lead resolution')
    resolutionsByOriginAndHash.add(key)
    const origin = invocations.find((entry) => entry.id === resolution.originInvocationId)
    if (!origin) throw new Error('new lead references an unknown origin invocation')
    if (!origin.newLeadHashes.includes(resolution.claimHash)) throw new Error('new-lead resolution was not emitted by its origin')
    const targetCandidate = candidates.find((entry) => entry.id === resolution.targetCandidateId)
    if (!targetCandidate) throw new Error('new-lead resolution references a missing candidate')
    const targetMechanismHash = candidateMechanismHash({
      id: targetCandidate.id,
      claim: targetCandidate.claim,
      basisType: targetCandidate.basisType,
      basis: targetCandidate.basis,
      mechanisms: [targetCandidate.mechanism],
      consequence: targetCandidate.consequence,
      defectClass: targetCandidate.defectClass,
      category: targetCandidate.category,
      locations: targetCandidate.locations,
      evidence: targetCandidate.evidence,
    })
    if (resolution.mechanismHash !== targetMechanismHash) {
      throw new Error('new-lead resolution maps to a different mechanism')
    }
    if (resolution.resolution === 'admitted') {
      if (targetCandidate.originInvocationId !== resolution.originInvocationId ||
          targetCandidate.claimHash !== resolution.claimHash) {
        throw new Error('admitted new lead is not bound to its originating invocation')
      }
    } else if (targetCandidate.originInvocationId === resolution.originInvocationId &&
        targetCandidate.claimHash === resolution.claimHash) {
      throw new Error('duplicate new lead inflated the candidate ledger')
    }
  }
  for (const invocation of invocations) {
    for (const hash of invocation.newLeadHashes) {
      if (!resolutionsByOriginAndHash.has(`${invocation.id}\0${hash}`)) {
        throw new Error(`unjudged new lead from invocation ${invocation.id}`)
      }
    }
  }
  if (!Array.isArray(receipt.pendingCandidateIds) || receipt.pendingCandidateIds.length !== 0) {
    throw new Error('Codex receipt has pending verification work')
  }
  exactKeys(receipt.counts, ['confirmed', 'provisional', 'rejected', 'unresolved'], 'Codex receipt counts')
  for (const [key, value] of Object.entries(receipt.counts)) integer(value, `Codex receipt counts.${key}`)
  const derived = {
    provisional: candidates.length,
    confirmed: candidates.filter((entry) => entry.finalDisposition === 'confirmed').length,
    rejected: candidates.filter((entry) => entry.finalDisposition === 'rejected').length,
    unresolved: candidates.filter((entry) => entry.finalDisposition === 'unresolved').length,
  }
  if (Object.keys(derived).some((key) => receipt.counts[key] !== derived[key])) {
    throw new Error('Codex receipt counts do not match the candidate ledger')
  }
  if (derived.provisional !== derived.confirmed + derived.rejected + derived.unresolved) {
    throw new Error('Codex receipt dispositions do not partition candidates')
  }
  requiredString(receipt.createdAt, 'Codex receipt createdAt')
  if (expected.target && JSON.stringify(target) !== JSON.stringify(normalizeTarget(expected.target, 'expected target'))) {
    throw new Error('Codex receipt target pins changed')
  }
  if (Object.hasOwn(expected, 'pluginFingerprint') &&
      JSON.stringify(pluginFingerprint) !== JSON.stringify(normalizePluginFingerprint(expected.pluginFingerprint, 'expected pluginFingerprint'))) {
    throw new Error('Codex receipt plugin fingerprint changed')
  }
  if (expected.model && judge.model !== expected.model) throw new Error('Codex receipt judge model changed')
  if (expected.reasoningEffort && judge.reasoningEffort !== expected.reasoningEffort) {
    throw new Error('Codex receipt judge reasoning effort changed')
  }
  if (expected.cliVersion && judge.cliVersion !== expected.cliVersion) throw new Error('Codex receipt CLI version changed')
  if (expected.executableSha256 && judge.executableSha256 !== expected.executableSha256) {
    throw new Error('Codex receipt executable changed')
  }
  if (expected.schemaSha256 && judge.schemaSha256 !== expected.schemaSha256) {
    throw new Error('Codex receipt output schema hash changed')
  }
  if (expected.inputSha256 && receipt.inputSha256 !== expected.inputSha256) {
    throw new Error('Codex receipt input package changed')
  }
  return canonical({
    ...receipt,
    target,
    pluginFingerprint,
    judge,
    candidates,
    invocations,
    newLeadResolutions: resolutions,
  })
}

function hashReceipt(receipt, expected = {}) {
  return sha256(validateReceipt(receipt, expected))
}

function sumUsage(invocations) {
  const total = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  }
  for (const invocation of invocations) {
    for (const key of Object.keys(total)) total[key] += invocation.usage[key]
  }
  return total
}

function receiptResultBinding(receipt, expected = {}) {
  const normalized = validateReceipt(receipt, expected)
  return canonical({
    candidateLedger: normalized.candidates.map((candidate) => ({
      candidateId: candidate.id,
      claimHash: candidate.claimHash,
      originInvocationId: candidate.originInvocationId,
      judgeInvocationId: candidate.judgmentInvocationId,
      verdict: candidate.verdict,
      finalDisposition: candidate.finalDisposition,
    })),
    newLeadResolutions: normalized.newLeadResolutions.map((lead) => ({
      leadId: `lead-${sha256({ originInvocationId: lead.originInvocationId, claimHash: lead.claimHash })}`,
      claimHash: lead.claimHash,
      originInvocationId: lead.originInvocationId,
      resolution: lead.resolution,
      candidateId: lead.targetCandidateId,
    })),
    codex: {
      provider: 'openai',
      model: normalized.judge.model,
      reasoningEffort: normalized.judge.reasoningEffort,
      cliVersion: normalized.judge.cliVersion,
      receiptSha256: sha256(normalized),
    },
    findings: normalized.counts,
  })
}

function normalizedReceiptProof(receipt, expected = {}) {
  const normalized = validateReceipt(receipt, expected)
  return canonical({
    schemaVersion: 1,
    receiptSha256: sha256(normalized),
    sourceProvider: 'anthropic',
    judgeProvider: 'openai',
    judgeModel: normalized.judge.model,
    reasoningEffort: normalized.judge.reasoningEffort,
    cliVersion: normalized.judge.cliVersion,
    executableSha256: normalized.judge.executableSha256,
    schemaSha256: normalized.judge.schemaSha256,
    inputSha256: normalized.inputSha256,
    candidateCount: normalized.candidates.length,
    invocationCount: normalized.invocations.length,
    usage: sumUsage(normalized.invocations),
  })
}

function receiptSummary(receipt, expected = {}) {
  const binding = receiptResultBinding(receipt, expected)
  return {
    candidateLedger: binding.candidateLedger,
    newLeadResolutions: binding.newLeadResolutions,
    codex: binding.codex,
  }
}

function receiptUsage(receipt, expected = {}) {
  return sumUsage(validateReceipt(receipt, expected).invocations)
}

module.exports = {
  BASIS_TYPES,
  CATEGORIES,
  CONTRACT_V2,
  FINAL_DISPOSITIONS,
  HASH,
  JUDGE_MODEL,
  JUDGE_REASONING_EFFORT,
  MIN_CODEX_CLI_VERSION,
  RECEIPT_SCHEMA_VERSION,
  SCOPES,
  SEVERITIES,
  VERDICTS,
  candidateClaimHash,
  candidateMechanismHash,
  canonical,
  hashReceipt,
  normalizeCandidate,
  normalizePluginFingerprint,
  normalizeTarget,
  normalizedReceiptProof,
  receiptResultBinding,
  receiptSummary,
  receiptUsage,
  sameMechanism,
  sanitizedCandidate,
  sha256,
  sumUsage,
  validateReceipt,
}
