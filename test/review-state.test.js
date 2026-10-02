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

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}

test('trusted journal import stores one large resumable envelope and rejects unbound sources', { timeout: 120000 }, t => {
  assert.doesNotMatch(fs.readFileSync(CLI, 'utf8'), /\bcompose(?:Artifact)?\b/)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-state-import-'))
  const store = path.join(temp, 'store')
  const config = path.join(temp, 'claude')
  const repo = path.join(temp, 'repo')
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))

  fs.mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'journal-import@example.test')
  git('config', 'user.name', 'Journal Import')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  git('add', 'tracked.txt')
  git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  const scopeFingerprint = 'a'.repeat(64)
  const stateKey = {
    repo: 'example/review-target', pr: 41, base: head, prHead: head, head, scopeFingerprint,
  }
  const projectName = fs.realpathSync(repo).replace(/[^A-Za-z0-9]/g, '-')
  const projectDir = path.join(config, 'projects', projectName)
  const sessionId = '11111111-2222-4333-8444-555555555555'
  const workflowsDir = path.join(projectDir, sessionId, 'subagents', 'workflows')
  fs.mkdirSync(workflowsDir, { recursive: true })

  const runCli = (args, options = {}) => {
    const nodeArgs = options.preload ? ['-r', options.preload, CLI] : [CLI]
    const result = spawnSync(process.execPath, [...nodeArgs, ...args, '--store', store], {
      encoding: 'utf8', cwd: repo, env: Object.assign({}, process.env,
        { CLAUDE_CONFIG_DIR: config }, options.env || {}),
      maxBuffer: 4 * 1024 * 1024,
    })
    return { status: result.status, json: JSON.parse(result.stdout), stderr: result.stderr }
  }
  const succeeds = args => {
    const result = runCli(args)
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.json))
    assert.equal(result.json.ok, true)
    return result.json
  }
  const fails = (args, pattern, options) => {
    const result = runCli(args, options)
    assert.notEqual(result.status, 0, JSON.stringify(result.json))
    assert.equal(result.json.ok, false)
    assert.match(result.json.error, pattern)
    return result.json
  }
  const key = Buffer.from(JSON.stringify(stateKey)).toString('base64')
  const claim = succeeds(['claim', '--key-base64', key, '--root', repo])
  const sourceLabel = 'review correctness import-nonce'
  const callerLabel = 'import cycle-1 correctness import-nonce'
  const name = 'cycle-1/lenses/correctness.json'
  const claimStart = { type: 'started', key: 'v2:claim', agentId: 'aclaim', label: 'claim review state', phase: 'Setup' }
  const sourceStart = { type: 'started', key: 'v2:source', agentId: 'asource', label: sourceLabel, phase: 'Review' }
  const callerStart = { type: 'started', key: 'v2:caller', agentId: 'acaller', label: callerLabel, phase: 'Report' }
  const largeResult = {
    lens: 'correctness', reviewSkillStatus: 'not-requested', findings: [], rejected: [], followUps: [],
    coverageReceipts: [{ unitId: 'hunk:1', status: 'checked', depth: 'traced',
      evidence: 'tracked.txt:1 was traced through its caller', reason: 'none' }],
    outcome: 'reviewed', commitSha: 'none', filesTouched: [], notes: 'x'.repeat(110000),
  }
  const claimResult = { ok: true, run: claim.run, keyHash: claim.keyHash, lockToken: claim.lockToken,
    repository: claim.repository, state: { keyHash: claim.keyHash, lineage: { currentHead: head } } }

  const writeJsonl = (file, rows) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const transcriptRow = (agentId, structured) => ({
    agentId, cwd: fs.realpathSync(repo), sessionId, type: 'assistant',
    message: { content: structured === undefined ? [] : [{ type: 'tool_use', name: 'StructuredOutput', input: structured }] },
  })
  const writeAgent = (dir, start, structured, symlink = null) => {
    const meta = path.join(dir, `agent-${start.agentId}.meta.json`)
    const transcript = path.join(dir, `agent-${start.agentId}.jsonl`)
    const metaValue = { agentType: 'workflow-subagent', description: start.label, workflowPhase: start.phase }
    if (symlink === 'meta') {
      const target = path.join(temp, start.agentId + '-meta-target.json')
      fs.writeFileSync(target, JSON.stringify(metaValue))
      fs.symlinkSync(target, meta)
    } else fs.writeFileSync(meta, JSON.stringify(metaValue))
    if (symlink === 'transcript') {
      const target = path.join(temp, start.agentId + '-transcript-target.jsonl')
      writeJsonl(target, [transcriptRow(start.agentId, structured)])
      fs.symlinkSync(target, transcript)
    } else writeJsonl(transcript, [transcriptRow(start.agentId, structured)])
  }
  const resetWorkflows = () => {
    fs.rmSync(workflowsDir, { recursive: true, force: true })
    fs.mkdirSync(workflowsDir, { recursive: true })
  }
  const writeWorkflow = (workflowId, events, result = largeResult, symlink = null) => {
    const dir = path.join(workflowsDir, workflowId)
    fs.mkdirSync(dir)
    writeJsonl(path.join(dir, 'journal.jsonl'), events)
    for (const start of events.filter(event => event.type === 'started')) {
      if (start.agentId === sourceStart.agentId) writeAgent(dir, start, result, symlink)
      else if (start.agentId === callerStart.agentId) writeAgent(dir, start)
      else if (start.agentId === claimStart.agentId) writeAgent(dir, start, claimResult)
    }
    return dir
  }
  const completeEvents = result => [
    { type: 'launched' }, claimStart, { type: 'result', key: claimStart.key, agentId: claimStart.agentId, result: claimResult },
    sourceStart, { type: 'result', key: sourceStart.key, agentId: sourceStart.agentId, result }, callerStart,
  ]
  const importArgs = ['import-journal', '--run', claim.run, '--lock-token', claim.lockToken, '--root', repo,
    '--name', name, '--source-label', sourceLabel, '--caller-label', callerLabel, '--kind', 'lens',
    '--expected-id', 'correctness', '--expected-head', head, '--source-phase', 'Review',
    '--expected-skill-status', 'not-requested', '--project-cwd', repo]

  const validDir = writeWorkflow('wf_valid', completeEvents(largeResult))
  const imported = succeeds(importArgs)
  assert.equal(imported.idempotent, false)
  assert.ok(imported.bytes > 100000)
  assert.equal(imported.binding.workflowId, 'wf_valid')
  const largeResultSha = crypto.createHash('sha256').update(Buffer.from(canonicalJson(largeResult))).digest('hex')
  assert.equal(imported.resultSha256, largeResultSha)
  const listed = succeeds(['list', '--run', claim.run])
  assert.deepEqual(listed.artifacts.map(artifact => artifact.name), [name])
  assert.equal(listed.artifacts.some(artifact => artifact.name.includes('checkpoint-parts')), false)
  const read = succeeds(['get', '--run', claim.run, '--name', name, '--base64'])
  const envelope = JSON.parse(Buffer.from(read.base64, 'base64'))
  assert.equal(envelope.importVersion, 1)
  assert.equal(envelope.binding.run, claim.run)
  assert.equal(envelope.binding.repositoryIdentity, claim.repository.identity)
  assert.equal(envelope.binding.sourceKey, sourceStart.key)
  assert.equal(envelope.binding.artifactName, name)
  assert.equal(envelope.binding.sessionId, sessionId)
  assert.equal(envelope.binding.projectCwd, fs.realpathSync(repo))
  assert.deepEqual(envelope.result, largeResult)
  const resumed = succeeds(['resume-json', '--run', claim.run, '--after', 'none'])
  assert.deepEqual(resumed.artifacts, [{ name, sha256: imported.sha256, bytes: imported.bytes, value: envelope }])
  const retryCaller = Object.assign({}, callerStart, { key: 'v2:caller-retry', agentId: 'acallerretry' })
  fs.appendFileSync(path.join(validDir, 'journal.jsonl'), [
    { type: 'result', key: callerStart.key, agentId: callerStart.agentId, result: { ok: true } }, retryCaller,
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  writeAgent(validDir, retryCaller)
  assert.equal(succeeds(importArgs).idempotent, true)

  const envelopeForName = (artifactName, bindingOverrides = {}) => {
    const value = JSON.parse(JSON.stringify(envelope))
    value.binding = Object.assign(value.binding, { artifactName }, bindingOverrides)
    return value
  }
  const writeOrphanEnvelope = (artifactName, value) => fs.writeFileSync(
    path.join(claim.runDir, 'artifacts', artifactName), JSON.stringify(value, null, 2) + '\n')
  const orphanName = 'cycle-1/lenses/orphan.json'
  writeOrphanEnvelope(orphanName, envelopeForName(orphanName))
  const orphanArgs = importArgs.slice()
  orphanArgs[orphanArgs.indexOf('--name') + 1] = orphanName
  const adoptedOrphan = succeeds(orphanArgs)
  assert.equal(adoptedOrphan.idempotent, false)
  assert.equal(adoptedOrphan.recoveredOrphan, true)
  assert.equal(adoptedOrphan.sourceResultMatches, true)
  const conflictingName = 'cycle-1/lenses/conflicting-orphan.json'
  fs.writeFileSync(path.join(claim.runDir, 'artifacts', conflictingName), '{}\n')
  const conflictingArgs = importArgs.slice()
  conflictingArgs[conflictingArgs.indexOf('--name') + 1] = conflictingName
  fails(conflictingArgs, /conflicting orphan/)

  const freshOrphanName = 'cycle-1/lenses/fresh-workflow-orphan.json'
  const freshEnvelope = envelopeForName(freshOrphanName)
  writeOrphanEnvelope(freshOrphanName, freshEnvelope)
  const freshResult = Object.assign({}, largeResult, { notes: 'fresh-result-' + 'z'.repeat(110000) })
  const freshClaimStart = Object.assign({}, claimStart, { key: 'v2:fresh-claim', agentId: 'afreshclaim' })
  const freshSourceStart = {
    type: 'started', key: 'v2:fresh-source', agentId: 'afreshsource',
    label: 'review correctness fresh-workflow', phase: 'Review',
  }
  const freshCallerStart = {
    type: 'started', key: 'v2:fresh-caller', agentId: 'afreshcaller',
    label: 'import correctness fresh-workflow', phase: 'Report',
  }
  const freshDir = path.join(workflowsDir, 'wf_fresh')
  fs.mkdirSync(freshDir)
  writeJsonl(path.join(freshDir, 'journal.jsonl'), [
    { type: 'launched' }, freshClaimStart,
    { type: 'result', key: freshClaimStart.key, agentId: freshClaimStart.agentId, result: claimResult },
    freshSourceStart,
    { type: 'result', key: freshSourceStart.key, agentId: freshSourceStart.agentId, result: freshResult },
    freshCallerStart,
  ])
  writeAgent(freshDir, freshClaimStart, claimResult)
  writeAgent(freshDir, freshSourceStart, freshResult)
  writeAgent(freshDir, freshCallerStart)
  const freshArgs = importArgs.slice()
  freshArgs[freshArgs.indexOf('--name') + 1] = freshOrphanName
  freshArgs[freshArgs.indexOf('--source-label') + 1] = freshSourceStart.label
  freshArgs[freshArgs.indexOf('--caller-label') + 1] = freshCallerStart.label
  const recoveredFresh = succeeds(freshArgs)
  assert.equal(recoveredFresh.recoveredOrphan, true)
  assert.equal(recoveredFresh.sourceResultMatches, false)
  assert.equal(recoveredFresh.resultSha256, largeResultSha)
  assert.equal(recoveredFresh.binding.workflowId, 'wf_valid')
  assert.equal(recoveredFresh.binding.sourceLabel, sourceLabel)
  assert.deepEqual(JSON.parse(Buffer.from(succeeds(['get', '--run', claim.run, '--name', freshOrphanName,
    '--base64']).base64, 'base64')), freshEnvelope)
  const retriedFresh = succeeds(freshArgs)
  assert.equal(retriedFresh.idempotent, true)
  assert.equal(retriedFresh.recoveredOrphan, true)
  assert.equal(retriedFresh.sourceResultMatches, false)
  assert.equal(retriedFresh.resultSha256, largeResultSha)

  const wrongWorkflowName = 'cycle-1/lenses/wrong-workflow-orphan.json'
  writeOrphanEnvelope(wrongWorkflowName, envelopeForName(wrongWorkflowName,
    { workflowId: 'wf_missing_provenance' }))
  const wrongWorkflowArgs = freshArgs.slice()
  wrongWorkflowArgs[wrongWorkflowArgs.indexOf('--name') + 1] = wrongWorkflowName
  fails(wrongWorkflowArgs, /conflicting orphan provenance/)
  const wrongExistingWorkflowName = 'cycle-1/lenses/wrong-existing-workflow-orphan.json'
  writeOrphanEnvelope(wrongExistingWorkflowName, envelopeForName(wrongExistingWorkflowName,
    { workflowId: 'wf_fresh' }))
  const wrongExistingWorkflowArgs = freshArgs.slice()
  wrongExistingWorkflowArgs[wrongExistingWorkflowArgs.indexOf('--name') + 1] = wrongExistingWorkflowName
  fails(wrongExistingWorkflowArgs, /stored orphan source start/)

  const changedResult = Object.assign({}, largeResult, { notes: 'changed-' + 'y'.repeat(110000) })
  resetWorkflows(); writeWorkflow('wf_valid', completeEvents(changedResult), changedResult)
  fails(importArgs, /immutable|source or bytes differ/)

  resetWorkflows()
  writeWorkflow('wf_missing', [claimStart,
    { type: 'result', key: claimStart.key, agentId: claimStart.agentId, result: claimResult }, callerStart])
  fails(importArgs, /no single Workflow journal/)

  const wrongRepositoryClaim = JSON.parse(JSON.stringify(claimResult))
  wrongRepositoryClaim.repository.identity = '0'.repeat(64)
  resetWorkflows()
  writeWorkflow('wf_wrong_claim_repo', [claimStart,
    { type: 'result', key: claimStart.key, agentId: claimStart.agentId, result: wrongRepositoryClaim },
    sourceStart, { type: 'result', key: sourceStart.key, agentId: sourceStart.agentId, result: largeResult },
    callerStart])
  fails(importArgs, /no single Workflow journal/)

  const secondSource = Object.assign({}, sourceStart, { key: 'v2:source-two', agentId: 'asource2' })
  resetWorkflows()
  writeWorkflow('wf_ambiguous', completeEvents(largeResult).concat(secondSource,
    { type: 'result', key: secondSource.key, agentId: secondSource.agentId, result: largeResult }))
  fails(importArgs, /no single Workflow journal/)

  resetWorkflows()
  writeWorkflow('wf_caller', [claimStart,
    { type: 'result', key: claimStart.key, agentId: claimStart.agentId, result: claimResult }, callerStart])
  writeWorkflow('wf_source', [sourceStart,
    { type: 'result', key: sourceStart.key, agentId: sourceStart.agentId, result: largeResult }])
  fails(importArgs, /no single Workflow journal/)

  const malformed = Object.assign({}, largeResult)
  delete malformed.coverageReceipts
  resetWorkflows(); writeWorkflow('wf_malformed', completeEvents(malformed), malformed)
  fails(importArgs, /coverageReceipts/)

  const scopeSourceStart = {
    type: 'started', key: 'v2:scope-source', agentId: 'ascope',
    label: 'capture immutable scope import-nonce', phase: 'Scope',
  }
  const scopeCallerStart = {
    type: 'started', key: 'v2:scope-caller', agentId: 'ascopecaller',
    label: 'import immutable scope import-nonce', phase: 'Setup',
  }
  const scopeResult = {
    repo: stateKey.repo,
    slug: 'example__review-target',
    prNumber: stateKey.pr,
    title: 'Exercise trusted scope journal import',
    url: 'https://example.test/example/review-target/pull/41',
    baseRef: 'main',
    mergeBaseSha: stateKey.base,
    headSha: stateKey.prHead,
    startBranch: 'main',
    startSha: stateKey.head,
    repoRoot: fs.realpathSync(repo),
    treeClean: true,
    headMatchesPr: true,
    intent: 'Persist the exact model-produced scope without relaying it through command arguments.',
    scopeFingerprint,
    intentSource: 'body',
    bodyQuality: 'good',
    inScope: ['trusted journal import'],
    outOfScope: [],
    acceptanceCriteria: ['scope remains hash-bound'],
    primaryLanguages: ['JavaScript'],
    changedFiles: [{ path: 'tracked.txt', status: 'modified' }],
    coverageUnits: [{ id: 'requirement:scope-import', type: 'requirement', path: 'none',
      symbol: 'file-level', hash: 'none', summary: 'Import the immutable scope result.' }],
    prAuthor: 'review-author',
    ghUser: 'review-author',
    authoredByMe: true,
    blocker: 'none',
    binOk: true,
    classifyPath: 'none',
    classifyAction: 'unused',
    fingerprint: 'b'.repeat(64),
    ledgerPath: 'none',
    ledgerEntries: 0,
    runDir: '/tmp/review-and-fix-pr-scope-test',
    chunks: [],
    hunksInLedger: 0,
    notReviewable: [],
    chunkerStderr: 'none',
    applicableLenses: [{ lens: 'correctness', reason: 'Import binding is correctness-sensitive.' }],
    notes: 'large-scope-result-' + 's'.repeat(9000),
  }
  const scopeEvents = result => [
    { type: 'launched' }, claimStart,
    { type: 'result', key: claimStart.key, agentId: claimStart.agentId, result: claimResult },
    scopeSourceStart,
    { type: 'result', key: scopeSourceStart.key, agentId: scopeSourceStart.agentId, result },
    scopeCallerStart,
  ]
  const writeScopeWorkflow = (workflowId, result) => {
    resetWorkflows()
    const dir = path.join(workflowsDir, workflowId)
    fs.mkdirSync(dir)
    writeJsonl(path.join(dir, 'journal.jsonl'), scopeEvents(result))
    writeAgent(dir, claimStart, claimResult)
    writeAgent(dir, scopeSourceStart, result)
    writeAgent(dir, scopeCallerStart)
  }
  const scopeName = 'scope-' + scopeFingerprint + '.json'
  const scopeImportArgs = ['import-journal', '--run', claim.run, '--lock-token', claim.lockToken, '--root', repo,
    '--name', scopeName, '--source-label', scopeSourceStart.label, '--caller-label', scopeCallerStart.label,
    '--kind', 'scope', '--expected-id', scopeFingerprint, '--expected-head', head,
    '--source-phase', 'Scope', '--project-cwd', repo]
  writeScopeWorkflow('wf_scope_valid', scopeResult)
  const scopeImported = succeeds(scopeImportArgs)
  assert.equal(scopeImported.idempotent, false)
  assert.ok(scopeImported.bytes > 8192)
  const scopeRead = succeeds(['get', '--run', claim.run, '--name', scopeName, '--base64'])
  const scopeEnvelope = JSON.parse(Buffer.from(scopeRead.base64, 'base64'))
  assert.equal(scopeEnvelope.importVersion, 1)
  assert.equal(scopeEnvelope.binding.kind, 'scope')
  assert.equal(scopeEnvelope.binding.resultId, scopeFingerprint)
  assert.deepEqual(scopeEnvelope.result, scopeResult)
  assert.equal(succeeds(['list', '--run', claim.run]).artifacts.filter(item => item.name === scopeName).length, 1)
  assert.equal(succeeds(['list', '--run', claim.run]).artifacts.some(item =>
    item.name.includes('checkpoint-parts')), false)

  const scopeWithoutOptionalDisplayFields = Object.assign({}, scopeResult)
  delete scopeWithoutOptionalDisplayFields.title
  delete scopeWithoutOptionalDisplayFields.url
  writeScopeWorkflow('wf_scope_optional_display', scopeWithoutOptionalDisplayFields)
  const optionalScopeArgs = scopeImportArgs.slice()
  optionalScopeArgs[optionalScopeArgs.indexOf('--name') + 1] = 'scope-optional-display.json'
  assert.equal(succeeds(optionalScopeArgs).idempotent, false)

  const rejectScope = (workflowId, patch, pattern) => {
    const result = Object.assign({}, scopeResult, patch)
    writeScopeWorkflow(workflowId, result)
    fails(scopeImportArgs, pattern)
  }
  rejectScope('wf_scope_wrong_repo', { repo: 'wrong/repository' }, /scope result.*repo/)
  rejectScope('wf_scope_wrong_pr', { prNumber: stateKey.pr + 1 }, /scope result.*prNumber/)
  rejectScope('wf_scope_wrong_pr_head', { headSha: '1'.repeat(40) }, /scope result.*headSha/)
  rejectScope('wf_scope_wrong_current_head', { startSha: '2'.repeat(40) }, /scope result.*startSha/)
  rejectScope('wf_scope_wrong_base', { mergeBaseSha: '3'.repeat(40) }, /scope result.*mergeBaseSha/)
  rejectScope('wf_scope_wrong_fingerprint', { scopeFingerprint: '4'.repeat(64) },
    /scope result.*scopeFingerprint/)
  rejectScope('wf_scope_bad_coverage', { coverageUnits: [{ id: 'hunk:not-yet-trusted', type: 'hunk',
    path: 'tracked.txt', symbol: '@@ -1 +1 @@', hash: '5'.repeat(64),
    summary: 'Deterministic units do not belong in the Scope-agent source result.' }] },
    /coverageUnits\[0\]\.type/)

  const badStoredScopeName = 'scope-stored-invalid.json'
  const badStoredScopeEnvelope = JSON.parse(JSON.stringify(scopeEnvelope))
  badStoredScopeEnvelope.binding.artifactName = badStoredScopeName
  badStoredScopeEnvelope.result.repo = 'wrong/stored-repository'
  writeOrphanEnvelope(badStoredScopeName, badStoredScopeEnvelope)
  const badStoredScopeArgs = scopeImportArgs.slice()
  badStoredScopeArgs[badStoredScopeArgs.indexOf('--name') + 1] = badStoredScopeName
  writeScopeWorkflow('wf_scope_stored_validation', scopeResult)
  fails(badStoredScopeArgs, /conflicting orphan.*scope result.*repo/)

  resetWorkflows(); writeWorkflow('wf_meta_link', completeEvents(largeResult), largeResult, 'meta')
  fails(importArgs, /non-symlink|cannot read source agent metadata/)
  resetWorkflows(); writeWorkflow('wf_transcript_link', completeEvents(largeResult), largeResult, 'transcript')
  fails(importArgs, /non-symlink|cannot read source agent transcript/)

  resetWorkflows()
  const swappedWorkflow = writeWorkflow('wf_directory_swap', completeEvents(largeResult))
  const workflowTemplate = path.join(temp, 'workflow-template')
  fs.cpSync(swappedWorkflow, workflowTemplate, { recursive: true })
  const swapPreload = path.join(temp, 'swap-workflow-preload.js')
  fs.writeFileSync(swapPreload, [
    "'use strict'",
    "const fs = require('fs')",
    'const opened = new Map()',
    'const openSync = fs.openSync',
    'const closeSync = fs.closeSync',
    'let swapped = false',
    'fs.openSync = function (file, ...rest) {',
    '  const fd = openSync.call(this, file, ...rest)',
    '  opened.set(fd, String(file))',
    '  return fd',
    '}',
    'fs.closeSync = function (fd) {',
    '  const file = opened.get(fd)',
    '  opened.delete(fd)',
    '  const result = closeSync.call(this, fd)',
    "  if (!swapped && file === process.env.REVIEW_STATE_SWAP_JOURNAL) {",
    '    swapped = true',
    "    fs.renameSync(process.env.REVIEW_STATE_SWAP_WORKFLOW, process.env.REVIEW_STATE_SWAP_WORKFLOW + '.old')",
    '    fs.cpSync(process.env.REVIEW_STATE_SWAP_TEMPLATE, process.env.REVIEW_STATE_SWAP_WORKFLOW, { recursive: true })',
    '  }',
    '  return result',
    '}',
    '',
  ].join('\n'))
  const swapArgs = importArgs.slice()
  swapArgs[swapArgs.indexOf('--name') + 1] = 'cycle-1/lenses/directory-swap.json'
  fails(swapArgs, /directory identity changed/, { preload: swapPreload, env: {
    REVIEW_STATE_SWAP_JOURNAL: path.join(swappedWorkflow, 'journal.jsonl'),
    REVIEW_STATE_SWAP_WORKFLOW: swappedWorkflow,
    REVIEW_STATE_SWAP_TEMPLATE: workflowTemplate,
  } })

  resetWorkflows(); writeWorkflow('wf_valid_again', completeEvents(largeResult))
  const artifactSwapPreload = path.join(temp, 'swap-artifact-parent-preload.js')
  fs.writeFileSync(artifactSwapPreload, [
    "'use strict'",
    "const fs = require('fs')",
    "const path = require('path')",
    'const linkSync = fs.linkSync',
    'let swapped = false',
    'fs.linkSync = function (source, target) {',
    '  const result = linkSync.call(this, source, target)',
    "  if (!swapped && target.endsWith(process.env.REVIEW_STATE_SWAP_ARTIFACT)) {",
    '    swapped = true',
    '    const parent = path.dirname(target)',
    "    fs.renameSync(parent, parent + '.old')",
    '    fs.mkdirSync(parent, { mode: 0o700 })',
    '  }',
    '  return result',
    '}',
    '',
  ].join('\n'))
  const artifactSwapArgs = importArgs.slice()
  artifactSwapArgs[artifactSwapArgs.indexOf('--name') + 1] =
    'cycle-8/artifact-swap/artifact-directory-swap.json'
  fails(artifactSwapArgs, /artifact parent.*identity changed/, { preload: artifactSwapPreload,
    env: { REVIEW_STATE_SWAP_ARTIFACT: '/artifact-directory-swap.json' } })

  const corruptPreload = path.join(temp, 'corrupt-import-preload.js')
  fs.writeFileSync(corruptPreload, [
    "'use strict'",
    "const fs = require('fs')",
    'const linkSync = fs.linkSync',
    'fs.linkSync = function (source, target) {',
    '  const result = linkSync.call(this, source, target)',
    "  if (process.env.REVIEW_STATE_CORRUPT_TARGET && target.endsWith(process.env.REVIEW_STATE_CORRUPT_TARGET)) fs.writeFileSync(target, 'corrupted\\n')",
    '  return result',
    '}',
    '',
  ].join('\n'))
  const postWriteArgs = importArgs.slice()
  postWriteArgs[postWriteArgs.indexOf('--name') + 1] = 'cycle-1/lenses/post-write.json'
  fails(postWriteArgs, /persisted imported artifact failed verification/, {
    preload: corruptPreload, env: { REVIEW_STATE_CORRUPT_TARGET: '/post-write.json' },
  })
  assert.equal(succeeds(['list', '--run', claim.run]).artifacts.some(item => item.name.endsWith('post-write.json')), false)

  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n')
  fails(importArgs, /dirty/)
  fs.unlinkSync(path.join(repo, 'dirty.txt'))
  fs.writeFileSync(path.join(repo, 'second.txt'), 'second\n'); git('add', 'second.txt'); git('commit', '-qm', 'second')
  fails(importArgs, /HEAD does not match|expected-head/)
  git('checkout', '-q', '--detach', head)

  const otherRepo = path.join(temp, 'other-repo')
  fs.mkdirSync(otherRepo)
  execFileSync('git', ['-C', otherRepo, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', otherRepo, 'config', 'user.email', 'other@example.test'])
  execFileSync('git', ['-C', otherRepo, 'config', 'user.name', 'Other'])
  fs.writeFileSync(path.join(otherRepo, 'tracked.txt'), 'other\n')
  execFileSync('git', ['-C', otherRepo, 'add', 'tracked.txt'])
  execFileSync('git', ['-C', otherRepo, 'commit', '-qm', 'other'])
  const wrongRootArgs = importArgs.slice()
  wrongRootArgs[wrongRootArgs.indexOf('--root') + 1] = otherRepo
  fails(wrongRootArgs, /identity|HEAD does not match/)

  assert.equal(succeeds(['validate', '--run', claim.run, '--root', repo]).validatedArtifacts, 5)
  succeeds(['unlock', '--run', claim.run, '--lock-token', claim.lockToken])
})

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
  const fallbackId = 'a'.repeat(64)
  const fallback = { receiptVersion: 2, batchId: 'recover-b1', allowedPaths: ['a.txt'],
    fixed: [], notABug: [], followUps: [], stillOpen: [{ id: fallbackId,
      whyStillHere: 'workflow interrupted after commit', defer: false, deferReason: 'none' }] }
  const prepared = invoke(['prepare-head', '--run', claim.run, '--lock-token', claim.lockToken, '--root', repo,
    '--from', base, '--batch', 'recover-b1',
    '--receipt-base64', Buffer.from(JSON.stringify(fallback)).toString('base64')])
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
  assert.equal(recoveredLineage.initialKeyHash, claim.keyHash)
  assert.equal(recoveredLineage.currentKeyHash, recovered.keyHash)
  assert.equal(recoveredLineage.commits[0].fromKeyHash, claim.keyHash)
  assert.equal(recoveredLineage.commits[0].toKeyHash, recovered.keyHash)
  assert.equal(recoveredLineage.commits[0].recovered, true)
  assert.equal(recoveredLineage.commits[0].receipt.receiptVersion, 2)
  assert.equal(recoveredLineage.commits[0].receipt.stillOpen[0].id, fallbackId)
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

test('compact inline v2 fix receipts fence prepare and advance without staged artifacts', { timeout: 120000 }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-state-inline-receipt-'))
  const store = path.join(temp, 'store')
  const repo = path.join(temp, 'repo')
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'inline-receipt@example.test')
  git('config', 'user.name', 'Inline Receipt')
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n')
  git('add', '-A'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const key = Buffer.from(JSON.stringify({ repository: repo, head: base, pr: 12 })).toString('base64')
  const run = (args, options = {}) => {
    const nodeArgs = options.preload ? ['-r', options.preload, CLI] : [CLI]
    const result = spawnSync(process.execPath, [...nodeArgs, ...args, '--store', store], {
      encoding: 'utf8', env: Object.assign({}, process.env, options.env || {}),
    })
    return { status: result.status, json: JSON.parse(result.stdout), stderr: result.stderr }
  }
  const succeeds = args => {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.json))
    return result.json
  }
  const fails = (args, pattern, options) => {
    const result = run(args, options)
    assert.notEqual(result.status, 0, JSON.stringify(result.json))
    assert.match(result.json.error, pattern)
  }
  const claim = succeeds(['claim', '--key-base64', key, '--root', repo])
  const findingId = '1'.repeat(64)
  const fallback = { receiptVersion: 2, batchId: 'inline-b1', allowedPaths: ['fixed.txt'],
    fixed: [], notABug: [], stillOpen: [{ id: findingId, whyStillHere: 'pending fix',
      defer: false, deferReason: 'none' }], followUps: [] }
  const prepare = receipt => ['prepare-head', '--run', claim.run, '--lock-token', claim.lockToken,
    '--root', repo, '--from', base, '--batch', 'inline-b1',
    '--receipt-base64', Buffer.from(JSON.stringify(receipt)).toString('base64')]

  fails(prepare(Object.assign({}, fallback, { allowedPaths: ['../escape.txt'] })), /unsafe.*allowedPaths/)
  fails(prepare(Object.assign({}, fallback, { allowedPaths: ['fixed.txt', 'fixed.txt'] })), /allowedPaths.*unique/)
  fails(prepare(Object.assign({}, fallback, { stillOpen: [{ id: 'bad', whyStillHere: 'pending',
    defer: false, deferReason: 'none' }] })), /64 lowercase hex/)
  fails(prepare(Object.assign({}, fallback, {
    fixed: [{ id: findingId, changeSummary: 'duplicate' }],
  })), /disposition IDs.*unique/)
  fails(prepare(fallback).concat('--receipt-prefix', 'legacy/parts', '--receipt-parts', '1'),
    /exactly one receipt source/)
  const oversizedArgs = prepare(fallback)
  oversizedArgs[oversizedArgs.indexOf('--receipt-base64') + 1] =
    Buffer.from(JSON.stringify({ payload: 'x'.repeat(65536) })).toString('base64')
  fails(oversizedArgs, /exceeds 64 KiB/)

  const prepared = succeeds(prepare(fallback))
  fs.writeFileSync(path.join(repo, 'fixed.txt'), 'fixed\n')
  git('add', 'fixed.txt')
  succeeds(['seal-head', '--run', claim.run, '--root', repo, '--tx-id', prepared.txId,
    '--paths-base64', Buffer.from(JSON.stringify(['fixed.txt'])).toString('base64')])
  git('commit', '-qm', 'inline fix\n\nReview-And-Fix-Run: ' + claim.run +
    '\nReview-And-Fix-Transaction: ' + prepared.txId)
  const fixedHead = git('rev-parse', 'HEAD')
  const finalReceipt = { receiptVersion: 2, batchId: 'inline-b1', allowedPaths: ['fixed.txt'],
    fixed: [{ id: findingId, changeSummary: 'created fixed.txt' }], notABug: [], stillOpen: [], followUps: [] }
  const wrongFinal = Object.assign({}, finalReceipt, {
    fixed: [{ id: '2'.repeat(64), changeSummary: 'wrong disposition identity' }],
  })
  fails(['advance-head', '--run', claim.run, '--lock-token', claim.lockToken,
    '--root', repo, '--from', base, '--to', fixedHead, '--tx-id', prepared.txId,
    '--receipt-base64', Buffer.from(JSON.stringify(wrongFinal)).toString('base64')], /does not exhaust/)
  const advanced = succeeds(['advance-head', '--run', claim.run, '--lock-token', claim.lockToken,
    '--root', repo, '--from', base, '--to', fixedHead, '--tx-id', prepared.txId,
    '--receipt-base64', Buffer.from(JSON.stringify(finalReceipt)).toString('base64')])
  assert.equal(advanced.state.lineage.currentHead, fixedHead)
  const lineage = succeeds(['export-lineage', '--run', claim.run, '--after', '0', '--limit', '1'])
  assert.equal(lineage.commits[0].receipt.receiptVersion, 2)
  assert.equal(lineage.commits[0].receipt.fixed[0].id, findingId)
  assert.deepEqual(succeeds(['list', '--run', claim.run]).artifacts, [])
  succeeds(['ack-head', '--run', claim.run, '--lock-token', claim.lockToken, '--tx-id', prepared.txId])
})

test('control checkpoints recover an immutable crash orphan and resume its stored value', { timeout: 120000 }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-state-control-'))
  const store = path.join(temp, 'store')
  const repo = path.join(temp, 'repo')
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'control@example.test')
  git('config', 'user.name', 'Control')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  git('add', '-A'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  const key = Buffer.from(JSON.stringify({ repository: repo, head, pr: 22 })).toString('base64')
  const run = (args, options = {}) => {
    const nodeArgs = options.preload ? ['-r', options.preload, CLI] : [CLI]
    const result = spawnSync(process.execPath, [...nodeArgs, ...args, '--store', store], {
      encoding: 'utf8', env: Object.assign({}, process.env, options.env || {}),
    })
    return { status: result.status, json: JSON.parse(result.stdout), stderr: result.stderr }
  }
  const succeeds = args => {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.json))
    return result.json
  }
  const fails = (args, pattern, options) => {
    const result = run(args, options)
    assert.notEqual(result.status, 0, JSON.stringify(result.json))
    assert.match(result.json.error, pattern)
  }
  const claim = succeeds(['claim', '--key-base64', key, '--root', repo])
  const controlArgs = (name, value) => ['put-control', '--run', claim.run, '--lock-token', claim.lockToken,
    '--root', repo, '--name', name, '--expected-head', head,
    '--base64', Buffer.from(JSON.stringify(value)).toString('base64')]
  const baselineValue = { build: true, test: true }
  const baseline = succeeds(controlArgs('baseline.json', baselineValue))
  assert.equal(baseline.recoveredOrphan, false)
  assert.equal(baseline.valueMatches, true)
  assert.equal(baseline.valueSha256,
    crypto.createHash('sha256').update(Buffer.from(canonicalJson(baselineValue))).digest('hex'))
  assert.equal(succeeds(controlArgs('baseline.json', baselineValue)).idempotent, true)
  fails(controlArgs('baseline.json', { build: false }), /immutable/)

  const orphanName = 'cycle-1/dispositions.json'
  const oldValue = { snapshotVersion: 3, headSha: head, sourceArtifacts: [], marker: 'old' }
  const oldEnvelope = { controlVersion: 1, binding: { run: claim.run, keyHash: claim.keyHash,
    repositoryIdentity: claim.repository.identity, headSha: head, artifactName: orphanName }, value: oldValue }
  const orphanPath = path.join(claim.runDir, 'artifacts', orphanName)
  fs.mkdirSync(path.dirname(orphanPath), { recursive: true })
  fs.writeFileSync(orphanPath, JSON.stringify(oldEnvelope, null, 2) + '\n')
  const adopted = succeeds(controlArgs(orphanName,
    { snapshotVersion: 3, headSha: head, sourceArtifacts: [], marker: 'new' }))
  assert.equal(adopted.recoveredOrphan, true)
  assert.equal(adopted.valueMatches, false)
  assert.equal(adopted.valueSha256,
    crypto.createHash('sha256').update(Buffer.from(canonicalJson(oldValue))).digest('hex'))
  const resumed = succeeds(['resume-json', '--run', claim.run, '--after', 'none'])
  const restored = resumed.artifacts.find(item => item.name === orphanName)
  assert.deepEqual(restored.value, oldEnvelope)
  const adoptedRetry = succeeds(controlArgs(orphanName, { marker: 'different retry' }))
  assert.equal(adoptedRetry.idempotent, true)
  assert.equal(adoptedRetry.valueMatches, false)

  const wrongName = 'cycle-2/dispositions.json'
  const wrongEnvelope = { controlVersion: 1, binding: Object.assign({}, oldEnvelope.binding,
    { artifactName: wrongName, keyHash: '0'.repeat(64) }), value: oldValue }
  const wrongPath = path.join(claim.runDir, 'artifacts', wrongName)
  fs.mkdirSync(path.dirname(wrongPath), { recursive: true })
  fs.writeFileSync(wrongPath, JSON.stringify(wrongEnvelope, null, 2) + '\n')
  fails(controlArgs(wrongName, oldValue), /conflicting orphan control artifact/)

  const swapPreload = path.join(temp, 'swap-control-parent-preload.js')
  fs.writeFileSync(swapPreload, [
    "'use strict'",
    "const fs = require('fs')",
    "const path = require('path')",
    'const linkSync = fs.linkSync',
    'let swapped = false',
    'fs.linkSync = function (source, target) {',
    '  const result = linkSync.call(this, source, target)',
    "  if (!swapped && target.endsWith('/control-swap.json')) {",
    '    swapped = true',
    '    const parent = path.dirname(target)',
    "    fs.renameSync(parent, parent + '.old')",
    '    fs.mkdirSync(parent, { mode: 0o700 })',
    '  }',
    '  return result',
    '}',
    '',
  ].join('\n'))
  fails(controlArgs('cycle-9/control-swap/control-swap.json', { control: true }),
    /artifact parent.*identity changed/, { preload: swapPreload })
  const expectedIndexName = 'summary/expected-artifacts.json'
  succeeds(controlArgs(expectedIndexName, { artifacts: ['baseline.json', orphanName] }))
  const completed = succeeds(['complete', '--run', claim.run, '--lock-token', claim.lockToken,
    '--root', repo, '--expected-index', expectedIndexName])
  assert.equal(completed.state.terminal, true)
  assert.equal(completed.validatedArtifacts, 3)
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
  const retainedSource = put('cycle-1/lenses/retained-source.json', { payload: 'r'.repeat(70000) })
  const previousDisposition = put('cycle-1/dispositions.json', { snapshotVersion: 3, sourceArtifacts: [[
    'cycle-1/lenses/retained-source.json', retainedSource.sha256, retainedSource.bytes,
  ]], payload: 'd'.repeat(70000) })
  put('cycle-2/lenses/a.json', { payload: 'a'.repeat(70000) })
  put('cycle-2/lenses/b.json', { payload: 'b'.repeat(70000) })
  put('cycle-2/dispositions.json', { snapshotVersion: 3, sourceArtifacts: [], previousDisposition: {
    name: 'cycle-1/dispositions.json', sha256: previousDisposition.sha256, bytes: previousDisposition.bytes,
  } })
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
    'cycle-1/dispositions.json', 'cycle-1/lenses/retained-source.json', 'cycle-2/dispositions.json',
    'cycle-2/lenses/a.json', 'cycle-2/lenses/b.json', scopeName,
    'summary/cycle-2-completed-8-4.json', 'summary/cycle-2-expected-artifacts.json',
  ])
  put('cycle-3/dispositions.json', { snapshotVersion: 3, sourceArtifacts: [], previousDisposition: {
    name: 'cycle-2/dispositions.json', sha256: '0'.repeat(64), bytes: 1,
  } })
  const invalidClosure = spawnSync(process.execPath, [CLI, 'resume-json', '--run', claim.run,
    '--after', 'none', '--store', store], { encoding: 'utf8' })
  assert.notEqual(invalidClosure.status, 0)
  assert.match(JSON.parse(invalidClosure.stdout).error, /previousDisposition does not match/)
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
  const initialLineage = succeeds(['export-lineage', '--run', first.run, '--after', '0', '--limit', '1'])
  assert.equal(initialLineage.initialKeyHash, first.keyHash)
  assert.equal(initialLineage.currentKeyHash, first.keyHash)
  assert.deepEqual(initialLineage.commits, [])

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
  assert.equal(lineagePage.initialKeyHash, resumed.keyHash)
  assert.equal(lineagePage.currentKeyHash, advanced.state.keyHash)
  assert.equal(lineagePage.commits[0].fromKeyHash, resumed.keyHash)
  assert.equal(lineagePage.commits[0].toKeyHash, advanced.state.keyHash)
  assert.equal(lineagePage.commits[0].receipt.receiptVersion, 1)
  assert.equal(lineagePage.commits[0].receipt.batchId, 'b1')
  assert.equal(lineagePage.commits[0].receipt.followUps[0].releaseBlocker, true)
  assert.equal(lineagePage.commits[0].receipt.followUps[0].detail.length, 80000)
  const mappedLineageState = fs.readFileSync(stateFile)
  const writeStateWithIntegrity = value => {
    delete value.integrity
    value.integrity = crypto.createHash('sha256').update(Buffer.from(canonicalJson(value))).digest('hex')
    fs.writeFileSync(stateFile, JSON.stringify(value, null, 2) + '\n')
  }
  const legacyPrefixState = JSON.parse(mappedLineageState)
  const legacyCommit = Object.assign({}, legacyPrefixState.lineage.ownedCommits[0], {
    transactionId: 'legacy-prefix', recovered: true,
  })
  delete legacyCommit.fromKeyHash
  delete legacyCommit.toKeyHash
  legacyPrefixState.lineage.ownedCommits.unshift(legacyCommit)
  writeStateWithIntegrity(legacyPrefixState)
  const legacyPrefixPage = succeeds(['export-lineage', '--run', first.run, '--after', '0', '--limit', '10'])
  assert.equal(legacyPrefixPage.initialKeyHash, null)
  assert.equal(legacyPrefixPage.commits.length, 2)
  const invalidSuffixState = JSON.parse(fs.readFileSync(stateFile))
  invalidSuffixState.lineage.ownedCommits.push(Object.assign({}, legacyCommit, { transactionId: 'legacy-suffix' }))
  writeStateWithIntegrity(invalidSuffixState)
  fails(['export-lineage', '--run', first.run, '--after', '0', '--limit', '10'], /unmapped lineage commit/)
  fs.writeFileSync(stateFile, mappedLineageState)
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
