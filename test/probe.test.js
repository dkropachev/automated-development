'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const artifacts = require('../bench/lib/artifacts')
const probe = require('../bench/probe')
const quota = require('../bench/quota')

const BENCH = path.join(__dirname, '..', 'bench')

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-probe-'))
  fs.copyFileSync(path.join(BENCH, 'models.json'), path.join(root, 'models.json'))
  const target = { id: 'sample', language: 'JS', fork: 'private/sample', forkPr: 1, forkHead: 'prepared' }
  const toolConfig = { context: 'Review', tools: [{ id: 'reviewer', label: 'Reviewer', source: 'test', prompt: 'Review' }] }
  writeJson(path.join(root, 'state.json'), { targets: { sample: target } })
  writeJson(path.join(root, 'tools.json'), toolConfig)
  const manifest = artifacts.ensureManifest(root, {
    runId: 'fable-probe', requestedModel: probe.FABLE_MODEL, modelLabel: 'Claude Fable 5.1',
    claudeVersion: '2.1.284 (Claude Code)', configSha256: artifacts.sha256File(path.join(root, 'tools.json')),
    targets: { sample: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) } },
    targetMetadata: { sample: target }, groundtruth: { sample: null }, toolConfig,
    expectedCells: [{ id: 'fable-probe/sample/reviewer', target: 'sample', tool: 'reviewer' }],
  })
  return { root, manifest }
}

function payload(result = 'OK', canonicalModel = probe.FABLE_MODEL) {
  return {
    is_error: false, api_error_status: null, result, total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {
      [probe.FABLE_MODEL]: {
        inputTokens: 1, outputTokens: 1, costUSD: 0.01, canonicalModel,
      },
    },
  }
}

function authorization(root, manifest, events) {
  return (_root, binding) => {
    events.push(['authorize', binding.stage])
    const decision = quota.decide([
      { label: 'Current session', percentUsed: 1, resetsAt: '2026-10-01T00:00:00.000Z' },
      { label: 'Current week (all models)', percentUsed: 2, resetsAt: '2026-10-01T00:00:00.000Z' },
      { label: 'Current week (Fable)', percentUsed: 3, resetsAt: '2026-10-01T00:00:00.000Z' },
    ])
    const record = quota.buildRecord({
      run: manifest.runId, final: false, nextCall: 'probe', stage: 'probe', target: null, tool: null,
    }, decision, { version: manifest.claudeVersion, executableSha256: 'd'.repeat(64) }, new Date('2026-09-29T12:00:00.000Z'))
    return {
      executable: '/exact/claude',
      quotaEvidence: quota.appendAuditRecord(root, manifest.runId, record).quotaEvidence,
    }
  }
}

test('probe authorizes then immediately runs exact Fable with no tools and publishes sanitized evidence', () => {
  const { root, manifest } = fixture()
  const events = []
  try {
    const file = probe.main(['--run', manifest.runId], root, {
      authorizePaidCall: authorization(root, manifest, events),
      spawnSync: (executable, args) => {
        events.push(['spawn', executable])
        assert.equal(args[args.indexOf('--model') + 1], probe.FABLE_MODEL)
        assert.equal(args[args.indexOf('--effort') + 1], 'medium')
        assert.equal(args[args.indexOf('--tools') + 1], '')
        assert.equal(args[args.indexOf('-p') + 1], probe.PROMPT)
        return { status: 0, signal: null, stdout: JSON.stringify(payload()), stderr: '' }
      },
    })
    assert.deepEqual(events, [['authorize', 'probe'], ['spawn', '/exact/claude']])
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(record.reply, 'OK')
    assert.equal(record.canonicalModel, probe.FABLE_MODEL)
    assert.equal(record.quotaEvidence.line, 1)
    assert.equal(Object.hasOwn(record, 'stdout'), false)
    assert.equal(Object.hasOwn(record, 'sessionId'), false)
    events.length = 0
    probe.main(['--run', manifest.runId], root, {
      authorizePaidCall: () => { throw new Error('must not authorize recorded probe') },
      spawnSync: () => { throw new Error('must not rerun recorded probe') },
    })
    assert.deepEqual(events, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('probe rejects non-exact replies and canonical-model mismatches without publishing', () => {
  for (const response of [payload('OK\n'), payload('OK', 'claude-fable-wrong')]) {
    const { root, manifest } = fixture()
    try {
      assert.throws(() => probe.main(['--run', manifest.runId], root, {
        authorizePaidCall: authorization(root, manifest, []),
        spawnSync: () => ({ status: 0, signal: null, stdout: JSON.stringify(response), stderr: '' }),
      }), /not exactly OK|canonicalModel/)
      assert.equal(fs.existsSync(artifacts.cohortPaths(root, manifest.runId).probe), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})
