'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync, spawn, spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CLI = path.join(ROOT, 'bin', 'review-and-fix-pr-state.js')

test('trusted diff inventory covers exact hunks and only genuine zero-hunk paths', { timeout: 120000 }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-diff-inventory-'))
  const repo = path.join(temp, 'repo')
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'review-state@example.test')
  git('config', 'user.name', 'Review State Test')
  fs.writeFileSync(path.join(repo, 'two.txt'), Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n') + '\n')
  fs.writeFileSync(path.join(repo, 'rename.txt'), 'rename only\n')
  fs.writeFileSync(path.join(repo, 'rename-edit.txt'), Array.from({ length: 20 }, (_, index) => `kept ${index + 1}`).join('\n') + '\n')
  fs.writeFileSync(path.join(repo, 'mode.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o644 })
  git('add', '-A'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')

  const lines = fs.readFileSync(path.join(repo, 'two.txt'), 'utf8').trimEnd().split('\n')
  lines[1] = 'changed near start'; lines[38] = 'changed near end'
  fs.writeFileSync(path.join(repo, 'two.txt'), lines.join('\n') + '\n')
  fs.renameSync(path.join(repo, 'rename.txt'), path.join(repo, 'moved.txt'))
  fs.renameSync(path.join(repo, 'rename-edit.txt'), path.join(repo, 'moved-edit.txt'))
  const movedLines = fs.readFileSync(path.join(repo, 'moved-edit.txt'), 'utf8').trimEnd().split('\n')
  movedLines[9] = 'edited after rename'
  fs.writeFileSync(path.join(repo, 'moved-edit.txt'), movedLines.join('\n') + '\n')
  fs.chmodSync(path.join(repo, 'mode.sh'), 0o755)
  fs.writeFileSync(path.join(repo, 'asset.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  git('add', '-A'); git('commit', '-qm', 'inventory cases')
  const head = git('rev-parse', 'HEAD')

  const result = spawnSync(process.execPath, [CLI, 'diff-files', '--store', path.join(temp, 'store'),
    '--root', repo, '--base', base, '--head', head], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const inventory = JSON.parse(result.stdout)
  assert.equal(inventory.ok, true)
  assert.equal(inventory.count, inventory.changedFiles.length)
  assert.equal(inventory.hunkCount, 3)
  assert.deepEqual(inventory.hunks.map(hunk => hunk.path), ['moved-edit.txt', 'two.txt', 'two.txt'])
  assert.deepEqual([...inventory.zeroHunkPaths].sort(), ['asset.bin', 'mode.sh', 'moved.txt'])
  assert.equal(inventory.structuralUnits.some(unit => unit.path === 'moved-edit.txt' && unit.id.startsWith('non-text:rename:')), true)
  assert.equal(inventory.structuralUnits.some(unit => unit.path === 'mode.sh' && unit.id.startsWith('non-text:mode:')), true)

  const diff = execFileSync('git', ['-C', repo, 'diff', `${base}...${head}`, '--', 'two.txt'], { encoding: 'utf8' })
  const starts = [...diff.matchAll(/^@@ /gm)].map(match => match.index)
  const expected = starts.map((start, index) => crypto.createHash('sha256')
    .update(diff.slice(start, index + 1 < starts.length ? starts[index + 1] : diff.length)).digest('hex'))
  assert.deepEqual(inventory.hunks.filter(hunk => hunk.path === 'two.txt').map(hunk => hunk.hash), expected)
})

test('prepared fix transaction recovers a commit after the workflow disappears', { timeout: 120000 }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-state-recovery-'))
  const store = path.join(temp, 'store')
  const repo = path.join(temp, 'repo')
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'recovery@example.test'); git('config', 'user.name', 'Recovery')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n'); git('add', '-A'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const key = { repository: repo, pr: 8, base, head: base, workflowVersion: '0.5.0', model: 'test' }
  const invoke = args => {
    const result = spawnSync(process.execPath, [CLI, ...args, '--store', store], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return JSON.parse(result.stdout)
  }
  const responseId = '9'.repeat(64)
  const claim = invoke(['claim', '--key-base64', Buffer.from(JSON.stringify(key)).toString('base64'),
    '--root', repo, '--response-id', responseId])
  const journaledClaim = invoke(['claim-result', '--response-id', responseId])
  assert.equal(journaledClaim.run, claim.run)
  assert.equal(journaledClaim.lockToken, claim.lockToken)
  const fallback = { batchId: 'recover-b1', fixed: [], notABug: [], followUps: [], stillOpen: [{
    fingerprint: 'a.txt:file-level:logic', title: 'recover me', detail: 'pending disposition', primaryFile: 'a.txt',
    files: ['a.txt'], symbol: 'file-level', defectClass: 'logic', evidence: 'a.txt:1', severity: 'medium',
    trigger: 'review', mechanism: 'pending commit', observableImpact: 'unknown disposition',
    baseVsHead: 'changed by recovered commit', coverageUnitIds: ['hunk:a'], scopeLabel: 'in',
    confidence: 'likely', fixSize: 'small', defer: false, deferReason: 'none', releaseBlocker: false,
    blockerReason: 'none', deferralQuote: 'none', whyStillHere: 'workflow interrupted after commit',
  }] }
  invoke(['put', '--run', claim.run, '--lock-token', claim.lockToken, '--name', 'pending/recover/0000.part',
    '--base64', Buffer.from(JSON.stringify(fallback)).toString('base64')])
  const prepared = invoke(['prepare-head', '--run', claim.run, '--lock-token', claim.lockToken, '--root', repo,
    '--from', base, '--batch', 'recover-b1', '--receipt-prefix', 'pending/recover', '--receipt-parts', '1'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n'); git('add', '-A')
  invoke(['seal-head', '--run', claim.run, '--root', repo, '--tx-id', prepared.txId,
    '--paths-base64', Buffer.from(JSON.stringify(['a.txt'])).toString('base64')])
  git('commit', '-qm', 'fix\n\nReview-And-Fix-Run: ' + claim.run +
    '\nReview-And-Fix-Transaction: ' + prepared.txId)
  const recoveredHead = git('rev-parse', 'HEAD')
  key.head = recoveredHead

  // No advance-head call: the original workflow vanished immediately after git commit.
  const recovered = invoke(['claim', '--key-base64', Buffer.from(JSON.stringify(key)).toString('base64'), '--root', repo])
  assert.equal(recovered.resumed, true)
  assert.equal(recovered.run, claim.run)
  assert.equal(recovered.state.lineage.currentHead, recoveredHead)
  const recoveredLineage = invoke(['export-lineage', '--run', claim.run, '--after', '0', '--limit', '1'])
  assert.equal(recoveredLineage.commits[0].recovered, true)
  assert.equal(recoveredLineage.commits[0].receipt.stillOpen[0].fingerprint,
    'a.txt:file-level:logic')
  invoke(['unlock', '--run', recovered.run, '--lock-token', recovered.lockToken])

  const unrelatedKey = Object.assign({}, key, { pr: 999 })
  const unrelated = invoke(['claim', '--key-base64', Buffer.from(JSON.stringify(unrelatedKey)).toString('base64'), '--root', repo])
  invoke(['unlock', '--run', unrelated.run, '--lock-token', unrelated.lockToken])
  fs.writeFileSync(path.join(unrelated.runDir, 'state.json'), '{corrupt\n')
  const exactCorrupt = spawnSync(process.execPath, [CLI, 'claim', '--key-base64',
    Buffer.from(JSON.stringify(unrelatedKey)).toString('base64'), '--root', repo, '--store', store], { encoding: 'utf8' })
  assert.notEqual(exactCorrupt.status, 0)
  assert.match(JSON.parse(exactCorrupt.stdout).error, /invalid JSON|state integrity/)
  const unaffected = invoke(['claim', '--key-base64', Buffer.from(JSON.stringify(key)).toString('base64'), '--root', repo])
  assert.equal(unaffected.run, claim.run)
  invoke(['unlock', '--run', unaffected.run, '--lock-token', unaffected.lockToken])
})

test('resume export is bounded to scope, latest cycle, and latest disposition', { timeout: 120000 }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-state-pages-'))
  const store = path.join(temp, 'store')
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const key = Buffer.from(JSON.stringify({ head: 'a'.repeat(40), repo: 'pages' })).toString('base64')
  const invoke = (args, input) => {
    const result = spawnSync(process.execPath, [CLI, ...args, '--store', store], { encoding: 'utf8', input })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return JSON.parse(result.stdout)
  }
  const claim = invoke(['claim', '--key-base64', key])
  const put = (name, value) => invoke(['put', '--run', claim.run, '--lock-token', claim.lockToken,
    '--name', name, '--stdin'], JSON.stringify(value))
  const scopeName = 'scope-' + 'b'.repeat(64) + '.json'
  put(scopeName, { scope: { coverageUnits: [] }, stateKey: { head: 'a'.repeat(40) } })
  put('cycle-1/lenses/old.json', { payload: 'o'.repeat(70000) })
  put('cycle-1/dispositions.json', { snapshotVersion: 2, payload: 'd'.repeat(70000) })
  put('cycle-2/lenses/a.json', { payload: 'a'.repeat(70000) })
  put('cycle-2/lenses/b.json', { payload: 'b'.repeat(70000) })
  put('summary/cycle-2-completed-8-4.json', { stopReason: 'completed' })
  put('summary/cycle-2-expected-artifacts.json', { artifacts: ['cycle-2/lenses/a.json'] })

  const names = []
  let after = 'none'
  for (let pages = 0; pages < 10; pages++) {
    const page = invoke(['resume-json', '--run', claim.run, '--after', after, '--max-bytes', '80000'])
    assert.ok(page.artifacts.length <= 1 || Buffer.byteLength(JSON.stringify(page)) <= 90000)
    names.push(...page.artifacts.map(item => item.name))
    if (page.nextAfter === 'none') break
    after = page.nextAfter
  }
  assert.deepEqual(names.sort(), [
    'cycle-1/dispositions.json', 'cycle-2/lenses/a.json', 'cycle-2/lenses/b.json', scopeName,
    'summary/cycle-2-completed-8-4.json', 'summary/cycle-2-expected-artifacts.json',
  ])
  invoke(['unlock', '--run', claim.run, '--lock-token', claim.lockToken])
})

test('review state checkpoints are atomic, resumable, and hash-bound', { timeout: 120000 }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-state-'))
  const store = path.join(temp, 'store')
  const repo = path.join(temp, 'repo')
  const keyFile = path.join(temp, 'key.json')
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))

  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'review-state@example.test')
  git('config', 'user.name', 'Review State Test')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n')
  git('add', 'a.txt')
  git('commit', '-qm', 'base')
  const initialHead = git('rev-parse', 'HEAD')

  let key = {
    repository: repo,
    pr: 7,
    base: initialHead,
    head: initialHead,
    workflowVersion: '0.5.0',
    model: 'test-model',
    mandatoryLenses: ['correctness', 'spec'],
    extraReviewSkills: [],
  }
  const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
  writeJson(keyFile, key)

  function invoke(commandArgs, options = {}) {
    const result = spawnSync(process.execPath, [CLI, ...commandArgs, '--store', store], {
      input: options.input,
      encoding: 'utf8',
      maxBuffer: 1 << 24,
    })
    let json
    try { json = JSON.parse(result.stdout) } catch {
      assert.fail('non-JSON state output (' + result.status + '): ' + result.stdout + '\n' + result.stderr)
    }
    return { status: result.status, json, stderr: result.stderr }
  }
  function succeeds(commandArgs, options) {
    const result = invoke(commandArgs, options)
    assert.equal(result.status, 0, JSON.stringify(result.json) + '\n' + result.stderr)
    assert.equal(result.json.ok, true)
    return result.json
  }
  function fails(commandArgs, pattern, options) {
    const result = invoke(commandArgs, options)
    assert.notEqual(result.status, 0, JSON.stringify(result.json))
    assert.equal(result.json.ok, false)
    if (pattern) assert.match(result.json.error, pattern)
    return result
  }

  const first = succeeds(['claim', '--key-file', keyFile, '--root', repo, '--owner', 'test'])
  assert.equal(first.resumed, false)
  assert.match(first.run, /^[A-Za-z0-9._-]+$/)
  assert.match(first.lockToken, /^[a-f0-9]{64}$/)
  assert.equal(first.repository.head, initialHead)
  assert.ok(first.runDir.startsWith(store + path.sep))

  fails(['claim', '--key-file', keyFile, '--root', repo], /already locked/)
  fails(['put', '--run', first.run, '--lock-token', '0'.repeat(64), '--name', 'bad.json', '--stdin'], /lock-token/, { input: '{}' })

  const artifact = Buffer.from('{"findings":[]}\n')
  const artifactFile = path.join(temp, 'artifact.json')
  fs.writeFileSync(artifactFile, artifact)
  const artifactSha = crypto.createHash('sha256').update(artifact).digest('hex')
  let saved = succeeds([
    'put', '--run', first.run, '--lock-token', first.lockToken,
    '--name', 'lenses/correctness.json', '--file', artifactFile, '--expected-sha256', artifactSha,
  ])
  assert.equal(saved.idempotent, false)
  saved = succeeds([
    'put', '--run', first.run, '--lock-token', first.lockToken,
    '--name', 'lenses/correctness.json', '--file', artifactFile,
  ])
  assert.equal(saved.idempotent, true)

  const different = path.join(temp, 'different.json')
  fs.writeFileSync(different, '{"findings":[1]}\n')
  fails([
    'put', '--run', first.run, '--lock-token', first.lockToken,
    '--name', 'lenses/correctness.json', '--file', different,
  ], /immutable/)
  succeeds([
    'put', '--run', first.run, '--lock-token', first.lockToken,
    '--name', 'coverage/manifest.json', '--stdin',
  ], { input: '{"hunks":["h1"]}\n' })
  succeeds([
    'put', '--run', first.run, '--lock-token', first.lockToken,
    '--name', 'lenses/spec.json', '--stdin',
  ], { input: '{"findings":[{"id":"S1"}]}\n' })
  succeeds([
    'put', '--run', first.run, '--lock-token', first.lockToken,
    '--name', 'raw.bin', '--base64', Buffer.from([0, 1, 2, 255]).toString('base64'),
  ])
  fails([
    'put', '--run', first.run, '--lock-token', first.lockToken,
    '--name', '../escape.json', '--stdin',
  ], /safe slash-separated/, { input: '{}' })
  fails([
    'put', '--run', first.run, '--lock-token', first.lockToken,
    '--name', 'wrong-hash.json', '--stdin', '--expected-sha256', '0'.repeat(64),
  ], /expected-sha256/, { input: '{}' })

  const listed = succeeds(['list', '--run', first.run])
  assert.deepEqual(listed.artifacts.map(item => item.name), [
    'coverage/manifest.json', 'lenses/correctness.json', 'lenses/spec.json', 'raw.bin',
  ])
  const exportedJson = succeeds(['export-json', '--run', first.run, '--prefix', 'lenses/'])
  assert.deepEqual(exportedJson, {
    ok: true,
    run: first.run,
    artifacts: [
      { name: 'lenses/correctness.json', value: { findings: [] } },
      { name: 'lenses/spec.json', value: { findings: [{ id: 'S1' }] } },
    ],
  })
  fails(['export-json', '--run', first.run, '--prefix', '../'], /artifact --name|artifact --prefix/)
  const exported = path.join(temp, 'exported.json')
  succeeds(['get', '--run', first.run, '--name', 'lenses/correctness.json', '--out', exported])
  assert.deepEqual(fs.readFileSync(exported), artifact)
  const encoded = succeeds(['get', '--run', first.run, '--name', 'raw.bin', '--base64'])
  assert.deepEqual(Buffer.from(encoded.base64, 'base64'), Buffer.from([0, 1, 2, 255]))

  const storedArtifact = path.join(first.runDir, 'artifacts', 'lenses', 'correctness.json')
  fs.writeFileSync(storedArtifact, 'tampered\n')
  fails(['validate', '--run', first.run], /artifact integrity/, undefined)
  fs.writeFileSync(storedArtifact, artifact)
  assert.equal(succeeds(['validate', '--run', first.run, '--root', repo]).validatedArtifacts, 4)

  const stateFile = path.join(first.runDir, 'state.json')
  const pristineState = fs.readFileSync(stateFile)
  const tamperedState = JSON.parse(pristineState)
  tamperedState.status = 'forged'
  fs.writeFileSync(stateFile, JSON.stringify(tamperedState))
  fails(['status', '--run', first.run], /state integrity/)
  fs.writeFileSync(stateFile, pristineState)

  const metaFile = path.join(temp, 'meta.json')
  writeJson(metaFile, { trigger: 'score-code', codeScore: 20 })
  const partial = succeeds([
    'status', '--run', first.run, '--lock-token', first.lockToken,
    '--set', 'partial-stop', '--meta-file', metaFile,
  ])
  assert.equal(partial.state.status, 'partial-stop')
  assert.equal(succeeds(['unlock', '--run', first.run, '--lock-token', first.lockToken]).state.locked, false)

  // Object key order does not affect the resume identity.
  key = Object.fromEntries(Object.entries(key).reverse())
  writeJson(keyFile, key)
  const keyBase64 = Buffer.from(JSON.stringify(key)).toString('base64')
  fails(['resume', '--key-file', keyFile, '--key-base64', keyBase64, '--root', repo], /exactly one/)
  const lookup = succeeds(['resume', '--key-base64', keyBase64, '--root', repo])
  assert.equal(lookup.found, true)
  assert.equal(lookup.state.run, first.run)
  const resumed = succeeds(['claim', '--key-base64', keyBase64, '--root', repo, '--owner', 'resume-test'])
  assert.equal(resumed.resumed, true)
  assert.equal(resumed.run, first.run)
  assert.notEqual(resumed.lockToken, first.lockToken)

  // Only a clean, direct workflow-owned commit may advance the resumable head.
  const receipt = Buffer.from(JSON.stringify({ batchId: 'b1', fixed: [{ fingerprint: 'f1' }],
    notABug: [], stillOpen: [], followUps: [{ title: 'later', detail: 'x'.repeat(80000), area: 'tests',
      size: 'big', doneNow: false, releaseBlocker: true, blockerReason: 'coverage' }] }))
  const receiptParts = []
  for (let offset = 0; offset < receipt.length; offset += 32768) receiptParts.push(receipt.subarray(offset, offset + 32768))
  for (let index = 0; index < receiptParts.length; index++) succeeds([
    'put', '--run', first.run, '--lock-token', resumed.lockToken,
    '--name', 'receipts/b1/' + String(index).padStart(4, '0') + '.part',
    '--base64', receiptParts[index].toString('base64'),
  ])
  const pendingReceipt = { batchId: 'b1', fixed: [], notABug: [], followUps: [], stillOpen: [{
    fingerprint: 'fix.txt:file-level:logic', title: 'fix it', detail: 'needs a fix', primaryFile: 'fix.txt',
    files: ['fix.txt'], symbol: 'file-level', defectClass: 'logic', evidence: 'fix.txt:1', severity: 'medium',
    trigger: 'review', mechanism: 'missing fix', observableImpact: 'wrong result',
    baseVsHead: 'introduced by PR', coverageUnitIds: ['hunk:fix'],
    confidence: 'likely', fixSize: 'small', defer: false, deferReason: 'none', releaseBlocker: false,
    blockerReason: 'none', scopeLabel: 'in', deferralQuote: 'none', whyStillHere: 'pending transaction',
  }] }
  succeeds(['put', '--run', first.run, '--lock-token', resumed.lockToken,
    '--name', 'pending/b1/0000.part', '--base64', Buffer.from(JSON.stringify(pendingReceipt)).toString('base64')])
  const prepared = succeeds([
    'prepare-head', '--run', first.run, '--lock-token', resumed.lockToken, '--root', repo,
    '--from', initialHead, '--batch', 'b1', '--receipt-prefix', 'pending/b1', '--receipt-parts', '1',
  ])
  assert.match(prepared.txId, /^[a-f0-9]{64}$/)
  fs.writeFileSync(path.join(repo, 'fix.txt'), 'workflow fix\n')
  git('add', 'fix.txt')
  succeeds(['seal-head', '--run', first.run, '--root', repo, '--tx-id', prepared.txId,
    '--paths-base64', Buffer.from(JSON.stringify(['fix.txt'])).toString('base64')])
  git('commit', '-qm', 'workflow fix\n\nReview-And-Fix-Run: ' + first.run +
    '\nReview-And-Fix-Transaction: ' + prepared.txId)
  const fixedHead = git('rev-parse', 'HEAD')
  const advanced = succeeds([
    'advance-head', '--run', first.run, '--lock-token', resumed.lockToken,
    '--root', repo, '--from', initialHead, '--to', fixedHead,
    '--receipt-prefix', 'receipts/b1', '--receipt-parts', String(receiptParts.length),
    '--tx-id', prepared.txId,
  ])
  assert.equal(advanced.state.lineage.currentHead, fixedHead)
  assert.equal(advanced.state.lineage.total, 1)
  const lineagePage = succeeds(['export-lineage', '--run', first.run, '--after', '0', '--limit', '1'])
  assert.equal(lineagePage.commits[0].receipt.batchId, 'b1')
  assert.equal(lineagePage.commits[0].receipt.followUps[0].releaseBlocker, true)
  assert.equal(lineagePage.commits[0].receipt.followUps[0].detail.length, 80000)
  const retriedAdvance = succeeds([
    'advance-head', '--run', first.run, '--lock-token', resumed.lockToken,
    '--root', repo, '--from', initialHead, '--to', fixedHead,
    '--receipt-prefix', 'receipts/b1', '--receipt-parts', String(receiptParts.length),
    '--tx-id', prepared.txId,
  ])
  assert.equal(retriedAdvance.idempotent, true)
  assert.equal(retriedAdvance.state.lineage.total, 1)
  key.head = fixedHead
  writeJson(keyFile, key)
  succeeds(['ack-head', '--run', first.run, '--lock-token', resumed.lockToken, '--tx-id', prepared.txId])
  const afterFix = succeeds(['claim', '--key-file', keyFile, '--root', repo])
  assert.equal(afterFix.resumed, true)
  assert.equal(afterFix.run, first.run)
  succeeds(['unlock', '--run', first.run, '--lock-token', afterFix.lockToken])

  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'not committed\n')
  fails(['claim', '--key-file', keyFile, '--root', repo], /dirty/)
  fs.unlinkSync(path.join(repo, 'dirty.txt'))

  const finalLock = succeeds(['claim', '--key-file', keyFile, '--root', repo])
  const summaryFile = path.join(temp, 'summary.json')
  writeJson(summaryFile, { coverage: 'complete', findings: 2 })
  const complete = succeeds([
    'complete', '--run', first.run, '--lock-token', finalLock.lockToken,
    '--root', repo, '--status', 'complete', '--summary-file', summaryFile,
  ])
  assert.equal(complete.state.terminal, true)
  assert.equal(complete.validatedArtifacts, 5 + receiptParts.length)
  assert.equal(succeeds(['resume', '--key-file', keyFile, '--root', repo]).found, false)
  fails(['status', '--run', first.run, '--lock-token', finalLock.lockToken, '--set', 'forged'], /lock-token|sealed/)

  const replacement = succeeds(['claim', '--key-file', keyFile, '--root', repo])
  assert.equal(replacement.resumed, false)
  assert.notEqual(replacement.run, first.run)
  succeeds(['unlock', '--run', replacement.run, '--lock-token', replacement.lockToken])

  // An unrelated head never aliases the saved workflow-owned lineage.
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'user commit\n')
  git('add', 'unrelated.txt')
  git('commit', '-qm', 'unrelated user commit')
  const unrelatedHead = git('rev-parse', 'HEAD')
  key.head = unrelatedHead
  writeJson(keyFile, key)
  const unrelated = succeeds(['claim', '--key-file', keyFile, '--root', repo])
  assert.equal(unrelated.resumed, false)
  succeeds(['unlock', '--run', unrelated.run, '--lock-token', unrelated.lockToken])

  // Abandoned incomplete runs are pruned after seven days; sealed audit records remain.
  const staleKeyFile = path.join(temp, 'stale-key.json')
  writeJson(staleKeyFile, Object.assign({}, key, { pr: 99 }))
  const stale = succeeds(['init', '--key-file', staleKeyFile, '--root', repo, '--run', 'stale-run'])
  succeeds(['unlock', '--run', stale.run, '--lock-token', stale.lockToken])
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000)
  fs.utimesSync(path.join(stale.runDir, 'state.json'), old, old)
  fs.utimesSync(path.join(first.runDir, 'state.json'), old, old)
  const pruned = succeeds(['prune', '--days', '7'])
  assert.deepEqual(pruned.removed, ['stale-run'])
  assert.equal(fs.existsSync(stale.runDir), false)
  assert.equal(fs.existsSync(first.runDir), true)
})

test('review state recovers crashed leases and serializes concurrent claims and prune', { timeout: 120000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-state-concurrency-'))
  const store = path.join(temp, 'store')
  const key = Buffer.from(JSON.stringify({ repository: 'concurrency-test', head: 'a'.repeat(40) })).toString('base64')
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))

  const run = extra => new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...extra, '--store', store], { encoding: 'utf8' })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolve({ status, json: JSON.parse(stdout), stderr }))
  })
  const sync = extra => {
    const result = spawnSync(process.execPath, [CLI, ...extra, '--store', store], { encoding: 'utf8' })
    return { status: result.status, json: JSON.parse(result.stdout) }
  }

  const claims = await Promise.all([
    run(['claim', '--key-base64', key, '--owner', 'concurrent-a']),
    run(['claim', '--key-base64', key, '--owner', 'concurrent-b']),
  ])
  const winner = claims.find(result => result.status === 0)
  const loser = claims.find(result => result.status !== 0)
  assert.ok(winner, JSON.stringify(claims))
  assert.ok(loser, JSON.stringify(claims))
  assert.match(loser.json.error, /already locked/)

  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000)
  fs.utimesSync(path.join(winner.json.runDir, 'state.json'), old, old)
  let pruned = sync(['prune', '--days', '7'])
  assert.equal(pruned.status, 0)
  assert.deepEqual(pruned.json.removed, [])
  assert.match(pruned.json.skipped.find(item => item.run === winner.json.run).reason, /active lease/)

  let unlocked = sync(['unlock', '--run', winner.json.run, '--lock-token', winner.json.lockToken])
  assert.equal(unlocked.status, 0, JSON.stringify(unlocked.json))
  fs.utimesSync(path.join(winner.json.runDir, 'state.json'), old, old)
  pruned = sync(['prune', '--days', '7'])
  assert.deepEqual(pruned.json.removed, [winner.json.run])

  // A claimant that crashes without unlocking loses its explicit short lease; next claim resumes.
  const crashed = sync(['claim', '--key-base64', key, '--owner', 'crashed', '--lease-seconds', '1'])
  assert.equal(crashed.status, 0, JSON.stringify(crashed.json))
  await new Promise(resolve => setTimeout(resolve, 1200))
  const recovered = sync(['claim', '--key-base64', key, '--owner', 'recovery', '--lease-seconds', '30'])
  assert.equal(recovered.status, 0, JSON.stringify(recovered.json))
  assert.equal(recovered.json.resumed, true)
  assert.equal(recovered.json.run, crashed.json.run)
  assert.notEqual(recovered.json.lockToken, crashed.json.lockToken)
  const staleTouch = sync(['touch', '--run', crashed.json.run, '--lock-token', crashed.json.lockToken])
  assert.notEqual(staleTouch.status, 0)
  assert.match(staleTouch.json.error, /lock-token/)

  const writes = await Promise.all([
    run(['put', '--run', recovered.json.run, '--lock-token', recovered.json.lockToken, '--name', 'concurrent/a.json', '--base64', Buffer.from('{"a":1}').toString('base64')]),
    run(['put', '--run', recovered.json.run, '--lock-token', recovered.json.lockToken, '--name', 'concurrent/b.json', '--base64', Buffer.from('{"b":2}').toString('base64')]),
  ])
  assert.equal(writes.filter(result => result.status === 0).length, 2, JSON.stringify(writes))
  const exported = sync(['export-json', '--run', recovered.json.run, '--prefix', 'concurrent/'])
  assert.deepEqual(exported.json.artifacts, [
    { name: 'concurrent/a.json', value: { a: 1 } },
    { name: 'concurrent/b.json', value: { b: 2 } },
  ])
  unlocked = sync(['unlock', '--run', recovered.json.run, '--lock-token', recovered.json.lockToken])
  assert.equal(unlocked.status, 0, JSON.stringify(unlocked.json))
})
