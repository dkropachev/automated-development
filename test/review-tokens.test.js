'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { compare } = require('../bench/check-review-tokens')

test('review token gate checks every target and rejects missing usage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-tokens-'))
  const put = (run, target, tool, total) => {
    const dir = path.join(root, 'runs', run, 'results', target)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${tool}.json`), JSON.stringify({ transcriptUsage: {
      input: total, output: 0, cacheRead: 0, cacheCreation: 0, total,
    } }))
  }
  try {
    for (const target of ['ironweave', 'quillstone', 'tidepool']) {
      put('opus-5-5-2026-09-29', target, 'anthropic-pr-review', 50)
      put('opus-5-5-2026-09-29', target, 'mattpocock-review', 50)
      put('new', target, 'review-and-fix-pr2', 120)
    }
    assert.ok(compare(root, 'new').every((row) => row.pass))
    put('new', 'tidepool', 'review-and-fix-pr2', 121)
    assert.deepEqual(compare(root, 'new').map((row) => row.pass), [true, true, false])
    fs.rmSync(path.join(root, 'runs/new/results/quillstone/review-and-fix-pr2.json'))
    assert.throws(() => compare(root, 'new'), /missing result/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
