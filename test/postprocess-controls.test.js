'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const artifacts = require('../bench/lib/artifacts')
const extractor = require('../bench/extract')
const judge = require('../bench/judge')

const BENCH = path.join(__dirname, '..', 'bench')
const BASE_SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function modelUsage(model) {
  return {
    [model]: {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      thinkingTokens: 1,
      costUSD: 0.25,
      canonicalModel: model,
    },
  }
}

function claudePayload(model, result = 'done') {
  return {
    is_error: false,
    api_error_status: null,
    result,
    total_cost_usd: 0.25,
    usage: { input_tokens: 1, output_tokens: 2 },
    modelUsage: modelUsage(model),
  }
}

function fixture(targetIds = ['alpha'], report = 'Review report') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postprocess-controls-'))
  fs.copyFileSync(path.join(BENCH, 'models.json'), path.join(root, 'models.json'))
  const toolConfig = {
    context: 'Review {fork}',
    tools: [{ id: 'reviewer', label: 'Reviewer', source: 'test', prompt: '{context}' }],
  }
  const configFile = path.join(root, 'tools.json')
  writeJson(configFile, toolConfig)
  const runId = 'postprocess-controls'
  const targets = Object.fromEntries(targetIds.map((id) => [id, { baseSha: BASE_SHA, headSha: HEAD_SHA }]))
  const targetMetadata = Object.fromEntries(targetIds.map((id, index) => [id, {
    id,
    language: 'JS',
    fork: `private/${id}`,
    forkPr: index + 1,
  }]))
  const manifest = artifacts.ensureManifest(root, {
    runId,
    requestedModel: 'claude-opus-5-5',
    modelLabel: 'Claude Opus 5.5',
    claudeVersion: '9.9.9',
    configSha256: artifacts.sha256File(configFile),
    targets,
    targetMetadata,
    groundtruth: Object.fromEntries(targetIds.map((id) => [id, null])),
    expectedCells: targetIds.map((target) => ({
      id: `${runId}/${target}/reviewer`, target, tool: 'reviewer',
    })).sort((left, right) => left.id.localeCompare(right.id)),
    toolConfig,
  })
  for (const target of targetIds) {
    const out = path.join(artifacts.cohortPaths(root, runId).results, target, 'reviewer.json')
    artifacts.writeJsonExclusive(out, {
      schemaVersion: 2,
      ...artifacts.manifestMetadata(manifest),
      cellId: `${runId}/${target}/reviewer`,
      target,
      tool: 'reviewer',
      label: 'Reviewer',
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      exitCode: 0,
      signal: null,
      isError: false,
      apiErrorStatus: null,
      result: report,
      reportedCostUsd: 0.25,
      reportedUsage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: modelUsage(manifest.requestedModel),
      transcriptUsage: {
        input: 1,
        output: 2,
        thinking: 1,
        cacheRead: 0,
        cacheCreation: 0,
        costUsd: 0.25,
        sessions: 1,
        models: { [manifest.requestedModel]: 0.25 },
        total: 3,
      },
    })
  }
  return { root, manifest }
}

function timedOutResult(stdout = '') {
  const error = new Error('spawnSync claude ETIMEDOUT')
  error.code = 'ETIMEDOUT'
  return { status: null, signal: 'SIGTERM', error, stdout, stderr: '' }
}

test('post-processing parsers validate budgets and default to two-hour timeouts', () => {
  for (const parseArgs of [extractor.parseArgs, judge.parseArgs]) {
    const defaults = parseArgs([], BENCH)
    assert.equal(defaults.maxBudgetUsd, null)
    assert.equal(defaults.timeoutMs, 120 * 60_000)

    const options = parseArgs(['--max-budget-usd', '5.25', '--timeout', '2.5'], BENCH)
    assert.equal(options.maxBudgetUsd, 5.25)
    assert.equal(options.timeoutMs, 150_000)

    for (const value of ['0', '-1', 'NaN', 'Infinity', '-Infinity']) {
      assert.throws(() => parseArgs(['--max-budget-usd', value], BENCH), /positive finite number/)
      assert.throws(() => parseArgs(['--timeout', value], BENCH), /positive finite number/)
    }
    assert.throws(() => parseArgs(['--timeout', '1e308'], BENCH), /positive finite number/)
    assert.throws(() => parseArgs(['--max-budget-usd'], BENCH), /requires a value/)
    assert.throws(() => parseArgs(['--timeout'], BENCH), /requires a value/)
  }
})

test('argument helpers preserve pinned Sonnet and propagate the hard budget', () => {
  for (const args of [
    extractor.extractorArgs('report', { maxBudgetUsd: 5 }),
    judge.judgeArgs('prompt', { maxBudgetUsd: 5 }),
  ]) {
    assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5')
    assert.equal(args[args.indexOf('--max-budget-usd') + 1], '5')
  }
  assert.equal(extractor.extractorArgs('report').includes('--max-budget-usd'), false)
  assert.equal(judge.judgeArgs('prompt').includes('--max-budget-usd'), false)
})

test('empty extraction sources do not launch a paid process even with controls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-extraction-'))
  try {
    const file = path.join(root, 'result.json')
    writeJson(file, { result: '' })
    let calls = 0
    const result = extractor.extractOne(file, root, '/fake/claude', {
      spawnSync: () => { calls += 1; throw new Error('must not spawn') },
    }, { maxBudgetUsd: 5, timeoutMs: 30_000 })
    assert.equal(result.ok, true)
    assert.equal(result.sourceReportEmpty, true)
    assert.equal(calls, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('extractor forwards timeout and budget while failed calls publish no finding', () => {
  const { root, manifest } = fixture()
  try {
    let invocation
    const failures = extractor.main([
      '--run', manifest.runId, '--max-budget-usd', '5', '--timeout', '0.5',
    ], root, {
      spawnSync: (executable, args, options) => {
        invocation = { executable, args, options }
        return timedOutResult()
      },
    })
    assert.equal(failures, 1)
    assert.equal(invocation.args[invocation.args.indexOf('--max-budget-usd') + 1], '5')
    assert.equal(invocation.options.timeout, 30_000)
    assert.equal(invocation.options.killSignal, 'SIGKILL')
    const out = path.join(artifacts.cohortPaths(root, manifest.runId).findings, 'alpha', 'reviewer.json')
    assert.equal(fs.existsSync(out), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('judge forwards timeout and budget while failed calls publish no judgement', () => {
  const { root, manifest } = fixture(['alpha'], '')
  try {
    assert.equal(extractor.main(['--run', manifest.runId], root), 0)
    const { seal } = artifacts.readSeal(root, manifest.runId)
    const cells = seal.cells
    const blob = judge.loadSealedFindings(root, manifest, seal).get('alpha') || []
    const paths = artifacts.cohortPaths(root, manifest.runId)
    const out = path.join(paths.judgement, 'alpha.json')
    const repo = path.join(root, 'judge-timeout-worktree')
    fs.mkdirSync(repo)
    let invocation
    assert.throws(() => judge.judgeTarget(
      root,
      manifest,
      manifest.targetMetadata.alpha,
      cells,
      blob,
      out,
      {
        checkoutPrepared: () => ({ repo, workspace: 'judge-timeout-worktree' }),
        spawnSync: (executable, args, options) => {
          invocation = { executable, args, options }
          writeJson(path.join(repo, 'judgement.json'), [])
          return timedOutResult(JSON.stringify(claudePayload(judge.JUDGE_MODEL)))
        },
      },
      { maxBudgetUsd: 5, timeoutMs: 45_000 },
    ), /claude process failed/)
    assert.equal(invocation.args[invocation.args.indexOf('--max-budget-usd') + 1], '5')
    assert.equal(invocation.options.timeout, 45_000)
    assert.equal(invocation.options.killSignal, 'SIGKILL')
    assert.equal(fs.existsSync(out), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('judge --only validates one extracted target and leaves cohort completion pending', () => {
  const { root, manifest } = fixture(['alpha', 'beta'], '')
  try {
    assert.equal(extractor.main(['--run', manifest.runId, '--only', 'alpha'], root), 0)
    const repo = path.join(root, 'judge-alpha-worktree')
    fs.mkdirSync(repo)
    let calls = 0
    judge.main([
      '--run', manifest.runId, '--only', 'alpha', '--max-budget-usd', '5', '--timeout', '1',
    ], root, {
      checkoutPrepared: () => ({ repo, workspace: 'judge-alpha-worktree' }),
      spawnSync: (_executable, args, options) => {
        calls += 1
        assert.equal(args[args.indexOf('--max-budget-usd') + 1], '5')
        assert.equal(options.timeout, 60_000)
        writeJson(path.join(repo, 'judgement.json'), [])
        return { status: 0, signal: null, error: null, stdout: JSON.stringify(claudePayload(judge.JUDGE_MODEL)), stderr: '' }
      },
    })
    const paths = artifacts.cohortPaths(root, manifest.runId)
    assert.equal(calls, 1)
    assert.equal(fs.existsSync(path.join(paths.judgement, 'alpha.json')), true)
    assert.equal(fs.existsSync(path.join(paths.judgement, 'beta.json')), false)
    assert.equal(fs.existsSync(paths.complete), false)
    assert.throws(() => judge.main(['--run', manifest.runId], root), /missing successful finding.*beta/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
