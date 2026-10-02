'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const pilot = require('../bench/pilot')

const FINGERPRINT = Object.freeze({
  version: '0.5.0',
  gitCommit: 'a'.repeat(40),
  contentSha256: 'b'.repeat(64),
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-budget-'))
  const cwd = path.join(root, 'target')
  const pluginDir = path.join(root, 'plugin')
  const promptFile = path.join(root, 'prompt.txt')
  fs.mkdirSync(cwd)
  fs.mkdirSync(pluginDir)
  fs.writeFileSync(promptFile, 'Run the audit-only pilot.\n')
  const argv = [
    '--id', 'opus-pilot',
    '--cwd', cwd,
    '--plugin-dir', pluginDir,
    '--prompt-file', promptFile,
    '--model', 'claude-opus-5-5',
    '--effort', 'medium',
    '--timeout', '30',
    '--budget-usd', '20',
  ]
  return { root, cwd, pluginDir, promptFile, argv }
}

function resolvedPlugin(directory) {
  return { directory, fingerprint: FINGERPRINT }
}

function resolvedTarget() {
  return { headSha: 'c'.repeat(40), treeSha: 'd'.repeat(40), baseSha: 'e'.repeat(40) }
}

function readLedger(root) {
  return JSON.parse(fs.readFileSync(pilot.pilotPaths(root, 'opus-pilot').ledger, 'utf8'))
}

test('pilot passes the full first ceiling, then only the cumulative remainder', () => {
  const fx = fixture()
  const calls = []
  let attempt = 0
  try {
    const dependencies = {
      resolvePluginDirectory: resolvedPlugin,
      resolveTargetIdentity: resolvedTarget,
      spawnSync: (executable, args, options) => {
        attempt += 1
        calls.push({ executable, args, options })
        return {
          status: 0,
          signal: null,
          error: null,
          stdout: JSON.stringify({ total_cost_usd: attempt === 1 ? 4 : 2 }),
          stderr: `attempt ${attempt} stderr`,
        }
      },
      // The charged amount is the larger valid source: transcript 5 beats reported 4 on attempt
      // one, while reported 2 beats transcript 1 on attempt two.
      totalsForCwd: (_cwd, options) => {
        assert.equal(typeof options.since, 'number')
        return { costUsd: attempt === 1 ? 5 : 1, sessions: 1, total: attempt * 100 }
      },
      log: () => {},
    }
    assert.equal(pilot.main(fx.argv, fx.root, dependencies), 0)
    const secondCwd = path.join(fx.root, 'target-second-checkout')
    const secondPrompt = path.join(fx.root, 'prompt-copy.txt')
    fs.mkdirSync(secondCwd)
    fs.copyFileSync(fx.promptFile, secondPrompt)
    const secondArgv = [...fx.argv]
    secondArgv[secondArgv.indexOf('--cwd') + 1] = secondCwd
    secondArgv[secondArgv.indexOf('--prompt-file') + 1] = secondPrompt
    assert.equal(pilot.main(secondArgv, fx.root, dependencies), 0)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].args[calls[0].args.indexOf('--max-budget-usd') + 1], '20')
    assert.equal(calls[1].args[calls[1].args.indexOf('--max-budget-usd') + 1], '15')
    assert.equal(calls[0].options.cwd, fx.cwd)
    assert.equal(calls[1].options.cwd, secondCwd)
    assert.equal(calls[0].options.timeout, 30 * 60_000)
    assert.equal(calls[0].options.killSignal, 'SIGKILL')
    assert.equal(calls[0].options.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0')
    assert.equal(calls[0].args[calls[0].args.indexOf('--settings') + 1],
      '{"enabledPlugins":{"automated-development@automated-development":false}}')
    assert.equal(calls[0].args[calls[0].args.indexOf('--plugin-dir') + 1], fx.pluginDir)

    const ledger = readLedger(fx.root)
    assert.equal(ledger.budgetUsd, 20)
    assert.deepEqual(ledger.events.map((event) => event.type), [
      'reserved', 'settled', 'reserved', 'settled',
    ])
    assert.deepEqual(ledger.events.filter((event) => event.type === 'settled').map((event) => event.chargedUsd), [5, 2])
    assert.equal(pilot.ledgerState(ledger, 'opus-pilot').remainingNanos, pilot.usdNanos(13))
    assert.equal(fs.readFileSync(path.join(fx.root, 'work', 'pilots', 'opus-pilot', 'attempts', '0002', 'stderr.txt'), 'utf8'),
      'attempt 2 stderr')
    assert.match(fs.readFileSync(path.join(fx.root, 'work', 'pilots', 'opus-pilot', 'attempts', '0001', 'response.txt'), 'utf8'),
      /"total_cost_usd":4/)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('pilot rejects a spent budget before launching another Claude process', () => {
  const fx = fixture()
  let calls = 0
  try {
    const dependencies = {
      resolvePluginDirectory: resolvedPlugin,
      resolveTargetIdentity: resolvedTarget,
      spawnSync: () => {
        calls += 1
        return { status: 0, signal: null, stdout: '{"total_cost_usd":20}', stderr: '' }
      },
      totalsForCwd: () => ({ costUsd: 19, sessions: 1 }),
      log: () => {},
    }
    assert.equal(pilot.main(fx.argv, fx.root, dependencies), 0)
    assert.throws(() => pilot.main(fx.argv, fx.root, dependencies), /no unreserved budget remaining/)
    assert.equal(calls, 1)
    assert.equal(fs.existsSync(pilot.pilotPaths(fx.root, 'opus-pilot').lock), false)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('an unknowable cost exhausts the reservation and returns failure', () => {
  const fx = fixture()
  let calls = 0
  try {
    const dependencies = {
      resolvePluginDirectory: resolvedPlugin,
      resolveTargetIdentity: resolvedTarget,
      spawnSync: () => {
        calls += 1
        return { status: 0, signal: null, stdout: '{"result":"no cost"}', stderr: '' }
      },
      totalsForCwd: () => ({ costUsd: 0, sessions: 0, total: 0 }),
      log: () => {},
    }
    assert.equal(pilot.main(fx.argv, fx.root, dependencies), 1)
    const settlement = readLedger(fx.root).events.at(-1)
    assert.equal(settlement.costKnown, false)
    assert.equal(settlement.chargedUsd, 20)
    assert.equal(settlement.budgetRemainingUsd, 0)
    assert.throws(() => pilot.main(fx.argv, fx.root, dependencies), /no unreserved budget remaining/)
    assert.equal(calls, 1)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('exclusive pilot lock blocks concurrent and crashed attempts without stale recovery', () => {
  const fx = fixture()
  const paths = pilot.pilotPaths(fx.root, 'opus-pilot')
  fs.mkdirSync(paths.directory, { recursive: true })
  const held = pilot.acquirePilotLock(paths.lock, { randomUUID: () => 'held', nowMs: () => 0 })
  let calls = 0
  try {
    assert.throws(() => pilot.main(fx.argv, fx.root, {
      resolvePluginDirectory: resolvedPlugin,
      resolveTargetIdentity: resolvedTarget,
      spawnSync: () => { calls += 1 },
    }), /concurrent or crashed attempt fails closed/)
    assert.equal(calls, 0)
    assert.equal(fs.existsSync(paths.lock), true)
  } finally {
    pilot.releasePilotLock(held)
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('an open write-ahead reservation remains exhausted even if its crash lock is removed', () => {
  const fx = fixture()
  let calls = 0
  try {
    const dependencies = {
      resolvePluginDirectory: resolvedPlugin,
      resolveTargetIdentity: resolvedTarget,
      spawnSync: () => {
        calls += 1
        return { status: 0, signal: null, stdout: '{"total_cost_usd":1}', stderr: '' }
      },
      totalsForCwd: () => ({ costUsd: 1, sessions: 1 }),
      log: () => {},
    }
    assert.equal(pilot.main(fx.argv, fx.root, dependencies), 0)
    const paths = pilot.pilotPaths(fx.root, 'opus-pilot')
    const ledger = readLedger(fx.root)
    ledger.events = [ledger.events[0]]
    fs.writeFileSync(paths.ledger, JSON.stringify(ledger, null, 2) + '\n')
    assert.equal(pilot.ledgerState(ledger, 'opus-pilot').remainingNanos, 0)
    assert.throws(() => pilot.main(fx.argv, fx.root, dependencies), /no unreserved budget remaining/)
    assert.equal(calls, 1)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('nonzero and timed-out processes are costed and keep their raw output', () => {
  const fx = fixture()
  const timeout = new Error('spawnSync claude ETIMEDOUT')
  timeout.code = 'ETIMEDOUT'
  try {
    const exit = pilot.main(fx.argv, fx.root, {
      resolvePluginDirectory: resolvedPlugin,
      resolveTargetIdentity: resolvedTarget,
      spawnSync: (_executable, _args, options) => {
        assert.equal(options.timeout, 1_800_000)
        return {
          status: null,
          signal: 'SIGKILL',
          error: timeout,
          stdout: '{"total_cost_usd":3.25}',
          stderr: 'killed at hard timeout',
        }
      },
      totalsForCwd: () => ({ costUsd: 3, sessions: 1 }),
      log: () => {},
    })
    assert.equal(exit, 1)
    const settlement = readLedger(fx.root).events.at(-1)
    assert.equal(settlement.timedOut, true)
    assert.equal(settlement.exitCode, null)
    assert.equal(settlement.signal, 'SIGKILL')
    assert.equal(settlement.chargedUsd, 3.25)
    assert.equal(settlement.budgetRemainingUsd, 16.75)
    assert.equal(fs.readFileSync(path.join(fx.root, 'work', 'pilots', 'opus-pilot', 'attempts', '0001', 'stderr.txt'), 'utf8'),
      'killed at hard timeout')
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('pilot options require an explicit total budget and reject unsafe paths and timeouts', () => {
  const fx = fixture()
  try {
    assert.throws(() => pilot.parseArgs(fx.argv.slice(0, -2)), /--budget-usd is required/)
    for (const value of ['0', '-1', 'Infinity', 'NaN']) {
      const argv = [...fx.argv]
      argv[argv.indexOf('--budget-usd') + 1] = value
      assert.throws(() => pilot.parseArgs(argv), /positive finite amount/)
    }
    assert.throws(() => pilot.usdNanos('0.0000000009'), /positive finite amount/)
    for (const value of ['0', '-1', 'Infinity', '1e308']) {
      const argv = [...fx.argv]
      argv[argv.indexOf('--timeout') + 1] = value
      assert.throws(() => pilot.parseArgs(argv), /positive finite number/)
    }
    const link = path.join(fx.root, 'target-link')
    fs.symlinkSync(fx.cwd, link)
    const argv = [...fx.argv]
    argv[argv.indexOf('--cwd') + 1] = link
    assert.throws(() => pilot.parseArgs(argv), /refusing symlink pilot cwd path/)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('pilot identity freezes its total budget and invocation inputs', () => {
  const fx = fixture()
  try {
    const dependencies = {
      resolvePluginDirectory: resolvedPlugin,
      resolveTargetIdentity: resolvedTarget,
      spawnSync: () => ({ status: 7, signal: null, stdout: '{"total_cost_usd":1}', stderr: 'failed' }),
      totalsForCwd: () => ({ costUsd: 1, sessions: 1 }),
      log: () => {},
    }
    assert.equal(pilot.main(fx.argv, fx.root, dependencies), 7)
    const changedBudget = [...fx.argv]
    changedBudget[changedBudget.indexOf('--budget-usd') + 1] = '25'
    assert.throws(() => pilot.main(changedBudget, fx.root, dependencies), /budget is immutable/)
    fs.writeFileSync(fx.promptFile, 'Changed prompt.\n')
    assert.throws(() => pilot.main(fx.argv, fx.root, dependencies), /invocation inputs changed/)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('pilot ledger fails closed when its atomic newline framing is lost', () => {
  const fx = fixture()
  try {
    const dependencies = {
      resolvePluginDirectory: resolvedPlugin,
      resolveTargetIdentity: resolvedTarget,
      spawnSync: () => ({ status: 0, signal: null, stdout: '{"total_cost_usd":1}', stderr: '' }),
      totalsForCwd: () => ({ costUsd: 1, sessions: 1 }),
      log: () => {},
    }
    assert.equal(pilot.main(fx.argv, fx.root, dependencies), 0)
    const ledger = pilot.pilotPaths(fx.root, 'opus-pilot').ledger
    fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').trimEnd())
    assert.throws(() => pilot.main(fx.argv, fx.root, dependencies), /durable newline terminator/)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('target identity accepts identical fresh checkouts and rejects dirty content', () => {
  const head = '1'.repeat(40)
  const tree = '2'.repeat(40)
  const base = '3'.repeat(40)
  const gitSpawnSync = (_git, args) => {
    const command = args.slice(2).join(' ')
    if (command === 'rev-parse --verify HEAD^{commit}') return { status: 0, stdout: `${head}\n`, stderr: '' }
    if (command === 'rev-parse --verify HEAD^{tree}') return { status: 0, stdout: `${tree}\n`, stderr: '' }
    if (command === 'rev-parse --verify --quiet refs/remotes/origin/main^{commit}') {
      return { status: 0, stdout: `${base}\n`, stderr: '' }
    }
    if (command === `merge-base ${head} ${base}`) return { status: 0, stdout: `${base}\n`, stderr: '' }
    if (command === 'status --porcelain=v1 --untracked-files=all') return { status: 0, stdout: '', stderr: '' }
    throw new Error(`unexpected git command: ${command}`)
  }
  assert.deepEqual(pilot.resolveTargetIdentity('/fresh/one', { gitSpawnSync }), {
    headSha: head, treeSha: tree, baseSha: base,
  })
  assert.deepEqual(pilot.resolveTargetIdentity('/fresh/two', { gitSpawnSync }), {
    headSha: head, treeSha: tree, baseSha: base,
  })

  const dirtyGit = (executable, args, options) => {
    if (args.slice(2).join(' ') === 'status --porcelain=v1 --untracked-files=all') {
      return { status: 0, stdout: ' M src/changed.js\n?? scratch.txt\n', stderr: '' }
    }
    return gitSpawnSync(executable, args, options)
  }
  assert.throws(() => pilot.resolveTargetIdentity('/dirty', { gitSpawnSync: dirtyGit }), /pilot cwd must be clean/)

  const noBaseGit = (_git, args) => {
    const command = args.slice(2).join(' ')
    if (command === 'rev-parse --verify HEAD^{commit}') return { status: 0, stdout: `${head}\n`, stderr: '' }
    if (command === 'rev-parse --verify HEAD^{tree}') return { status: 0, stdout: `${tree}\n`, stderr: '' }
    if (command.startsWith('rev-parse --verify --quiet ')) return { status: 1, stdout: '', stderr: '' }
    throw new Error(`unexpected git command: ${command}`)
  }
  assert.throws(() => pilot.resolveTargetIdentity('/no-base', { gitSpawnSync: noBaseGit }), /no pinned main\/master merge-base/)
})
