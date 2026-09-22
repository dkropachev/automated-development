'use strict'
// What a run actually cost. The number that matters is the one Claude Code itself bills: each
// session writes a `cost-state` record with per-model token totals, and that is what is summed
// here - across every session filed under the run's working directory, because a review that
// delegates to a workflow spends most of its tokens in sessions the top-level result never
// mentions. Every run gets a working directory nobody else uses, and Claude Code files transcripts
// per working directory, so the directory IS the run.
//
// Raw assistant-message usage is summed too, but only as a secondary figure: a retried request
// appears once per attempt there, so it runs ahead of the billed total.
//
// `opts.since` narrows the sum to sessions that STARTED at or after an epoch-ms instant. A pair
// that was cut off by the account's usage limit and retried has several attempts filed under the
// same directory, and only the last one produced the report being scored: `since` is how the cost
// of the attempt that finished is told apart from the cost of the attempts that were killed.
const fs = require('node:fs')
const path = require('node:path')

const projectsRoot = () => path.join(process.env.HOME || '.', '.claude', 'projects')
const slugFor = (cwd) => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-')

function readLines(file) {
  const out = []
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* a transcript can end mid-write */ }
  }
  return out
}

function walkSubagents(dir, acc) {
  if (!fs.existsSync(dir)) return
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) { walkSubagents(p, acc); continue }
    if (!ent.name.endsWith('.jsonl')) continue
    acc.subagentTranscripts += 1
    for (const ev of readLines(p)) {
      const m = ev.message
      if (ev.type !== 'assistant' || !m || !m.usage) continue
      acc.rawMessages += 1
      acc.rawOutput += m.usage.output_tokens || 0
      acc.rawCacheRead += m.usage.cache_read_input_tokens || 0
    }
  }
}

function totalsForCwd(cwd, opts) {
  const since = (opts && opts.since) || 0
  const dir = path.join(projectsRoot(), slugFor(cwd))
  const acc = {
    input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0,
    sessions: 0, models: {}, bySession: {}, rawMessages: 0, rawOutput: 0, rawCacheRead: 0,
    since,
    subagentTranscripts: 0, transcriptDir: dir,
  }
  const finish = () => { acc.total = acc.input + acc.output + acc.cacheRead + acc.cacheCreation; return acc }
  if (!fs.existsSync(dir)) return finish()
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    const evs = readLines(path.join(dir, f))
    // cost-state is cumulative for its session; the last one written is the session's total.
    let last = null
    for (const ev of evs) if (ev.type === 'cost-state') last = ev
    if (last && since && !(last.startTime >= since)) last = null
    if (last) {
      acc.sessions += 1
      acc.costUsd += last.totalCostUSD || 0
      // Kept per session so a run that polls a background workflow can be split into the polling
      // conversation and the sessions that did the reviewing.
      acc.bySession[f.replace(/\.jsonl$/, '')] = {
        costUsd: last.totalCostUSD || 0,
        startTime: last.startTime || 0,
        tokens: Object.values(last.modelUsage || {}).reduce((n, u) => n +
          (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0), 0),
      }
      for (const [model, u] of Object.entries(last.modelUsage || {})) {
        acc.input += u.inputTokens || 0
        acc.output += u.outputTokens || 0
        acc.thinking += u.thinkingTokens || 0
        acc.cacheRead += u.cacheReadInputTokens || 0
        acc.cacheCreation += u.cacheCreationInputTokens || 0
        acc.models[model] = (acc.models[model] || 0) + (u.costUSD || 0)
      }
    }
    for (const ev of evs) {
      const m = ev.message
      if (ev.type !== 'assistant' || !m || !m.usage) continue
      acc.rawMessages += 1
      acc.rawOutput += m.usage.output_tokens || 0
      acc.rawCacheRead += m.usage.cache_read_input_tokens || 0
    }
    walkSubagents(path.join(dir, f.replace(/\.jsonl$/, ''), 'subagents'), acc)
  }
  return finish()
}

module.exports = { totalsForCwd, slugFor }
