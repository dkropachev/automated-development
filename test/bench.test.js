'use strict'
// Unit tests for the bake-off harness's pure parts: the link rewriter that blinds a republished PR,
// and the token accounting that reads a session's own cost record back.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const rewrite = require('../bench/lib/rewrite')
const usage = require('../bench/lib/usage')

const target = { upstream: 'scylladb/gocql', fork: 'dkropachev/tidepool', extraReplacements: { 'github.com/gocql/gocql': 'github.com/dkropachev/tidepool' } }

test('buildMap orders longest key first so a long key is never half-replaced', () => {
  const pairs = rewrite.buildMap(target)
  assert.equal(pairs[0][0], 'github.com/gocql/gocql')
  assert.equal(rewrite.rewriteText('import "github.com/gocql/gocql"', pairs), 'import "github.com/dkropachev/tidepool"')
})

test('rewriteText repoints every shape of link to the same repo', () => {
  const pairs = rewrite.buildMap(target)
  assert.equal(rewrite.rewriteText('https://github.com/scylladb/gocql/pull/3', pairs), 'https://github.com/dkropachev/tidepool/pull/3')
  assert.equal(rewrite.rewriteText('git@github.com:scylladb/gocql.git', pairs), 'git@github.com:dkropachev/tidepool.git')
  assert.equal(rewrite.rewriteText('see scylladb/gocql#12', pairs), 'see dkropachev/tidepool#12')
})

test('isBinary keeps a NUL-bearing file out of the rewrite', () => {
  assert.equal(rewrite.isBinary(Buffer.from([0x50, 0x4b, 0x03, 0x00])), true)
  assert.equal(rewrite.isBinary(Buffer.from('plain text')), false)
})

test('rewriteTree reports the files it changed and leaves the rest alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rewrite-'))
  fs.writeFileSync(path.join(dir, 'README.md'), 'go get github.com/scylladb/gocql\n')
  fs.writeFileSync(path.join(dir, 'other.txt'), 'nothing to see\n')
  const changed = rewrite.rewriteTree(dir, rewrite.buildMap(target))
  assert.deepEqual(changed, ['README.md'])
  assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /dkropachev\/tidepool/)
  assert.deepEqual(rewrite.residualLeaks(dir, ['scylladb/gocql']), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('slugFor turns a working directory into the transcript folder Claude Code files it under', () => {
  assert.equal(usage.slugFor('/extra/x/bench/work/tidepool/runs/prf-review/repo'),
               '-extra-x-bench-work-tidepool-runs-prf-review-repo')
})

test('totalsForCwd is zero, not a throw, for a directory that never ran anything', () => {
  const t = usage.totalsForCwd('/nonexistent/bench/run/repo')
  assert.equal(t.total, 0)
  assert.equal(t.sessions, 0)
})
