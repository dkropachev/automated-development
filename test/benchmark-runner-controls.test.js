'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const artifacts = require('../bench/lib/artifacts')
const runner = require('../bench/run')

const BENCH_ROOT = path.join(__dirname, '..', 'bench')
const BASE_SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-runner-controls-'))
  fs.copyFileSync(path.join(BENCH_ROOT, 'models.json'), path.join(root, 'models.json'))
  const targets = Object.fromEntries(['ironweave', 'quillstone', 'tidepool'].map((id, index) => [id, {
    id,
    language: index === 1 ? 'Rust' : 'C++',
    fork: `private/${id}`,
    forkPr: index + 1,
    forkPrUrl: `https://example.invalid/private/${id}/pull/${index + 1}`,
    forkHead: 'prepared',
  }]))
  writeJson(path.join(root, 'state.json'), { targets })
  for (const id of Object.keys(targets)) writeJson(path.join(root, 'groundtruth', `${id}.json`), { target: id })
  writeJson(path.join(root, 'tools.json'), {
    context: 'Review {fork}',
    tools: [
      { id: 'ordinary', label: 'Ordinary', source: 'test', prompt: '{context}' },
      {
        id: 'review-and-fix-pr', label: 'Review and fix', source: 'test', prompt: '{context}',
        cohortOnly: true, requiresPluginDir: true, resultContract: 'review-and-fix-pr-v1',
      },
    ],
  })
  return root
}

function pluginFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-plugin-'))
  writeJson(path.join(directory, '.claude-plugin', 'plugin.json'), {
    name: 'automated-development', version: '0.5.0',
  })
  fs.mkdirSync(path.join(directory, 'skills', 'review-and-fix-pr'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'skills', 'review-and-fix-pr', 'SKILL.md'), 'review\n')
  return directory
}

function stateAndConfig(root) {
  return {
    state: JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')),
    config: JSON.parse(fs.readFileSync(path.join(root, 'tools.json'), 'utf8')),
  }
}

function pinsFor(state) {
  return Object.fromEntries(Object.keys(state.targets).map((id) => [id, {
    baseSha: BASE_SHA, headSha: HEAD_SHA,
  }]))
}

function validContract() {
  return {
    schemaVersion: 1,
    coverage: 'complete',
    verification: 'complete',
    fix: 'not-requested',
    stopTrigger: 'none',
    stopReason: 'completed',
    fixRequested: false,
    completedLenses: [...artifacts.REVIEW_AND_FIX_PR_MANDATORY_LENSES],
    skippedLenses: [],
    failedLenses: [],
    coverageGapCount: 0,
    findings: { provisional: 3, confirmed: 1, rejected: 2, unresolved: 0 },
  }
}

function validUsage(model) {
  return {
    reportedUsage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {
      [model]: {
        canonicalModel: model, inputTokens: 1, outputTokens: 1, costUSD: 0.1,
      },
    },
    transcriptUsage: {
      input: 1, output: 1, thinking: 0, cacheRead: 0, cacheCreation: 0,
      costUsd: 0.1, total: 2, sessions: 1, models: { [model]: 0.1 },
    },
  }
}

test('cohort scope controls are distinct from invocation filters and defaults keep the full matrix', () => {
  const root = fixture()
  try {
    const { state, config } = stateAndConfig(root)
    const defaults = runner.parseArgs([], root)
    const paths = artifacts.cohortPaths(root, defaults.runId)
    assert.equal(defaults.cohortTool, null)
    assert.equal(defaults.cohortTarget, null)
    assert.deepEqual(
      runner.expectedCellsForFreshCohort(root, defaults, paths, state, config)
        .map((cell) => `${cell.target}/${cell.tool}`),
      [
        'ironweave/ordinary', 'quillstone/ordinary', 'tidepool/ordinary',
      ],
    )

    const filtered = runner.parseArgs([
      '--run', 'scoped', '--cohort-tool', 'review-and-fix-pr', '--tool', 'ordinary',
    ], root)
    assert.deepEqual(
      runner.expectedCellsForFreshCohort(root, filtered, artifacts.cohortPaths(root, 'scoped'), state, config)
        .map((cell) => `${cell.target}/${cell.tool}`),
      ['ironweave/review-and-fix-pr', 'quillstone/review-and-fix-pr', 'tidepool/review-and-fix-pr'],
    )
    assert.equal(filtered.onlyTool, 'ordinary')
    assert.throws(() => runner.parseArgs(['--cohort-target', 'ironweave'], root), /requires --cohort-tool/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('repository default stays 19 cells while the opt-in skill scope contains three', () => {
  const state = JSON.parse(fs.readFileSync(path.join(BENCH_ROOT, 'state.json'), 'utf8'))
  const config = JSON.parse(fs.readFileSync(path.join(BENCH_ROOT, 'tools.json'), 'utf8'))
  const defaults = runner.parseArgs([], BENCH_ROOT)
  const defaultCells = runner.expectedCellsForFreshCohort(
    BENCH_ROOT, defaults, artifacts.cohortPaths(BENCH_ROOT, defaults.runId), state, config,
  )
  assert.equal(defaultCells.length, 19)
  assert.equal(defaultCells.some((cell) => cell.tool === 'review-and-fix-pr'), false)

  const scoped = runner.parseArgs(['--run', 'skill-only', '--cohort-tool', 'review-and-fix-pr'], BENCH_ROOT)
  const scopedCells = runner.expectedCellsForFreshCohort(
    BENCH_ROOT, scoped, artifacts.cohortPaths(BENCH_ROOT, scoped.runId), state, config,
  )
  assert.equal(scopedCells.length, 3)
  assert.deepEqual(scopedCells.map((cell) => cell.target), ['ironweave', 'quillstone', 'tidepool'])
})

test('invocation --tool alone cannot admit a cohort-only tool to the default matrix', () => {
  const root = fixture()
  try {
    const { state, config } = stateAndConfig(root)
    const options = runner.parseArgs(['--run', 'default-filter', '--tool', 'review-and-fix-pr'], root)
    assert.deepEqual(runner.expectedCellsForFreshCohort(
      root, options, artifacts.cohortPaths(root, options.runId), state, config,
    ).map((cell) => cell.tool), ['ordinary', 'ordinary', 'ordinary'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fresh list intersects immutable cohort scope with invocation filters', async () => {
  const root = fixture()
  const lines = []
  const original = console.log
  try {
    console.log = (line) => lines.push(String(line))
    await runner.main([
      '--run', 'conflicting-list', '--cohort-tool', 'review-and-fix-pr',
      '--cohort-target', 'ironweave', '--only', 'quillstone', '--list',
    ], root)
    assert.deepEqual(lines, ['0 pairs in conflicting-list'])
  } finally {
    console.log = original
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('unscoped resumes still reject additions to the live target set', async () => {
  const root = fixture()
  try {
    await runner.main(['--run', 'ordinary-full', '--only', 'absent'], root, {
      claudeVersion: () => '9.9.9',
      resolveManifestTargets: (_root, scopedState) => pinsFor(scopedState),
    })
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
    state.targets.added = {
      id: 'added', language: 'Go', fork: 'private/added', forkPr: 9,
      forkPrUrl: 'https://example.invalid/private/added/pull/9', forkHead: 'prepared',
    }
    writeJson(path.join(root, 'state.json'), state)
    await assert.rejects(runner.main(['--run', 'ordinary-full', '--only', 'absent'], root), /target set mismatch/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local-plugin cells cannot be frozen without a plugin fingerprint', () => {
  const root = fixture()
  try {
    const { state, config } = stateAndConfig(root)
    const target = state.targets.ironweave
    const toolConfig = { ...config, tools: [config.tools[1]] }
    assert.throws(() => artifacts.ensureManifest(root, {
      runId: 'missing-plugin-proof', requestedModel: 'claude-opus-5-5',
      modelLabel: 'Claude Opus 5.5', claudeVersion: '9.9.9',
      configSha256: runner.hashJson(toolConfig),
      targets: { ironweave: { baseSha: BASE_SHA, headSha: HEAD_SHA } },
      targetMetadata: artifacts.snapshotTargetMetadata({ ironweave: target }),
      groundtruth: artifacts.snapshotGroundtruth(root, ['ironweave']),
      expectedCells: [{
        id: 'missing-plugin-proof/ironweave/review-and-fix-pr',
        target: 'ironweave', tool: 'review-and-fix-pr',
      }],
      toolConfig,
      cohortScope: { tool: 'review-and-fix-pr', target: 'ironweave' },
    }), /require pluginFingerprint/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fresh scoped manifests freeze only selected targets, groundtruth, tool, and plugin fingerprint', async () => {
  const root = fixture()
  const pluginDir = pluginFixture()
  try {
    const { state } = stateAndConfig(root)
    await runner.main([
      '--run', 'scoped-three-cells', '--cohort-tool', 'review-and-fix-pr',
      '--plugin-dir', pluginDir, '--only', 'absent',
    ], root, {
      claudeVersion: () => '9.9.9',
      resolveManifestTargets: (_root, scopedState) => pinsFor(scopedState),
    })
    const manifest = artifacts.readManifest(root, 'scoped-three-cells')
    assert.deepEqual(manifest.cohortScope, { tool: 'review-and-fix-pr', target: null })
    assert.deepEqual(Object.keys(manifest.targets), Object.keys(state.targets).sort())
    assert.deepEqual(Object.keys(manifest.targetMetadata), Object.keys(state.targets).sort())
    assert.deepEqual(Object.keys(manifest.groundtruth), Object.keys(state.targets).sort())
    assert.deepEqual(manifest.toolConfig.tools.map((tool) => tool.id), ['review-and-fix-pr'])
    assert.deepEqual(manifest.expectedCells.map((cell) => cell.tool), [
      'review-and-fix-pr', 'review-and-fix-pr', 'review-and-fix-pr',
    ])
    assert.deepEqual(manifest.pluginFingerprint, runner.resolvePluginDirectory(pluginDir).fingerprint)
    assert.equal(Object.hasOwn(manifest, 'pluginName'), false)
    assert.deepEqual(Object.keys(manifest.pluginFingerprint), ['version', 'gitCommit', 'contentSha256'])

    const oneTarget = runner.parseArgs([
      '--run', 'one-target', '--cohort-tool', 'review-and-fix-pr', '--cohort-target', 'ironweave',
    ], root)
    assert.deepEqual(
      runner.expectedCellsForFreshCohort(
        root, oneTarget, artifacts.cohortPaths(root, 'one-target'), stateAndConfig(root).state,
        stateAndConfig(root).config,
      ).map((cell) => cell.target),
      ['ironweave'],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('resume rejects supplied cohort scope and plugin fingerprint mismatches', async () => {
  const root = fixture()
  const pluginDir = pluginFixture()
  try {
    await runner.main([
      '--run', 'immutable-scope', '--cohort-tool', 'review-and-fix-pr',
      '--plugin-dir', pluginDir, '--only', 'absent',
    ], root, {
      claudeVersion: () => '9.9.9',
      resolveManifestTargets: (_root, scopedState) => pinsFor(scopedState),
    })
    assert.throws(() => runner.selectCohort(root, runner.parseArgs([
      '--run', 'immutable-scope', '--cohort-tool', 'ordinary', '--plugin-dir', pluginDir,
    ], root)), /scope mismatch/)
    assert.throws(() => runner.selectCohort(root, runner.parseArgs([
      '--run', 'immutable-scope', '--cohort-tool', 'review-and-fix-pr',
      '--cohort-target', 'ironweave', '--plugin-dir', pluginDir,
    ], root)), /scope mismatch/)
    assert.throws(() => runner.selectCohort(root, runner.parseArgs([
      '--run', 'immutable-scope',
    ], root)), /requires --plugin-dir/)

    fs.appendFileSync(path.join(pluginDir, 'skills', 'review-and-fix-pr', 'SKILL.md'), 'changed\n')
    assert.throws(() => runner.selectCohort(root, runner.parseArgs([
      '--run', 'immutable-scope', '--plugin-dir', pluginDir,
    ], root)), /plugin fingerprint mismatch/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('plugin fingerprint is deterministic and ignores benchmark artifacts and dependency trees', () => {
  const pluginDir = pluginFixture()
  try {
    const plugin = runner.resolvePluginDirectory(pluginDir)
    const before = plugin.fingerprint
    const launchOptions = { pluginDir, pluginName: plugin.name, pluginFingerprint: before }
    assert.doesNotThrow(() => runner.assertPluginDirectoryCurrent(launchOptions))
    writeJson(path.join(pluginDir, 'bench', 'runs', 'discarded', 'result.json'), { changing: true })
    fs.mkdirSync(path.join(pluginDir, 'node_modules', 'discarded'), { recursive: true })
    fs.writeFileSync(path.join(pluginDir, 'node_modules', 'discarded', 'index.js'), 'changing\n')
    assert.deepEqual(runner.resolvePluginDirectory(pluginDir).fingerprint, before)
    assert.doesNotThrow(() => runner.assertPluginDirectoryCurrent(launchOptions))
    fs.appendFileSync(path.join(pluginDir, 'skills', 'review-and-fix-pr', 'SKILL.md'), 'relevant\n')
    assert.notEqual(runner.resolvePluginDirectory(pluginDir).fingerprint.contentSha256, before.contentSha256)
    assert.throws(() => runner.assertPluginDirectoryCurrent(launchOptions), /changed after it was fingerprinted/)
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('plugin mutation during Claude execution prevents canonical result admission', async () => {
  const root = fixture()
  const pluginDir = pluginFixture()
  try {
    const { state, config } = stateAndConfig(root)
    const target = state.targets.ironweave
    const toolConfig = { ...config, tools: [config.tools[1]] }
    const runId = 'mid-run-plugin-mutation'
    const options = runner.parseArgs(['--run', runId, '--plugin-dir', pluginDir], root)
    const manifest = artifacts.ensureManifest(root, {
      runId,
      requestedModel: options.model,
      modelLabel: 'Claude Opus 5.5',
      claudeVersion: '9.9.9',
      configSha256: runner.hashJson(toolConfig),
      targets: { ironweave: { baseSha: BASE_SHA, headSha: HEAD_SHA } },
      targetMetadata: artifacts.snapshotTargetMetadata({ ironweave: target }),
      groundtruth: artifacts.snapshotGroundtruth(root, ['ironweave']),
      expectedCells: [{
        id: `${runId}/ironweave/review-and-fix-pr`,
        target: 'ironweave', tool: 'review-and-fix-pr',
      }],
      toolConfig,
      cohortScope: { tool: 'review-and-fix-pr', target: 'ironweave' },
      pluginFingerprint: options.pluginFingerprint,
    })
    const outFile = path.join(
      artifacts.cohortPaths(root, runId).results, 'ironweave', 'review-and-fix-pr.json',
    )
    const checkout = path.join(root, 'checkout')
    fs.mkdirSync(checkout)
    let calls = 0
    await assert.rejects(runner.execPair({ target, tool: toolConfig.tools[0], outFile }, {
      options, cohort: manifest, config: toolConfig, root, claudeExecutable: '/exact/claude',
    }, {
      checkoutPrepared: () => ({
        repo: checkout, workspace: 'checkout', baseSha: BASE_SHA, headSha: HEAD_SHA,
      }),
      discoverPluginIsolationSettings: () => ({ enabledPlugins: {} }),
      claudeRun: async () => {
        calls += 1
        fs.appendFileSync(path.join(pluginDir, 'skills', 'review-and-fix-pr', 'SKILL.md'), 'mutated\n')
        return { code: 0, signal: null, out: '{}', err: '', wallMs: 1 }
      },
      totalsForCwd: () => { throw new Error('mutated plugin response reached admission') },
    }), /changed after it was fingerprinted/)
    assert.equal(calls, 1)
    assert.equal(fs.existsSync(outFile), false)
    assert.equal(fs.existsSync(`${outFile}.lock`), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('Claude review argv carries an exact hard budget and isolated local plugin configuration', () => {
  assert.equal(runner.claudeEnvironment({ KEEP: 'yes', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '600000' })
    .CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0')
  assert.equal(runner.claudeEnvironment({ KEEP: 'yes' }).KEEP, 'yes')
  const pluginIsolationSettings = runner.parseInstalledPluginSettings(JSON.stringify([
    {
      id: 'automated-development@second-marketplace',
      enabled: false,
      projectEnabled: true,
    },
    {
      id: 'unrelated-plugin@second-marketplace',
      enabled: true,
      projectEnabled: false,
    },
    {
      id: 'automated-development@automated-development',
      enabled: true,
      projectEnabled: false,
    },
  ]), 'automated-development')
  assert.deepEqual(pluginIsolationSettings, {
    enabledPlugins: {
      'automated-development@automated-development': false,
      'automated-development@second-marketplace': false,
    },
  })
  assert.deepEqual(runner.claudeArgs('review', 'claude-opus-5-5', {
    maxBudgetUsd: 20,
    pluginDir: '/safe/plugin',
    pluginName: 'automated-development',
    pluginIsolationSettings,
  }), [
    '-p', 'review',
    '--output-format', 'json',
    '--model', 'claude-opus-5-5',
    '--effort', 'medium',
    '--permission-mode', 'bypassPermissions',
    '--max-budget-usd', '20',
    '--settings', '{"enabledPlugins":{"automated-development@automated-development":false,"automated-development@second-marketplace":false}}',
    '--plugin-dir', '/safe/plugin',
    '--disallowedTools', 'WebSearch', 'WebFetch',
  ])
  const root = fixture()
  try {
    assert.equal(runner.parseArgs(['--max-budget-usd', '50'], root).maxBudgetUsd, 50)
    for (const bad of ['0', '-1', 'Infinity', 'NaN']) {
      assert.throws(() => runner.parseArgs(['--max-budget-usd', bad], root), /finite positive/)
    }
    assert.throws(() => runner.parseArgs(['--timeout', '1e308'], root), /positive finite/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local plugin discovery and launch fail closed on malformed or unknown state', () => {
  for (const [output, message] of [
    ['not json', /invalid JSON/],
    ['{}', /did not return an array/],
    ['[null]', /entry 0 is malformed/],
    [JSON.stringify([{ id: 'missing-marketplace', enabled: true, projectEnabled: false }]), /invalid id/],
    [JSON.stringify([{
      id: 'automated-development@marketplace', enabled: 'unknown', projectEnabled: false,
    }]), /unknown enabled state/],
    [JSON.stringify([{
      id: 'automated-development@marketplace', enabled: true,
    }]), /unknown enabled state/],
  ]) {
    assert.throws(() => runner.parseInstalledPluginSettings(output, 'automated-development'), message)
  }

  assert.throws(() => runner.claudeArgs('review', 'claude-opus-5-5', {
    pluginDir: '/safe/plugin', pluginName: 'automated-development',
  }), /requires verified plugin isolation settings/)

  const invocations = []
  assert.deepEqual(runner.discoverPluginIsolationSettings(
    '/exact/claude', 'automated-development', '/target/repo', {
      env: { PATH: '/test/bin' },
      pluginListSpawnSync: (executable, args, options) => {
        invocations.push({ executable, args, options })
        return { status: 0, stdout: '[]', stderr: '' }
      },
    },
  ), { enabledPlugins: {} })
  assert.deepEqual(invocations.map((call) => call.executable), ['/exact/claude', '/exact/claude'])
  assert.deepEqual(invocations.map((call) => call.args), [
    ['plugin', 'list', '--json'],
    ['--settings', '{"enabledPlugins":{}}', 'plugin', 'list', '--json'],
  ])
  assert.equal(invocations[0].options.cwd, '/target/repo')
  assert.deepEqual(invocations[0].options.env, { PATH: '/test/bin' })

  assert.throws(() => runner.discoverPluginIsolationSettings(
    '/exact/claude', 'automated-development', '/target/repo', {
      pluginListSpawnSync: () => ({ status: 2, stdout: '', stderr: 'cannot inspect plugins' }),
    },
  ), /plugin discovery exited 2: cannot inspect plugins/)

  let calls = 0
  assert.throws(() => runner.discoverPluginIsolationSettings(
    '/exact/claude', 'automated-development', '/target/repo', {
      pluginListSpawnSync: () => {
        calls += 1
        return {
          status: 0,
          stdout: JSON.stringify([{
            id: 'automated-development@marketplace', enabled: true, projectEnabled: false,
          }]),
          stderr: '',
        }
      },
    },
  ), /ignored local plugin isolation settings/)
  assert.equal(calls, 2)

  calls = 0
  assert.throws(() => runner.discoverPluginIsolationSettings(
    '/exact/claude', 'automated-development', '/target/repo', {
      pluginListSpawnSync: () => ({
        status: 0,
        stdout: JSON.stringify(calls++ === 0 ? [{
          id: 'automated-development@marketplace', enabled: true, projectEnabled: false,
        }] : []),
        stderr: '',
      }),
    },
  ), /inventory changed during isolation verification/)
})

test('review-and-fix-pr structured contract gates admission and is revalidated on read', () => {
  const root = fixture()
  const pluginDir = pluginFixture()
  try {
    const { state, config } = stateAndConfig(root)
    const targetId = 'ironweave'
    const runId = 'contract-cohort'
    const pluginFingerprint = runner.resolvePluginDirectory(pluginDir).fingerprint
    const manifest = artifacts.ensureManifest(root, {
      runId,
      requestedModel: 'claude-opus-5-5',
      modelLabel: 'Claude Opus 5.5',
      claudeVersion: '9.9.9',
      configSha256: runner.hashJson({ ...config, tools: [config.tools[1]] }),
      targets: { [targetId]: { baseSha: BASE_SHA, headSha: HEAD_SHA } },
      targetMetadata: artifacts.snapshotTargetMetadata({ [targetId]: state.targets[targetId] }),
      groundtruth: artifacts.snapshotGroundtruth(root, [targetId]),
      expectedCells: [{ id: `${runId}/${targetId}/review-and-fix-pr`, target: targetId, tool: 'review-and-fix-pr' }],
      toolConfig: { ...config, tools: [config.tools[1]] },
      cohortScope: { tool: 'review-and-fix-pr', target: targetId },
      pluginFingerprint,
    })
    const contract = validContract()
    const result = `Review report\n\nREVIEW_AND_FIX_PR_RESULT_JSON=${JSON.stringify(contract)}`
    const usage = validUsage(manifest.requestedModel)
    const record = {
      schemaVersion: 2,
      ...artifacts.manifestMetadata(manifest),
      cellId: `${runId}/${targetId}/review-and-fix-pr`,
      target: targetId,
      tool: 'review-and-fix-pr',
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      exitCode: 0,
      signal: null,
      isError: false,
      apiErrorStatus: null,
      result,
      resultContract: artifacts.parseReviewAndFixPrResultContract(result),
      reportedCostUsd: 0.1,
      ...usage,
    }
    const file = path.join(artifacts.cohortPaths(root, runId).results, targetId, 'review-and-fix-pr.json')
    artifacts.writeJsonExclusive(file, record)
    assert.doesNotThrow(() => artifacts.assertRecordMetadata(
      JSON.parse(JSON.stringify(record)), manifest, 'round-tripped plugin record',
    ))
    assert.deepEqual(artifacts.readResultRecord(file, manifest, targetId, 'review-and-fix-pr').resultContract, contract)

    const incomplete = { ...contract, coverage: 'partial-stop' }
    assert.throws(() => artifacts.parseReviewAndFixPrResultContract(
      `Report\nREVIEW_AND_FIX_PR_RESULT_JSON=${JSON.stringify(incomplete)}`,
    ), /coverage must be "complete"/)
    assert.throws(() => artifacts.parseReviewAndFixPrResultContract(
      `${result}\nREVIEW_AND_FIX_PR_RESULT_JSON=${JSON.stringify(contract)}`,
    ), /exactly one/)

    const poisoned = { ...record, resultContract: { ...contract, stopTrigger: 'tokens' } }
    fs.writeFileSync(file, JSON.stringify(poisoned, null, 2) + '\n')
    assert.throws(() => artifacts.readResultRecord(file, manifest, targetId, 'review-and-fix-pr'), /does not match report marker/)
    assert.throws(() => artifacts.ensureSeal(root, runId), /does not match report marker/)
    assert.equal(fs.existsSync(artifacts.cohortPaths(root, runId).seal), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(pluginDir, { recursive: true, force: true })
  }
})
