#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const {
  sha256, canonical, validateReceipt, receiptSummary, JUDGE_MODEL, JUDGE_REASONING_EFFORT,
} = require('../lib/review-codex-contract')
const { PASS_IDS, assemblePasses, formatReport, normalizedPass, passPrompt } = require('../lib/review-fast')
const { applyGroups, clusterPrompt, normalizeGroups } = require('../lib/review-fast-cluster')
const { validatePassReceipt } = require('../lib/review-fast-contract')
const { normalizeInput, parseTrace } = require('./review-and-fix-pr-codex')

const PLUGIN_ROOT = path.join(__dirname, '..')
const PASS_DIR = path.join(PLUGIN_ROOT, 'skills', 'review-and-fix-pr', 'passes')
const DEFAULT_PASS_TIMEOUT_MS = 12 * 60_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const PASS_EFFORT = Object.freeze({ contracts: 'low' })

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (!key?.startsWith('--') || !argv[index + 1]) throw new Error('expected --name value pairs')
    options[key.slice(2)] = argv[index + 1]
  }
  if (!options.root) throw new Error('--root is required')
  return options
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()
}

function assertTarget(root, base, head) {
  if (path.resolve(git(root, 'rev-parse', '--show-toplevel')) !== root) throw new Error('--root is not the repository top level')
  if (git(root, 'rev-parse', 'HEAD') !== head) throw new Error('review target HEAD changed')
  if (git(root, 'status', '--porcelain') !== '') throw new Error('review target tree is dirty')
  if (git(root, 'rev-parse', '--verify', `${base}^{commit}`) !== base) throw new Error('base SHA is unavailable')
}

function runProcess(executable, args, options) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.end(options.input || '')
    let stdout = '', stderr = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > MAX_OUTPUT_BYTES) child.kill('SIGKILL')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > MAX_OUTPUT_BYTES) child.kill('SIGKILL')
    })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut || code !== 0 || signal) {
        reject(new Error(`${executable} ${timedOut ? 'timed out' : `exited ${code ?? signal}`}: ${stderr.slice(-500)}`))
      } else resolve({ stdout, stderr, wallMs: Date.now() - started })
    })
  })
}

function childEnvironment(env) {
  const child = { ...env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }
  delete child.CLAUDECODE
  delete child.CLAUDE_CODE_ENTRYPOINT
  return child
}

async function runPass(id, context, options) {
  const schema = fs.readFileSync(path.join(PASS_DIR, 'output.schema.json'), 'utf8')
  const prompt = passPrompt(id, context, PASS_DIR)
  const effort = PASS_EFFORT[id] || 'medium'
  const args = ['-p', prompt, '--output-format', 'json', '--json-schema', schema,
    '--model', options.model, '--effort', effort, '--permission-mode', 'bypassPermissions',
    '--max-budget-usd', String(options.passBudgetUsd), '--disallowedTools',
    'WebSearch', 'WebFetch', 'ScheduleWakeup', 'Agent', 'Skill']
  const result = await runProcess(options.claudeExecutable, args, {
    cwd: options.root, env: childEnvironment(options.env), timeoutMs: options.passTimeoutMs,
  })
  let response
  try { response = JSON.parse(result.stdout) } catch { throw new Error(`${id} returned invalid Claude JSON`) }
  if (response.is_error !== false || !response.structured_output ||
      response.modelUsage?.[options.model] == null ||
      !Number.isFinite(response.total_cost_usd) || response.total_cost_usd < 0 ||
      response.subagent_stats?.spawned !== 0) {
    throw new Error(`${id} did not finish as one isolated ${options.model} review`)
  }
  const pass = normalizedPass(id, response.structured_output, {
    model: options.model, effort, wallMs: result.wallMs, costUsd: response.total_cost_usd,
    reportedUsage: response.usage, resultSha256: sha256(response.structured_output),
  })
  assertTarget(options.root, options.base, options.head)
  return pass
}

async function runPasses(context, options) {
  const output = Array(PASS_IDS.length)
  let next = 0
  const execute = options.runPass || runPass
  const workers = Array.from({ length: PASS_IDS.length }, async () => {
    while (next < PASS_IDS.length) {
      const index = next++
      output[index] = await execute(PASS_IDS[index], context, options)
    }
  })
  await Promise.all(workers)
  return output
}

async function runCluster(candidates, options) {
  const template = fs.readFileSync(path.join(PASS_DIR, 'cluster.txt'), 'utf8')
  const prompt = clusterPrompt(candidates, template)
  const schema = path.join(PASS_DIR, 'cluster.schema.json')
  const args = ['--ask-for-approval', 'never', 'exec', '--json', '--ephemeral',
    '--ignore-user-config', '--ignore-rules', '--strict-config', '--model', JUDGE_MODEL,
    '--sandbox', 'read-only', '-c', `model_reasoning_effort="${JUDGE_REASONING_EFFORT}"`,
    '-c', 'web_search="disabled"', '--output-schema', schema, '--cd', options.root, '-']
  const response = await runProcess(options.codexExecutable, args, {
    cwd: options.root, env: options.env, timeoutMs: options.passTimeoutMs, input: prompt,
  })
  const trace = parseTrace(response.stdout)
  if (trace.events.some((event) => /collab_tool_call|request_permissions/i.test(event.type || '') ||
      /collab_tool_call|request_permissions/i.test(event.item?.type || ''))) {
    throw new Error('Codex clustering attempted a tool or permission request')
  }
  const groups = normalizeGroups(trace.output, candidates)
  return { groups, model: JUDGE_MODEL, usage: trace.usage,
    invocationId: trace.invocationId, promptSha256: sha256(prompt),
    traceSha256: sha256(response.stdout), resultSha256: sha256(trace.output),
    wallMs: response.wallMs }
}

function writeExclusive(file, value) {
  if (path.isAbsolute(file) === false) throw new Error('output paths must be absolute')
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  const root = fs.realpathSync(args.root)
  const expected = env.REVIEW_AND_FIX_PR_CODEX_EXPECTED_JSON
    ? JSON.parse(env.REVIEW_AND_FIX_PR_CODEX_EXPECTED_JSON) : null
  const base = expected?.target?.baseSha || args.base
  const head = expected?.target?.headSha || args.head
  const repository = expected?.target?.repository || args.repo
  if (!base || !head || !repository) throw new Error('target repository, base, and head are required')
  assertTarget(root, base, head)
  const contextFile = env.REVIEW_AND_FIX_PR_CODEX_CONTEXT || args.context
  if (!contextFile || !path.isAbsolute(contextFile)) throw new Error('absolute frozen context path is required')
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'review-and-fix-pr-fast-'))
  const inputFile = env.REVIEW_AND_FIX_PR_CODEX_INPUT || path.join(scratch, 'input.json')
  const ledgerFile = env.REVIEW_AND_FIX_PR_DISCOVERY_LEDGER || path.join(scratch, 'discovery.json')
  const receiptFile = env.REVIEW_AND_FIX_PR_CODEX_RECEIPT || path.join(scratch, 'receipt.json')
  const passReceiptFile = env.REVIEW_AND_FIX_PR_PASS_RECEIPT || path.join(scratch, 'passes.json')
  for (const file of [inputFile, ledgerFile, receiptFile, passReceiptFile]) {
    if (!path.isAbsolute(file) || fs.existsSync(file)) throw new Error(`unsafe or existing output path: ${file}`)
  }
  const options = { root, base, head, env, model: env.REVIEW_AND_FIX_PR_MODEL || args.model || 'claude-opus-5-5',
    claudeExecutable: env.CLAUDE || 'claude', passBudgetUsd: Number(args['pass-budget-usd'] || 5),
    passTimeoutMs: Number(args['pass-timeout-ms'] || DEFAULT_PASS_TIMEOUT_MS) }
  if (!Number.isFinite(options.passBudgetUsd) || options.passBudgetUsd <= 0 ||
      !Number.isSafeInteger(options.passTimeoutMs) || options.passTimeoutMs < 1) {
    throw new Error('pass budget or timeout is invalid')
  }
  const passes = await runPasses(context, options)
  assertTarget(root, base, head)
  const target = { repository, baseSha: base, headSha: head }
  const pluginFingerprint = expected?.pluginFingerprint || null
  const assembled = assemblePasses(passes, context, target, pluginFingerprint)
  const cluster = await runCluster(assembled.input.candidates, {
    root, env, codexExecutable: env.CODEX || 'codex', passTimeoutMs: options.passTimeoutMs,
  })
  const { input, ledger } = applyGroups(assembled, cluster.groups)
  normalizeInput(input)
  const passReceipt = { schemaVersion: 1, target, model: options.model,
    passes, cluster, createdAt: new Date().toISOString() }
  validatePassReceipt(passReceipt, { target, model: options.model })
  writeExclusive(passReceiptFile, passReceipt)
  writeExclusive(inputFile, input)
  writeExclusive(ledgerFile, ledger)
  const judgeArgs = [path.join(PLUGIN_ROOT, 'bin', 'review-and-fix-pr-codex.js'),
    '--root', root, '--base', base, '--head', head, '--input', inputFile, '--receipt', receiptFile]
  const judged = await runProcess(process.execPath, judgeArgs, {
    cwd: root, env, timeoutMs: 40 * 60_000,
  })
  let result
  try { result = JSON.parse(judged.stdout) } catch { throw new Error('Codex helper returned invalid JSON') }
  if (result.ok !== true) throw new Error('Codex helper did not complete')
  const receipt = validateReceipt(JSON.parse(fs.readFileSync(receiptFile, 'utf8')), {
    target, pluginFingerprint, inputSha256: sha256(normalizeInput(input)),
  })
  if (JSON.stringify(canonical(result.markerBinding)) !== JSON.stringify(canonical(receiptSummary(receipt)))) {
    throw new Error('Codex marker binding differs from runner-owned receipt')
  }
  assertTarget(root, base, head)
  const report = formatReport(receipt, passReceipt)
  process.stdout.write(report)
  return { report, passes, receipt }
}

module.exports = { PASS_EFFORT, assertTarget, childEnvironment, main, parseArgs, runCluster, runPass, runPasses, runProcess }
if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1 })
}
