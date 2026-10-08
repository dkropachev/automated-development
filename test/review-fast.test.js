'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PASS_IDS, assemblePasses, normalizedPass, passPrompt } = require('../lib/review-fast')
const { applyGroups, normalizeGroups } = require('../lib/review-fast-cluster')
const { childEnvironment, parseArgs, runPasses } = require('../bin/review-and-fix-pr-fast')
const { validatePassReceipt } = require('../lib/review-fast-contract')
const { candidateClaimHash, sha256 } = require('../lib/review-codex-contract')

const finding = {
  claim: 'Two flags can drift', basisType: 'trigger', basis: 'editing one guard',
  mechanisms: ['duplicated closing state'], consequence: 'a send is accepted after close',
  defectClass: 'state-drift', category: 'maintainability',
  locations: [{ path: 'src/a.js', line: 7 }],
  evidence: [{ path: 'src/a.js', line: 7, detail: 'two flags gate send' }],
}

test('six structured passes assemble exact duplicates with source provenance', () => {
  const passes = PASS_IDS.map((id, index) => normalizedPass(id, {
    findings: index < 2 ? [finding] : [], coverage: 'whole diff reviewed',
  }))
  const result = assemblePasses(passes, {},
    { repository: 'example/repo', baseSha: '1'.repeat(40), headSha: '2'.repeat(40) }, null)
  assert.equal(result.input.candidates.length, 1)
  assert.deepEqual(result.input.candidates[0].sourceIds, ['P1', 'P2'])
  assert.deepEqual(result.ledger.candidates.map((row) => row.disposition), ['admitted', 'merged'])
  assert.throws(() => assemblePasses(passes.slice(1), {}, {}, null))
})

test('pass prompt keeps frozen PR evidence in spec and contracts only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rafp-fast-pass-'))
  try {
    for (const id of PASS_IDS) fs.writeFileSync(path.join(directory, `${id}.txt`), `Review ${id}.\n`)
    const context = { prTitle: 'Frozen title', prBody: 'Quoted body',
      commitMessages: ['commit'], acceptanceCriteria: ['criterion'] }
    assert.doesNotMatch(passPrompt('holistic', context, directory), /Quoted body/)
    assert.match(passPrompt('spec-test', context, directory), /<FROZEN_PR_EVIDENCE_JSON>[\s\S]*Quoted body/)
    assert.match(passPrompt('contracts', context, directory), /<FROZEN_PR_EVIDENCE_JSON>[\s\S]*Quoted body/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('nested Claude subprocess drops parent session markers', () => {
  const env = childEnvironment({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', TASK_ENV: 'kept' })
  assert.equal(env.CLAUDECODE, undefined)
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined)
  assert.equal(env.TASK_ENV, 'kept')
  assert.equal(parseArgs(['--root', '/tmp/repo']).root, '/tmp/repo')
})

test('all six independent passes launch before any one finishes', async () => {
  const started = [], release = []
  const running = runPasses({}, { runPass: (id) => new Promise((resolve) => {
    started.push(id)
    release.push(() => resolve(id))
  }) })
  assert.deepEqual(started, PASS_IDS)
  for (const finish of release) finish()
  assert.deepEqual(await running, PASS_IDS)
})

test('semantic clustering preserves raw provenance and rejects missing or unsafe groups', () => {
  const second = { ...finding, claim: 'A closing flag may diverge later',
    basis: 'updating only the first flag', mechanisms: ['two independent closing flags'] }
  const passes = PASS_IDS.map((id, index) => normalizedPass(id, {
    findings: index === 0 ? [finding] : index === 1 ? [second] : [], coverage: 'reviewed',
  }))
  const assembled = assemblePasses(passes, {}, {}, null)
  const groups = [{ representativeId: 'C1', memberIds: ['C1', 'C2'], reason: 'same state drift' }]
  const result = applyGroups(assembled, groups)
  assert.equal(result.input.candidates.length, 1)
  assert.deepEqual(result.input.candidates[0].sourceIds, ['P1', 'P2'])
  assert.deepEqual(result.ledger.candidates.map((row) => row.disposition), ['admitted', 'merged'])
  assert.throws(() => normalizeGroups({ groups: [{ ...groups[0], memberIds: ['C1'] }] }, assembled.input.candidates))
  assert.throws(() => normalizeGroups({ groups: [{ ...groups[0], memberIds: ['C1', 'C1'] }] }, assembled.input.candidates))
})

test('six-pass receipt binds raw findings and semantic clusters to closure IDs', () => {
  const target = { repository: 'example/repo', baseSha: '1'.repeat(40), headSha: '2'.repeat(40) }
  const passes = PASS_IDS.map((id, index) => {
    const output = { coverage: 'reviewed', findings: index === 0 ? [finding] : [] }
    return normalizedPass(id, output, { model: 'claude-opus-5-5', wallMs: 10,
      costUsd: 0.1, reportedUsage: { input_tokens: 1 }, resultSha256: sha256(output) })
  })
  const assembled = assemblePasses(passes, {}, target, null)
  const groups = assembled.input.candidates.map((candidate) => ({ representativeId: candidate.id,
    memberIds: [candidate.id], reason: 'singleton' }))
  const receipt = { schemaVersion: 1, target, model: 'claude-opus-5-5', passes,
    cluster: { groups, model: 'gpt-5.6-sol', usage: { totalTokens: 10 },
      promptSha256: 'a'.repeat(64), traceSha256: 'b'.repeat(64),
      resultSha256: sha256({ groups }), invocationId: 'J1' }, createdAt: 'now' }
  const candidateLedger = assembled.input.candidates.map((candidate) => ({
    candidateId: candidate.id, claimHash: candidateClaimHash(candidate), originInvocationId: null,
  }))
  assert.equal(validatePassReceipt(receipt, { target, model: receipt.model, candidateLedger })
    .assembled.input.candidates.length, 1)
  assert.throws(() => validatePassReceipt({ ...receipt, passes: [{ ...passes[0],
    coverage: 'tampered' }, ...passes.slice(1)] }))
  assert.throws(() => validatePassReceipt(receipt, { target: { ...target, headSha: '3'.repeat(40) } }))
})
