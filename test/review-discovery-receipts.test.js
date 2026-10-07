'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { captureDiscoveryReceipts, validateDiscoveryReceipts } = require('../lib/review-discovery-receipts')

test('snapshots final subagent receipts and keeps checked observations inspectable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-receipts-'))
  const session = '11111111-1111-1111-1111-111111111111'
  const directory = path.join(root, session, 'subagents')
  fs.mkdirSync(directory, { recursive: true })
  try {
    for (let i = 1; i <= 6; i++) {
      const events = [
        { type: 'assistant', message: { stop_reason: null, content: [{ type: 'text', text: 'draft' }] } },
        { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: `source_id: lane-${i}\nchecked_nonissues:\n  - observation_id: N${i}\n    reason: checked` }] } },
      ]
      fs.writeFileSync(path.join(directory, `agent-a${i}.jsonl`), events.map(JSON.stringify).join('\n') + '\n')
    }
    const receipts = captureDiscoveryReceipts(root, session)
    assert.equal(receipts.length, 6)
    assert.match(receipts[0].finalText, /observation_id: N1/)
    assert.doesNotMatch(receipts[0].finalText, /draft/)
    assert.equal(validateDiscoveryReceipts(receipts), receipts)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
