'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('child_process')
const path = require('path')
const { filterDiff } = require('../bin/added-code-diff')

const SCRIPT = path.join(__dirname, '..', 'bin', 'added-code-diff.js')

test('shows pure removals, redacts replacement removals, and summarizes whole-file deletion', () => {
  const input = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1234567..abcdef0 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1,3 +1,3 @@',
    ' keep',
    '-old()',
    '+newCode()',
    ' tail',
    '@@ -8,2 +8,1 @@',
    '-removedOnly()',
    ' next',
    '@@ -20,2 +19,2 @@ function later() {',
    ' near',
    '-alsoOld()',
    '+alsoNew()',
    'diff --git a/gone.js b/gone.js',
    'deleted file mode 100644',
    'index abcdef0..0000000',
    '--- a/gone.js',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-secretOldCode()',
    'diff --git a/new.js b/new.js',
    'new file mode 100644',
    'index 0000000..1234567',
    '--- /dev/null',
    '+++ b/new.js',
    '@@ -0,0 +1,1 @@',
    '+added()',
    '',
  ].join('\n')
  const output = filterDiff(input)
  assert.match(output, /^Display-only diff: each -\[N removed lines omitted\] marker replaces one consecutive run/)
  assert.match(output, /@@ -1,3 \+1,3 @@ \[1 removed line omitted\]\n keep\n-\[1 removed line omitted\]\n\+newCode\(\)\n tail\n/)
  assert.match(output, /@@ -8,2 \+8,1 @@\n-removedOnly\(\)\n next\n/)
  assert.match(output, /@@ -20,2 \+19,2 @@ function later\(\) \{ \[1 removed line omitted\]\n near\n-\[1 removed line omitted\]\n\+alsoNew\(\)\n/)
  assert.match(output, /diff --git a\/gone\.js b\/gone\.js\ndeleted file mode 100644\ndiff --git a\/new\.js/)
  assert.match(output, /@@ -0,0 \+1,1 @@\n\+added\(\)\n/)
  assert.doesNotMatch(output, /old\(\)|secretOldCode|index /)
})

test('drops removed no-newline marker and rejects malformed hunks', () => {
  const input = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n'
  assert.match(filterDiff(input), /@@ -1,1 \+1,1 @@ \[1 removed line omitted\]\n-\[1 removed line omitted\]\n\+new\n$/)
  assert.doesNotMatch(filterDiff(input), /No newline/)
  assert.throws(() => filterDiff('diff --git a/a b/a\n@@ -1 +1 @@\n+new\n'), /incomplete/)
})

test('reads a patch from stdin', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n+yes\n',
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\+yes\n$/)
})

test('omits binary payload while retaining its file change', () => {
  const input = 'diff --git a/image.bin b/image.bin\nindex 123..456 100644\nGIT binary patch\nliteral 2\nabc123\n\n'
  assert.equal(filterDiff(input),
    'Display-only diff: each -[N removed lines omitted] marker replaces one consecutive run of removed lines in a replacement. Deletion-only lines are shown. Whole-file deletion contents are omitted. Hunk ranges are adjusted for this view. To inspect hidden code, run git diff manually. Do not apply this filtered diff.\n' +
    'diff --git a/image.bin b/image.bin\nBinary patch omitted\n')
})

test('shows deletion-only modifications with their original contents', () => {
  const input = 'diff --git a/config.js b/config.js\n--- a/config.js\n+++ b/config.js\n@@ -1,2 +1 @@\n-removed secret\n keep\n'
  const output = filterDiff(input)
  assert.match(output, /@@ -1,2 \+1,1 @@\n-removed secret\n keep\n$/)
})

test('treats separate change blocks in the same hunk independently', () => {
  const input = 'diff --git a/code.js b/code.js\n--- a/code.js\n+++ b/code.js\n@@ -1,5 +1,4 @@\n a\n-deleteOnly\n b\n-oldValue\n+newValue\n c\n'
  const output = filterDiff(input)
  assert.match(output, /@@ -1,5 \+1,4 @@ \[1 removed line omitted\]\n a\n-deleteOnly\n b\n-\[1 removed line omitted\]\n\+newValue\n c\n$/)
  assert.doesNotMatch(output, /oldValue/)
})

test('collapses each consecutive replacement removal run once and adjusts later hunk positions', () => {
  const input = 'diff --git a/code.js b/code.js\n--- a/code.js\n+++ b/code.js\n' +
    '@@ -1,4 +1,2 @@\n-old1\n-old2\n+new1\n-old3\n-old4\n+new2\n' +
    '@@ -10,2 +8,2 @@\n-old5\n+new3\n keep\n'
  const output = filterDiff(input)
  assert.match(output, /@@ -1,2 \+1,2 @@ \[4 removed lines omitted\]\n-\[2 removed lines omitted\]\n\+new1\n-\[2 removed lines omitted\]\n\+new2\n/)
  assert.match(output, /@@ -8,2 \+8,2 @@ \[1 removed line omitted\]\n-\[1 removed line omitted\]\n\+new3\n keep\n$/)
  assert.doesNotMatch(output, /old[1-5]/)
})
