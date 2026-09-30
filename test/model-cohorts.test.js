'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const artifacts = require('../bench/lib/artifacts')
const usage = require('../bench/lib/usage')
const runner = require('../bench/run')
const extractor = require('../bench/extract')
const judge = require('../bench/judge')
const quota = require('../bench/quota')

const ROOT = path.join(__dirname, '..', 'bench')
const BASE_SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cohorts-'))
  fs.copyFileSync(path.join(ROOT, 'models.json'), path.join(root, 'models.json'))
  writeJson(path.join(root, 'state.json'), {
    targets: {
      sample: {
        id: 'sample', language: 'JS', fork: 'private/sample', forkPr: 1,
        forkPrUrl: 'https://example.invalid/private/sample/pull/1', forkHead: 'prepared',
        upstreamTitle: 'Sample change', localDiffBytes: 42, commits: 1,
      },
    },
  })
  writeJson(path.join(root, 'tools.json'), {
    context: 'Review {fork}',
    tools: [{ id: 'reviewer', label: 'Reviewer', source: 'test', prompt: '{context}' }],
  })
  return root
}

function cohortMetadata(root, runId = 'cohort-a') {
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
  const configFile = path.join(root, 'tools.json')
  const toolConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  return {
    runId,
    requestedModel: 'claude-opus-5-5',
    modelLabel: 'Claude Opus 5.5',
    claudeVersion: '9.9.9',
    targets: { sample: { baseSha: BASE_SHA, headSha: HEAD_SHA } },
    targetMetadata: artifacts.snapshotTargetMetadata(state.targets),
    groundtruth: artifacts.snapshotGroundtruth(root, Object.keys(state.targets)),
    configSha256: artifacts.sha256File(configFile),
    toolConfig,
    expectedCells: [{ id: `${runId}/sample/reviewer`, target: 'sample', tool: 'reviewer' }],
  }
}

function createManifest(root, runId = 'cohort-a') {
  return artifacts.ensureManifest(root, cohortMetadata(root, runId))
}

function createFableManifest(root, runId = 'fable-cohort') {
  return artifacts.ensureManifest(root, {
    ...cohortMetadata(root, runId),
    requestedModel: 'claude-fable-5-1',
    modelLabel: 'Claude Fable 5.1',
    claudeVersion: '2.1.284 (Claude Code)',
  })
}

function createResult(root, manifest, report = 'Review report') {
  const cell = artifacts.cellId(manifest.runId, 'sample', 'reviewer')
  const file = path.join(artifacts.cohortPaths(root, manifest.runId).results, 'sample', 'reviewer.json')
  const response = successfulClaudePayload(manifest.requestedModel)
  const record = {
    schemaVersion: 2,
    ...artifacts.manifestMetadata(manifest),
    cellId: cell,
    target: 'sample',
    tool: 'reviewer',
    label: 'Reviewer',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    exitCode: 0,
    signal: null,
    isError: false,
    apiErrorStatus: null,
    result: report,
    reportedCostUsd: response.total_cost_usd,
    reportedUsage: response.usage,
    modelUsage: response.modelUsage,
    transcriptUsage: validTranscriptUsage(manifest.requestedModel),
  }
  artifacts.writeJsonExclusive(file, record)
  return { file, record }
}

function installReport(root) {
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'report.js'), path.join(root, 'report.js'))
  fs.copyFileSync(path.join(ROOT, 'lib', 'artifacts.js'), path.join(root, 'lib', 'artifacts.js'))
  fs.copyFileSync(path.join(ROOT, 'lib', 'usage.js'), path.join(root, 'lib', 'usage.js'))
}

function runReport(root, ...args) {
  installReport(root)
  return spawnSync(process.execPath, [path.join(root, 'report.js'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOME: path.join(root, 'home') },
  })
}

function runSalvage(root, configDir, ...args) {
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'salvage.js'), path.join(root, 'salvage.js'))
  fs.copyFileSync(path.join(ROOT, 'lib', 'artifacts.js'), path.join(root, 'lib', 'artifacts.js'))
  fs.copyFileSync(path.join(ROOT, 'lib', 'usage.js'), path.join(root, 'lib', 'usage.js'))
  return spawnSync(process.execPath, [path.join(root, 'salvage.js'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  })
}

function completeSampleCohort(root, manifest) {
  createResult(root, manifest)
  assert.equal(extractor.main(['--run', manifest.runId], root, {
    extractOne: (file) => ({
      ok: true,
      record: JSON.parse(fs.readFileSync(file, 'utf8')),
      findings: [{
        title: 'Claim', file: 'src/sample.js', line: 1, severity: 'medium', kind: 'bug',
        claim: 'Something is wrong.', selfRejected: false,
      }],
      modelUsage: successfulClaudePayload('claude-sonnet-5').modelUsage,
    }),
  }), 0)
  const { seal } = artifacts.readSeal(root, manifest.runId)
  const cell = seal.cells[0]
  artifacts.writeJsonExclusive(path.join(artifacts.cohortPaths(root, manifest.runId).judgement, 'sample.json'), {
    schemaVersion: 2,
    ...artifacts.manifestMetadata(manifest),
    target: 'sample', language: 'JS', baseSha: BASE_SHA, headSha: HEAD_SHA,
    rawFindings: 1,
    issues: [{
      id: 'I1', title: 'Claim', file: 'src/sample.js', line: 1, kind: 'bug', severity: 'medium',
      verdict: 'real', verdictReason: 'Code confirms claim.', introducedByPr: true,
      scope: 'in-scope', scopeReason: 'PR added it.', reportedBy: ['reviewer'],
      reportedByRuns: [cell.id], reportedAs: { reviewer: 'Something is wrong.' },
      reportedAsByRun: { [cell.id]: 'Something is wrong.' },
    }],
    judgeRequestedModel: 'claude-sonnet-5',
    judgeModelUsage: successfulClaudePayload('claude-sonnet-5').modelUsage,
    judgeCostUsd: 0.25,
    judgedAt: new Date().toISOString(),
  })
  return { ...artifacts.ensureComplete(root, manifest.runId), cell }
}

function snapshot(dirs) {
  const rows = []
  const visit = (dir, prefix) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name)
      const name = path.join(prefix, entry.name)
      if (entry.isDirectory()) visit(file, name)
      else rows.push([name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])
    }
  }
  for (const dir of dirs) visit(path.join(ROOT, dir), dir)
  return rows
}

function successfulClaudePayload(model = 'claude-opus-5-5') {
  return {
    is_error: false,
    api_error_status: null,
    result: 'Review report',
    total_cost_usd: 0.25,
    usage: { input_tokens: 1, output_tokens: 2 },
    modelUsage: {
      [model]: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        thinkingTokens: 1,
        costUSD: 0.25,
        canonicalModel: model,
      },
      'claude-sonnet-5': {
        inputTokens: 3,
        outputTokens: 4,
        costUSD: 0.05,
        canonicalModel: 'claude-sonnet-5',
      },
    },
  }
}

function validTranscriptUsage(model = 'claude-opus-5-5') {
  return {
    input: 1, output: 2, thinking: 1, cacheRead: 0, cacheCreation: 0,
    costUsd: 0.25, sessions: 1, models: { [model]: 0.25 }, total: 3,
  }
}

function claudeResponse(payload, code = 0) {
  return {
    code, signal: null, error: null, out: JSON.stringify(payload), err: '', wallMs: 25,
  }
}

function fakeExecDependencies(root, responses) {
  const state = { calls: 0, checkouts: 0, sleeps: [] }
  return {
    state,
    dependencies: {
      checkoutPrepared: () => {
        state.checkouts += 1
        const repo = path.join(root, `fake-review-${state.checkouts}`)
        fs.mkdirSync(repo, { recursive: true })
        return { repo, workspace: path.basename(repo), baseSha: BASE_SHA, headSha: HEAD_SHA }
      },
      claudeRun: async () => responses[state.calls++],
      sleep: async (ms) => { state.sleeps.push(ms) },
      totalsForCwd: () => ({
        input: 1, output: 2, thinking: 1, cacheRead: 0, cacheCreation: 0,
        costUsd: 0.25, sessions: 1, models: { 'claude-opus-5-5': 0.25 }, total: 3,
      }),
    },
  }
}

test('model registry exposes Sonnet and Fable while keeping Opus 5.5 default and legacy observed-only', () => {
  const config = artifacts.loadModelConfig(ROOT)
  assert.equal(config.defaultModel, 'claude-opus-5-5')
  assert.equal(artifacts.defaultRunId(ROOT), 'claude-opus-5-5')
  assert.deepEqual(config.models.map(({ id, label }) => ({ id, label })), [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
  ])
  assert.equal(config.legacyCohort.requestedModel, null)
  assert.equal(config.legacyCohort.observedModel, 'claude-opus-5')
  for (const target of fs.readdirSync(path.join(ROOT, 'results'))) {
    for (const file of fs.readdirSync(path.join(ROOT, 'results', target)).filter((name) => name.endsWith('.json'))) {
      const record = JSON.parse(fs.readFileSync(path.join(ROOT, 'results', target, file), 'utf8'))
      assert.equal(Object.hasOwn(record, 'requestedModel'), false)
    }
  }
})

test('runner defaults to pinned model/run and every model invocation is explicit', () => {
  const options = runner.parseArgs([], ROOT)
  assert.equal(options.model, 'claude-opus-5-5')
  assert.equal(options.runId, 'claude-opus-5-5')
  assert.equal(options.limitRetries, Infinity)
  assert.equal(extractor.parseArgs([], ROOT).runId, 'claude-opus-5-5')
  assert.equal(judge.parseArgs([], ROOT).runId, 'claude-opus-5-5')
  const reviewArgs = runner.claudeArgs('review', options.model)
  assert.equal(reviewArgs[reviewArgs.indexOf('--model') + 1], 'claude-opus-5-5')
  assert.equal(reviewArgs[reviewArgs.indexOf('--effort') + 1], 'medium')
  assert.equal(extractor.EXTRACTOR_MODEL, 'claude-sonnet-5')
  const extractArgs = extractor.extractorArgs('report')
  assert.equal(extractArgs[extractArgs.indexOf('--model') + 1], 'claude-sonnet-5')
  assert.equal(extractArgs[extractArgs.indexOf('--effort') + 1], 'high')
  assert.equal(extractArgs[extractArgs.indexOf('--tools') + 1], '')
  assert.equal(judge.JUDGE_MODEL, 'claude-sonnet-5')
  const judgeArgs = judge.judgeArgs('prompt')
  assert.equal(judgeArgs[judgeArgs.indexOf('--model') + 1], 'claude-sonnet-5')
  assert.equal(judgeArgs[judgeArgs.indexOf('--effort') + 1], 'high')
  assert.ok(judgeArgs.slice(judgeArgs.indexOf('--disallowedTools') + 1).includes('ReportFindings'))
})

test('runner parses a bounded usage-limit retry budget', () => {
  assert.equal(runner.parseArgs(['--limit-retries', '0'], ROOT).limitRetries, 0)
  assert.equal(runner.parseArgs(['--limit-retries', '12'], ROOT).limitRetries, 12)
  assert.throws(() => runner.parseArgs(['--limit-retries'], ROOT), /requires a value/)
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    assert.throws(() => runner.parseArgs(['--limit-retries', value], ROOT), /non-negative integer/)
  }
})

test('Fable runner concurrency is exactly one and other cohorts retain their default', async () => {
  assert.equal(runner.parseArgs([
    '--model', 'claude-fable-5-1', '--concurrency', '1',
  ], ROOT).concurrency, 1)
  assert.throws(() => runner.parseArgs(['--model', 'claude-fable-5-1'], ROOT), /requires --concurrency 1/)
  assert.throws(() => runner.parseArgs([
    '--model', 'claude-fable-5-1', '--concurrency', '2',
  ], ROOT), /requires --concurrency 1/)
  for (const value of ['0', '-1', '1.5', '1e2', '0x10', 'NaN', '4294967296']) {
    assert.throws(() => runner.parseArgs(['--concurrency', value], ROOT), /positive integer/)
  }
  assert.equal(runner.parseArgs([], ROOT).concurrency, 2)

  const root = fixture()
  try {
    const manifest = createFableManifest(root)
    await assert.rejects(runner.main(['--run', manifest.runId, '--only', 'absent'], root), /requires --concurrency 1/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Fable requires Claude Code 2.1.284 or newer before cohort creation', async () => {
  assert.deepEqual(runner.parseClaudeVersion('2.1.284 (Claude Code)'), { major: 2, minor: 1, patch: 284 })
  assert.doesNotThrow(() => runner.assertClaudeVersionSupportsModel('2.1.284 (Claude Code)', 'claude-fable-5-1'))
  assert.doesNotThrow(() => runner.assertClaudeVersionSupportsModel('2.2.0 (Claude Code)', 'claude-fable-5-1'))
  assert.throws(() => runner.assertClaudeVersionSupportsModel('2.1.283 (Claude Code)', 'claude-fable-5-1'), /requires Claude Code 2\.1\.284\+/)
  assert.throws(() => runner.assertClaudeVersionSupportsModel('not-a-version', 'claude-fable-5-1'), /could not parse version/)
  assert.doesNotThrow(() => runner.assertClaudeVersionSupportsModel('not-a-version', 'claude-opus-5-5'))
  assert.throws(() => runner.parseClaudeVersion('2.1'), /invalid Claude Code version/)

  const root = fixture()
  try {
    const runId = 'fable-old-client'
    await assert.rejects(runner.main([
      '--model', 'claude-fable-5-1', '--run', runId, '--only', 'absent', '--concurrency', '1',
    ], root, {
      resolveExecutable: () => '/absolute/test-claude',
      claudeVersion: () => '2.1.283 (Claude Code)',
    }), /requires Claude Code 2\.1\.284\+/)
    assert.equal(fs.existsSync(artifacts.cohortPaths(root, runId).manifest), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Fable version check invokes the resolved absolute executable', async () => {
  const root = fixture()
  try {
    const manifest = createFableManifest(root, 'fable-version-realpath')
    const calls = []
    await runner.main([
      '--run', manifest.runId, '--only', 'absent', '--concurrency', '1',
    ], root, {
      env: { CLAUDE: 'relative-claude' },
      resolveExecutable: (command) => { calls.push(['resolve', command]); return '/absolute/claude' },
      claudeVersion: (executable) => { calls.push(['version', executable]); return manifest.claudeVersion },
    })
    assert.deepEqual(calls, [['resolve', 'relative-claude'], ['version', '/absolute/claude']])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('extractor normalizes overlong display titles without changing finding evidence', () => {
  const claim = 'The detailed evidence remains unchanged.'
  const title = 'A generated benchmark finding title that is intentionally far too long for the dashboard and report ceiling'
  const [finding] = extractor.normalizeFindings([{ title, claim, severity: 'medium' }])
  assert.ok(finding.title.length <= extractor.TITLE_LIMIT)
  assert.match(finding.title, /…$/)
  assert.equal(finding.claim, claim)
  assert.equal(finding.severity, 'medium')
  assert.equal(extractor.normalizeTitle('  Short title  '), 'Short title')
})

test('extractor normalizes report line ranges to their first line', () => {
  const [finding] = extractor.normalizeFindings([{
    title: 'Range', file: 'src/sample.js', line: '12-18', severity: 'low', kind: 'bug',
    claim: 'The report cited a source range.', selfRejected: false,
  }])
  assert.equal(finding.line, 12)
})

test('manifests pin exact target commits and preserve target metadata', () => {
  const root = fixture()
  try {
    const first = artifacts.ensureManifest(root, { ...cohortMetadata(root), createdAt: '2026-01-01T00:00:00.000Z' })
    const resumed = artifacts.ensureManifest(root, { ...cohortMetadata(root), createdAt: 'ignored-on-resume' })
    assert.equal(first.schemaVersion, 2)
    assert.equal(resumed.createdAt, first.createdAt)
    assert.deepEqual(first.targets.sample, { baseSha: BASE_SHA, headSha: HEAD_SHA })
    assert.equal(first.targetMetadata.sample.fork, 'private/sample')
    assert.equal(first.targetMetadata.sample.upstreamTitle, 'Sample change')
    assert.throws(() => artifacts.ensureManifest(root, {
      ...cohortMetadata(root), targets: { sample: { baseSha: 'short', headSha: HEAD_SHA } },
    }), /40-hex/)
    assert.throws(() => artifacts.ensureManifest(root, {
      ...cohortMetadata(root), targets: { sample: { baseSha: 'c'.repeat(40), headSha: HEAD_SHA } },
    }), /target pins mismatch/)
    assert.throws(() => artifacts.readManifest(root, 'cohort-a', ['other']), /target set mismatch/)

    const parsed = runner.parseLsRemote([
      `${BASE_SHA}\trefs/heads/main`,
      `${HEAD_SHA}\trefs/heads/prepared`,
    ].join('\n'), { fork: 'private/sample', forkHead: 'prepared' })
    assert.deepEqual(parsed, { baseSha: BASE_SHA, headSha: HEAD_SHA })
    let called = false
    const remote = runner.resolveTargetPins(root, first.targetMetadata.sample, (command, args) => {
      called = true
      assert.deepEqual([command, ...args.slice(0, 2)], ['git', 'ls-remote', 'git@github.com:private/sample.git'])
      return { out: `${BASE_SHA}\trefs/heads/main\n${HEAD_SHA}\trefs/heads/prepared\n` }
    })
    assert.equal(called, true)
    assert.deepEqual(remote, parsed)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('manifest pins tool protocol and resume refuses config or state drift', async () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    assert.equal(manifest.toolConfig.tools[0].prompt, '{context}')
    const originalTools = fs.readFileSync(path.join(root, 'tools.json'), 'utf8')
    const changed = JSON.parse(originalTools)
    changed.tools[0].prompt = 'Changed prompt'
    writeJson(path.join(root, 'tools.json'), changed)
    const dependencies = { claudeVersion: () => manifest.claudeVersion }
    await assert.rejects(runner.main(['--run', manifest.runId, '--only', 'absent'], root, dependencies), /configSha256 mismatch|tool config mismatch/)

    fs.writeFileSync(path.join(root, 'tools.json'), originalTools)
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
    state.targets.sample.forkPr = 99
    writeJson(path.join(root, 'state.json'), state)
    await assert.rejects(runner.main(['--run', manifest.runId, '--only', 'absent'], root, dependencies), /target metadata mismatch/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('two cohorts never collide and exclusive publication leaves no temporary file', () => {
  const root = fixture()
  try {
    fs.mkdirSync(path.join(root, 'results'), { recursive: true })
    writeJson(path.join(root, 'results', 'legacy.json'), { untouched: true })
    const first = createManifest(root, 'cohort-a')
    createManifest(root, 'cohort-b')
    const resumeOptions = runner.parseArgs(['--run', 'cohort-a'], root)
    assert.equal(runner.selectCohort(root, resumeOptions, ['sample']).requestedModel, 'claude-opus-5-5')
    assert.throws(() => runner.selectCohort(root, runner.parseArgs([
      '--run', 'cohort-a', '--model', 'claude-opus-5',
    ], root), ['sample']), /uses claude-opus-5-5/)

    const aFile = path.join(artifacts.cohortPaths(root, 'cohort-a').results, 'sample', 'reviewer.json')
    const bFile = path.join(artifacts.cohortPaths(root, 'cohort-b').results, 'sample', 'reviewer.json')
    artifacts.writeJsonExclusive(aFile, { cohort: 'a' })
    artifacts.writeJsonExclusive(bFile, { cohort: 'b' })
    assert.notEqual(aFile, bFile)
    const before = fs.readFileSync(aFile)
    assert.throws(() => artifacts.writeJsonExclusive(aFile, { cohort: 'replacement' }), { code: 'EEXIST' })
    assert.deepEqual(fs.readFileSync(aFile), before)
    assert.deepEqual(fs.readdirSync(path.dirname(aFile)), ['reviewer.json'])
    assert.equal(first.requestedModel, 'claude-opus-5-5')

    const cohorts = artifacts.discoverCohorts(root)
    assert.deepEqual(cohorts.map((cohort) => cohort.runId), ['legacy', 'cohort-a', 'cohort-b'])
    assert.equal(cohorts[0].requestedModel, null)
    assert.equal(cohorts[0].observedModel, 'claude-opus-5')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('run IDs reject traversal in every stage', () => {
  for (const bad of ['../legacy', 'nested/run', '..\\legacy', '.', '..']) {
    assert.throws(() => artifacts.cohortPaths(ROOT, bad), /invalid run id/)
    assert.throws(() => runner.parseArgs(['--run', bad, '--list'], ROOT), /invalid run id/)
    assert.throws(() => extractor.parseArgs(['--run', bad], ROOT), /invalid run id/)
    assert.throws(() => judge.parseArgs(['--run', bad], ROOT), /invalid run id/)
  }
  assert.throws(() => runner.validateInputs({ targets: { '../bad': { id: '../bad' } } }, { context: '', tools: [] }), /invalid state target key/)
  assert.throws(() => runner.validateInputs({ targets: { ok: { id: 'ok' } } }, {
    context: '', tools: [{ id: 'same' }, { id: 'same' }],
  }), /duplicate tool id/)
})

test('cohort paths reject symlinks before manifest or result creation', () => {
  const root = fixture()
  try {
    fs.mkdirSync(path.join(root, 'runs'))
    fs.symlinkSync(root, path.join(root, 'runs', 'evil'), 'dir')
    assert.throws(() => artifacts.ensureManifest(root, cohortMetadata(root, 'evil')), /symlink/)
    assert.equal(fs.existsSync(path.join(root, 'manifest.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('--force is rejected and list mode has no network or filesystem side effects', async () => {
  assert.throws(() => runner.parseArgs(['--force', '--list'], ROOT), /not supported/)
  assert.throws(() => extractor.parseArgs(['--force'], ROOT), /not supported/)
  assert.throws(() => judge.parseArgs(['--force'], ROOT), /not supported/)
  const root = fixture()
  try {
    await runner.main(['--list', '--only', 'absent'], root)
    assert.equal(fs.existsSync(path.join(root, 'runs')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runner reclaims dead local locks but never live or foreign locks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-locks-'))
  const out = path.join(root, 'result.json')
  const lock = out + '.lock'
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname() }))
  assert.equal(runner.claim(out), null)
  const foreign = JSON.stringify({ pid: 100000000, hostname: 'some-other-host.invalid' })
  fs.writeFileSync(lock, foreign)
  assert.equal(runner.claim(out), null)
  assert.equal(fs.readFileSync(lock, 'utf8'), foreign)
  let deadPid = 100000000
  for (;;) {
    try { process.kill(deadPid, 0); deadPid += 1 } catch (error) {
      if (error.code === 'ESRCH') break
      throw error
    }
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid, hostname: os.hostname() }))
  assert.equal(runner.claim(out), lock)
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid)
  assert.equal(artifacts.releaseLocalLock(lock), true)

  fs.writeFileSync(lock, '{"pid":')
  assert.equal(runner.claim(out), null, 'fresh truncated legacy lock stays conservative')
  const old = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(lock, old, old)
  assert.equal(runner.claim(out), lock, 'old malformed lock is recoverable')
  assert.equal(artifacts.releaseLocalLock(lock), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('delayed stale reclaimer cannot steal replacement lock via pathname ABA', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-lock-aba-'))
  try {
    const lock = path.join(root, 'cell.json.lock')
    let deadPid = 100000000
    while (true) {
      try { process.kill(deadPid, 0); deadPid += 1 } catch (error) {
        if (error.code === 'ESRCH') break
        throw error
      }
    }
    fs.writeFileSync(lock, JSON.stringify({ pid: deadPid, hostname: os.hostname() }))
    let winner = null
    const delayed = artifacts.acquireLocalLock(lock, {
      afterObserveAbandoned: () => { winner = artifacts.acquireLocalLock(lock) },
    })
    assert.equal(delayed, null)
    assert.equal(winner, lock)
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid)
    assert.equal(artifacts.releaseLocalLock(winner), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('only successful exact requested-model Claude responses are publishable', () => {
  const model = 'claude-opus-5-5'
  const success = successfulClaudePayload(model)
  const response = { code: 0, signal: null, error: null }
  assert.equal(runner.assertPublishableResponse(response, success, model), success)
  assert.deepEqual(Object.keys(success.modelUsage), [model, 'claude-sonnet-5'])
  assert.throws(() => runner.assertPublishableResponse({ ...response, signal: 'SIGKILL' }, success, model), /SIGKILL/)
  assert.throws(() => runner.assertPublishableResponse(response, null, model), /valid JSON/)
  assert.throws(() => runner.assertPublishableResponse({ ...response, code: 1 }, success, model), /exited 1/)
  assert.throws(() => runner.assertPublishableResponse(response, { ...success, is_error: true }, model), /marked as an error/)
  assert.throws(() => runner.assertPublishableResponse(response, { ...success, api_error_status: 500 }, model), /API error status 500/)
  assert.throws(() => runner.assertPublishableResponse(response, { ...success, result: null }, model), /not a string/)
  assert.doesNotThrow(() => runner.assertPublishableResponse(response, { ...success, result: '  \n' }, model))
  assert.throws(() => runner.assertPublishableResponse(response, {
    ...success, modelUsage: { 'claude-sonnet-5': success.modelUsage['claude-sonnet-5'] },
  }, model), /missing requested model/)

  const usage = success.modelUsage[model]
  assert.throws(() => runner.assertPublishableResponse(response, {
    ...success, modelUsage: { ...success.modelUsage, [model]: { ...usage, canonicalModel: 'claude-opus-5' } },
  }, model), /canonicalModel/)
  assert.throws(() => runner.assertPublishableResponse(response, {
    ...success, modelUsage: { ...success.modelUsage, [model]: { ...usage, outputTokens: -1 } },
  }, model), /token usage/)
  assert.throws(() => runner.assertPublishableResponse(response, {
    ...success, modelUsage: { ...success.modelUsage, [model]: { ...usage, costUSD: Infinity } },
  }, model), /cost usage/)
  assert.throws(() => runner.assertPublishableResponse(response, {
    ...success,
    modelUsage: {
      ...success.modelUsage,
      [model]: {
        ...usage, inputTokens: 0, outputTokens: 0, thinkingTokens: 0,
        cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      },
    },
  }, model), /contains no token usage/)
  assert.throws(() => runner.assertPublishableResponse(response, {
    ...success, total_cost_usd: -1,
  }, model), /total_cost_usd/)
  assert.throws(() => runner.assertPublishableResponse(response, {
    ...success, usage: { ...success.usage, output_tokens: '2' },
  }, model), /reported usage\.output_tokens/)
  assert.doesNotThrow(() => runner.assertPublishableResponse(response, {
    ...success,
    modelUsage: {
      ...success.modelUsage,
      'claude-haiku-4-5-20251001': {
        inputTokens: 1, outputTokens: 1, costUSD: 0.01, canonicalModel: 'claude-haiku-4-5',
      },
    },
  }, model))
  assert.throws(() => runner.assertPublishableResponse(response, {
    ...success,
    modelUsage: {
      ...success.modelUsage,
      'subagent-model': { inputTokens: 1, outputTokens: 1, costUSD: 0.01, canonicalModel: null },
    },
  }, model), /canonicalModel for subagent-model/)
})

test('zero retry budget fails a usage-limited cell without canonical publication', async () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    const outFile = path.join(artifacts.cohortPaths(root, manifest.runId).results, 'sample', 'reviewer.json')
    const limited = claudeResponse({ is_error: true, api_error_status: 429, result: 'hit your usage limit' }, 1)
    const fake = fakeExecDependencies(root, [limited])
    const options = runner.parseArgs(['--run', manifest.runId, '--limit-retries', '0'], root)
    await assert.rejects(runner.execPair({
      target: manifest.targetMetadata.sample, tool: manifest.toolConfig.tools[0], outFile,
    }, {
      options, cohort: manifest, config: manifest.toolConfig, root,
    }, fake.dependencies), /usage limit reached; exhausted --limit-retries 0 after 1 attempt/)
    assert.equal(fake.state.calls, 1)
    assert.deepEqual(fake.state.sleeps, [])
    assert.equal(fs.existsSync(outFile), false)
    assert.equal(fs.existsSync(`${outFile}.lock`), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retry budget permits a bounded retry and publishes only the successful attempt', async () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    const outFile = path.join(artifacts.cohortPaths(root, manifest.runId).results, 'sample', 'reviewer.json')
    const limited = claudeResponse({ is_error: true, api_error_status: 429, result: 'usage limit reached' }, 1)
    const success = successfulClaudePayload(manifest.requestedModel)
    const fake = fakeExecDependencies(root, [limited, claudeResponse(success)])
    const options = runner.parseArgs(['--run', manifest.runId, '--limit-retries', '1'], root)
    await runner.execPair({
      target: manifest.targetMetadata.sample, tool: manifest.toolConfig.tools[0], outFile,
    }, {
      options, cohort: manifest, config: manifest.toolConfig, root,
    }, fake.dependencies)
    assert.equal(fake.state.calls, 2)
    assert.deepEqual(fake.state.sleeps, [5 * 60_000])
    const record = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    assert.equal(record.attempts, 2)
    assert.equal(record.result, success.result)
    assert.deepEqual(record.modelUsage, success.modelUsage)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('every Fable paid stage authorizes immediately and uses the authorized executable', async () => {
  const root = fixture()
  try {
    const manifest = createFableManifest(root, 'fable-paid-stages')
    const paths = artifacts.cohortPaths(root, manifest.runId)
    const outFile = path.join(paths.results, 'sample', 'reviewer.json')
    const events = []
    const authorized = '/absolute/authorized-claude'
    const decision = quota.decide([
      { label: 'Current session', percentUsed: 1, resetsAt: '2026-10-01T00:00:00.000Z' },
      { label: 'Current week (all models)', percentUsed: 2, resetsAt: '2026-10-01T00:00:00.000Z' },
      { label: 'Current week (Fable)', percentUsed: 3, resetsAt: '2026-10-01T00:00:00.000Z' },
    ])
    const metadata = { version: manifest.claudeVersion, executableSha256: 'c'.repeat(64) }
    let tick = 0
    const appendQuota = (binding, final = false) => {
      const nextCall = final ? null : (binding.stage === 'probe'
        ? 'probe'
        : `${binding.stage}:${binding.target}${binding.tool ? `/${binding.tool}` : ''}`)
      const record = quota.buildRecord({
        run: manifest.runId, final, nextCall,
        stage: final ? null : binding.stage,
        target: final ? null : binding.target,
        tool: final ? null : binding.tool,
      }, decision, metadata, new Date(`2026-09-29T14:00:0${tick++}.000Z`))
      return quota.appendAuditRecord(root, manifest.runId, record).quotaEvidence
    }
    const probePayload = successfulClaudePayload(manifest.requestedModel)
    artifacts.writeJsonExclusive(paths.probe, {
      schemaVersion: 1, ...artifacts.manifestMetadata(manifest),
      canonicalModel: manifest.requestedModel, reply: 'OK',
      reportedCostUsd: probePayload.total_cost_usd, reportedUsage: probePayload.usage,
      modelUsage: probePayload.modelUsage,
      quotaEvidence: appendQuota({ stage: 'probe', target: null, tool: null }),
      probedAt: '2026-09-29T14:00:00.000Z',
    })
    const historical = quota.buildRecord({
      run: manifest.runId, final: false, nextCall: 'review:unused/historical',
      stage: 'review', target: 'unused', tool: 'historical',
    }, decision, metadata, new Date(`2026-09-29T14:00:0${tick++}.000Z`))
    historical.thresholds = {
      'Current session': 50,
      'Current week (all models)': 90,
      'Current week (Fable)': 90,
    }
    quota.appendAuditRecord(root, manifest.runId, historical)
    const authorizePaidCall = (_root, binding) => {
      events.push(['authorize', binding.stage, binding.target, binding.tool, binding.runId, binding.claudeVersion])
      return { executable: authorized, quotaEvidence: appendQuota(binding) }
    }
    const options = runner.parseArgs([
      '--run', manifest.runId, '--concurrency', '1', '--limit-retries', '0',
    ], root)
    await runner.execPair({
      target: manifest.targetMetadata.sample, tool: manifest.toolConfig.tools[0], outFile,
    }, {
      options, cohort: manifest, config: manifest.toolConfig, root,
    }, {
      authorizePaidCall,
      checkoutPrepared: () => {
        const repo = path.join(root, 'fable-review-repo')
        fs.mkdirSync(repo, { recursive: true })
        return { repo, workspace: 'fable-review-repo', baseSha: BASE_SHA, headSha: HEAD_SHA }
      },
      claudeRun: async (_prompt, _cwd, model, _timeout, executable) => {
        events.push(['spawn', 'review', executable, model])
        return claudeResponse(successfulClaudePayload(model))
      },
      totalsForCwd: () => validTranscriptUsage(manifest.requestedModel),
    })

    assert.equal(extractor.main(['--run', manifest.runId], root, {
      authorizePaidCall,
      extractOne: (file, _cwd, executable) => {
        events.push(['spawn', 'extract', executable, extractor.EXTRACTOR_MODEL])
        return {
          ok: true,
          record: JSON.parse(fs.readFileSync(file, 'utf8')),
          findings: [{
            title: 'Claim', file: 'src/sample.js', line: 1, severity: 'medium', kind: 'bug',
            claim: 'Something is wrong.', selfRejected: false,
          }],
          modelUsage: successfulClaudePayload(extractor.EXTRACTOR_MODEL).modelUsage,
        }
      },
    }), 0)

    const judgeRepo = path.join(root, 'fable-judge-repo')
    fs.mkdirSync(judgeRepo)
    const { seal } = artifacts.readSeal(root, manifest.runId)
    const cells = seal.cells.filter((cell) => cell.target === 'sample')
    const blob = judge.loadSealedFindings(root, manifest, seal).get('sample')
    judge.judgeTarget(root, manifest, manifest.targetMetadata.sample, cells, blob,
      path.join(paths.judgement, 'sample.json'), {
      authorizePaidCall,
      checkoutPrepared: () => ({ repo: judgeRepo, workspace: 'fable-judge-repo', baseSha: BASE_SHA, headSha: HEAD_SHA }),
      spawnSync: (executable, args) => {
        events.push(['spawn', 'judge', executable, args[args.indexOf('--model') + 1]])
        const cellId = `${manifest.runId}/sample/reviewer`
        writeJson(path.join(judgeRepo, 'judgement.json'), [{
          id: 'I1', title: 'Claim', file: 'src/sample.js', line: 1, kind: 'bug', severity: 'medium',
          verdict: 'real', verdictReason: 'Code confirms claim.', introducedByPr: true,
          scope: 'in-scope', scopeReason: 'PR added it.', reportedBy: ['reviewer'],
          reportedByRuns: [cellId], reportedAs: { reviewer: 'Something is wrong.' },
          reportedAsByRun: { [cellId]: 'Something is wrong.' },
        }])
        return { status: 0, stdout: JSON.stringify(successfulClaudePayload(judge.JUDGE_MODEL)), stderr: '' }
      },
      })
    assert.equal(artifacts.ensureComplete(root, manifest.runId), null)
    appendQuota({ stage: 'review', target: 'unused', tool: 'attempt' })
    const denied = quota.buildRecord({
      run: manifest.runId, final: false, nextCall: 'judge:unused', stage: 'judge', target: 'unused', tool: null,
    }, quota.decide([
      { label: 'Current session', percentUsed: 96, resetsAt: '2026-10-01T00:00:00.000Z' },
      { label: 'Current week (all models)', percentUsed: 2, resetsAt: '2026-10-01T00:00:00.000Z' },
      { label: 'Current week (Fable)', percentUsed: 3, resetsAt: '2026-10-01T00:00:00.000Z' },
    ]), metadata, new Date('2026-09-29T14:00:08.000Z'))
    quota.appendAuditRecord(root, manifest.runId, denied)
    appendQuota({}, true)
    assert.throws(() => appendQuota({}, true), /finalized/)
    assert.throws(() => appendQuota({ stage: 'judge', target: 'later', tool: null }), /finalized/)
    const completion = artifacts.ensureComplete(root, manifest.runId)
    assert.equal(completion.complete.schemaVersion, 2)
    assert.equal(completion.complete.quota.finalLine, 8)
    assert.equal(completion.complete.quota.records, 8)
    assert.equal(completion.complete.probe.file, 'probe.json')
    const fableReport = runReport(root, '--run', manifest.runId)
    assert.equal(fableReport.status, 0, fableReport.stderr)
    assert.match(fableReport.stdout, /## Cohort accounting/)
    assert.match(fableReport.stdout, /Exact-model probe: \$0\.25/)
    assert.match(fableReport.stdout, /Extraction: 1 calls, 1 raw claims, \$0\.05/)
    assert.match(fableReport.stdout, /Judging: 1 calls, 1 merged issues \(1 real, 0 false-positive, 0 unproven\), \$0\.25/)
    assert.match(fableReport.stdout, /Final quota: current session 1%, all-model week 2%, Fable week 3%/)

    assert.deepEqual(events.map((event) => event.slice(0, 3)), [
      ['authorize', 'review', 'sample'],
      ['spawn', 'review', authorized],
      ['authorize', 'extract', 'sample'],
      ['spawn', 'extract', authorized],
      ['authorize', 'judge', 'sample'],
      ['spawn', 'judge', authorized],
    ])
    assert.deepEqual(events.filter(([kind]) => kind === 'authorize').map((event) => event.slice(1)), [
      ['review', 'sample', 'reviewer', manifest.runId, manifest.claudeVersion],
      ['extract', 'sample', 'reviewer', manifest.runId, manifest.claudeVersion],
      ['judge', 'sample', null, manifest.runId, manifest.claudeVersion],
    ])
    assert.ok(artifacts.readComplete(root, manifest.runId))
    assert.throws(() => quota.appendAuditRecord(root, manifest.runId, denied), /complete/)

    const quotaRaw = fs.readFileSync(paths.quota, 'utf8')
    fs.writeFileSync(paths.quota, quotaRaw.replace('"Current session":1', '"Current session":4'))
    assert.throws(() => artifacts.readComplete(root, manifest.runId), /quota evidence|quota ledger|quota.*hash/i)
    fs.writeFileSync(paths.quota, quotaRaw)
    const probeRaw = fs.readFileSync(paths.probe, 'utf8')
    fs.writeFileSync(paths.probe, probeRaw.replace('"reply": "OK"', '"reply": "NO"'))
    assert.throws(() => artifacts.readComplete(root, manifest.runId), /invalid Fable probe/)
    fs.writeFileSync(paths.probe, probeRaw)

    const findingFile = path.join(paths.findings, 'sample', 'reviewer.json')
    const findingRaw = fs.readFileSync(findingFile, 'utf8')
    const findingRecord = JSON.parse(findingRaw)
    findingRecord.quotaEvidence = JSON.parse(fs.readFileSync(outFile, 'utf8')).quotaEvidence
    fs.writeFileSync(findingFile, JSON.stringify(findingRecord, null, 2) + '\n')
    assert.throws(() => artifacts.readComplete(root, manifest.runId), /reuses quota evidence/)
    fs.writeFileSync(findingFile, findingRaw)
    assert.ok(artifacts.readComplete(root, manifest.runId))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('denied Fable authorization prevents the paid review spawn and publication', async () => {
  const root = fixture()
  try {
    const manifest = createFableManifest(root, 'fable-denied')
    const outFile = path.join(artifacts.cohortPaths(root, manifest.runId).results, 'sample', 'reviewer.json')
    let spawned = false
    await assert.rejects(runner.execPair({
      target: manifest.targetMetadata.sample, tool: manifest.toolConfig.tools[0], outFile,
    }, {
      options: runner.parseArgs(['--run', manifest.runId, '--concurrency', '1'], root),
      cohort: manifest, config: manifest.toolConfig, root,
    }, {
      checkoutPrepared: () => {
        const repo = path.join(root, 'denied-review-repo')
        fs.mkdirSync(repo, { recursive: true })
        return { repo, workspace: 'denied-review-repo', baseSha: BASE_SHA, headSha: HEAD_SHA }
      },
      authorizePaidCall: () => { throw new Error('quota denied') },
      claudeRun: async () => { spawned = true; return null },
    }), /quota denied/)
    assert.equal(spawned, false)
    assert.equal(fs.existsSync(outFile), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a rejected Claude response leaves the canonical result absent', async () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    const outFile = path.join(artifacts.cohortPaths(root, manifest.runId).results, 'sample', 'reviewer.json')
    const parsedFailure = { ...successfulClaudePayload(manifest.requestedModel), is_error: true }
    const fake = fakeExecDependencies(root, [claudeResponse(parsedFailure)])
    const options = runner.parseArgs(['--run', manifest.runId], root)
    await assert.rejects(runner.execPair({
      target: manifest.targetMetadata.sample, tool: manifest.toolConfig.tools[0], outFile,
    }, {
      options, cohort: manifest, config: manifest.toolConfig, root,
    }, fake.dependencies), /marked as an error/)
    assert.equal(fs.existsSync(outFile), false)
    assert.equal(fs.existsSync(`${outFile}.lock`), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('invalid transcript usage leaves the canonical result absent', async () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    const outFile = path.join(artifacts.cohortPaths(root, manifest.runId).results, 'sample', 'reviewer.json')
    const fake = fakeExecDependencies(root, [claudeResponse(successfulClaudePayload(manifest.requestedModel))])
    fake.dependencies.totalsForCwd = () => ({
      input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0,
      sessions: 0, models: {}, total: 0,
    })
    const options = runner.parseArgs(['--run', manifest.runId], root)
    await assert.rejects(runner.execPair({
      target: manifest.targetMetadata.sample, tool: manifest.toolConfig.tools[0], outFile,
    }, {
      options, cohort: manifest, config: manifest.toolConfig, root,
    }, fake.dependencies), /transcript usage total must be finite and positive/)
    assert.equal(fs.existsSync(outFile), false)
    assert.equal(fs.existsSync(`${outFile}.lock`), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runner stops dequeuing cells after the first failure', async () => {
  const root = fixture()
  try {
    const configFile = path.join(root, 'tools.json')
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    config.tools.push({ id: 'second', label: 'Second', source: 'test', prompt: '{context}' })
    writeJson(configFile, config)
    const metadata = cohortMetadata(root)
    metadata.expectedCells = ['reviewer', 'second'].map((tool) => ({
      id: `${metadata.runId}/sample/${tool}`, target: 'sample', tool,
    }))
    const manifest = artifacts.ensureManifest(root, metadata)
    const failure = { ...successfulClaudePayload(manifest.requestedModel), is_error: true }
    const fake = fakeExecDependencies(root, [claudeResponse(failure), claudeResponse(failure)])
    await assert.rejects(runner.main([
      '--run', manifest.runId, '--concurrency', '1',
    ], root, {
      ...fake.dependencies, claudeVersion: () => manifest.claudeVersion,
    }), /1 benchmark cell failed/)
    assert.equal(fake.state.calls, 1)
    const paths = artifacts.cohortPaths(root, manifest.runId)
    assert.equal(fs.existsSync(path.join(paths.results, 'sample', 'reviewer.json')), false)
    assert.equal(fs.existsSync(path.join(paths.results, 'sample', 'second.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runner refuses malformed recorded result instead of skipping it', async () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    const paths = artifacts.cohortPaths(root, manifest.runId)
    const out = path.join(paths.results, 'sample', 'reviewer.json')
    writeJson(out, { target: 'sample', tool: 'reviewer' })
    const target = manifest.targetMetadata.sample
    const tool = manifest.toolConfig.tools[0]
    const options = runner.parseArgs(['--run', manifest.runId], root)
    await assert.rejects(runner.execPair({ target, tool, outFile: out }, {
      options, cohort: manifest, config: manifest.toolConfig, root,
    }), /schemaVersion is invalid/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resume and sealing reject a semantically poisoned canonical result', async () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    const { file, record } = createResult(root, manifest)
    const poisoned = {
      ...record,
      modelUsage: {
        ...record.modelUsage,
        'subagent-model': {
          inputTokens: 1, outputTokens: 1, costUSD: 0.01, canonicalModel: null,
        },
      },
    }
    writeJson(file, poisoned)
    const pair = {
      target: manifest.targetMetadata.sample, tool: manifest.toolConfig.tools[0], outFile: file,
    }
    await assert.rejects(runner.execPair(pair, {
      options: runner.parseArgs(['--run', manifest.runId], root),
      cohort: manifest, config: manifest.toolConfig, root,
    }), /canonicalModel for subagent-model/)
    assert.throws(() => artifacts.ensureSeal(root, manifest.runId), /canonicalModel for subagent-model/)
    assert.equal(fs.existsSync(artifacts.cohortPaths(root, manifest.runId).seal), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('seal snapshots result bytes and permanently closes cohort to runner', async () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    const { file } = createResult(root, manifest)
    const sealed = artifacts.ensureSeal(root, manifest.runId, ['sample'])
    assert.equal(sealed.seal.cells.length, 1)
    assert.equal(sealed.seal.cells[0].sha256, artifacts.sha256File(file))
    assert.throws(() => artifacts.assertCohortOpen(root, manifest.runId), /sealed/)
    await assert.rejects(runner.main(['--run', manifest.runId, '--only', 'absent'], root), /sealed/)
    fs.appendFileSync(file, ' ')
    assert.throws(() => artifacts.readSeal(root, manifest.runId, ['sample']), /sealed results changed/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('seal waits for full matrix while run filters select only current invocation', () => {
  const root = fixture()
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'tools.json'), 'utf8'))
    config.tools.push({ id: 'second', label: 'Second', source: 'test', prompt: '{context}', parked: true })
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
    const options = runner.parseArgs(['--tool', 'reviewer'], root)
    const paths = artifacts.cohortPaths(root, options.runId)
    const allPairs = runner.buildPairs(root, { ...options, only: null, onlyTool: null }, paths, state, config)
    const expectedCells = runner.expectedCellsForPairs(options.runId, allPairs)
    assert.deepEqual(expectedCells.map((cell) => cell.tool), ['reviewer', 'second'])
    const fakeManifest = { expectedCells }
    assert.deepEqual(runner.pairsForManifest(root, options, paths, state, config, fakeManifest).map((pair) => pair.tool.id), ['reviewer'])
    assert.deepEqual(runner.pairsForManifest(root, { ...options, onlyTool: 'second' }, paths, state, config, fakeManifest), [])
    assert.deepEqual(runner.pairsForManifest(root, {
      ...options, onlyTool: 'second', includeParked: true,
    }, paths, state, config, fakeManifest).map((pair) => pair.tool.id), ['second'])
    const manifest = createManifest(root)
    assert.throws(() => artifacts.ensureSeal(root, manifest.runId), /results incomplete: missing/)
    assert.equal(fs.existsSync(artifacts.cohortPaths(root, manifest.runId).seal), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('failed extraction stays absent and judge refuses every incomplete sealed cohort', () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    createResult(root, manifest)
    const finding = path.join(artifacts.cohortPaths(root, manifest.runId).findings, 'sample', 'reviewer.json')
    artifacts.ensureSeal(root, manifest.runId)
    const findingLock = artifacts.acquireLocalLock(finding + '.lock')
    let extractCalls = 0
    assert.equal(extractor.main(['--run', manifest.runId], root, {
      extractOne: () => { extractCalls += 1; throw new Error('must not extract') },
    }), 0)
    assert.equal(extractCalls, 0)
    assert.equal(fs.existsSync(finding), false)
    artifacts.releaseLocalLock(findingLock)
    const failures = extractor.main(['--run', manifest.runId], root, {
      extractOne: () => ({ ok: false, error: 'synthetic parse failure' }),
    })
    assert.equal(failures, 1)
    assert.equal(fs.existsSync(finding), false)
    assert.throws(() => judge.main(['--run', manifest.runId], root), /missing successful finding/)

    const malformed = extractor.main(['--run', manifest.runId], root, {
      extractOne: (file) => ({
        ok: true, record: JSON.parse(fs.readFileSync(file, 'utf8')),
        findings: [{ title: 'Missing required schema' }], modelUsage: null,
      }),
    })
    assert.equal(malformed, 1)
    assert.equal(fs.existsSync(finding), false)

    const success = extractor.main(['--run', manifest.runId], root, {
      extractOne: (file) => ({
        ok: true,
        record: JSON.parse(fs.readFileSync(file, 'utf8')),
        findings: [{
          title: 'Claim', file: 'src/sample.js', line: 1, severity: 'medium', kind: 'bug',
          claim: 'Something is wrong.', selfRejected: false,
        }],
        modelUsage: successfulClaudePayload('claude-sonnet-5').modelUsage,
      }),
    })
    assert.equal(success, 0)
    const { seal } = artifacts.readSeal(root, manifest.runId, ['sample'])
    const loaded = judge.loadSealedFindings(root, manifest, seal)
    assert.equal(loaded.get('sample').length, 1)
    assert.equal(loaded.get('sample')[0].cellId, 'cohort-a/sample/reviewer')
    const judgementOut = path.join(artifacts.cohortPaths(root, manifest.runId).judgement, 'sample.json')
    const judgeLock = artifacts.acquireLocalLock(judgementOut + '.lock')
    let checkoutCalls = 0
    judge.main(['--run', manifest.runId], root, {
      checkoutPrepared: () => { checkoutCalls += 1; throw new Error('must not checkout') },
    })
    assert.equal(checkoutCalls, 0)
    assert.equal(fs.existsSync(judgementOut), false)
    artifacts.releaseLocalLock(judgeLock)
    const judgeRepo = path.join(root, 'fake-judge-repo')
    fs.mkdirSync(judgeRepo)
    assert.throws(() => judge.main(['--run', manifest.runId], root, {
      checkoutPrepared: () => ({ repo: judgeRepo, workspace: 'fake-judge-repo', baseSha: BASE_SHA, headSha: HEAD_SHA }),
      spawnSync: () => {
        writeJson(path.join(judgeRepo, 'judgement.json'), [{ id: 'I1' }])
        return {
          status: 0,
          stdout: JSON.stringify(successfulClaudePayload('claude-sonnet-5')),
          stderr: '',
        }
      },
    }), /issue 1\.title/)
    assert.equal(fs.existsSync(path.join(artifacts.cohortPaths(root, manifest.runId).judgement, 'sample.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('extractor stops before authorizing a later Fable cell after the first failure', () => {
  const root = fixture()
  try {
    const configFile = path.join(root, 'tools.json')
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    config.tools.push({ id: 'second', label: 'Second', source: 'test', prompt: 'Review second' })
    writeJson(configFile, config)
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
    const runId = 'fable-extract-stop'
    const manifest = artifacts.ensureManifest(root, {
      ...cohortMetadata(root, runId),
      requestedModel: 'claude-fable-5-1', modelLabel: 'Claude Fable 5.1',
      claudeVersion: '2.1.284 (Claude Code)', configSha256: artifacts.sha256File(configFile),
      targetMetadata: artifacts.snapshotTargetMetadata(state.targets), toolConfig: config,
      expectedCells: ['reviewer', 'second'].map((tool) => ({
        id: `${runId}/sample/${tool}`, target: 'sample', tool,
      })).sort((left, right) => left.id.localeCompare(right.id)),
    })
    for (const [index, tool] of ['reviewer', 'second'].entries()) {
      const response = successfulClaudePayload(manifest.requestedModel)
      const file = path.join(artifacts.cohortPaths(root, runId).results, 'sample', `${tool}.json`)
      artifacts.writeJsonExclusive(file, {
        schemaVersion: 2, ...artifacts.manifestMetadata(manifest),
        cellId: `${runId}/sample/${tool}`, target: 'sample', tool,
        label: tool, baseSha: BASE_SHA, headSha: HEAD_SHA,
        exitCode: 0, signal: null, isError: false, apiErrorStatus: null,
        result: 'Review report', reportedCostUsd: response.total_cost_usd,
        reportedUsage: response.usage, modelUsage: response.modelUsage,
        transcriptUsage: validTranscriptUsage(manifest.requestedModel),
        quotaEvidence: { file: 'quota.jsonl', line: index + 1, sha256: String(index + 1).repeat(64) },
      })
    }
    let authorizations = 0
    let calls = 0
    assert.equal(extractor.main(['--run', runId], root, {
      authorizePaidCall: () => {
        authorizations += 1
        return { executable: '/exact/claude', quotaEvidence: { file: 'quota.jsonl', line: 9, sha256: 'f'.repeat(64) } }
      },
      extractOne: () => { calls += 1; return { ok: false, error: 'first extraction failed' } },
    }), 1)
    assert.equal(authorizations, 1)
    assert.equal(calls, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('complete marker snapshots successful findings and strict judgements', () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    createResult(root, manifest)
    assert.equal(extractor.main(['--run', manifest.runId], root, {
      extractOne: (file) => ({
        ok: true,
        record: JSON.parse(fs.readFileSync(file, 'utf8')),
        findings: [{
          title: 'Claim', file: 'src/sample.js', line: 1, severity: 'medium', kind: 'bug',
          claim: 'Something is wrong.', selfRejected: false,
        }],
        modelUsage: successfulClaudePayload('claude-sonnet-5').modelUsage,
      }),
    }), 0)
    const { seal } = artifacts.readSeal(root, manifest.runId)
    const cell = seal.cells[0]
    const judgementFile = path.join(artifacts.cohortPaths(root, manifest.runId).judgement, 'sample.json')
    artifacts.writeJsonExclusive(judgementFile, {
      schemaVersion: 2,
      ...artifacts.manifestMetadata(manifest),
      target: 'sample', language: 'JS', baseSha: BASE_SHA, headSha: HEAD_SHA,
      rawFindings: 1,
      issues: [{
        id: 'I1', title: 'Claim', file: 'src/sample.js', line: 1, kind: 'bug', severity: 'medium',
        verdict: 'real', verdictReason: 'Code confirms claim.', introducedByPr: true,
        scope: 'in-scope', scopeReason: 'PR added it.', reportedBy: ['reviewer'],
        reportedByRuns: [cell.id], reportedAs: { reviewer: 'Something is wrong.' },
        reportedAsByRun: { [cell.id]: 'Something is wrong.' },
      }],
      judgeRequestedModel: 'claude-sonnet-5',
      judgeModelUsage: successfulClaudePayload('claude-sonnet-5').modelUsage,
      judgeCostUsd: 0.25,
      judgedAt: new Date().toISOString(),
    })
    const completed = artifacts.ensureComplete(root, manifest.runId)
    assert.ok(completed)
    assert.equal(completed.complete.findings.length, 1)
    assert.equal(completed.complete.judgements.length, 1)
    assert.ok(artifacts.readComplete(root, manifest.runId))
    const manifestFile = artifacts.cohortPaths(root, manifest.runId).manifest
    const manifestBytes = fs.readFileSync(manifestFile)
    fs.appendFileSync(manifestFile, ' ')
    assert.throws(() => artifacts.readComplete(root, manifest.runId), /manifest hash mismatch/)
    fs.writeFileSync(manifestFile, manifestBytes)
    const findingFile = artifacts.findingFileForCell(root, manifest.runId, cell)
    fs.appendFileSync(findingFile, ' ')
    assert.throws(() => artifacts.readComplete(root, manifest.runId), /finding hashes mismatch/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('report requires a complete hash snapshot and uses only its frozen target/tool matrix', () => {
  const root = fixture()
  try {
    writeJson(path.join(root, 'groundtruth', 'sample.json'), {
      url: 'https://upstream.invalid/pull/1', author: 'author',
      review: { inline: [{ user: 'maintainer', path: 'src/sample.js', line: 1, body: 'Frozen review comment' }], issue: [] },
    })
    const metadata = cohortMetadata(root)
    metadata.targets.unused = { baseSha: 'c'.repeat(40), headSha: 'd'.repeat(40) }
    metadata.targetMetadata.unused = {
      id: 'unused', language: 'LIVE', fork: 'private/unused', forkPr: 2,
      forkPrUrl: 'https://example.invalid/private/unused/pull/2', forkHead: 'unused',
      upstreamTitle: 'Not in expected matrix', localDiffBytes: 99, commits: 2,
    }
    metadata.groundtruth.unused = null
    const manifest = artifacts.ensureManifest(root, metadata)
    const completed = completeSampleCohort(root, manifest)
    assert.ok(completed.complete)

    const liveState = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
    liveState.targets.sample.language = 'CHANGED-LIVE-STATE'
    writeJson(path.join(root, 'state.json'), liveState)
    writeJson(path.join(root, 'tools.json'), {
      context: 'changed live context',
      tools: [{ id: 'reviewer', label: 'Changed Live Reviewer', source: 'live', prompt: 'changed' }],
    })
    writeJson(path.join(root, 'groundtruth', 'sample.json'), {
      url: 'https://changed.invalid/pull/9', author: 'changed',
      review: { inline: [{ user: 'changed', path: 'changed.js', line: 9, body: 'Changed live comment' }], issue: [] },
    })

    const report = runReport(root, '--run', manifest.runId)
    assert.equal(report.status, 0, report.stderr)
    assert.match(report.stdout, /1 review configurations, 1 real PR/)
    assert.match(report.stdout, /\| `sample` \| JS \| 42 B/)
    assert.match(report.stdout, /\| Reviewer \| 1 \|/)
    assert.match(report.stdout, /## Cohort accounting/)
    assert.match(report.stdout, /Reviews: 1 calls, 3 tokens, \$0\.25/)
    assert.match(report.stdout, /Extraction: 1 calls, 1 raw claims, \$0\.05/)
    assert.match(report.stdout, /Judging: 1 calls, 1 merged issues \(1 real, 0 false-positive, 0 unproven\), \$0\.25/)
    assert.match(report.stdout, /Total known canonical spend: \$0\.55/)
    assert.match(report.stdout, /Frozen review comment/)
    assert.doesNotMatch(report.stdout, /CHANGED-LIVE-STATE|Changed Live Reviewer|Changed live comment|changed\.invalid|unused/)

    fs.appendFileSync(path.join(artifacts.cohortPaths(root, manifest.runId).results, 'sample', 'reviewer.json'), ' ')
    const changed = runReport(root, '--run', manifest.runId)
    assert.notEqual(changed.status, 0)
    assert.match(changed.stderr, /cannot report cohort cohort-a: sealed results changed/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('report rejects a nonlegacy cohort before its seal and completion snapshot exist', () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    createResult(root, manifest)
    const report = runReport(root, '--run', manifest.runId)
    assert.notEqual(report.status, 0)
    assert.match(report.stderr, /cannot report cohort cohort-a: cohort cohort-a is not sealed/)
    assert.equal(report.stdout, '')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('salvage writes audit-only recovery outside canonical results', () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    const repo = path.join(root, 'work', 'sample', 'runs', manifest.runId, 'reviewer', 'attempt-recover', 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const configDir = path.join(root, 'claude-config')
    const transcriptDir = path.join(usage.projectsRoot(configDir), usage.slugFor(repo))
    fs.mkdirSync(transcriptDir, { recursive: true })
    const timestamp = '2026-09-28T12:00:00.000Z'
    const events = [{
      type: 'assistant', timestamp, isSidechain: false,
      message: {
        content: [{ type: 'text', text: 'Recovered review text for audit.' }],
        usage: { output_tokens: 5, cache_read_input_tokens: 0 },
      },
    }, {
      type: 'cost-state', startTime: Date.parse(timestamp), totalCostUSD: 0.25,
      modelUsage: {
        'claude-opus-5-5': {
          inputTokens: 2, outputTokens: 5, thinkingTokens: 1,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 3, costUSD: 0.25,
        },
      },
    }]
    fs.writeFileSync(path.join(transcriptDir, 'session.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n')

    const recovered = runSalvage(root, configDir, 'sample', 'reviewer', '--run', manifest.runId, '--cwd', repo)
    assert.equal(recovered.status, 0, recovered.stderr)
    assert.match(recovered.stdout, /audit candidate only; runner will rerun cell/)
    const canonical = path.join(artifacts.cohortPaths(root, manifest.runId).results, 'sample', 'reviewer.json')
    assert.equal(fs.existsSync(canonical), false)
    assert.deepEqual(artifacts.listResultCells(root, manifest), [])
    const recoveredDir = path.join(artifacts.cohortPaths(root, manifest.runId).root, 'recovered', 'sample')
    const files = fs.readdirSync(recoveredDir)
    assert.deepEqual(files, ['reviewer-20260928T120000000Z.json'])
    const candidate = JSON.parse(fs.readFileSync(path.join(recoveredDir, files[0]), 'utf8'))
    assert.equal(candidate.artifactKind, 'recovered-candidate')
    assert.equal(candidate.canonical, false)
    assert.equal(Object.hasOwn(candidate, 'exitCode'), false)
    assert.equal(candidate.result, 'Recovered review text for audit.')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('empty canonical source report extracts as valid zero findings', () => {
  const root = fixture()
  try {
    const manifest = createManifest(root)
    const { file } = createResult(root, manifest, '')
    const extracted = extractor.extractOne(file, root)
    assert.equal(extracted.ok, true)
    assert.equal(extracted.sourceReportEmpty, true)
    assert.deepEqual(extracted.findings, [])
    assert.equal(extracted.extractError, null)
    assert.equal(extractor.main(['--run', manifest.runId], root), 0)
    const finding = path.join(artifacts.cohortPaths(root, manifest.runId).findings, 'sample', 'reviewer.json')
    const record = JSON.parse(fs.readFileSync(finding, 'utf8'))
    assert.equal(record.sourceReportEmpty, true)
    assert.deepEqual(record.findings, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('legacy result, finding, and judgement bytes stay unchanged', async () => {
  const dirs = ['results', 'findings', 'judgement']
  const before = snapshot(dirs)
  await runner.main(['--run', 'legacy', '--list', '--only', 'absent'], ROOT)
  assert.deepEqual(snapshot(dirs), before)
})

test('judge normalizes display titles and preserves tool plus cohort cell attribution', () => {
  const blob = [{ tool: 'reviewer', cellId: 'cohort-a/sample/reviewer', claim: 'bad thing' }]
  const issues = judge.normalizeAttribution([{
    id: 'I1',
    title: 'A merged judgement title that is intentionally much too long for the report and dashboard display ceiling',
    reportedBy: ['reviewer'],
    reportedAs: { reviewer: 'bad thing' },
  }], blob, 'cohort-a', 'sample')
  assert.ok(issues[0].title.length <= extractor.TITLE_LIMIT)
  assert.match(issues[0].title, /…$/)
  assert.deepEqual(issues[0].reportedBy, ['reviewer'])
  assert.deepEqual(issues[0].reportedByRuns, ['cohort-a/sample/reviewer'])
  assert.deepEqual(issues[0].reportedAsByRun, { 'cohort-a/sample/reviewer': 'bad thing' })
})
