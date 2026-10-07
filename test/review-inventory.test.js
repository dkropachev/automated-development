'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { compactInventory } = require('../lib/review-inventory')

test('compact inventory preserves exact changed lines and stable hunk IDs', () => {
  const context = { prTitle: 'Fix send', acceptanceCriteria: ['refuse late send'],
    canonicalDiffInventory: { inventory: { changedFiles: [{ path: 'a.js', status: 'modified' }],
      hunks: [{ id: 'hunk:a.js:1:abc', path: 'a.js' }], structuralUnits: [] },
    patch: 'diff --git a/a.js b/a.js\nindex abc..def 100644\n--- a/a.js\n+++ b/a.js\n@@ -2,2 +2,2 @@\n-old()\n+new()\n context\n' } }
  const result = compactInventory(context)
  assert.deepEqual(result.hunkIds, [{ id: 'hunk:a.js:1:abc', path: 'a.js' }])
  assert.deepEqual(result.exactChanges[0].hunks[0].changes, ['-old()', '+new()'])
  assert.equal(JSON.stringify(result).includes(' context'), false)
  assert.equal(JSON.stringify(result).includes('index abc'), false)
})
