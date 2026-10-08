'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const net = require('node:net')

const runner = require('../bin/review-and-fix-pr-codex')
const codexContract = require('../lib/review-codex-contract')

const MODEL = 'gpt-5.6-sol'
const SCHEMA = path.join(__dirname, '..', 'skills', 'review-and-fix-pr', 'codex-judge.schema.json')

function judgment(candidateId, overrides = {}) {
  return {
    candidateId,
    verdict: 'real',
    severity: 'low',
    scope: 'in',
    reason: 'The named path reaches the adverse behavior.',
    sourceEvidence: [{ path: 'src/example.cc', line: 12, detail: 'The guard is bypassed.' }],
    ...overrides,
  }
}

function judgeOutput(judgments, newCandidates = [], overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'OpenAI Codex',
    model: MODEL,
    judgments,
    newCandidates,
    ...overrides,
  }
}

function trace(invocationId, output, options = {}) {
  const events = [
    { type: 'thread.started', thread_id: invocationId, model: options.model || MODEL },
    { type: 'turn.started' },
    ...(options.items || []),
    {
      type: 'item.completed',
      item: { id: `${invocationId}-answer`, type: 'agent_message', text: JSON.stringify(output) },
    },
    {
      type: 'turn.completed',
      usage: options.usage || {
        input_tokens: 17,
        cached_input_tokens: 5,
        output_tokens: 7,
        reasoning_output_tokens: 3,
      },
    },
  ]
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n'
}

function candidate(id = 'C1', overrides = {}) {
  return {
    id,
    claim: 'The close path can use released state.',
    basisType: 'trigger',
    basis: 'A close races the queued callback.',
    mechanisms: ['The callback retains a stale reference.'],
    consequence: 'The process can read freed memory.',
    defectClass: 'use-after-free',
    category: 'runtime',
    locations: [{ path: 'src/example.cc', line: 12 }],
    evidence: [{ path: 'src/example.cc', line: 12, detail: 'The callback retains the reference.' }],
    sourceIds: ['lifecycle:1'],
    ...overrides,
  }
}

function newCandidate(overrides = {}, duplicateOfCandidateId = '') {
  const value = candidate('not-assigned', overrides)
  delete value.id
  delete value.sourceIds
  return { ...value, duplicateOfCandidateId }
}

function reviewContext() {
  return {
    repositoryIdentity: 'private/example',
    remoteIdentity: { name: 'origin', url: 'git@example.invalid:private/example.git' },
    upstreamIdentity: { repository: 'upstream/example', pullRequest: 42 },
    prTitle: 'Close queued callbacks safely',
    prBody: 'Prevent a callback from retaining state after close.',
    acceptanceCriteria: ['Queued callbacks finish before close returns.'],
    commitMessages: ['close callbacks before releasing state'],
    canonicalDiffInventory: { paths: ['src/example.cc'], hunks: ['src/example.cc:H1'] },
    applicableBaseRules: ['AGENTS.md: keep callbacks lifetime-safe'],
    applicableHeadRules: ['AGENTS.md: keep callbacks lifetime-safe'],
    linkedSources: [],
    missingSourceIndicators: {},
  }
}

function judgeInput(candidates = [candidate()]) {
  return {
    schemaVersion: 1,
    contract: 'review-and-fix-pr-v2',
    sourceDisclosure: { discovery: 'Anthropic Claude', adjudication: 'OpenAI Codex' },
    target: {
      repository: 'private/example',
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
    },
    pluginFingerprint: {
      version: '0.5.0', gitCommit: '3'.repeat(40), contentSha256: '4'.repeat(64),
    },
    reviewContext: reviewContext(),
    candidates,
  }
}

function preflightSpawn(executable, args) {
  assert.equal(executable, '/exact/codex')
  if (args[0] === '--version') {
    return { status: 0, signal: null, error: null, stdout: 'codex-cli 0.149.0\n', stderr: '' }
  }
  assert.deepEqual(args, ['login', 'status'])
  return {
    status: 0, signal: null, error: null,
    stdout: 'Logged in using ChatGPT\n', stderr: '',
  }
}

function adjudicationFixture(candidates = [candidate()]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-codex-adjudication-'))
  return {
    root,
    options: {
      root,
      base: '1'.repeat(40),
      head: '2'.repeat(40),
      input: judgeInput(candidates),
      expected: null,
      schemaFile: SCHEMA,
      traceDirectory: path.join(root, 'traces'),
      timeoutMs: 30_000,
      env: { PATH: '/test/bin' },
      executable: '/exact/codex',
      cliVersion: '0.149.0',
      executableSha256: '5'.repeat(64),
    },
  }
}

function invocation(invocationId, candidates, output, sequence = 1) {
  return {
    invocationId,
    events: JSON.parse(`[${trace(invocationId, output).trim().split('\n').join(',')}]`),
    output,
    usage: {
      inputTokens: sequence * 10,
      cachedInputTokens: sequence,
      cacheWriteInputTokens: 0,
      outputTokens: sequence * 4,
      reasoningOutputTokens: sequence * 2,
      totalTokens: sequence * 14,
    },
    traceSha256: String(sequence).repeat(64),
    resultSha256: String(sequence + 2).repeat(64),
    promptSha256: String(sequence + 4).repeat(64),
    candidateIds: candidates.map((entry) => entry.id),
  }
}

function gitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-codex-target-'))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(root, 'src.txt'), 'source\n')
  git('add', 'src.txt')
  git('commit', '-q', '-m', 'fixture')
  return { root, head: git('rev-parse', 'HEAD') }
}

function brokerRequest(socketFile, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketFile)
    let response = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.end(JSON.stringify(request)))
    socket.on('data', (chunk) => { response += chunk })
    socket.on('error', reject)
    socket.on('close', () => {
      try { resolve(JSON.parse(response)) } catch (error) { reject(error) }
    })
  })
}

test('Codex argv pins model, reasoning, isolation, read-only operation, JSONL, and schema', () => {
  const root = path.join('/target', 'repo')
  const schema = path.join('/outside-target', 'judge.schema.json')
  assert.deepEqual(runner.codexArgs(schema, root), [
    '--ask-for-approval', 'never',
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--model', MODEL,
    '--sandbox', 'read-only',
    '-c', 'model_reasoning_effort="high"',
    '-c', 'web_search="disabled"',
    '--output-schema', schema,
    '--cd', root,
    '-',
  ])
  const args = runner.codexArgs(schema, root)
  assert.equal(args.includes('--search'), false)
  assert.equal(args.includes('--add-dir'), false)
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false)
  assert.equal(args.includes('--approve-for-me'), false)
})

test('Codex version parsing requires 0.149.0+ and rejects malformed versions', () => {
  assert.equal(runner.parseCodexVersion('codex-cli 0.149.0\n'), '0.149.0')
  assert.equal(runner.parseCodexVersion('codex-cli 1.2.3'), '1.2.3')
  assert.throws(() => runner.parseCodexVersion('codex-cli 0.148.9'), /0\.149\.0.*required/i)
  for (const value of ['', '0.149', 'codex-cli next', 'claude 0.149.0']) {
    assert.throws(() => runner.parseCodexVersion(value), /parse Codex CLI version/i)
  }
})

test('Codex preflight checks the executable version and authentication and fails closed', () => {
  const calls = []
  const spawnSync = (executable, args, options) => {
    calls.push({ executable, args, options })
    return preflightSpawn(executable, args)
  }
  assert.deepEqual(runner.preflightCodex({
    executable: '/exact/codex', executableSha256: '5'.repeat(64),
  }, { spawnSync }), {
    executable: '/exact/codex',
    cliVersion: '0.149.0',
    executableSha256: '5'.repeat(64),
    authentication: 'Logged in using ChatGPT',
  })
  assert.deepEqual(calls.map(({ executable, args }) => [executable, args]), [
    ['/exact/codex', ['--version']],
    ['/exact/codex', ['login', 'status']],
  ])

  const preflight = (responses) => runner.preflightCodex({
    executable: '/exact/codex', executableSha256: '5'.repeat(64),
  }, {
    spawnSync: () => responses.shift(),
  })
  assert.throws(() => preflight([{
    status: null,
    signal: null,
    error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
    stdout: '',
    stderr: '',
  }]), /codex --version failed.*ENOENT/i)
  assert.throws(() => preflight([
    { status: 0, signal: null, stdout: 'codex-cli 0.149.0\n', stderr: '' },
    { status: 1, signal: null, stdout: '', stderr: 'Not logged in' },
  ]), /login status exited 1.*Not logged in/i)
  assert.throws(() => preflight([
    { status: 0, signal: null, stdout: 'codex-cli 0.149.0\n', stderr: '' },
    { status: 0, signal: null, stdout: 'Credential state unknown', stderr: '' },
  ]), /explicitly confirm authentication/i)
  assert.throws(() => preflight([
    { status: 0, signal: null, stdout: 'codex-cli 0.149.0\n', stderr: '' },
    { status: 0, signal: null, stdout: 'Not authenticated', stderr: '' },
  ]), /explicitly confirm authentication/i)
})

test('judge prompt discloses providers while excluding lane, support, disposition, and baseline signals', () => {
  const secretSources = [
    'lane:lifecycle', 'support-count:4', 'claude-disposition:confirmed',
    'matt-output:secret', 'sealed-baseline:I19',
  ]
  const prompt = runner.buildJudgePrompt(reviewContext(), [candidate('C1', { sourceIds: secretSources })])
  assert.match(prompt, /Anthropic Claude/)
  assert.match(prompt, /OpenAI Codex/)
  assert.match(prompt, /independently adjudicating/i)
  assert.match(prompt, /"id":"C1"/)
  assert.match(prompt, /stale reference/)
  for (const secret of secretSources) assert.doesNotMatch(prompt, new RegExp(secret, 'i'))
})

test('v3 broad discovery runs once and later waves see known mechanisms', () => {
  const first = runner.buildJudgePrompt(reviewContext(), [candidate('C1')],
    codexContract.CONTRACT_V3)
  const later = runner.buildJudgePrompt(reviewContext(), [candidate('N1')],
    codexContract.CONTRACT_V3, [candidate('C1')], false)
  assert.match(first, /Independently inspect every changed hunk/)
  assert.match(first, /false_positive only when evidence disproves the factual premise/)
  assert.match(first, /group candidates that share the same trigger or rule/)
  assert.match(first, /cherry-picking a behavior commit without its later test/)
  assert.match(first, /shared callee handles current paths/)
  assert.match(later, /judgment-only wave/)
  assert.match(later, /"knownCandidates":\[\{"category"/)
  assert.doesNotMatch(later, /Independently inspect every changed hunk/)
})

test('judge prompt and schema bind every verdict sourceEvidence to its candidate locations', () => {
  const prompt = runner.buildJudgePrompt(reviewContext(), [candidate()])
  assert.match(prompt, /every verdict, including false_positive and unresolved/i)
  assert.match(prompt, /exact path and line pair from that same candidate's supplied locations or evidence/i)
  assert.match(prompt, /explanation in sourceEvidence\.detail while preserving the copied path and line exactly/i)

  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'))
  const description = schema.properties.judgments.items.properties.sourceEvidence.description
  assert.match(description, /every verdict, including false_positive and unresolved/i)
  assert.match(description, /exact path and line pair from that same candidate's supplied locations or evidence/i)
  assert.match(description, /explanation in detail/i)
})

test('trace parsing captures invocation and token usage without inventing USD cost', () => {
  const output = judgeOutput([judgment('C1')])
  const parsed = runner.parseTrace(trace('judge-1', output))
  assert.equal(parsed.invocationId, 'judge-1')
  assert.deepEqual(parsed.output, output)
  assert.deepEqual(parsed.usage, {
    inputTokens: 17,
    cachedInputTokens: 5,
    cacheWriteInputTokens: 0,
    outputTokens: 7,
    reasoningOutputTokens: 3,
    totalTokens: 24,
  })
  assert.equal(Object.hasOwn(parsed.usage, 'costUsd'), false)
  assert.equal(Object.hasOwn(parsed.usage, 'costUSD'), false)
})

test('trace and output validation reject malformed data, model drift, writes, and web search', () => {
  assert.throws(() => runner.parseTrace('{not-json}\n'), /JSONL line 1 is malformed/i)
  assert.throws(() => runner.parseTrace([
    JSON.stringify({ type: 'thread.started', thread_id: 'judge-1', model: MODEL }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
  ].join('\n')), /exactly one final agent message/i)
  const malformedFinal = [
    { type: 'thread.started', thread_id: 'judge-1', model: MODEL },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: '{not-json}' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n'
  assert.throws(() => runner.parseTrace(malformedFinal), /structured output is malformed JSON/i)
  assert.throws(() => runner.parseTrace(
    trace('judge-1', judgeOutput([judgment('C1')]), { model: 'gpt-5.6-luna' }),
  ), /model drifted.*gpt-5\.6-luna/i)

  const fileChange = {
    type: 'item.completed',
    item: { id: 'write-1', type: 'file_change', changes: [{ path: 'src/example.cc' }] },
  }
  assert.throws(() => runner.parseTrace(
    trace('judge-1', judgeOutput([judgment('C1')]), { items: [fileChange] }),
  ), /attempted a write/i)

  const writeCommand = {
    type: 'item.completed',
    item: { id: 'write-2', type: 'command_execution', command: 'touch should-not-exist' },
  }
  assert.throws(() => runner.parseTrace(
    trace('judge-1', judgeOutput([judgment('C1')]), { items: [writeCommand] }),
  ), /attempted a write/i)
  for (const command of [
    'python -c \'open("out", "w").write("x")\'',
    'node -e \'require("fs").writeFileSync("out", "x")\'',
    'git config user.name attacker',
  ]) {
    assert.throws(() => runner.parseTrace(trace('judge-1', judgeOutput([judgment('C1')]), {
      items: [{ type: 'item.completed', item: { id: 'write-hidden', type: 'command_execution', command } }],
    })), /attempted a write/i)
  }

  const webSearch = {
    type: 'item.completed',
    item: { id: 'web-1', type: 'web_search', query: 'sealed benchmark issues' },
  }
  assert.throws(() => runner.parseTrace(
    trace('judge-1', judgeOutput([judgment('C1')]), { items: [webSearch] }),
  ), /attempted web search/i)

  assert.throws(() => runner.validateJudgeOutput(
    judgeOutput([judgment('C1', { sourceEvidence: [] })]), ['C1'],
  ), /sourceEvidence must be nonempty/i)
  assert.throws(() => runner.validateJudgeOutput(
    judgeOutput([judgment('C1')], [], { model: 'gpt-5.6-luna' }), ['C1'],
  ), /identity or model drifted|model.*gpt-5\.6-sol|fields are invalid/i)
  assert.throws(() => runner.validateJudgeOutput(
    judgeOutput([]), ['C1'],
  ), /omitted a candidate judgment/i)
})

test('one invocation forwards exact argv, prompt, cwd, timeout, and stdin', () => {
  const repo = gitFixture()
  let call
  try {
    const output = judgeOutput([judgment('C1')])
    const result = runner.runOneInvocation({
      root: repo.root,
      head: repo.head,
      executable: '/exact/codex',
      schemaFile: SCHEMA,
      timeoutMs: 45_000,
      env: { PATH: '/test/bin' },
      reviewContext: reviewContext(),
      candidates: [candidate()],
    }, {
      spawnSync: (executable, args, options) => {
        call = { executable, args, options }
        return {
          status: 0, signal: null, error: null,
          stdout: trace('judge-1', output), stderr: '',
        }
      },
    })
    assert.equal(call.executable, '/exact/codex')
    assert.deepEqual(call.args, runner.codexArgs(SCHEMA, repo.root))
    assert.equal(call.options.cwd, repo.root)
    assert.equal(call.options.timeout, 45_000)
    assert.equal(call.options.killSignal, 'SIGKILL')
    assert.equal(call.options.input, runner.buildJudgePrompt(reviewContext(), [candidate()]))
    assert.equal(result.invocationId, 'judge-1')
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true })
  }
})

test('timeout and nonzero Codex exits fail before producing an invocation', () => {
  for (const [response, expected] of [
    [{
      status: null,
      signal: 'SIGKILL',
      error: Object.assign(new Error('spawnSync codex ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      stdout: '',
      stderr: '',
    }, /codex exec timed out/i],
    [{ status: 9, signal: null, error: null, stdout: '', stderr: 'judge failed' }, /codex exec exited 9.*judge failed/i],
  ]) {
    const repo = gitFixture()
    try {
      assert.throws(() => runner.runOneInvocation({
        root: repo.root,
        head: repo.head,
        executable: '/exact/codex',
        schemaFile: SCHEMA,
        timeoutMs: 45_000,
        reviewContext: reviewContext(),
        candidates: [candidate()],
      }, { spawnSync: () => response }), expected)
    } finally {
      fs.rmSync(repo.root, { recursive: true, force: true })
    }
  }
})

test('adjudication sends a unique new lead to a distinct fresh invocation and captures usage', () => {
  const fixture = adjudicationFixture()
  const calls = []
  const candidateKeys = Object.keys(candidate()).sort()
  const blindCandidateKeys = candidateKeys.filter((key) => key !== 'sourceIds')
  let clock = 0
  try {
    fixture.options.deadlineMs = 1000
    const receipt = runner.runAdjudication(fixture.options, {
      now: () => new Date('2026-10-03T12:00:00.000Z'),
      nowMs: () => { clock += 100; return clock },
      runOneInvocation: (options) => {
        calls.push(options)
        for (const entry of options.candidates) {
          assert.deepEqual(Object.keys(entry).sort(), candidateKeys)
        }
        const prompt = runner.buildJudgePrompt(options.reviewContext, options.candidates)
        const payloadText = prompt.match(/<BEGIN_REVIEW_EVIDENCE_JSON>\n(.+)\n<END_REVIEW_EVIDENCE_JSON>/s)[1]
        const payload = JSON.parse(payloadText)
        for (const entry of payload.candidates) {
          assert.deepEqual(Object.keys(entry).sort(), blindCandidateKeys)
        }
        const sequence = calls.length
        const output = judgeOutput(
          options.candidates.map((entry) => judgment(entry.id, sequence === 2 ? { severity: 'nit' } : {})),
          sequence === 1 ? [newCandidate({
            claim: 'The comment promises cleanup that the exception path skips.',
            basis: 'The callback throws before cleanup.',
            mechanisms: ['The documented cleanup is not reached from the exception origin.'],
            consequence: 'Maintainers are misled about the cleanup invariant.',
            category: 'comments',
          })] : [],
        )
        return invocation(`J00${sequence}`, options.candidates, output, sequence)
      },
    })
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map((call) => call.candidates.map((entry) => entry.id)), [['C1'], ['N1']])
    assert.deepEqual(calls.map((call) => call.timeoutMs), [900, 800])
    assert.deepEqual(receipt.invocations.map((entry) => entry.id), ['J001', 'J002'])
    assert.deepEqual(receipt.invocations.map((entry) => entry.usage.totalTokens), [14, 28])
    assert.equal(receipt.candidates.length, 2)
    assert.equal(receipt.candidates.find((entry) => entry.id === 'N1').originInvocationId, 'J001')
    assert.equal(receipt.candidates.find((entry) => entry.id === 'N1').judgmentInvocationId, 'J002')
    assert.equal(receipt.newLeadResolutions[0].resolution, 'admitted')
    const backwards = JSON.parse(JSON.stringify(receipt))
    backwards.invocations = [
      { ...backwards.invocations[1], sequence: 1 },
      { ...backwards.invocations[0], sequence: 2 },
    ]
    assert.throws(() => codexContract.validateReceipt(backwards), /not judged after its originating invocation/i)
    const wrongDuplicateMechanism = JSON.parse(JSON.stringify(receipt))
    wrongDuplicateMechanism.newLeadResolutions[0].mechanismHash = 'f'.repeat(64)
    assert.throws(() => codexContract.validateReceipt(wrongDuplicateMechanism), /mechanismHash|different mechanism/i)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('adjudication judges every candidate across bounded waves', () => {
  const candidates = Array.from({ length: 13 }, (_, index) => candidate(`C${index + 1}`, {
    claim: `Distinct issue ${index + 1}`,
    basis: `Trigger ${index + 1}`,
    mechanisms: [`Mechanism ${index + 1}`],
    consequence: `Consequence ${index + 1}`,
  }))
  const fixture = adjudicationFixture(candidates)
  const sizes = []
  try {
    const receipt = runner.runAdjudication(fixture.options, {
      now: () => new Date('2026-10-08T00:00:00.000Z'),
      runOneInvocation: (options) => {
        sizes.push(options.candidates.length)
        const output = judgeOutput(options.candidates.map((entry) => judgment(entry.id)))
        return invocation(`J00${sizes.length}`, options.candidates, output, sizes.length)
      },
    })
    assert.deepEqual(sizes, [6, 6, 1])
    assert.equal(receipt.candidates.length, 13)
    assert.equal(receipt.counts.confirmed, 13)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test('a duplicate new lead maps to the existing mechanism without another invocation', () => {
  const fixture = adjudicationFixture()
  let calls = 0
  try {
    const receipt = runner.runAdjudication(fixture.options, {
      now: () => new Date('2026-10-03T12:00:00.000Z'),
      runOneInvocation: (options) => {
        calls += 1
        const output = judgeOutput(
          options.candidates.map((entry) => judgment(entry.id)),
          [newCandidate({}, 'C1')],
        )
        return invocation('J001', options.candidates, output)
      },
    })
    assert.equal(calls, 1)
    assert.equal(receipt.candidates.length, 1)
    assert.deepEqual(receipt.newLeadResolutions.map((lead) => ({
      resolution: lead.resolution,
      targetCandidateId: lead.targetCandidateId,
    })), [{ resolution: 'duplicate', targetCandidateId: 'C1' }])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a new lead cannot be judged by its own originating invocation', () => {
  const fixture = adjudicationFixture()
  let calls = 0
  try {
    assert.throws(() => runner.runAdjudication(fixture.options, {
      runOneInvocation: (options) => {
        calls += 1
        const output = judgeOutput(
          options.candidates.map((entry) => judgment(entry.id)),
          calls === 1 ? [newCandidate({
            claim: 'A distinct fresh lead.',
            mechanisms: ['A separate cleanup branch retains an invalid iterator.'],
            consequence: 'The next cleanup pass can dereference invalid state.',
          })] : [],
        )
        return invocation('J001', options.candidates, output, calls)
      },
    }), /reused invocation ID J001|originating invocation/i)
    assert.equal(calls, 2)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('runner-owned broker is the exclusive producer of the admitted receipt proof', async () => {
  const repo = gitFixture()
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'review-codex-broker-'))
  const inputFile = path.join(parent, 'judge-input.json')
  const receiptFile = path.join(parent, 'receipt.json')
  const socketFile = path.join(parent, 'broker.sock')
  const input = judgeInput()
  input.target = { repository: 'private/example', baseSha: repo.head, headSha: repo.head }
  input.pluginFingerprint = null
  fs.writeFileSync(inputFile, JSON.stringify(input))
  const request = {
    root: repo.root,
    base: repo.head,
    head: repo.head,
    inputFile,
    receiptFile,
    timeoutMs: 30_000,
  }
  let broker
  try {
    broker = await runner.startCodexBroker({
      ...request,
      socketFile,
      expected: {
        target: input.target,
        pluginFingerprint: null,
        model: MODEL,
        reasoningEffort: 'high',
        cliVersion: '0.149.0',
        executableSha256: '5'.repeat(64),
        schemaSha256: codexContract.sha256(fs.readFileSync(SCHEMA)),
      },
      expectedReviewContext: input.reviewContext,
      schemaFile: SCHEMA,
      executable: '/exact/codex',
      cliVersion: '0.149.0',
      executableSha256: '5'.repeat(64),
      env: {},
    }, {
      now: () => new Date('2026-10-03T12:00:00.000Z'),
      runOneInvocation: (options) => invocation(
        'J001', options.candidates,
        judgeOutput(options.candidates.map((entry) => judgment(entry.id))),
      ),
    })
    const response = await brokerRequest(socketFile, request)
    assert.equal(response.ok, true, response.error)
    assert.equal(fs.existsSync(receiptFile), true)
    const produced = broker.assertCompleted()
    assert.equal(response.receiptSha256, produced.proof.receiptSha256)
    const forged = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
    forged.createdAt = '2026-10-03T13:00:00.000Z'
    fs.writeFileSync(receiptFile, JSON.stringify(forged))
    assert.notEqual(
      codexContract.normalizedReceiptProof(forged).receiptSha256,
      produced.proof.receiptSha256,
    )
  } finally {
    if (broker) broker.close()
    fs.rmSync(repo.root, { recursive: true, force: true })
    fs.rmSync(parent, { recursive: true, force: true })
  }
})
