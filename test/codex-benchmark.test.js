'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const artifacts = require('../bench/lib/artifacts')
const codex = require('../bench/lib/codex-review')
const runner = require('../bench/run-codex')
const extractor = require('../bench/extract')
const dashboard = require('../bench/dashboard')

function fixture(t) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'native-codex-bench-'))
  const root = path.join(repository, 'bench')
  fs.mkdirSync(root)
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }))
  fs.copyFileSync(path.join(__dirname, '../bench/models.json'), path.join(root, 'models.json'))
  const skill = path.join(repository, '.agents/skills/code-review-ad')
  fs.mkdirSync(skill, { recursive: true })
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'Skill')
  fs.writeFileSync(path.join(skill, 'review.md'), 'Procedure')
  const targetIds = ['alpha', 'beta', 'gamma']
  const targetMetadata = Object.fromEntries(targetIds.map((id) => [id, { id, language: 'JS' }]))
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ targets: targetMetadata }))
  const manifest = artifacts.ensureManifest(root, {
    runId: 'codex-test', platform: 'codex', requestedModel: 'gpt-6.1-sol', modelLabel: 'GPT-6.1 Sol',
    codexReviewer: { version: 'codex-cli 1', executableSha256: 'e'.repeat(64), reasoningEffort: 'high', reviewerEffort: 'xhigh', roles: ['spec', 'standards', 'toolkit'], skill: codex.snapshotSkill(skill) },
    configSha256: 'c'.repeat(64),
    targets: Object.fromEntries(targetIds.map((id) => [id, { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }])),
    targetMetadata, groundtruth: Object.fromEntries(targetIds.map((id) => [id, null])),
    toolConfig: { context: '', tools: [{ id: 'code-review-ad', platform: 'codex', label: 'code-review-ad', prompt: 'Review' }] },
    expectedCells: targetIds.map((target) => ({ id: `codex-test/${target}/code-review-ad`, target, tool: 'code-review-ad' })),
  })
  return { root, manifest }
}

function result(manifest, target = 'alpha') {
  const report = '## Toolkit\nNo findings\n## Standards\nNo findings\n## Spec\nNo spec available\n'
  const prompt = 'Frozen review prompt'
  const agents = ['/root', '/root/spec', '/root/standards', '/root/toolkit'].map((role) => ({
    threadId: role, role, completed: true, model: manifest.requestedModel,
    reasoningEffort: role === '/root' ? 'high' : 'xhigh', rolloutSha256: 'd'.repeat(64),
    usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 140 },
  }))
  return {
    schemaVersion: 2, ...artifacts.manifestMetadata(manifest), target, tool: 'code-review-ad',
    cellId: `${manifest.runId}/${target}/code-review-ad`, ...manifest.targets[target],
    result: report, prompt, wallMs: 1000, finishedAt: '2026-10-17T00:00:00.000Z', exitCode: 0, signal: null, isError: false, apiErrorStatus: null, reportedCostUsd: null,
    transcriptUsage: codex.transcriptUsage(agents), codexReview: { schemaVersion: 1, agents, reportSha256: codex.sha256(report), promptSha256: codex.sha256(prompt) },
  }
}

test('Codex cohort seals only the complete target matrix and validates frozen receipts', (t) => {
  const { root, manifest } = fixture(t)
  assert.equal(artifacts.readManifest(root, manifest.runId).claudeVersion, null)
  for (const target of ['alpha', 'beta']) artifacts.writeJsonExclusive(path.join(root, 'runs', manifest.runId, 'results', target, 'code-review-ad.json'), result(manifest, target))
  assert.throws(() => artifacts.ensureSeal(root, manifest.runId), /incomplete|missing/)
  artifacts.writeJsonExclusive(path.join(root, 'runs', manifest.runId, 'results', 'gamma', 'code-review-ad.json'), result(manifest, 'gamma'))
  assert.equal(artifacts.ensureSeal(root, manifest.runId).seal.cells.length, 3)
  const file = path.join(root, 'runs', manifest.runId, 'results', 'alpha', 'code-review-ad.json')
  fs.appendFileSync(file, '\n')
  assert.throws(() => artifacts.readSeal(root, manifest.runId), /changed/)
})

test('native Codex accounting excludes subsets and does not invent USD receipts', (t) => {
  const { manifest } = fixture(t)
  const record = result(manifest)
  artifacts.validateResultRecord(record, manifest, 'alpha', 'code-review-ad')
  assert.equal(record.transcriptUsage.total, 560)
  assert.equal(record.transcriptUsage.input, 320)
  assert.equal(record.transcriptUsage.cacheRead, 80)
  assert.equal(record.transcriptUsage.thinking, 40)
  assert.equal(record.transcriptUsage.costUsd, null)
  const corruptions = [
    (r) => { r.result += 'changed' },
    (r) => { r.codexReview.agents[1].completed = false },
    (r) => { r.codexReview.agents.pop() },
    (r) => { r.codexReview.agents[1].model = 'other-model' },
    (r) => { r.codexReview.agents[1].reasoningEffort = 'high' },
    (r) => { r.codexReview.agents[1].usage.cached_input_tokens = 500 },
    (r) => { r.transcriptUsage.total += 1 },
    (r) => { r.reportedCostUsd = 0 },
    (r) => { r.finishedAt = 'unknown' },
  ]
  for (const corrupt of corruptions) {
    const changed = JSON.parse(JSON.stringify(record))
    corrupt(changed)
    assert.throws(() => artifacts.validateResultRecord(changed, manifest, 'alpha', 'code-review-ad'), /Codex/)
  }
})

test('Codex manifest refuses runtime or skill drift on resume', (t) => {
  const { root, manifest } = fixture(t)
  const changed = JSON.parse(JSON.stringify(manifest.codexReviewer))
  changed.executableSha256 = 'f'.repeat(64)
  assert.throws(() => artifacts.ensureManifest(root, { ...manifest, codexReviewer: changed }), /reviewer mismatch/)
  changed.skill.files['review.md'] = 'e'.repeat(64)
  assert.throws(() => codex.validateReviewer(changed), /fingerprint mismatch/)
})

test('the existing extractor can seal and consume native Codex reports', (t) => {
  const { root, manifest } = fixture(t)
  for (const target of ['alpha', 'beta', 'gamma']) artifacts.writeJsonExclusive(path.join(root, 'runs', manifest.runId, 'results', target, 'code-review-ad.json'), result(manifest, target))
  const model = 'claude-sonnet-5'
  assert.equal(extractor.main(['--run', manifest.runId], root, {
    extractOne: (file) => ({ ok: true, record: JSON.parse(fs.readFileSync(file)), findings: [], costUsd: 0.01,
      modelUsage: { [model]: { canonicalModel: model, inputTokens: 1, outputTokens: 1, costUSD: 0.01 } } }),
  }), 0)
  for (const cell of artifacts.readSeal(root, manifest.runId).seal.cells) {
    const record = artifacts.readFindingRecord(path.join(root, 'runs', manifest.runId, 'findings', cell.target, 'code-review-ad.json'), manifest, cell)
    assert.equal(record.platform, 'codex')
  }
})

test('native runner requires an explicit cohort and isolates the supplied skill from grading', () => {
  assert.throws(() => runner.parseArgs([]), /--run/)
  assert.throws(() => runner.parseArgs(['--run', 'legacy']), /--run/)
  assert.throws(() => runner.parseArgs(['--run', 'new', '--concurrency', '4']), /concurrency/)
  const prompt = runner.reviewPrompt('/isolated/skill', { title: 'Frozen PR', body: 'Description', baseRefOid: 'base', headRefOid: 'head' })
  assert.match(prompt, /\/isolated\/skill\/SKILL.md/)
  assert.match(prompt, /Never read benchmark results/)
  assert.doesNotMatch(prompt, /expected findings|verifiedGroups|gold standard/)
})

test('completed native cohort reaches dashboard under Codex and latest follows the actual skill hash', (t) => {
  const { root, manifest } = fixture(t)
  for (const target of ['alpha', 'beta', 'gamma']) artifacts.writeJsonExclusive(path.join(root, 'runs', manifest.runId, 'results', target, 'code-review-ad.json'), result(manifest, target))
  const model = 'claude-sonnet-5'
  const usage = { [model]: { canonicalModel: model, inputTokens: 1, outputTokens: 1, costUSD: 0.01 } }
  assert.equal(extractor.main(['--run', manifest.runId], root, {
    extractOne: (file) => ({ ok: true, record: JSON.parse(fs.readFileSync(file)), findings: [], costUsd: 0.01, modelUsage: usage }),
  }), 0)
  for (const target of ['alpha', 'beta', 'gamma']) artifacts.writeJsonExclusive(path.join(root, 'runs', manifest.runId, 'judgement', `${target}.json`), {
    schemaVersion: 2, ...artifacts.manifestMetadata(manifest), target, ...manifest.targets[target],
    rawFindings: 0, issues: [], judgeCostUsd: 0.01, judgeRequestedModel: model, judgeModelUsage: usage,
  })
  artifacts.ensureComplete(root, manifest.runId)
  const data = dashboard.loadArtifacts(root)
  assert.equal(data.runs.length, 3)
  assert.ok(data.runs.every((run) => run.platform === 'codex' && run.skillId === 'codex:code-review-ad' && run.currentEvaluation))
  assert.ok(data.runs.every((run) => run.usage.costUsd === null && run.metrics.costPerReal === null))
  assert.deepEqual(data.tools.map((tool) => tool.skillId), ['codex:code-review-ad'])
  assert.equal(data.currentEvaluations.length, 1)
  assert.equal(data.currentEvaluations[0].id, manifest.runId)
  assert.equal(data.currentEvaluations[0].skillFingerprint, manifest.codexReviewer.skill.contentSha256)
  fs.appendFileSync(path.join(root, '../.agents/skills/code-review-ad/review.md'), 'New skill version')
  const changed = dashboard.loadArtifacts(root)
  assert.deepEqual(changed.currentEvaluations, [])
  assert.equal(changed.runs.length, 3, 'historical completed evidence is never discarded')
  assert.ok(changed.runs.every((run) => run.currentEvaluation === false))
})

test('a real finding without a dollar receipt never becomes a zero-cost finding', () => {
  const { applyIdentities } = require('../bench/issue-identities')
  const data = applyIdentities({
    runs: [{ id: 'run/target/tool', targetId: 'target', issueIds: ['issue'], metrics: {}, usage: { costUsd: null }, wallMs: 1000 }],
    issues: [{ id: 'issue', targetId: 'target', verdict: 'real', reporterIds: ['run/target/tool'] }],
  }, { identities: new Map(), mappings: new Map() })
  assert.equal(data.runs[0].metrics.real, 1)
  assert.equal(data.runs[0].metrics.costPerReal, null)
})

test('usage collector isolates a retry from older threads in the same checkout', (t) => {
  const { root } = fixture(t)
  const { execFileSync } = require('node:child_process')
  const database = path.join(root, 'state.sqlite')
  const thread = (id, parent, role) => {
    const rollout = path.join(root, `${id}.jsonl`)
    fs.writeFileSync(rollout, [
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 15 } } } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ].map((row) => JSON.stringify(row)).join('\n'))
    return [id, rollout, role, 'gpt-6.1-sol', role ? 'xhigh' : 'high', parent ? JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent } } }) : 'exec', '/same/checkout']
  }
  const rows = [thread('old', null, null), thread('old-toolkit', 'old', '/root/toolkit'), thread('new', null, null),
    ...['spec', 'standards', 'toolkit'].map((role) => thread(`new-${role}`, 'new', `/root/${role}`))]
  execFileSync('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE threads (id, rollout_path, agent_path, model, reasoning_effort, source, cwd)"); c.executemany("INSERT INTO threads VALUES (?,?,?,?,?,?,?)",json.loads(sys.argv[2])); c.commit()', database, JSON.stringify(rows)])
  const agents = JSON.parse(execFileSync('python3', [path.join(__dirname, '../bench/collect-codex-usage.py'), database, '/same/checkout', 'new'], { encoding: 'utf8' }))
  assert.equal(agents.length, 4)
  assert.ok(agents.every((agent) => agent.threadId.startsWith('new')))
})
