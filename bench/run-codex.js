#!/usr/bin/env node
'use strict'

// Run the repository's current Codex skill on every prepared target. Review processes see only
// their isolated target and the frozen skill; benchmark findings and gold never enter prompts.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const { isDeepStrictEqual } = require('node:util')
const artifacts = require('./lib/artifacts')
const { snapshotSkill, sha256, transcriptUsage, validateReviewer, validateCodexResult } = require('./lib/codex-review')
const { rateCard, estimateApiCost } = require('./lib/codex-pricing')
const ROOT = __dirname
const TOOL = 'code-review-ad'
const MODEL = 'gpt-6.1-sol'
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const command = (exe, args, cwd) => execFileSync(exe, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
const git = (cwd, ...args) => command('git', args, cwd)

function parseArgs(args) {
  const options = { runId: null, only: null, concurrency: 1, prepareOnly: false, timeoutMs: 90 * 60_000 }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--prepare-only') options.prepareOnly = true
    else if (['--run', '--only', '--concurrency', '--timeout'].includes(flag)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
      if (flag === '--run') options.runId = artifacts.assertSafeId(value, 'run id')
      if (flag === '--only') options.only = artifacts.assertSafeId(value, 'target')
      if (flag === '--concurrency') options.concurrency = Number(value)
      if (flag === '--timeout') options.timeoutMs = Number(value) * 60_000
    } else throw new Error(`unknown argument: ${flag}`)
  }
  if (!options.runId || options.runId === 'legacy') throw new Error('--run must name a new cohort')
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 3 || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('invalid Codex concurrency or timeout')
  return options
}

function executable() {
  const configured = process.env.CODEX || 'codex'
  const found = configured.includes('/') ? configured : command('which', [configured])
  return fs.realpathSync(found)
}

function reviewPrompt(skill, metadata) {
  return `Use code-review-ad at ${skill}/SKILL.md to review this pull request. Follow the supplied skill exactly, including its three independent native Codex agents and reviewer reasoning settings. Use gpt-6.1-sol for the parent and reviewers. The parent runs at high effort; the skill specifies xhigh for reviewers. The checkout is pinned to the head below. Use this supplied frozen PR metadata in place of gh pr view for this offline benchmark. Do not fetch reviews, comments, or external web content. Read source, repository guidance, and Git history in this checkout. Review only: do not edit files, commit, post, or run model subprocesses. Never read benchmark results, reports, judgements, other review sessions, or anything under ${path.dirname(ROOT)}. Use only the supplied skill snapshot, not an installed skill. Return the skill's final report.\n\nFrozen PR metadata:\n${JSON.stringify(metadata, null, 2)}\n`
}

function prepare(root, options) {
  const state = json(path.join(root, 'state.json'))
  const targetIds = Object.keys(state.targets).sort()
  for (const id of targetIds) {
    artifacts.assertSafeId(id, 'target')
    if (state.targets[id].id !== id) throw new Error('state target identity mismatch')
  }
  if (options.only && !targetIds.includes(options.only)) throw new Error(`unknown target: ${options.only}`)
  const skill = path.join(root, '..', '.agents', 'skills', TOOL)
  const binary = executable()
  const codexReviewer = validateReviewer({
    version: command(binary, ['--version']), executableSha256: sha256(fs.readFileSync(binary)),
    reasoningEffort: 'high', reviewerEffort: 'xhigh', roles: ['spec', 'standards', 'toolkit'], skill: snapshotSkill(skill),
  })
  const work = path.join(root, 'work', 'codex-native', options.runId)
  const receiptFile = path.join(work, 'prepared.json')
  // Resuming uses the manifest's frozen rates, including legacy cohorts without estimates.
  codexReviewer.apiPricing = fs.existsSync(receiptFile)
    ? artifacts.readManifest(root, options.runId).codexReviewer.apiPricing : rateCard()
  if (codexReviewer.apiPricing == null) delete codexReviewer.apiPricing
  if (fs.existsSync(receiptFile)) {
    const prepared = json(receiptFile)
    const manifest = artifacts.readManifest(root, options.runId)
    artifacts.validateManifest(manifest, { platform: 'codex', codexReviewer, targetIds })
    for (const target of targetIds) {
      if (!isDeepStrictEqual(snapshotSkill(prepared.targets[target].skill), codexReviewer.skill)) throw new Error('frozen skill changed')
    }
    return { ...prepared, manifest, binary, work }
  }
  if (fs.existsSync(artifacts.cohortPaths(root, options.runId).manifest)) throw new Error('cohort exists without its prepared Codex inputs')
  artifacts.ensureDirectorySafe(work)
  const isolation = fs.mkdtempSync(path.join(os.tmpdir(), `review-bench-${options.runId}-`))
  const prepared = { repositoryCommit: git(path.dirname(root), 'rev-parse', 'HEAD'), isolation, targets: {} }
  const pins = {}
  for (const id of targetIds) {
    const target = state.targets[id]
    const metadata = JSON.parse(command('gh', ['pr', 'view', String(target.forkPr), '--repo', target.fork, '--json', 'title,body,url,baseRefOid,headRefOid,commits']))
    const checkout = path.join(isolation, id)
    command('git', ['clone', '--shared', '--quiet', path.join(root, 'work', id, 'src'), checkout])
    git(checkout, 'checkout', '--quiet', '--detach', metadata.headRefOid)
    if (git(checkout, 'merge-base', metadata.baseRefOid, metadata.headRefOid) !== metadata.baseRefOid || git(checkout, 'status', '--porcelain')) throw new Error(`invalid pinned checkout: ${id}`)
    pins[id] = { baseSha: metadata.baseRefOid, headSha: metadata.headRefOid }
    const visibleSkill = path.join(isolation, `${id}-skill`)
    fs.cpSync(skill, visibleSkill, { recursive: true })
    if (!isDeepStrictEqual(snapshotSkill(visibleSkill), codexReviewer.skill)) throw new Error('skill snapshot copy mismatch')
    const prompt = reviewPrompt(visibleSkill, metadata)
    artifacts.writeJsonExclusive(path.join(work, `${id}-metadata.json`), metadata)
    fs.writeFileSync(path.join(work, `${id}-prompt.txt`), prompt, { flag: 'wx' })
    prepared.targets[id] = { checkout, skill: visibleSkill, promptFile: path.join(work, `${id}-prompt.txt`), promptSha256: sha256(prompt) }
  }
  const source = json(path.join(root, 'tools.json')).tools.find((tool) => tool.id === TOOL)
  const toolConfig = { context: 'Native Codex review of a frozen target using the recorded skill snapshot.', tools: [{
    ...source, platform: 'codex', requiresPluginDir: false, label: TOOL,
    source: 'repository:.agents/skills/code-review-ad', prompt: 'Use the frozen Codex code-review-ad skill and supplied PR metadata.',
    pageUrl: 'https://github.com/dkropachev/automated-development/blob/main/.agents/skills/code-review-ad/SKILL.md',
    install: 'Use .agents/skills/code-review-ad from the repository checkout.', invoke: '$code-review-ad <PR>',
  }] }
  const runnerSha256 = Object.fromEntries(['run-codex.js', 'collect-codex-usage.py', 'lib/codex-review.js', 'lib/codex-pricing.js'].map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]))
  const manifest = artifacts.ensureManifest(root, {
    runId: options.runId, requestedModel: MODEL, modelLabel: 'GPT-6.1 Sol', platform: 'codex', codexReviewer,
    configSha256: sha256(JSON.stringify({ toolConfig, codexReviewer, runnerSha256 })),
    targets: pins, targetMetadata: artifacts.snapshotTargetMetadata(state.targets), groundtruth: artifacts.snapshotGroundtruth(root, targetIds),
    expectedCells: targetIds.map((target) => ({ id: artifacts.cellId(options.runId, target, TOOL), target, tool: TOOL })),
    toolConfig, cohortScope: { tool: TOOL, target: null },
  })
  fs.cpSync(path.join(root, 'collect-codex-usage.py'), path.join(work, 'collect-usage.py'))
  artifacts.writeJsonExclusive(receiptFile, { ...prepared, runnerSha256 })
  return { ...prepared, manifest, binary, work }
}

async function reviewTarget(prepared, targetId, options) {
  const { manifest, work } = prepared
  const out = path.join(ROOT, 'runs', manifest.runId, 'results', targetId, `${TOOL}.json`)
  if (fs.existsSync(out)) {
    artifacts.readResultRecord(out, manifest, targetId, TOOL)
    console.log(`skip ${targetId} (recorded)`)
    return
  }
  const lock = artifacts.acquireLocalLock(out + '.lock')
  if (!lock) throw new Error(`Codex target is already running: ${targetId}`)
  try {
    if (fs.existsSync(out)) {
      artifacts.readResultRecord(out, manifest, targetId, TOOL)
      return
    }
    artifacts.assertCohortOpen(ROOT, manifest.runId)
    const target = prepared.targets[targetId]
    const prompt = fs.readFileSync(target.promptFile, 'utf8')
    if (sha256(prompt) !== target.promptSha256 || !isDeepStrictEqual(snapshotSkill(target.skill), manifest.codexReviewer.skill)) throw new Error('prepared review inputs changed')
    if (git(target.checkout, 'rev-parse', 'HEAD') !== manifest.targets[targetId].headSha || git(target.checkout, 'status', '--porcelain')) throw new Error('review checkout changed')
    const attempt = fs.mkdtempSync(path.join(work, `${targetId}-attempt-`))
    const reportFile = path.join(attempt, 'report.md')
    const args = ['exec', '--ignore-user-config', '--enable', 'multi_agent', '-c', 'agents.max_threads=4', '-c', 'agents.max_depth=1', '-c', 'web_search="disabled"', '-m', MODEL, '-c', 'model_reasoning_effort="high"', '-s', 'read-only', '-C', target.checkout, '--json', '-o', reportFile, '-']
    const started = Date.now()
    artifacts.writeJsonExclusive(path.join(attempt, 'invocation.json'), { executable: prepared.binary, args, promptSha256: target.promptSha256, startedAt: new Date(started).toISOString() })
    const stdout = fs.openSync(path.join(attempt, 'events.jsonl'), 'wx')
    const stderr = fs.openSync(path.join(attempt, 'stderr.log'), 'wx')
    const child = spawn(prepared.binary, args, { cwd: target.checkout, stdio: ['pipe', stdout, stderr] })
    fs.closeSync(stdout)
    fs.closeSync(stderr)
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
    console.log(`reviewing ${targetId}: PID ${child.pid}, ${attempt}`)
    const completed = await new Promise((resolve, reject) => {
      let timedOut = false
      let hardStop = null
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        hardStop = setTimeout(() => child.kill('SIGKILL'), 15_000)
      }, options.timeoutMs)
      const clear = () => { clearTimeout(timer); if (hardStop) clearTimeout(hardStop) }
      child.once('error', (error) => { clear(); reject(error) })
      child.once('close', (code, signal) => { clear(); resolve({ code, signal, timedOut }) })
    })
    artifacts.writeJsonExclusive(path.join(attempt, 'exit.json'), { ...completed, finishedAt: new Date().toISOString() })
    if (completed.code !== 0 || completed.signal || completed.timedOut) throw new Error(`Codex review failed: ${targetId}; see ${attempt}`)
    if (git(target.checkout, 'rev-parse', 'HEAD') !== manifest.targets[targetId].headSha || git(target.checkout, 'status', '--porcelain')) throw new Error('review modified checkout')
    if (!isDeepStrictEqual(snapshotSkill(target.skill), manifest.codexReviewer.skill)) throw new Error('review changed frozen skill files')
    const events = fs.readFileSync(path.join(attempt, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const threadId = events.find((event) => event.type === 'thread.started')?.thread_id
    if (!threadId) throw new Error('Codex root thread receipt is missing')
    const agents = JSON.parse(command('python3', [path.join(work, 'collect-usage.py'), path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'state_5.sqlite'), target.checkout, threadId]))
    const report = fs.readFileSync(reportFile, 'utf8')
    const record = {
      schemaVersion: 2, ...artifacts.manifestMetadata(manifest), target: targetId, tool: TOOL,
      cellId: artifacts.cellId(manifest.runId, targetId, TOOL), ...manifest.targets[targetId],
      label: TOOL, source: manifest.toolConfig.tools[0].source,
      exitCode: completed.code, signal: completed.signal, isError: false, apiErrorStatus: null,
      result: report, prompt, reportedCostUsd: null, transcriptUsage: transcriptUsage(agents),
      ...(manifest.codexReviewer.apiPricing ? { apiCostEstimate: estimateApiCost(agents, manifest.codexReviewer.apiPricing) } : {}),
      codexReview: { schemaVersion: 1, reportSha256: sha256(report), promptSha256: sha256(prompt), agents },
      wallMs: Date.now() - started, finishedAt: new Date().toISOString(),
    }
    validateCodexResult(record, manifest)
    artifacts.validateResultRecord(record, manifest, targetId, TOOL)
    artifacts.writeJsonExclusive(out, record)
    console.log(`recorded ${targetId}: ${record.transcriptUsage.total} tokens; Standard API estimate ${record.apiCostEstimate?.costUsd == null ? 'unavailable' : '$' + record.apiCostEstimate.costUsd.toFixed(4)}`)
  } finally { artifacts.releaseLocalLock(lock) }
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args)
  const prepared = prepare(ROOT, options)
  console.log(`Codex cohort ${options.runId}: ${Object.keys(prepared.targets).length} pinned targets; skill ${prepared.manifest.codexReviewer.skill.contentSha256}`)
  if (options.prepareOnly) return
  const pending = Object.keys(prepared.targets).filter((id) => !options.only || options.only === id)
  const failures = []
  await Promise.all(Array.from({ length: options.concurrency }, async () => {
    while (pending.length) {
      const target = pending.shift()
      try { await reviewTarget(prepared, target, options) } catch (error) { failures.push(error); console.error(error.message) }
    }
  }))
  if (failures.length) throw new Error(`${failures.length} Codex review(s) failed; completed results were retained`)
}

module.exports = { parseArgs, reviewPrompt, prepare }
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1 })
