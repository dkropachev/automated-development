'use strict'
// The review-and-fix-pr helper scripts, exercised against a throwaway git repo this file builds itself.
// One test case rather than many: the repo is constructed step by step and later assertions depend
// on earlier ones having run, so splitting them would only make the ordering implicit.
//
// Ported from a standalone runner; it keeps its own ck() tally and asserts once at the end so a
// failure lists every problem instead of stopping at the first.
const { test } = require('node:test')
const assert = require('node:assert/strict')
'use strict'
// Self-contained regression suite for the review-and-fix-pr helper scripts.
// Builds its own throwaway git repo, so it depends on nothing outside this directory.
//
//   node ~/.claude/review-and-fix-pr/test/selftest.js
//
// Exists because of two real incidents:
//   1. A heredoc collapsed the `\u0000` escape in chunker.js into a RAW NUL byte. Harmless at
//      runtime, but it made the file binary to grep, so patch anchors silently stopped matching
//      and the file looked corrupt when it was not. -> the "no control bytes" check below.
//   2. A round-trip test edited the WORKING TREE and expected the chunker to notice, but the
//      chunker reads committed state (base...head). The test was wrong, not the code, and it
//      nearly sent me after a phantom bug. -> the content-change test below commits.

const { execFileSync, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const BIN = path.join(ROOT, 'bin')
// Everything we own, not just bin/. The first version of this file scanned only bin/ and therefore
// passed while carrying a raw NUL in its own comment - a guard that cannot inspect itself is half a
// guard.
test('review-and-fix-pr helper scripts', { timeout: 120000 }, async () => {
const OWNED = [
  path.join(ROOT, 'workflows', 'review-and-fix-pr.js'),
  path.join(ROOT, 'skills', 'review-and-fix-pr', 'SKILL.md'),
  __filename,
]
let fails = 0
const failures = []
const ck = (name, cond, extra) => {
  if (!cond) { fails++; failures.push(name + (extra ? '   ' + extra : '')) }
}
const sh = (cmd, args, opts) => execFileSync(cmd, args, Object.assign({ encoding: 'utf8', maxBuffer: 1 << 28 }, opts || {}))

// ---------------------------------------------------------------- 1. bytes --
const scripts = fs.readdirSync(BIN).filter(f => f.endsWith('.js')).sort()
ck('found the helper scripts', ['review-and-fix-pr-chunker.js','review-and-fix-pr-driver.js','review-and-fix-pr-meter.js','review-and-fix-pr-repofp.js','review-and-fix-pr-reviewed.js'].every(x => scripts.includes(x)), scripts.join(','))
for (const f of scripts) {
  const buf = fs.readFileSync(path.join(BIN, f))
  // Anything outside tab/LF/CR means a heredoc or an editor mangled an escape sequence.
  const bad = []
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b < 0x09 || (b > 0x0d && b < 0x20)) { bad.push(i); if (bad.length > 3) break }
  }
  ck('  ' + f + ': no raw control bytes', bad.length === 0, 'at offsets ' + bad.join(','))
  let ok = true
  try { sh('node', ['--check', path.join(BIN, f)]) } catch (e) { ok = false }
  ck('  ' + f + ': parses', ok)
}
for (const f of OWNED) {
  if (!fs.existsSync(f)) { ck('  ' + path.basename(f) + ': exists', false); continue }
  const buf = fs.readFileSync(f)
  const bad = []
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b < 0x09 || (b > 0x0d && b < 0x20)) { bad.push(i); if (bad.length > 3) break }
  }
  ck('  ' + path.basename(f) + ': no raw control bytes', bad.length === 0,
     'at offsets ' + bad.join(',') + (bad.length ? '  line ' + (buf.slice(0, bad[0]).toString().split('\n').length) : ''))
}

// ------------------------------------------------------------- 2. test repo --
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prfix-selftest-'))
const R = path.join(TMP, 'repo')
fs.mkdirSync(R)
const git = (...a) => sh('git', ['-C', R, ...a])
git('init', '-q', '-b', 'main')
git('config', 'user.email', 't@t'); git('config', 'user.name', 'T')
const write = (p, c) => { fs.mkdirSync(path.dirname(path.join(R, p)), { recursive: true }); fs.writeFileSync(path.join(R, p), c) }

write('src/a.js', 'function a(){ return 1 }\n')
write('src/b.js', 'function b(){ return 2 }\n')
write('README.md', '# title\n')
git('add', '-A'); git('commit', '-qm', 'base')
const BASE = git('rev-parse', 'HEAD').trim()

write('src/a.js', 'function a(){ return 1 }\nfunction a2(){ return 3 }\n')
write('src/b.js', 'function b(){ return 2 }\nfunction b2(){ return 4 }\n')
write('README.md', '# title\nmore docs\n')
write('tests/a.test.js', 'test("a", () => {})\n')
git('add', '-A'); git('commit', '-qm', 'change')
const HEAD = git('rev-parse', 'HEAD').trim()

const LED = path.join(TMP, 'reviewed.json')
fs.writeFileSync(LED, '{}')
const OUT = path.join(TMP, 'chunks')

function chunk(extra) {
  const out = sh('node', [path.join(BIN, 'review-and-fix-pr-chunker.js'), '--root', R, '--base', BASE,
    '--head', git('rev-parse', 'HEAD').trim(), '--out', OUT, '--ledger', LED,
    '--isolation', './../'].concat(extra || []))
  return JSON.parse(out)
}
const filesIn = m => [...new Set(m.chunks.flatMap(c => c.files))].sort()

// --------------------------------------------------------- 3. chunker basics --
let m = chunk()
ck('chunks the changed files', m.totals.chunks > 0 && filesIn(m).length === 4, filesIn(m).join(','))
ck('deterministic', JSON.stringify(chunk().chunks.map(c => c.id + c.files.join())) ===
                    JSON.stringify(m.chunks.map(c => c.id + c.files.join())))
ck('wholeFiles is a subset of files', m.chunks.every(c => c.wholeFiles.every(f => c.files.includes(f))))
ck('every file in a chunk shares its lockKey',
   m.chunks.every(c => new Set(c.files.map(f => path.dirname(f))).size === 1))
ck('hashes are NOT in the manifest', m.chunks.every(c => !('hunks' in c) && !('hunkHashes' in c)))
ck('a .hashes sidecar exists per chunk with hunkCount lines',
   m.chunks.every(c => fs.readFileSync(c.hashFile, 'utf8').trim().split('\n').length === c.hunkCount))

{
  const rules = path.join(TMP, 'classify.json')
  fs.writeFileSync(rules, JSON.stringify({ exclude: [], test: ['^tests/'], cicd: ['^\\.github/'], other: ['\\.md$'] }))
  const classified = chunk(['--classify', rules])
  ck('declarative classifier routes tests without executing code',
     classified.chunks.some(c => c.stage === 'test' && c.files.includes('tests/a.test.js')))
  const evil = path.join(TMP, 'classify.js'), pwned = path.join(TMP, 'executed')
  fs.writeFileSync(evil, `require('fs').writeFileSync(${JSON.stringify(pwned)}, 'x'); module.exports=()=>({reviewable:true,category:'code'})`)
  let refused = false
  try { chunk(['--classify', evil]) } catch (e) { refused = true }
  ck('executable classifier source is rejected and never run', refused && !fs.existsSync(pwned))
}

// A file git reports as changed but whose diff has no "@@" - a pure rename - must be ACCOUNTED FOR,
// not dropped. It used to appear in no chunk, no skip list and no count, which is the one thing this
// design promises never happens.
{
  git('mv', 'src/b.js', 'src/b_renamed.js')
  git('commit', '-qm', 'pure rename')
  const rm = chunk()
  const named = (rm.skipped.notReviewable || []).map(x => x.file)
  ck('a pure rename is accounted for, not silently dropped',
     named.includes('src/b_renamed.js') || filesIn(rm).includes('src/b_renamed.js'),
     'chunks: ' + filesIn(rm).join(',') + '  skipped: ' + named.join(','))
  ck('  and the reason says why there was nothing to read',
     !named.includes('src/b_renamed.js') ||
       /rename|mode change|binary/.test((rm.skipped.notReviewable.find(x => x.file === 'src/b_renamed.js') || {}).reason || ''),
     JSON.stringify(rm.skipped.notReviewable))
  git('mv', 'src/b_renamed.js', 'src/b.js')
  git('commit', '-qm', 'rename back')
}

{
  git('rm', '-q', 'src/b.js'); git('commit', '-qm', 'delete source')
  const dm = chunk()
  ck('pure deletions remain reviewable', filesIn(dm).includes('src/b.js'), JSON.stringify(dm.skipped.notReviewable))
  git('checkout', 'HEAD^', '--', 'src/b.js'); git('commit', '-qm', 'restore source')
}

// ------------------------------------------------------ 4. reviewed.js cycle --
const mark = (file, stage) => JSON.parse(sh('node', [path.join(BIN, 'review-and-fix-pr-reviewed.js'), '--mark',
  '--root', R, '--base', BASE, '--ledger', LED, '--pr', '1', '--run', 'RUN1', '--stage', stage, '--file', file]))

let r = mark('README.md', 'other')
ck('marks a changed file', r.marked === 1, JSON.stringify(r))
m = chunk()
ck('a marked file is skipped entirely', !filesIn(m).includes('README.md') && m.totals.cleanFilesSkipped === 1, filesIn(m).join(','))

r = JSON.parse(sh('node', [path.join(BIN, 'review-and-fix-pr-reviewed.js'), '--mark', '--root', R, '--base', BASE,
  '--ledger', LED, '--pr', '1', '--run', 'RUN1', '--stage', 'other', '--file', 'src/a.js']))
ck('marking is idempotent-safe for a new file', r.marked === 1)
m = chunk()
ck('both marked files now skipped', !filesIn(m).includes('src/a.js') && m.totals.cleanFilesSkipped === 2, filesIn(m).join(','))

r = JSON.parse(sh('node', [path.join(BIN, 'review-and-fix-pr-reviewed.js'), '--mark', '--root', R, '--base', BASE,
  '--ledger', LED, '--pr', '1', '--run', 'RUN1', '--stage', 'other', '--file', 'src/b.js', '--file', 'src/b.js']))
ck('re-marking the same file adds nothing', r.marked === 1 && r.skipped.length === 1, JSON.stringify(r))

// A file with no diff must be refused, not silently recorded as clean.
r = JSON.parse(sh('node', [path.join(BIN, 'review-and-fix-pr-reviewed.js'), '--mark', '--root', R, '--base', BASE,
  '--ledger', LED, '--pr', '1', '--run', 'RUN1', '--stage', 'other', '--file', 'does/not/exist.js']))
ck('refuses a file with no diff', r.marked === 0 && r.skipped.length === 1, JSON.stringify(r))

// THE CORRECTED TEST: the chunker reads COMMITTED state, so the change has to be committed.
write('README.md', '# title\nmore docs\nand more\n')
git('add', '-A'); git('commit', '-qm', 'touch readme')
m = chunk()
ck('a COMMITTED change brings a marked file back', filesIn(m).includes('README.md'), filesIn(m).join(','))
// and prove the worktree-only case is the thing that does NOT count, so nobody re-learns this
git('reset', '--hard', HEAD, '-q')
fs.appendFileSync(path.join(R, 'README.md'), 'uncommitted\n')
m = chunk()
ck('an UNCOMMITTED edit does not (chunker reads base...head)', !filesIn(m).includes('README.md'), filesIn(m).join(','))
git('checkout', '--', 'README.md')

r = JSON.parse(sh('node', [path.join(BIN, 'review-and-fix-pr-reviewed.js'), '--revoke', '--ledger', LED, '--run', 'RUN1', '--stage', 'other']))
ck('revoke removes exactly that run+stage', r.revoked === 3 && r.total === 0, JSON.stringify(r))
m = chunk()
ck('everything comes back after revoke', filesIn(m).length === 4 && m.totals.cleanFilesSkipped === 0, filesIn(m).join(','))

// ----------------------------------------------------------- 4b. isolation --
// lockKey decides which files may share a chunk, so it gets a table test rather than being
// inferred from a chunking run. The two notations are the same axis from opposite ends:
// `./../` walks UP from the file, `*/` walks DOWN from the repo root, and both clamp at the root.
{
  const key = (expr, file) =>
    sh('node', [path.join(BIN, 'review-and-fix-pr-chunker.js'), '--lock-key', '--isolation', expr, '--path', file]).trim()
  const DEEP = 'tests/testinfra/ccm_provisioner.cpp'      // depth 2
  const table = [
    ['.',            DEEP, DEEP],
    ['./../',        DEEP, 'tests/testinfra'],
    ['./../../',     DEEP, 'tests'],
    ['./../../../',  DEEP, '.'],                          // clamps at the root, does not error
    ['*/',           DEEP, 'tests'],
    ['*/*/',         DEEP, 'tests/testinfra'],
    ['*/*/*/',       DEEP, 'tests/testinfra'],            // clamps at the file's own depth
    ['.',            'Makefile', 'Makefile'],
    ['./../',        'Makefile', '.'],                    // a root-level file locks the root
    ['*/',           'Makefile', '.'],
  ]
  for (const [expr, file, want] of table) {
    const got = key(expr, file)
    ck('lockKey("' + file + '", "' + expr + '") = ' + want, got === want, 'got ' + got)
  }
  // The identity that makes the two notations one axis: for a file at depth d,
  // `./../` x k and `*/` x (d-k) name the same directory.
  let identity = true
  for (let k = 1; k <= 3; k++) {
    const up = '.' + '/..'.repeat(k) + '/'
    const down = '*/'.repeat(Math.max(0, 3 - k))
    if (down && key(up, DEEP) !== key(down, DEEP)) identity = false
  }
  ck('./../ xk and */ x(d-k) name the same lock', identity)
  let threw = false
  try { key('~/nonsense', DEEP) } catch (e) { threw = true }
  ck('an unrecognised expression is refused, not guessed at', threw)
}

// -------------------------------------------------------------- 5. driver --
// The driver keeps state under $HOME/.claude/review-and-fix-pr/state, so every invocation here runs
// with HOME pointed at the throwaway dir. The suite must never touch the real state directory.
{
  const D = path.join(BIN, 'review-and-fix-pr-driver.js')
  const HOME = path.join(TMP, 'driver-home')
  fs.mkdirSync(HOME, { recursive: true })
  const env = Object.assign({}, process.env, { HOME })
  const drive = (step, batch, extra) =>
    sh('node', [D, step, '--batch', batch].concat(extra || []), { env })
  // Only lines that ARE commands - an indented git/rm - not prose that merely mentions one.
  // The first version of these assertions matched the driver's own "Do not `git reset --hard`"
  // warning and failed on text that was doing exactly the right thing.
  const cmdLines = out => out.split('\n').filter(l => /^\s+(git|rm|cat|node)\b/.test(l)).join('\n')
  const parent = git('rev-parse', 'HEAD').trim()

  // ---- fix machine: start -> fixed -> validated -> committed ----
  drive('start', 'fx1', ['--root', R, '--parent', parent, '--mode', 'fix'])
  let out = drive('fixed', 'fx1', ['--followups', '0'])
  ck('fix: no edits at all ends the batch, nothing to commit',
     /FINAL STATE: no-changes/.test(out), out.slice(-120))

  const fixStart = drive('start', 'fx2', ['--root', R, '--parent', parent, '--mode', 'fix'])
  ck('fix: the driver names the tree it measures, so edits in a review scratch clone cannot be mistaken for fixes',
     fixStart.includes('You are fixing ' + R) && /scratch clone/.test(fixStart), fixStart.slice(0, 400))
  fs.appendFileSync(path.join(R, 'src/a.js'), '// fix\n')
  out = drive('fixed', 'fx2', ['--followups', '2'])
  ck('fix: a non-zero follow-up count loops on the same verb',
     /DO THE FOLLOW-UPS/.test(out) && /fixed --batch fx2 --followups/.test(out), out.slice(0, 160))
  out = drive('fixed', 'fx2', ['--followups', '0'])
  ck('fix: zero follow-ups moves on to validation', /VALIDATE/.test(out), out.slice(0, 120))
  ck('fix: validation is told what actually changed on disk, measured not claimed',
     /src\/a\.js/.test(out), out.slice(0, 300))

  out = drive('validated', 'fx2', ['--passed', 'no'])
  ck('fix: a red build never reaches a commit step', !/COMMIT/.test(out) && /REPAIR/.test(out))
  ck('fix: repair never asks the agent to undo anything',
     !/checkout --|reset --hard|\brm -f\b/.test(cmdLines(out)), cmdLines(out))
  // The repair attempt re-validates; it does not re-enter `fixed`. There is only one repair.
  out = drive('validated', 'fx2', ['--passed', 'no'])
  ck('fix: a second failure simply does not commit',
     /FINAL STATE: not-committed/.test(out) && /DO NOT COMMIT/.test(out), out.slice(-200))
  ck('fix: there is no revert API anywhere in the failure path',
     !/checkout --|reset --hard/.test(cmdLines(out)), cmdLines(out))
  git('checkout', '--', 'src/a.js')

  // --passed is validated on a LIVE batch: a finished one short-circuits before the parse, so
  // asserting this on fx2 tested nothing at all.
  drive('start', 'fxp', ['--root', R, '--parent', parent, '--mode', 'fix'])
  fs.appendFileSync(path.join(R, 'src/a.js'), '// p\n')
  drive('fixed', 'fxp', ['--followups', '0'])
  let bad = false
  try { drive('validated', 'fxp', ['--passed', 'maybe']) } catch (e) { bad = true }
  ck('fix: --passed refuses anything but yes/no', bad)
  git('checkout', '--', 'src/a.js')

  // green path
  drive('start', 'fx3', ['--root', R, '--parent', parent, '--mode', 'fix'])
  fs.appendFileSync(path.join(R, 'src/a.js'), '// ok\n')
  drive('fixed', 'fx3', ['--followups', '0'])
  fs.writeFileSync(path.join(R, 'build.tmp'), 'validation artifact\n')
  out = drive('validated', 'fx3', ['--passed', 'yes'])
  ck('fix: a green build offers COMMIT with an explicit add list',
     /COMMIT/.test(out) && /src\/a\.js/.test(out), out.slice(0, 200))
  ck('fix: an untracked validation artifact is explicitly excluded from staging',
     /Do NOT stage[\s\S]*build\.tmp/.test(out), out.slice(0, 500))
  ck('fix: the commit is gated on the parent sha', out.includes(parent))
  ck('fix: the add list is explicit, never -A/./-u', !/add (-A|\.|-u)\b/.test(cmdLines(out)))
  let threw = false
  try { drive('committed', 'fx3') } catch (e) { threw = true }
  ck('fix: refuses to finish while HEAD has not moved', threw)
  git('add', '--', 'src/a.js'); git('commit', '-qm', 'batch fx3')
  out = drive('committed', 'fx3')
  ck('fix: confirms the commit once HEAD has moved', /FINAL STATE: committed/.test(out))
  fs.unlinkSync(path.join(R, 'build.tmp'))
  git('reset', '--hard', parent, '-q')

  // ---- review machine: start -> found* -> checked -> marked ----
  const chunkPath = path.join(TMP, 'rv.diff')
  fs.writeFileSync(chunkPath, 'diff --git a/src/a.js b/src/a.js\n')
  const rvStart = ['--root', R, '--mode', 'review', '--chunk', chunkPath,
                   '--whole-files', 'src/a.js,src/b.js', '--base', BASE,
                   '--ledger', path.join(TMP, 'rv-ledger.json'), '--pr', '7']
  const reviewArgs = (batch, extra) => rvStart.concat(extra || [], ['--scratch', path.join(TMP, batch + '-scratch')])
  drive('start', 'rv1', reviewArgs('rv1'))
  out = drive('found', 'rv1', ['--new', '2'])
  ck('review: finding something means look again', /LOOK AGAIN/.test(out), out.slice(0, 120))
  out = drive('found', 'rv1', ['--new', '0'])
  ck('review: ONE empty pass is not enough to stop', /LOOK AGAIN/.test(out), out.slice(0, 120))
  ck('review: the agent is never told how many zeros it is on',
     !/\b(zero|consecutive|1 of 2|one more)\b/i.test(out), out.slice(0, 400))
  out = drive('found', 'rv1', ['--new', '0'])
  ck('review: two empty passes in a row start the double-check', /DOUBLE-CHECK/.test(out), out.slice(0, 120))
  threw = false
  try { drive('found', 'rv1', ['--new', '0']) } catch (e) { threw = true; out = String(e.stdout || '') }
  ck('review: a wrong verb is refused and the right one is named',
     threw && /checked --batch rv1/.test(out), out.slice(0, 200))

  out = drive('checked', 'rv1', ['--kept', '0', '--clean-files', 'src/a.js,src/zzz.js'])
  ck('review: a file whose other hunks live elsewhere cannot be called clean',
     /src\/zzz\.js/.test(out) && /ignored/i.test(out), out.slice(0, 300))
  ck('review: the rejected file never appears in a printed mark command',
     !/--file src\/zzz\.js/.test(out), cmdLines(out))
  ck('review: the file that IS wholly ours is offered for marking',
     /--file 'src\/a\.js'/.test(out), cmdLines(out))
  sh('node', [path.join(BIN, 'review-and-fix-pr-reviewed.js'), '--mark', '--root', R, '--base', BASE,
    '--ledger', path.join(TMP, 'rv-ledger.json'), '--pr', '7', '--run', 'rv1', '--stage', 'review', '--file', 'src/a.js'])
  out = drive('marked', 'rv1')
  ck('review: marking ends the batch', /FINAL STATE: reviewed/.test(out), out.slice(-120))

  drive('start', 'rv-kept', reviewArgs('rv-kept'))
  drive('found', 'rv-kept', ['--new', '1']); drive('found', 'rv-kept', ['--new', '0']); drive('found', 'rv-kept', ['--new', '0'])
  out = drive('checked', 'rv-kept', ['--kept', '1', '--clean-files', 'src/a.js'])
  ck('review: a batch that kept a finding cannot record any file clean',
     !/--file 'src\/a\.js'/.test(out) && /ignored/i.test(out), out.slice(0, 400))

  drive('start', 'rv-mutated', reviewArgs('rv-mutated'))
  fs.appendFileSync(path.join(R, 'README.md'), 'unexpected reviewer edit\n')
  threw = false; out = ''
  try { drive('found', 'rv-mutated', ['--new', '0']) } catch (e) { threw = true; out = String(e.stdout || '') }
  ck('review: repository mutation trips the read-only guard', threw && /repository changed during a read-only review/.test(out), out.slice(0, 300))
  git('checkout', '--', 'README.md')

  // a review that never goes quiet still terminates
  drive('start', 'rv2', reviewArgs('rv2'))
  let rounds = 0
  for (; rounds < 40; rounds++) {
    out = drive('found', 'rv2', ['--new', '1'])
    if (/DOUBLE-CHECK/.test(out)) break
  }
  ck('review: a never-quiet review is capped rather than looping forever',
     rounds < 40 && /DOUBLE-CHECK/.test(out), 'rounds=' + rounds)

  // ---- detailed review: the clone is idempotent and is cleaned up on exit ----
  {
    const scr = path.join(TMP, 'rv-scratch')
    out = drive('start', 'dt1', reviewArgs('dt1', ['--detailed', '--scratch', scr]))
    ck('detailed: the clone command removes the target first (ids restart on re-chunk; retries must not fail)',
       out.includes("rm -rf -- '" + scr + "' && git clone --no-hardlinks --no-local"), out.slice(0, 900))
    ck('detailed: tells the reviewer to run things, not just read', /RUN THINGS/.test(out))
    drive('found', 'dt1', ['--new', '0']); drive('found', 'dt1', ['--new', '0'])
    out = drive('checked', 'dt1', ['--kept', '0'])
    ck('detailed: the scratch clone is removed at the end', out.includes("rm -rf -- '" + scr + "'") && /FINAL STATE: reviewed/.test(out), out.slice(-300))
  }

  // ---- cross-machine: the verbs of one machine are rejected by the other ----
  drive('start', 'x1', ['--root', R, '--parent', parent, '--mode', 'fix'])
  threw = false; out = ''
  try { drive('found', 'x1', ['--new', '0']) } catch (e) { threw = true; out = String(e.stdout || '') }
  ck('a review verb is refused in a fix batch and the fix verb is named',
     threw && /fixed --batch x1/.test(out), out.slice(0, 200))
  drive('start', 'x2', reviewArgs('x2'))
  threw = false; out = ''
  try { drive('fixed', 'x2', ['--followups', '0']) } catch (e) { threw = true; out = String(e.stdout || '') }
  ck('a fix verb is refused in a review batch and the review verb is named',
     threw && /found --batch x2/.test(out), out.slice(0, 200))

  // ---- guidance: a refused command must say where it is and what to run ----
  drive('start', 'gd1', ['--root', R, '--parent', parent, '--mode', 'fix'])
  threw = false; out = ''
  try { drive('found', 'gd1', ['--new', '0']) } catch (e) { threw = true; out = String(e.stdout || '') }
  ck('a verb from the other machine is named as such', threw && /WRONG MACHINE/.test(out), out.slice(0, 120))
  ck('  it says where the batch actually is', /Where this batch actually is:/.test(out), out.slice(0, 300))
  ck('  it prints the whole sequence, not just the next step',
     /start -> fixed --followups N -> validated/.test(out), out.slice(0, 400))
  try { drive('committed', 'gd1') } catch (e) { out = String(e.stdout || '') }
  ck('a verb of the right machine at the wrong step says so', /NOT THIS STEP/.test(out), out.slice(0, 120))
  ck('  a second miss warns that repeating will not work', /told this 2 times/.test(out), out.slice(-300))
  try { drive('fixed', 'gd1') } catch (e) { out = String(e.stdout || '') }
  ck('the right verb with a missing flag is a miss too, not progress',
     /MISSING COUNT/.test(out) && /told this 3 times/.test(out), out.slice(-300))

  // ---- circuit breaker: repeated misses on one step give up ----
  try { drive('fixed', 'gd1') } catch (e) { out = String(e.stdout || '') }
  ck('a fourth miss on one step trips the breaker',
     /DRIVER ERROR/.test(out) && /FINAL STATE: driver-error/.test(out), out.slice(0, 200))
  ck('  the breaker tells it to stop rather than start over',
     /do NOT run `start` again/.test(out), out.slice(-400))
  out = drive('fixed', 'gd1', ['--followups', '0'])
  ck('  an aborted batch stays aborted', /already finished \(driver-error\)/.test(out), out.slice(0, 160))

  // a batch that keeps missing DIFFERENT steps trips the cumulative breaker instead
  drive('start', 'gd2', ['--root', R, '--parent', parent, '--mode', 'fix'])
  let tripped = 0
  for (let i = 0; i < 12 && !tripped; i++) {
    try {
      out = drive(i % 2 ? 'found' : 'committed', 'gd2', i % 2 ? ['--new', '0'] : [])
    } catch (e) { out = String(e.stdout || '') }
    if (/DRIVER ERROR/.test(out)) tripped = i + 1
  }
  ck('alternating wrong verbs still trip a breaker', tripped > 0 && tripped <= 8, 'after ' + tripped)

  // ---- lost state: never silently restart ----
  out = ''
  try { drive('fixed', 'gone-forever', ['--followups', '0']) } catch (e) { out = String(e.stdout || '') }
  ck('a batch with no state is explained, not just rejected',
     /NO STATE FOR THIS BATCH/.test(out), out.slice(0, 120))
  ck('  it says to check the batch name first', /character for character/.test(out), out.slice(0, 400))
  ck('  and never tells it to run start again', /Do NOT run `start`/.test(out), out.slice(0, 600))
  try { drive('fixed', 'gone-forever', ['--followups', '0']) } catch (e) { out = String(e.stdout || '') }
  ck('  a second call for lost state gives up outright',
     /DRIVER ERROR/.test(out) && /FINAL STATE: driver-error/.test(out), out.slice(0, 200))

  // ---- a review that never goes quiet cannot loop forever either ----
  drive('start', 'gd3', reviewArgs('gd3'))
  let guard = 0
  for (; guard < 60; guard++) {
    try { out = drive('found', 'gd3', ['--new', '1']) } catch (e) { out = String(e.stdout || '') }
    if (/DOUBLE-CHECK|DRIVER ERROR/.test(out)) break
  }
  ck('an endlessly-finding review is stopped by one breaker or the other', guard < 60, 'rounds=' + guard)

  // step order is enforced across the board
  threw = false
  try { drive('committed', 'never-started') } catch (e) { threw = true }
  ck('refuses any step for a batch that never started', threw)
  threw = false
  try { drive('start', 'bad batch name', ['--root', R, '--parent', parent, '--mode', 'fix']) } catch (e) { threw = true }
  ck('refuses a batch name that is not a safe filename', threw)
  drive('start', 'duplicate-state', ['--root', R, '--parent', parent, '--mode', 'fix'])
  threw = false
  try { drive('start', 'duplicate-state', ['--root', R, '--parent', parent, '--mode', 'fix']) } catch (e) { threw = true }
  ck('refuses to overwrite an existing batch state', threw)
  ck('the suite left the real state directory alone',
     fs.existsSync(path.join(HOME, '.claude', 'review-and-fix-pr', 'state', 'fx3.state.json')),
     'state did not land under the throwaway HOME')
}

// -------------------------------------------------------------- 6. repofp --
write('package.json', '{"scripts":{"test":"node --test"}}\n'); git('add', '-A'); git('commit', '-qm', 'manifest')
const fp1 = sh('node', [path.join(BIN, 'review-and-fix-pr-repofp.js'), '--root', R]).trim()
const fp2 = sh('node', [path.join(BIN, 'review-and-fix-pr-repofp.js'), '--root', R]).trim()
ck('deterministic across runs', fp1 === fp2 && /^[0-9a-f]{64}$/.test(fp1), fp1)
write('package.json', '{"scripts":{"test":"node --test","lint":"eslint ."}}\n'); git('add', '-A'); git('commit', '-qm', 'manifest command')
const fp3 = sh('node', [path.join(BIN, 'review-and-fix-pr-repofp.js'), '--root', R]).trim()
ck('changes when a classifier input changes content', fp3 !== fp1)
write('newtop/x.js', 'x\n'); git('add', '-A'); git('commit', '-qm', 'new top dir')
ck('changes when the repo shape changes', sh('node', [path.join(BIN, 'review-and-fix-pr-repofp.js'), '--root', R]).trim() !== fp3)

// Parallel reviewers update one shared ledger. Locking must preserve every mark.
{
  const RR = path.join(TMP, 'race-repo'), LL = path.join(TMP, 'race-ledger.json')
  fs.mkdirSync(RR); const rg = (...a) => sh('git', ['-C', RR, ...a])
  rg('init', '-q', '-b', 'main'); rg('config', 'user.email', 't@t'); rg('config', 'user.name', 'T')
  for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(RR, 'f' + i + '.js'), 'old\n')
  rg('add', '.'); rg('commit', '-qm', 'base'); const rb = rg('rev-parse', 'HEAD').trim()
  for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(RR, 'f' + i + '.js'), 'new ' + i + '\n')
  const children = []
  for (let i = 0; i < 24; i++) children.push(spawn(process.execPath, [path.join(BIN, 'review-and-fix-pr-reviewed.js'),
    '--mark', '--root', RR, '--base', rb, '--ledger', LL, '--run', 'race', '--stage', 'code', '--file', 'f' + i + '.js'], { stdio: 'ignore' }))
  await Promise.all(children.map(c => new Promise(resolve => c.on('exit', resolve))))
  ck('parallel ledger marks are merged without lost updates', Object.keys(JSON.parse(fs.readFileSync(LL, 'utf8'))).length === 24)
}

  fs.rmSync(TMP, { recursive: true, force: true })
  assert.equal(fails, 0, '\n  ' + failures.join('\n  '))
})
