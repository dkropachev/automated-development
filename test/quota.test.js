'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const quota = require('../bench/quota')
const RESET = '1970-01-01T00:00:00.000Z'

function payload(session = 12, week = 34, fable = 56) {
  return {
    session: {
      total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 12,
      total_lines_added: 0, total_lines_removed: 0, model_usage: {},
    },
    rate_limits_available: true,
    rate_limits: {
      limits: [
        { kind: 'session', scope: null, percent: session, resets_at: RESET },
        { kind: 'weekly_all', scope: null, percent: week, resets_at: RESET },
        { kind: 'weekly_scoped', scope: { surface: null, model: { display_name: 'Opus' } }, percent: 99, resets_at: RESET },
        { kind: 'weekly_scoped', scope: { surface: null, model: { display_name: 'Fable' } }, percent: fable, resets_at: RESET },
      ],
    },
  }
}

function controlOutput(usagePayload = payload()) {
  return [
    {
      type: 'control_response',
      response: { subtype: 'success', request_id: quota.INITIALIZE_REQUEST_ID, response: { account: 'must-not-be-audited' } },
    },
    {
      type: 'control_response',
      response: { subtype: 'success', request_id: quota.USAGE_REQUEST_ID, response: usagePayload },
    },
  ].map(JSON.stringify).join('\n') + '\n'
}

function labeled(session = 12, week = 34, fable = 56) {
  return [
    'Unrelated summary',
    '99% used',
    'Current session',
    `${session}% used`,
    'Resets later',
    'Current week (all models)',
    `${week}% used`,
    'Current week (Fable)',
    `${fable}% used`,
    "What's contributing",
    '87% used',
  ].join('\n')
}

test('structured parser maps semantic quota fields and the unique Fable display name', () => {
  assert.deepEqual(quota.parseStructuredUsage(payload()), [
    { label: 'Current session', percentUsed: 12, resetsAt: RESET },
    { label: 'Current week (all models)', percentUsed: 34, resetsAt: RESET },
    { label: 'Current week (Fable)', percentUsed: 56, resetsAt: RESET },
  ])
  assert.deepEqual(quota.parseControlOutput(controlOutput()), quota.parseStructuredUsage(payload()))
})

test('structured parser fails closed on unavailable, missing, duplicate, or non-finite values', () => {
  const unavailable = payload()
  unavailable.rate_limits_available = false
  assert.throws(() => quota.parseStructuredUsage(unavailable), /no available rate limits/)

  const missing = payload()
  missing.rate_limits.limits = missing.rate_limits.limits.filter((entry) => entry.kind !== 'weekly_scoped')
  assert.throws(() => quota.parseStructuredUsage(missing), /exactly one Fable weekly_scoped/)

  const duplicate = payload()
  duplicate.rate_limits.limits.push({
    kind: 'weekly_scoped', scope: { surface: null, model: { display_name: 'Fable' } }, percent: 1, resets_at: RESET,
  })
  assert.throws(() => quota.parseStructuredUsage(duplicate), /found 2/)

  assert.throws(() => quota.parseStructuredUsage(payload(Infinity)), /finite percent/)
  assert.throws(() => quota.parseStructuredUsage(payload(1, 2, null)), /finite percent/)
  assert.throws(() => quota.parseStructuredUsage(payload(101)), /finite percent/)

  const surfaceOnly = payload()
  const scoped = surfaceOnly.rate_limits.limits.find((entry) => entry.scope && entry.scope.model.display_name === 'Fable')
  scoped.scope.surface = 'api'
  assert.throws(() => quota.parseStructuredUsage(surfaceOnly), /exactly one Fable weekly_scoped.*found 0/)
})

test('control parser requires one successful response per request and rejects model turns', () => {
  const duplicate = controlOutput() + controlOutput()
  assert.throws(() => quota.parseControlOutput(duplicate), /exactly one quota-initialize/)
  assert.throws(() => quota.parseControlOutput('{not json}\n'), /invalid JSON/)
  assert.throws(() => quota.parseControlOutput(controlOutput() + '{"type":"assistant"}\n'), /model turn/)
  assert.doesNotThrow(() => quota.parseControlOutput(controlOutput() + '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"duration_api_ms":0,"usage":{},"modelUsage":{}}\n'))
  assert.throws(() => quota.parseControlOutput(controlOutput() + '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"duration_api_ms":0,"usage":{}}\n'), /zero cost/)

  const spent = payload()
  spent.session.total_cost_usd = 0.01
  assert.throws(() => quota.parseControlOutput(controlOutput(spent)), /zero model usage and cost/)

  for (const value of ['0', null, false, [], { nested: ['bad'] }]) {
    const terminal = {
      type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0,
      duration_api_ms: 0, usage: { input_tokens: value },
    }
    assert.throws(() => quota.parseControlOutput(controlOutput() + JSON.stringify(terminal) + '\n'), /does not prove zero usage/)
  }
  for (const field of ['total_duration_ms', 'total_lines_added', 'total_lines_removed']) {
    const malformed = payload()
    delete malformed.session[field]
    assert.throws(() => quota.parseControlOutput(controlOutput(malformed)), /does not prove zero model usage/)
  }
})

test('labeled parser keys by exact section labels and bounds the Fable section', () => {
  assert.deepEqual(quota.parseLabeledUsage(labeled()), quota.parseStructuredUsage(payload()))
  assert.throws(() => quota.parseLabeledUsage(`Refreshing\n${labeled()}`), /still Refreshing/)
  assert.throws(() => quota.parseLabeledUsage(`${labeled()}\nCurrent session\n1% used`), /exactly one Current session/)
  assert.throws(() => quota.parseLabeledUsage(labeled().replace('Resets later', '13% used')), /exactly one percent used/)
  assert.throws(() => quota.parseLabeledUsage(labeled().replace("What's contributing", 'Other')), /boundary/)
})

test('thresholds are inclusive and any overage denies the next call', () => {
  assert.equal(quota.decide(quota.parseStructuredUsage(payload(50, 90, 90))).allowed, true)
  assert.equal(quota.decide(quota.parseStructuredUsage(payload(50.01, 10, 10))).allowed, false)
  assert.equal(quota.decide(quota.parseStructuredUsage(payload(10, 90.01, 10))).allowed, false)
  assert.equal(quota.decide(quota.parseStructuredUsage(payload(10, 10, 90.01))).allowed, false)
})

test('query uses only initialize and get_usage control messages with the pinned Fable model', () => {
  let call
  const result = quota.queryClaudeUsage('/pinned/claude', {
    spawnSync: (executable, args, options) => {
      call = { executable, args, options }
      return { status: 0, stdout: controlOutput(), stderr: '' }
    },
    env: { PATH: '/unused' },
  })
  assert.equal(result[0].percentUsed, 12)
  assert.equal(call.executable, '/pinned/claude')
  assert.deepEqual(call.args, quota.QUERY_ARGS)
  assert.match(call.options.input, /"subtype":"initialize"/)
  assert.match(call.options.input, /"subtype":"get_usage"/)
  assert.doesNotMatch(call.options.input, /"type":"user"|prompt/)
})

test('allowed and denied preflights append sanitized records and return the matching status', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-quota-'))
  const logs = []
  const errors = []
  const baseDependencies = {
    env: { CLAUDE: '/pinned/claude' },
    resolveExecutable: (value) => value,
    inspectClaude: () => ({ version: '2.1.284 (Claude Code)', executableSha256: 'a'.repeat(64) }),
    now: () => new Date('2026-09-29T12:00:00.000Z'),
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  }
  try {
    assert.equal(quota.main(['--run', 'fable-5-1-test', '--next-call', 'review:tidepool/tool'], root, {
      ...baseDependencies,
      queryClaudeUsage: () => quota.parseStructuredUsage(payload(50, 90, 90)),
    }), 0)
    assert.equal(quota.main(['--run', 'fable-5-1-test', '--next-call', 'extract:tidepool/tool'], root, {
      ...baseDependencies,
      queryClaudeUsage: () => quota.parseStructuredUsage(payload(51, 20, 20)),
    }), 1)

    const file = path.join(root, 'runs', 'fable-5-1-test', 'quota.jsonl')
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(records.length, 2)
    assert.equal(records[0].allowed, true)
    assert.equal(records[1].allowed, false)
    assert.equal(records[0].nextCall, 'review:tidepool/tool')
    assert.deepEqual(records[0].usage, {
      'Current session': 50,
      'Current week (all models)': 90,
      'Current week (Fable)': 90,
    })
    assert.equal(records[0].claudeVersion, '2.1.284 (Claude Code)')
    assert.equal(records[0].claudeExecutableSha256, 'a'.repeat(64))
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /account|must-not-be-audited|pinned\/claude/)
    assert.equal(logs.length, 1)
    assert.equal(errors.length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('final snapshot records a denied threshold decision but does not deny a completed pipeline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-quota-final-'))
  try {
    const code = quota.main(['--run', 'fable-final', '--final'], root, {
      env: { CLAUDE: '/pinned/claude' },
      resolveExecutable: (value) => value,
      inspectClaude: () => ({ version: '2.1.284 (Claude Code)', executableSha256: 'b'.repeat(64) }),
      queryClaudeUsage: () => quota.parseStructuredUsage(payload(99, 99, 99)),
      now: () => new Date('2026-09-29T13:00:00.000Z'),
      log: () => {},
    })
    assert.equal(code, 0)
    const record = JSON.parse(fs.readFileSync(path.join(root, 'runs', 'fable-final', 'quota.jsonl'), 'utf8'))
    assert.equal(record.kind, 'final')
    assert.equal(record.nextCall, null)
    assert.equal(record.allowed, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('unsafe run IDs and call labels are rejected before querying Claude', () => {
  assert.throws(() => quota.parseArgs(['--run', '../escape', '--next-call', 'probe']), /invalid run id/)
  assert.throws(() => quota.parseArgs(['--run', 'safe', '--next-call', 'line\nbreak']), /safe label/)
  assert.throws(() => quota.parseArgs(['--run', 'safe']), /safe label/)
})

test('Claude metadata enforces the minimum version and hashes the selected executable', () => {
  const dependencies = {
    spawnSync: () => ({ status: 0, stdout: '2.1.284 (Claude Code)\n', stderr: '' }),
    sha256File: (file) => `hash:${file}`,
  }
  assert.deepEqual(quota.inspectClaude('/exact/claude', dependencies), {
    version: '2.1.284 (Claude Code)', executableSha256: 'hash:/exact/claude',
  })
  assert.throws(() => quota.inspectClaude('/old/claude', {
    ...dependencies,
    spawnSync: () => ({ status: 0, stdout: '2.1.283 (Claude Code)\n', stderr: '' }),
  }), /2\.1\.284 or newer/)
})

test('paid-call authorization is fresh, bound, durable, and returns the inspected realpath', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-quota-authorize-'))
  const calls = []
  const dependencies = {
    env: { CLAUDE: 'claude' },
    resolveExecutable: (command) => { calls.push(['resolve', command]); return '/real/claude' },
    inspectClaude: (executable) => {
      calls.push(['inspect', executable])
      return { version: '2.1.284 (Claude Code)', executableSha256: 'c'.repeat(64) }
    },
    queryClaudeUsage: (executable) => {
      calls.push(['query', executable])
      return quota.parseStructuredUsage(payload(1, 2, 3))
    },
    now: () => new Date('2026-09-29T14:00:00.000Z'),
  }
  try {
    const authorized = quota.authorizePaidCall(root, {
      runId: 'fable-bound', stage: 'review', target: 'sample', tool: 'reviewer',
      claudeVersion: '2.1.284 (Claude Code)',
    }, dependencies)
    assert.equal(authorized.executable, '/real/claude')
    assert.deepEqual(calls, [
      ['resolve', 'claude'], ['inspect', '/real/claude'], ['query', '/real/claude'],
    ])
    const record = JSON.parse(fs.readFileSync(authorized.audit, 'utf8'))
    assert.deepEqual([record.nextCall, record.stage, record.target, record.tool], [
      'review:sample/reviewer', 'review', 'sample', 'reviewer',
    ])

    assert.throws(() => quota.authorizePaidCall(root, {
      runId: 'fable-bound', stage: 'judge', target: 'sample', tool: null,
      claudeVersion: '2.1.284 (Claude Code)',
    }, {
      ...dependencies,
      queryClaudeUsage: () => quota.parseStructuredUsage(payload(51, 2, 3)),
    }), /quota denied for judge:sample/)
    const records = fs.readFileSync(authorized.audit, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(records.length, 2)
    assert.equal(records[1].allowed, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('paid-call authorization rejects version drift before querying quota', () => {
  let queried = false
  assert.throws(() => quota.authorizePaidCall('/tmp', {
    runId: 'fable-version', stage: 'extract', target: 'sample', tool: 'reviewer',
    claudeVersion: '2.1.284 (Claude Code)',
  }, {
    env: { CLAUDE: '/real/claude' },
    resolveExecutable: () => '/real/claude',
    inspectClaude: () => ({ version: '2.1.285 (Claude Code)', executableSha256: 'd'.repeat(64) }),
    queryClaudeUsage: () => { queried = true; return quota.parseStructuredUsage(payload()) },
  }), /does not match cohort manifest/)
  assert.equal(queried, false)
})
