#!/usr/bin/env node
'use strict'
// review-and-fix-pr chunker. Deterministic: same inputs -> byte-identical manifest.
// Usage:
//   node review-and-fix-pr-chunker.js --root <repo> --base <sha> --head <sha> --classify <classify.json>
//                   --ledger <reviewed.json> --out <dir> --isolation './../'
//                   --caps '{"code":20000,...}' --stages code,test,cicd,other [--ignore-ledger]
// Emits the manifest as JSON on stdout.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function argv(name, dflt) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1) return dflt
  const v = process.argv[i + 1]
  return (v === undefined || v.startsWith('--')) ? true : v
}

const ROOT = argv('root', process.cwd())
const BASE = argv('base')
const HEAD = argv('head')
const CLASSIFY = argv('classify')
const LEDGER = argv('ledger')
const OUT = argv('out')
const ISO = String(argv('isolation', './../'))
const CAPS = JSON.parse(argv('caps', '{"code":20000,"test":20000,"cicd":20000,"other":20000}'))
const STAGES = String(argv('stages', 'code,test,cicd,other')).split(',')
const IGNORE_LEDGER = argv('ignore-ledger', false) === true

// --lock-key answers "which lock does this path resolve to under this expression?" and exits. It is
// the only way to see the isolation rule without running a whole chunking pass, and it is what the
// test suite table-tests: this function decides which files may share a chunk, so it is worth being
// able to interrogate directly.
//
//   node review-and-fix-pr-chunker.js --lock-key --isolation './../' --path tests/testinfra/ccm.cpp
const LOCK_KEY_PROBE = argv('lock-key', false) === true

if (!LOCK_KEY_PROBE && (!BASE || !HEAD || !OUT)) { console.error('chunker: --base, --head and --out are required'); process.exit(2) }
for (const [stage, cap] of Object.entries(CAPS)) {
  if (!Number.isSafeInteger(cap) || cap <= 0) { console.error('chunker: cap for ' + stage + ' must be a positive integer'); process.exit(2) }
}
if (!STAGES.length || STAGES.some(s => !/^[a-z][a-z0-9-]*$/.test(s))) { console.error('chunker: --stages must be comma-separated slugs'); process.exit(2) }

const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 1 << 30 })

// ---------------------------------------------------------------- isolation --
// "."        -> {up:0}    the file itself
// "./../"    -> {up:1}    the directory holding the file
// "./../../" -> {up:2}    one above that
// "*/"       -> {down:1}  its top-level directory
// "*/*/"     -> {down:2}  its second-level directory
//
// There is deliberately NO "none". The lock key is a pure function of the path, which is what
// guarantees that two chunks containing the same file always collide and can never be worked on
// concurrently. "none" bucketed every file under one key and the scheduler then waived exclusion
// entirely, so two chunks holding hunks of the SAME file could run in one wave - two agents editing
// one file. "." is already the loosest safe setting: per-file locking, maximum parallelism.
function parseIsolation(expr) {
  const e = String(expr).trim()
  if (e === '.') return { up: 0 }
  if (/^\.(\/\.\.)+\/?$/.test(e)) return { up: (e.match(/\/\.\./g) || []).length }
  if (/^(\*\/)+$/.test(e)) return { down: (e.match(/\*\//g) || []).length }
  throw new Error(`chunker: unrecognised isolation expression ${JSON.stringify(expr)}; ` +
                  `expected "." , "./../" (xN) or "*/" (xN)`)
}

function lockKey(p, expr) {
  const dirs = p.split('/').slice(0, -1)              // never include the filename
  if (expr.up !== undefined) {
    if (expr.up === 0) return p
    return dirs.slice(0, Math.max(0, dirs.length - (expr.up - 1))).join('/') || '.'
  }
  return dirs.slice(0, Math.min(expr.down, dirs.length)).join('/') || '.'
}

if (LOCK_KEY_PROBE) {
  const probe = argv('path', '')
  if (!probe || probe === true) { console.error('chunker: --lock-key needs --path <file>'); process.exit(2) }
  try { process.stdout.write(lockKey(String(probe), parseIsolation(ISO)) + '\n') }
  catch (e) { console.error(String(e.message || e)); process.exit(2) }
  process.exit(0)
}

// ----------------------------------------------------------------- classify --
let classify
if (CLASSIFY && fs.existsSync(CLASSIFY)) {
  let rules
  try { rules = JSON.parse(fs.readFileSync(path.resolve(CLASSIFY), 'utf8')) } catch (e) {
    console.error('chunker: classifier must be valid JSON: ' + String(e.message || e)); process.exit(2)
  }
  const compile = (name) => {
    if (!Array.isArray(rules[name]) || rules[name].some(x => typeof x !== 'string')) throw new Error('classifier field ' + name + ' must be an array of regex strings')
    return rules[name].map(x => new RegExp(x))
  }
  let excluded, test, cicd, other
  try { excluded = compile('exclude'); test = compile('test'); cicd = compile('cicd'); other = compile('other') } catch (e) {
    console.error('chunker: ' + e.message); process.exit(2)
  }
  classify = (p) => {
    if (excluded.some(re => re.test(p))) return { reviewable: false, category: 'other', reason: 'classifier exclusion' }
    if (test.some(re => re.test(p))) return { reviewable: true, category: 'test', reason: 'classifier test rule' }
    if (cicd.some(re => re.test(p))) return { reviewable: true, category: 'cicd', reason: 'classifier cicd rule' }
    if (other.some(re => re.test(p))) return { reviewable: true, category: 'other', reason: 'classifier other rule' }
    return { reviewable: true, category: 'code', reason: 'classifier default' }
  }
} else {
  // Conservative fallback, only used when no per-repo rule has been generated yet.
  classify = (p, _status) => {
    if (p.startsWith('.github/')) return { reviewable: true, category: 'cicd', reason: 'fallback: .github' }
    if (/(^|\/)tests?\//.test(p) || /_test\.|test_/.test(p)) return { reviewable: true, category: 'test', reason: 'fallback: test path' }
    if (/\.(md|txt|rst|ya?ml|json|toml|ini|cfg)$/.test(p)) return { reviewable: true, category: 'other', reason: 'fallback: docs/config' }
    return { reviewable: true, category: 'code', reason: 'fallback: default' }
  }
}

// ------------------------------------------------------------------- ledger --
let ledger = {}
if (!IGNORE_LEDGER && LEDGER && fs.existsSync(LEDGER)) {
  try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) || {} } catch { ledger = {} }
}

// --------------------------------------------------------------------- diff --
const sha = s => crypto.createHash('sha256').update(s).digest('hex')

function fileDiff(file) {
  return git('diff', `${BASE}...${HEAD}`, '--', file)
}

// Split a single file's diff into {header, hunks[]}. The header is everything before
// the first "@@ " line (diff --git / index / --- / +++ / new file mode / similarity...).
function splitHunks(text) {
  const marks = []
  const re = /^@@ /gm
  let m
  while ((m = re.exec(text)) !== null) marks.push(m.index)
  if (!marks.length) return { header: text, hunks: [] }
  const header = text.slice(0, marks[0])
  const hunks = marks.map((start, i) => text.slice(start, i + 1 < marks.length ? marks[i + 1] : text.length))
  return { header, hunks }
}

const isoExpr = parseIsolation(ISO)
const nameStatus = git('diff', '--name-status', '-z', `${BASE}...${HEAD}`).split('\0').filter(Boolean)

const skipped = { notReviewable: [], inLedger: 0, inLedgerBytes: 0, cleanFiles: [] }
const totalHunksPerFile = new Map()
const groups = new Map()   // "stage\u0000lockKey" -> {stage, lockKey, files: Map(file -> {header, hunks:[{body,hash,bytes}]})}

for (let i = 0; i < nameStatus.length; i++) {
  const status = nameStatus[i]
  const renamed = /^[RC]/.test(status)
  if (i + 1 >= nameStatus.length) { skipped.notReviewable.push({ file: '(unknown)', reason: 'malformed git --name-status output' }); break }
  const source = nameStatus[++i]
  const file = renamed && i + 1 < nameStatus.length ? nameStatus[++i] : source
  const verdict = classify(file, status) || {}
  if (!verdict.reviewable) { skipped.notReviewable.push({ file, reason: verdict.reason || 'classifier said no' }); continue }
  const stage = verdict.category || 'other'
  if (!STAGES.includes(stage)) { skipped.notReviewable.push({ file, reason: `stage "${stage}" not in --stages` }); continue }

  const fileText = fileDiff(file)
  const { header, hunks } = splitHunks(fileText)
  // No "@@" at all: a pure rename, a mode change, or a binary file. There is nothing to read, but
  // it must not vanish silently - "nothing disappears without saying so" is the whole point of the
  // notReviewable list, and a file dropped here used to appear in no count and no section.
  if (!hunks.length) {
    skipped.notReviewable.push({ file, reason: 'no diff hunks (rename, mode change or binary)' })
    continue
  }

  // A file an agent recorded clean IN FULL is skipped outright. The key is the sha of this exact
  // diff, so any edit to the file brings it straight back for review.
  const fileSha = sha(fileText)
  if (ledger[fileSha] && ledger[fileSha].kind === 'file') {
    skipped.cleanFiles.push(file)
    skipped.inLedger += hunks.length
    skipped.inLedgerBytes += Buffer.byteLength(fileText)
    continue
  }

  const kept = []
  for (const body of hunks) {
    const h = sha(body)
    if (ledger[h]) { skipped.inLedger++; skipped.inLedgerBytes += Buffer.byteLength(body); continue }
    kept.push({ body, hash: h, bytes: Buffer.byteLength(body) })
  }
  if (!kept.length) continue

  const key = lockKey(file, isoExpr)
  const gk = stage + '\u0000' + key
  if (!groups.has(gk)) groups.set(gk, { stage, lockKey: key, files: new Map() })
  groups.get(gk).files.set(file, { header, hunks: kept })
  totalHunksPerFile.set(file, kept.length)
}

// ---------------------------------------------------------------- packing ----
// Within a (stage, lockKey) group: walk files in sorted order, hunks in file order,
// and start a new chunk whenever adding the next hunk would exceed the stage cap.
// A hunk that alone exceeds the cap gets its own chunk, intact.
fs.mkdirSync(OUT, { recursive: true })

const orderedGroups = [...groups.values()].sort((a, b) =>
  (STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage)) || (a.lockKey < b.lockKey ? -1 : a.lockKey > b.lockKey ? 1 : 0))

const manifest = []
let seq = 0

for (const g of orderedGroups) {
  const cap = CAPS[g.stage] || 20000
  let cur = []            // [{file, header, hunk}]
  let curBytes = 0

  const flush = () => {
    if (!cur.length) return
    const id = String(seq++).padStart(4, '0')
    const byFile = new Map()
    for (const e of cur) {
      if (!byFile.has(e.file)) byFile.set(e.file, { header: e.header, hunks: [] })
      byFile.get(e.file).hunks.push(e.hunk)
    }
    let text = ''
    for (const v of byFile.values()) text += v.header + v.hunks.map(h => h.body).join('')
    fs.writeFileSync(path.join(OUT, `${id}.diff`), text)
    // Hashes go to a sidecar file, never to stdout - a language model should never retype 64 hex
    // characters per hunk. Nothing reads this file today: marking became file-level, so reviewed.js
    // keys on a file's whole diff and hunk hashes are only still READ here, to honour hunk-level
    // ledger entries written by older runs. It is kept because it is free and it is what you want
    // when a skip looks wrong.
    fs.writeFileSync(path.join(OUT, `${id}.hashes`),
                     cur.map(e => e.hunk.hash + '\t' + e.file).join('\n') + '\n')
    manifest.push({
      id,
      stage: g.stage,
      lockKey: g.lockKey,
      files: [...byFile.keys()],
      // Files whose EVERY remaining hunk is in this chunk. Only these can honestly be called clean by
      // the agent that reviewed this chunk; a file split across chunks needs all of them to agree.
      wholeFiles: [...byFile.entries()].filter(([f, v]) => v.hunks.length === totalHunksPerFile.get(f)).map(([f]) => f),
      path: path.join(OUT, `${id}.diff`),
      hashFile: path.join(OUT, `${id}.hashes`),
      bytes: curBytes,
      hunkCount: cur.length,
    })
    cur = []; curBytes = 0
  }

  for (const file of [...g.files.keys()].sort()) {
    const { header, hunks } = g.files.get(file)
    for (const hunk of hunks) {
      const headerBytes = cur.some(e => e.file === file) ? 0 : Buffer.byteLength(header)
      if (cur.length && curBytes + headerBytes + hunk.bytes > cap) flush()
      cur.push({ file, header, hunk })
      curBytes += (cur.filter(e => e.file === file).length === 1 ? Buffer.byteLength(header) : 0) + hunk.bytes
    }
  }
  flush()
}

process.stdout.write(JSON.stringify({
  base: BASE, head: HEAD, isolation: ISO, caps: CAPS,
  chunks: manifest,
  skipped: { notReviewable: skipped.notReviewable, hunksInLedger: skipped.inLedger, bytesInLedger: skipped.inLedgerBytes },
  totals: {
    chunks: manifest.length,
    hunks: manifest.reduce((n, c) => n + c.hunkCount, 0),
    bytes: manifest.reduce((n, c) => n + c.bytes, 0),
    cleanFilesSkipped: skipped.cleanFiles.length,
    spanningChunks: manifest.filter(c => c.files.length > 1).length,
    overCap: manifest.filter(c => c.bytes > (CAPS[c.stage] || 20000)).length,
  },
}, null, 2))
