'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { assembleLaneReceipts, readLaneReceipts } = require('../lib/review-discovery-assembler')
const { main: assembleCommand } = require('../bin/review-and-fix-pr-assemble')

function finding(id, mechanism = 'duplicate state') {
  return { candidate_id: id, claim: 'Second state flag can drift', basisType: 'trigger',
    basis: 'a future edit changes only one flag', mechanisms: [mechanism],
    consequence: 'the send guard becomes inconsistent', defectClass: 'maintenance',
    category: 'maintainability', locations: [{ path: 'src/a.js', line: 3 }],
    evidence: [{ path: 'src/a.js', line: 3, detail: 'two flags gate the same action' }] }
}
function lanes() {
  return Array.from({ length: 6 }, (_, index) => ({
    lane: `lane-${index + 1}`, source_id: `S${index + 1}`,
    findings: index < 2 ? [finding(`S${index + 1}-1`)] : [],
    checked_nonissues: [{ observation_id: `N${index + 1}`, basis: 'base behavior',
      reason: 'unchanged at the base revision',
      evidence: [{ path: 'src/a.js', line: 3, detail: 'same code at base' }] }],
    receipt: { coverage_units: [`hunk-${index + 1}`], evidence_refs: ['src/a.js:3'],
      candidate_ids: [], checked_nonissue_ids: [`N${index + 1}`], not_examined: [] },
  }))
}

test('assembler merges exact mechanisms and keeps every source and checked reason', () => {
  const result = assembleLaneReceipts(lanes(), {},
    { repository: 'example/repo', baseSha: '1'.repeat(40), headSha: '2'.repeat(40) }, null)
  assert.equal(result.input.candidates.length, 1)
  assert.deepEqual(result.input.candidates[0].sourceIds, ['S1', 'S2'])
  assert.deepEqual(result.ledger.candidates.map((row) => row.disposition), ['admitted', 'merged'])
  assert.equal(result.ledger.checkedNonissues.length, 6)
  assert.equal(result.ledger.checkedNonissues[0].reason, 'unchanged at the base revision')
  assert.equal(result.input.reviewQuestions.length, 1)
})

test('assembler preserves distinct mechanisms and fails on missing core lanes', () => {
  const distinct = lanes()
  distinct[1].findings[0].mechanisms = ['independent guard']
  assert.equal(assembleLaneReceipts(distinct, {}, {}, null).input.candidates.length, 2)
  assert.throws(() => assembleLaneReceipts(distinct.slice(1), {}, {}, null), /missing core lane S1/)
})

test('transcript reader extracts final JSON without relaying lane prose through parent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rafp-assembler-'))
  try {
    for (const [index, lane] of lanes().entries()) {
      const event = { type: 'assistant', message: { stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(lane) }] } }
      fs.writeFileSync(path.join(dir, `agent-${(index + 10).toString(16)}.jsonl`), JSON.stringify(event) + '\n')
    }
    assert.equal(readLaneReceipts(dir).length, 6)
    fs.writeFileSync(path.join(dir, 'agent-ff.jsonl'), JSON.stringify({ type: 'assistant',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'source_id: S7' }] } }) + '\n')
    assert.throws(() => readLaneReceipts(dir), /not one JSON object/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('assembler command writes frozen judge input and ledger exclusively', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rafp-assembler-cli-'))
  try {
    const receipts = path.join(dir, 'receipts')
    fs.mkdirSync(receipts)
    for (const [index, lane] of lanes().entries()) {
      const event = { type: 'assistant', message: { stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(lane) }] } }
      fs.writeFileSync(path.join(receipts, `agent-${(index + 10).toString(16)}.jsonl`), JSON.stringify(event) + '\n')
    }
    const context = path.join(dir, 'context.json'), input = path.join(dir, 'input.json')
    const ledger = path.join(dir, 'ledger.json')
    fs.writeFileSync(context, JSON.stringify({ prTitle: 'Frozen title' }))
    const env = { REVIEW_AND_FIX_PR_CODEX_CONTEXT: context,
      REVIEW_AND_FIX_PR_CODEX_INPUT: input, REVIEW_AND_FIX_PR_DISCOVERY_LEDGER: ledger,
      REVIEW_AND_FIX_PR_CODEX_EXPECTED_JSON: JSON.stringify({ target: {
        repository: 'example/repo', baseSha: '1'.repeat(40), headSha: '2'.repeat(40) },
      pluginFingerprint: null }) }
    const result = assembleCommand(['--root', dir, '--receipts', receipts], env)
    assert.deepEqual(result, { candidates: 1, rawCandidates: 2, checkedNonissues: 6 })
    assert.equal(JSON.parse(fs.readFileSync(input)).reviewContext.prTitle, 'Frozen title')
    assert.throws(() => assembleCommand(['--root', dir, '--receipts', receipts], env), /refusing to overwrite/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
