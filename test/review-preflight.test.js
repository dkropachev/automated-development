'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DIFF = path.join(ROOT, 'bin', 'review-and-fix-pr-diff.js')
const SCOPE = path.join(ROOT, 'bin', 'review-and-fix-pr-scope.js')
const { collectIssueReferences, instructionApplies } = require('../bin/review-and-fix-pr-scope')
const { splitFileDiffs, splitHunks, wholeDiff } = require('../bin/review-and-fix-pr-diff')

test('direct diff inventory covers exact hunks and genuine zero-hunk paths', { timeout: 120000 }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-diff-inventory-'))
  const repo = path.join(temp, 'repo')
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'review-preflight@example.test')
  git('config', 'user.name', 'Review Preflight Test')
  fs.writeFileSync(path.join(repo, 'two.txt'), Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n') + '\n')
  fs.writeFileSync(path.join(repo, 'rename.txt'), 'rename only\n')
  fs.writeFileSync(path.join(repo, 'rename-edit.txt'), Array.from({ length: 20 }, (_, index) => `kept ${index + 1}`).join('\n') + '\n')
  fs.writeFileSync(path.join(repo, 'mode.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o644 })
  git('add', '-A')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')

  const lines = fs.readFileSync(path.join(repo, 'two.txt'), 'utf8').trimEnd().split('\n')
  lines[1] = 'changed near start'
  lines[38] = 'changed near end'
  fs.writeFileSync(path.join(repo, 'two.txt'), lines.join('\n') + '\n')
  fs.renameSync(path.join(repo, 'rename.txt'), path.join(repo, 'moved.txt'))
  fs.renameSync(path.join(repo, 'rename-edit.txt'), path.join(repo, 'moved-edit.txt'))
  const movedLines = fs.readFileSync(path.join(repo, 'moved-edit.txt'), 'utf8').trimEnd().split('\n')
  movedLines[9] = 'edited after rename'
  fs.writeFileSync(path.join(repo, 'moved-edit.txt'), movedLines.join('\n') + '\n')
  fs.chmodSync(path.join(repo, 'mode.sh'), 0o755)
  fs.writeFileSync(path.join(repo, 'asset.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  git('add', '-A')
  git('commit', '-qm', 'inventory cases')
  const head = git('rev-parse', 'HEAD')
  git('config', 'diff.renames', 'false')
  git('config', 'diff.algorithm', 'patience')
  git('config', 'diff.context', '0')
  git('config', 'diff.indentHeuristic', 'true')
  git('config', 'diff.noprefix', 'true')
  git('config', 'color.ui', 'always')
  git('config', 'diff.external', 'false')

  const result = spawnSync(process.execPath, [DIFF, '--root', repo, '--base', base, '--head', head], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const inventory = JSON.parse(result.stdout)
  assert.equal(inventory.ok, true)
  assert.equal(inventory.count, inventory.changedFiles.length)
  assert.equal(inventory.hunkCount, 3)
  assert.deepEqual(inventory.hunks.map(hunk => hunk.path), ['moved-edit.txt', 'two.txt', 'two.txt'])
  assert.equal(new Set(inventory.hunks.map(hunk => hunk.id)).size, inventory.hunkCount)
  assert.equal(inventory.hunks.every(hunk => hunk.id.endsWith(hunk.hash)), true)
  assert.deepEqual([...inventory.zeroHunkPaths].sort(), ['asset.bin', 'mode.sh', 'moved.txt'])
  assert.equal(inventory.structuralUnits.some(unit => unit.path === 'moved-edit.txt' && unit.id.startsWith('non-text:rename:')), true)
  assert.equal(inventory.structuralUnits.some(unit => unit.path === 'mode.sh' && unit.id.startsWith('non-text:mode:')), true)

  const diff = execFileSync('git', ['-C', repo, '-c', 'color.ui=false', '-c', 'diff.renames=true',
    '-c', 'diff.algorithm=myers', '-c', 'diff.context=3', '-c', 'diff.indentHeuristic=false',
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '--find-copies=50%',
    '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/',
    `${base}...${head}`, '--', 'two.txt'], { encoding: 'utf8' })
  const starts = [...diff.matchAll(/^@@ /gm)].map(match => match.index)
  const expected = starts.map((start, index) => crypto.createHash('sha256')
    .update(diff.slice(start, index + 1 < starts.length ? starts[index + 1] : diff.length)).digest('hex'))
  assert.deepEqual(inventory.hunks.filter(hunk => hunk.path === 'two.txt').map(hunk => hunk.hash), expected)
})

test('scope preflight resolves only a repository root and carries no durable review state', () => {
  const result = spawnSync(process.execPath, [SCOPE, '--root', ROOT, '--root-only'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, repoRoot: fs.realpathSync(ROOT) })

  const nested = spawnSync(process.execPath, [SCOPE, '--root', path.join(ROOT, 'bin'), '--root-only'], { encoding: 'utf8' })
  assert.notEqual(nested.status, 0)
  assert.match(JSON.parse(nested.stdout).error, /repository top level/)

  const source = fs.readFileSync(SCOPE, 'utf8')
  assert.doesNotMatch(source, /deferrals-base64|scopeFingerprint|sourceJson|checkpoint|resume/)
  assert.match(source, /\[\['base', mergeBase\], \['head', head\]\]/,
    'scope must preserve governing instructions from both merge base and PR head')
})

test('scope preflight bounds same-repo issue reads and never follows cross-repo references', () => {
  const repo = 'owner/project'
  const body = [
    'Fixes #3 and owner/project#2.',
    'See https://github.com/owner/project/issues/4 and private/secret#99.',
    'Ignore https://github.com/private/secret/issues/100.',
    ...Array.from({ length: 30 }, (_, index) => `#${index + 10}`),
  ].join('\n')
  const result = collectIssueReferences(body, repo)
  assert.equal(result.refs.length, 20)
  assert.equal(result.refs.every(ref => ref.repo === repo), true)
  assert.deepEqual(result.refs.slice(0, 3).map(ref => ref.number), [3, 2, 4])
  assert.equal(result.ignoredCrossRepoIssueCount, 2)
  assert.equal(result.omittedIssueReferenceCount, 13)
})

test('scope preflight selects root and changed-path ancestor instructions only', () => {
  const changed = ['src/api/handler.js', 'test/api.test.js']
  assert.equal(instructionApplies('AGENTS.md', changed), true)
  assert.equal(instructionApplies('src/AGENTS.md', changed), true)
  assert.equal(instructionApplies('src/api/CLAUDE.md', changed), true)
  assert.equal(instructionApplies('.github/CONTRIBUTING.md', changed), true)
  assert.equal(instructionApplies('.github/copilot-instructions.md', changed), true)
  assert.equal(instructionApplies('.github/AGENTS.md', changed), false)
  assert.equal(instructionApplies('vendor/AGENTS.md', changed), false)
  assert.equal(instructionApplies('docs/CONTRIBUTING.md', changed), false)
})

test('direct diff inventory rejects ambiguous revisions and non-root paths', () => {
  for (const args of [
    ['--root', ROOT, '--base', 'HEAD', '--head', 'a'.repeat(40)],
    ['--root', path.join(ROOT, 'bin'), '--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
  ]) {
    const result = spawnSync(process.execPath, [DIFF, ...args], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.equal(JSON.parse(result.stdout).ok, false)
  }
})

test('direct diff inventory fails closed on non-UTF-8 path bytes', { timeout: 120000 }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-diff-encoding-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', temp, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'review-preflight@example.test')
  git('config', 'user.name', 'Review Preflight Test')
  fs.writeFileSync(path.join(temp, 'base.txt'), 'base\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const invalidPath = Buffer.concat([Buffer.from(temp + path.sep + 'bad-'), Buffer.from([0xff])])
  fs.writeFileSync(invalidPath, 'changed\n')
  git('add', '-A')
  git('commit', '-qm', 'invalid path bytes')
  const head = git('rev-parse', 'HEAD')

  const result = spawnSync(process.execPath, [DIFF, '--root', temp, '--base', base, '--head', head], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(JSON.parse(result.stdout).error, /non-UTF-8/)
})

test('copy inventory does not duplicate a modified source hunk under the destination', { timeout: 120000 }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-diff-copy-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', temp, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'review-preflight@example.test')
  git('config', 'user.name', 'Review Preflight Test')
  const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
  fs.writeFileSync(path.join(temp, 'a.txt'), original.join('\n') + '\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')

  const changedSource = [...original]
  changedSource[1] = 'source changed'
  fs.writeFileSync(path.join(temp, 'a.txt'), changedSource.join('\n') + '\n')
  const copied = [...original]
  copied[25] = 'copy changed'
  fs.writeFileSync(path.join(temp, 'b.txt'), copied.join('\n') + '\n')
  git('add', '-A')
  git('commit', '-qm', 'modify source and copy')
  const head = git('rev-parse', 'HEAD')

  const result = spawnSync(process.execPath, [DIFF, '--root', temp, '--base', base, '--head', head], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const inventory = JSON.parse(result.stdout)
  assert.deepEqual(inventory.changedFiles, [
    { path: 'a.txt', status: 'modified' },
    { path: 'b.txt', status: 'copied' },
  ])
  assert.deepEqual(inventory.hunks.map(hunk => hunk.path), ['a.txt', 'b.txt'])
  assert.equal(inventory.structuralUnits.some(unit => unit.path === 'b.txt' && unit.id.startsWith('non-text:copy:')), true)
  const copySection = splitFileDiffs(wholeDiff(temp, base, head))
    .find(section => /\ncopy from a\.txt\ncopy to b\.txt\n/.test(section))
  assert.ok(copySection, 'canonical whole patch has a copy-relative destination section')
  const canonicalCopyHunk = splitHunks(copySection).hunks[0]
  assert.equal(inventory.hunks.find(hunk => hunk.path === 'b.txt').hash,
    crypto.createHash('sha256').update(canonicalCopyHunk).digest('hex'))
})
