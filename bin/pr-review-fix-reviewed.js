#!/usr/bin/env node
'use strict'
// pr-review-fix reviewed-ledger tool. This is the ONLY way a file is recorded as clean.
//
//   mark:    node pr-review-fix-reviewed.js --mark --root R --base <mergeBaseSha> --ledger L \
//                             --pr N --run <runId> --stage <stage> --file <path> [--file ...]
//   revoke:  node pr-review-fix-reviewed.js --revoke --ledger L --run <runId> --stage <stage>
//   check:   node pr-review-fix-reviewed.js --check --root R --base <mergeBaseSha> --ledger L --file <path>
//
// The key is sha256 of the file's CURRENT diff against the merge base, taken from the WORKING TREE -
// so a file marked after a fix records the fixed content, not the content that had the bug. A later
// run recomputes the same sha and skips the file only while it is byte-identical.
//
// Deliberately a script, not an instruction: the agent decides WHETHER a file is clean, and this
// decides WHAT that means on disk. No sha256 is ever typed by a language model.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const argv = process.argv
const has = f => argv.includes('--' + f)
const one = (f, d) => { const i = argv.indexOf('--' + f); return i === -1 ? d : (argv[i + 1] || d) }
const all = f => argv.reduce((o, a, i) => (a === '--' + f && argv[i + 1] && !argv[i + 1].startsWith('--') ? o.concat(argv[i + 1]) : o), [])

const LEDGER = one('ledger')
const ROOT = one('root', process.cwd())
const BASE = one('base')
const RUN = one('run', '')
const STAGE = one('stage', '')
const PR = Number(one('pr', '0')) || 0
const FILES = all('file')

if (!LEDGER) { console.error('reviewed: --ledger is required'); process.exit(2) }

function load() {
  if (!fs.existsSync(LEDGER)) return {}
  try {
    const p = JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
    return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {}
  } catch { return {} }
}
function save(obj) {
  const tmp = LEDGER + '.tmp-' + process.pid
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1))
  fs.renameSync(tmp, LEDGER)
}
// Two-dot diff against the merge base compares it to the WORKING TREE, which is what we want while
// a stage's fixes are still uncommitted. With a clean tree it is byte-identical to `base...head`,
// which is what the chunker computes on the next run.
function diffSha(file) {
  const d = execFileSync('git', ['-C', ROOT, 'diff', BASE, '--', file], { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (!d) return null
  return { sha: crypto.createHash('sha256').update(d).digest('hex'), bytes: Buffer.byteLength(d) }
}

if (has('revoke')) {
  const led = load()
  let removed = 0
  for (const [k, v] of Object.entries(led)) {
    if (v && v.run === RUN && (!STAGE || v.stage === STAGE)) { delete led[k]; removed++ }
  }
  save(led)
  process.stdout.write(JSON.stringify({ ok: true, revoked: removed, total: Object.keys(led).length }, null, 1))
  process.exit(0)
}

if (has('check')) {
  const led = load()
  const out = {}
  for (const f of FILES) {
    const d = diffSha(f)
    out[f] = d ? !!led[d.sha] : false
  }
  process.stdout.write(JSON.stringify({ ok: true, reviewed: out }, null, 1))
  process.exit(0)
}

// --- mark ---
if (!BASE) { console.error('reviewed: --base is required to mark'); process.exit(2) }
if (!FILES.length) { console.error('reviewed: at least one --file is required'); process.exit(2) }

const led = load()
const before = Object.keys(led).length
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const marked = [], skipped = []

for (const f of FILES) {
  let d
  try { d = diffSha(f) } catch (e) { skipped.push({ file: f, reason: 'git diff failed: ' + String(e.message || e).slice(0, 120) }); continue }
  if (!d) { skipped.push({ file: f, reason: 'this file has no diff against the merge base - nothing to record' }); continue }
  if (led[d.sha]) { skipped.push({ file: f, reason: 'already recorded' }); continue }
  led[d.sha] = { file: f, kind: 'file', bytes: d.bytes, reviewedAt: now, pr: PR, run: RUN, stage: STAGE }
  marked.push({ file: f, sha: d.sha })
}
save(led)

process.stdout.write(JSON.stringify({
  ok: true, marked: marked.length, skipped, files: marked.map(m => m.file),
  before, total: Object.keys(led).length,
}, null, 1))
