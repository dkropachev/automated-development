'use strict'
// Tests for bin/promptgen-driver.js. Every case runs the real binary in a subprocess with HOME
// pointed at a temp dir, so state files, caches and result files land where the test can see them.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync, execFileSync } = require('child_process')

const DRIVER = path.join(__dirname, '..', 'bin', 'promptgen-driver.js')
const SCHEMA = path.join(__dirname, '..', 'skills', 'draft-pr-description', 'schema.md')
const LEARN = path.join(__dirname, '..', 'skills', 'draft-pr-description', 'learn.md')

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pgd-')) }
function run(home, args, cwd) {
  const r = spawnSync(process.execPath, [DRIVER, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home }, cwd })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
function today() { return new Date().toISOString().slice(0, 10) }
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) }

const GOOD_PROMPT = (extra) => `---
learned_at: ${today()}
source_prs: [101, 102, 103]
contributors: [alice, bob]
pattern: derived
max_bytes: 2000
${extra || ''}---

## Title
Imperative, under 70 characters, prefixed with the component: \`core: fix pool shutdown\`.

## Body
### \`## Why\`  <!-- covers: motivation -->
One paragraph on the problem being solved and where it showed up. Link the issue as \`Fixes #N\`.

### \`## What changed\`  <!-- covers: summary-of-changes -->
Two to five bullets on the change, not the diff. Name the module, not every file.

### \`## Risk\`  <!-- covers: risk, breaking-changes -->
One line: what could break, and whether the public API changed. Say "None" when it did not.

## Style
Lead with the fact. No "in order to", no "it is worth noting". Median 900 characters, middle half 500-1600.

## Notes
No sign-off line. No test plan section: 4 of 20 sampled bodies have one.
`

function gitRepo(dir, origin) {
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin])
  write(path.join(dir, 'src', 'pool.py'), 'x = 1\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
}

function startBuild(h, batch, cache, extra) {
  return run(h, ['start', '--batch', batch, '--cache', cache, '--schema', SCHEMA, '--learn', LEARN,
                 '--nwo', 'o/r', '--host', 'github.com', '--root', h, ...(extra || [])])
}
// drafted -> two clean passes -> handed-off, for a draft already on disk
function buildThrough(h, batch) {
  run(h, ['drafted', '--batch', batch])
  run(h, ['critiqued', '--batch', batch, '--issues', '0']); run(h, ['critiqued', '--batch', batch, '--issues', '0'])
  return run(h, ['handed-off', '--batch', batch])
}
function startDraft(h, repo, draft, prompt, files) {
  return run(h, ['start', '--batch', 'd1', '--mode', 'draft', '--draft', draft, '--prompt', prompt, '--files', files, '--root', repo])
}

// ------------------------------------------------------------------ gate ----

test('gate passes a prompt that covers every required field', () => {
  const h = tmp(); const p = path.join(h, 'p.md'); write(p, GOOD_PROMPT())
  const r = run(h, ['gate', '--draft', p, '--schema', SCHEMA])
  assert.equal(r.code, 0, r.out); assert.match(r.out, /GATE: pass/)
})

test('gate fails on an uncovered required field and on an unknown covers name', () => {
  const h = tmp(); const p = path.join(h, 'p.md')
  write(p, GOOD_PROMPT().replace('covers: motivation', 'covers: motivaton'))
  const r = run(h, ['gate', '--draft', p, '--schema', SCHEMA])
  assert.equal(r.code, 5); assert.match(r.out, /not covered:\n {2}- motivation/); assert.match(r.out, /motivaton/)
})

test('gate fails without a ## Style section', () => {
  const h = tmp(); const p = path.join(h, 'p.md'); write(p, GOOD_PROMPT().replace('## Style', '## Tone'))
  const r = run(h, ['gate', '--draft', p, '--schema', SCHEMA])
  assert.equal(r.code, 5); assert.match(r.out, /no `## Style` section/)
})

test('gate accepts pattern none with well-formed frontmatter and no body', () => {
  const h = tmp(); const p = path.join(h, 'p.md')
  write(p, `---\nlearned_at: ${today()}\nsource_prs: []\ncontributors: []\npattern: none\n---\n`)
  assert.equal(run(h, ['gate', '--draft', p, '--schema', SCHEMA]).code, 0)
  write(p, `---\nlearned_at: yesterday\nsource_prs: []\npattern: none\n---\n`)
  assert.equal(run(h, ['gate', '--draft', p, '--schema', SCHEMA]).code, 5)
})

// --------------------------------------------------------------- resolve ----

test('resolve parses ssh, scp-style and https origins and never asks gh', () => {
  for (const [origin, host, nwo] of [
    ['git@github.com:scylladb/python-driver.git', 'github.com', 'scylladb/python-driver'],
    ['ssh://git@ghe.example.com:2222/team/repo', 'ghe.example.com', 'team/repo'],
    ['https://gitlab.com/group/sub/repo.git', 'gitlab.com', 'group/sub/repo'],
  ]) {
    const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, origin)
    const r = run(h, ['resolve', '--root', repo])
    assert.equal(r.code, 0, r.out)
    assert.match(r.stdout, new RegExp(`^HOST='${host}'$`, 'm'))
    assert.match(r.stdout, new RegExp(`^NWO='${nwo}'$`, 'm'))
    assert.match(r.stdout, new RegExp(`^CACHE='${path.join(h, '.claude/pr-style-cache', host, nwo + '.md')}'$`, 'm'))
    assert.match(r.stdout, /^STALE=1$/m); assert.match(r.stdout, /^STALE_REASON='missing'$/m)
    assert.match(r.stdout, /^LEARN_NOW=1$/m); assert.match(r.stdout, /^LAST_ATTEMPT_HOURS=-1$/m)
  }
})

test('resolve refuses a directory without an origin remote', () => {
  const h = tmp(); const d = path.join(h, 'nogit'); fs.mkdirSync(d)
  const r = run(h, ['resolve', '--root', d])
  assert.equal(r.code, 2); assert.match(r.out, /not a git repository with an origin remote/)
})

test('resolve staleness: fresh, aged out, unverified after 7 days, sources changed', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  write(path.join(repo, '.github', 'PULL_REQUEST_TEMPLATE.md'), '## Why\n## What\n')
  const cache = path.join(h, '.claude/pr-style-cache/github.com/o/r.md')
  const hash = /SOURCES_HASH='([0-9a-f]+)'/.exec(run(h, ['resolve', '--root', repo]).stdout)[1]
  assert.equal(hash.length, 12)

  write(cache, GOOD_PROMPT(`verified: true\nsources_hash: ${hash}\n`))
  let r = run(h, ['resolve', '--root', repo]).stdout
  assert.match(r, /^STALE=0$/m); assert.match(r, /^STALE_REASON='fresh'$/m); assert.match(r, /^CACHE_AGE_DAYS=0$/m); assert.match(r, /^LEARN_NOW=0$/m)

  write(cache, GOOD_PROMPT(`verified: true\nsources_hash: ${hash}\n`).replace(today(), daysAgo(91)))
  assert.match(run(h, ['resolve', '--root', repo]).stdout, /^STALE_REASON='age'$/m)

  write(cache, GOOD_PROMPT(`verified: false\nunresolved: 2\nsources_hash: ${hash}\n`).replace(today(), daysAgo(8)))
  r = run(h, ['resolve', '--root', repo]).stdout
  assert.match(r, /^STALE_REASON='unverified'$/m); assert.match(r, /^CACHE_UNRESOLVED=2$/m)

  write(cache, GOOD_PROMPT(`verified: false\nunresolved: 2\nsources_hash: ${hash}\n`).replace(today(), daysAgo(3)))
  assert.match(run(h, ['resolve', '--root', repo]).stdout, /^STALE=0$/m)

  write(cache, GOOD_PROMPT(`verified: true\nsources_hash: ${hash}\n`))
  write(path.join(repo, 'CONTRIBUTING.md'), '## Pull requests\nAlways link the issue.\n')
  assert.match(run(h, ['resolve', '--root', repo]).stdout, /^STALE_REASON='sources-changed'$/m)

  // an older cache with no hash is judged on age alone
  write(cache, GOOD_PROMPT())
  assert.match(run(h, ['resolve', '--root', repo]).stdout, /^STALE=0$/m)
})

// --------------------------------------------------------- build machine ----

test('start (build) refuses a cache path outside the cache root and names the work file itself', () => {
  const h = tmp()
  let r = startBuild(h, 'b1', path.join(h, 'elsewhere', 'r.md'))
  assert.equal(r.code, 2); assert.match(r.out, /--cache must be an absolute .md path inside/)
  r = run(h, ['start', '--batch', 'b1', '--cache', path.join(h, '.claude/pr-style-cache/github.com/o/r.md'), '--schema', SCHEMA])
  assert.equal(r.code, 2); assert.match(r.out, /--nwo must be owner\/repo/)
  const cache = path.join(h, '.claude/pr-style-cache/github.com/o/r.md')
  r = startBuild(h, 'b1', cache)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, new RegExp(cache.replace(/[.]/g, '\\.') + '\\.work\\.b1'))
  assert.match(r.out, /drafted --batch b1/)
})

test('full build: drafted -> two clean critiques -> handed-off -> result -> verified -> publish', () => {
  const h = tmp(); const cache = path.join(h, '.claude/pr-style-cache/github.com/o/r.md'); const work = cache + '.work.b1'
  assert.equal(startBuild(h, 'b1', cache).code, 0)

  let r = run(h, ['drafted', '--batch', 'b1'])
  assert.equal(r.code, 3); assert.match(r.out, /THERE IS NO DRAFT/)

  write(work, GOOD_PROMPT())
  r = run(h, ['drafted', '--batch', 'b1']); assert.equal(r.code, 0, r.out); assert.match(r.out, /CRITIQUE YOUR OWN DRAFT/)

  r = run(h, ['critiqued', '--batch', 'b1']); assert.equal(r.code, 3); assert.match(r.out, /MISSING COUNT/)
  r = run(h, ['critiqued', '--batch', 'b1', '--issues', '2']); assert.match(r.out, /GO AGAIN/)
  r = run(h, ['critiqued', '--batch', 'b1', '--issues', '0']); assert.match(r.out, /GO AGAIN/)
  r = run(h, ['critiqued', '--batch', 'b1', '--issues', '0']); assert.match(r.out, /LAST READ/)

  // publishing before the build is finished is refused
  r = run(h, ['publish', '--batch', 'b1']); assert.equal(r.code, 4); assert.match(r.out, /not finished/)

  r = run(h, ['handed-off', '--batch', 'b1']); assert.equal(r.code, 0, r.out); assert.match(r.out, /FINAL STATE: built derived/)

  const res = JSON.parse(run(h, ['result', '--batch', 'b1']).stdout)
  assert.equal(res.outcome, 'built'); assert.equal(res.pattern, 'derived'); assert.equal(res.critiquePasses, 3)
  assert.deepEqual(res.sourcePrs, [101, 102, 103]); assert.deepEqual(res.contributors, ['alice', 'bob'])
  assert.equal(res.cache, cache); assert.equal(res.draft, work)
  assert.ok(fs.existsSync(path.join(h, '.claude/draft-pr-description/state/b1.result.json')))

  // no verdict, no publish
  r = run(h, ['publish', '--batch', 'b1']); assert.equal(r.code, 4); assert.match(r.out, /no verdict has been recorded/)
  assert.ok(!fs.existsSync(cache))

  // a report that only re-checked the builder's own sample is refused, and nothing is recorded
  const report = path.join(h, 'report.txt')
  write(report, 'VERDICT: sound\nCHECKED_PRS: 101, 102\nFINDINGS:\n')
  r = run(h, ['verified', '--batch', 'b1', '--report-file', report]); assert.equal(r.code, 3); assert.match(r.out, /NOT RECORDED[\s\S]*only 0 are outside/)
  r = run(h, ['publish', '--batch', 'b1']); assert.equal(r.code, 4)
  // a file that is not a report at all
  write(report, 'looks fine to me'); assert.equal(run(h, ['verified', '--batch', 'b1', '--report-file', report]).code, 2)
  // a real one, in the fenced form the verifier prints
  write(report, '```\nVERDICT: sound\nCHECKED_PRS: #104, 105, 101\nFINDINGS:\n  - [worth-fixing] ## Title: example is stale  (evidence: #104)\n```\n')
  r = run(h, ['verified', '--batch', 'b1', '--report-file', report])
  assert.equal(r.code, 0, r.out); assert.match(r.out, /RECORDED verdict=sound blocking=0 checked_prs=3/)

  r = run(h, ['publish', '--batch', 'b1']); assert.equal(r.code, 0, r.out); assert.match(r.out, /^PUBLISHED /m)
  assert.ok(fs.existsSync(cache)); assert.ok(!fs.existsSync(work))
  const fm = fs.readFileSync(cache, 'utf8').split('\n---\n')[0]
  assert.match(fm, /^verified: true$/m); assert.match(fm, /^verify_verdict: sound$/m); assert.match(fm, /^unresolved: 0$/m)
  assert.match(fm, /^sources_hash: \w+$/m); assert.match(fm, /^nwo: o\/r$/m)
  assert.match(fm, new RegExp('^learned_at: ' + today() + '$', 'm'))
  assert.match(run(h, ['publish', '--batch', 'b1']).out, /ALREADY PUBLISHED/)

  // the published hash is the one resolve computes afterwards, and the cache reads as fresh
  const repo = path.join(h, 'repo'); gitRepo(repo, 'git@github.com:o/r.git')
  const res2 = run(h, ['resolve', '--root', repo]).stdout
  assert.match(res2, /^STALE=0$/m); assert.match(res2, /^CACHE_VERIFIED='true'$/m)
})

test('reopen sends a finished build back to critiquing with the findings; verdict is derived from them', () => {
  const h = tmp(); const cache = path.join(h, '.claude/pr-style-cache/github.com/o/r.md'); const work = cache + '.work.b2'
  startBuild(h, 'b2', cache); write(work, GOOD_PROMPT())
  assert.match(buildThrough(h, 'b2').out, /FINAL STATE: built/)

  let r = run(h, ['reopen', '--batch', 'b2']); assert.equal(r.code, 2)
  const report = path.join(h, 'report.txt')
  write(report, 'VERDICT: sound\nCHECKED_PRS: 77, 78, 101\nFINDINGS:\n  - [blocking] ## Title: CI rejects titles without a scope  (evidence: #77, .github/workflows/lint.yml)\n')
  r = run(h, ['reopen', '--batch', 'b2', '--carry-file', report])
  assert.equal(r.code, 0, r.out); assert.match(r.out, /CRITIQUE YOUR OWN DRAFT/); assert.match(r.out, /CI rejects titles without a scope/)
  assert.doesNotMatch(r.out, /VERDICT:/)

  // the exit rule is unchanged: two clean passes, then the gate, then handed-off
  assert.match(run(h, ['critiqued', '--batch', 'b2', '--issues', '1']).out, /GO AGAIN/)
  assert.match(run(h, ['critiqued', '--batch', 'b2', '--issues', '0']).out, /GO AGAIN/)
  assert.match(run(h, ['critiqued', '--batch', 'b2', '--issues', '0']).out, /LAST READ/)
  assert.match(run(h, ['handed-off', '--batch', 'b2']).out, /FINAL STATE: built/)
  const res = JSON.parse(run(h, ['result', '--batch', 'b2']).stdout)
  assert.equal(res.reopened, 1); assert.equal(res.critiquePasses, 5)

  r = run(h, ['verified', '--batch', 'b2', '--report-file', report])
  assert.match(r.out, /RECORDED verdict=needs-work blocking=1/); assert.match(r.out, /the verifier wrote "sound"/)
  r = run(h, ['publish', '--batch', 'b2']); assert.equal(r.code, 0, r.out)
  const fm = fs.readFileSync(cache, 'utf8').split('\n---\n')[0]
  assert.match(fm, /^verified: false$/m); assert.match(fm, /^unresolved: 1$/m)
})

test('reopen is capped', () => {
  const h = tmp(); const cache = path.join(h, '.claude/pr-style-cache/github.com/o/r.md')
  const carry = path.join(h, 'c.txt'); write(carry, '  - [blocking] ## Body: x  (evidence: #1)\n')
  startBuild(h, 'b9', cache); write(cache + '.work.b9', GOOD_PROMPT()); buildThrough(h, 'b9')
  for (let i = 0; i < 3; i++) {
    assert.equal(run(h, ['reopen', '--batch', 'b9', '--carry-file', carry]).code, 0)
    run(h, ['critiqued', '--batch', 'b9', '--issues', '0']); run(h, ['critiqued', '--batch', 'b9', '--issues', '0']); run(h, ['handed-off', '--batch', 'b9'])
  }
  const r = run(h, ['reopen', '--batch', 'b9', '--carry-file', carry]); assert.equal(r.code, 3); assert.match(r.out, /NOT AGAIN/)
  assert.equal(JSON.parse(run(h, ['result', '--batch', 'b9']).stdout).reopened, 3)
})

test('publish refuses when the draft no longer passes the gate, and that counts as a failed attempt', () => {
  const h = tmp(); const cache = path.join(h, '.claude/pr-style-cache/github.com/o/r.md'); const work = cache + '.work.b3'
  startBuild(h, 'b3', cache); write(work, GOOD_PROMPT()); buildThrough(h, 'b3')
  run(h, ['verified', '--batch', 'b3', '--verdict', 'unverified'])
  write(work, GOOD_PROMPT().replace('covers: risk, breaking-changes', 'covers: risk'))
  const r = run(h, ['publish', '--batch', 'b3'])
  assert.equal(r.code, 5); assert.match(r.out, /uncovered field: breaking-changes/); assert.ok(!fs.existsSync(cache))
  assert.ok(fs.existsSync(cache + '.attempt'))
  const repo = path.join(h, 'repo'); gitRepo(repo, 'git@github.com:o/r.git')
  const out = run(h, ['resolve', '--root', repo]).stdout
  assert.match(out, /^STALE=1$/m); assert.match(out, /^LEARN_NOW=0$/m); assert.match(out, /^LAST_ATTEMPT_HOURS=0$/m)
  assert.match(out, /^LAST_ATTEMPT_REASON='publish refused: coverage gate failed'$/m)
  assert.match(run(h, ['resolve', '--root', repo, '--backoff-hours', '0']).stdout, /^LEARN_NOW=1$/m)
})

test('abandon stamps the attempt; a later successful publish clears it', () => {
  const h = tmp(); const cache = path.join(h, '.claude/pr-style-cache/github.com/o/r.md')
  const repo = path.join(h, 'repo'); gitRepo(repo, 'git@github.com:o/r.git')
  startBuild(h, 'b6', cache)
  const r = run(h, ['abandon', '--batch', 'b6', '--reason', 'gh: not logged in'])
  assert.equal(r.code, 0); assert.match(r.out, /ABANDONED batch b6/)
  assert.equal(JSON.parse(run(h, ['result', '--batch', 'b6']).stdout).outcome, 'abandoned')
  assert.match(run(h, ['resolve', '--root', repo]).stdout, /^LEARN_NOW=0$/m)

  startBuild(h, 'b7', cache); write(cache + '.work.b7', GOOD_PROMPT()); buildThrough(h, 'b7')
  run(h, ['verified', '--batch', 'b7', '--verdict', 'unverified'])
  assert.equal(run(h, ['publish', '--batch', 'b7']).code, 0)
  assert.ok(!fs.existsSync(cache + '.attempt'))
  const out = run(h, ['resolve', '--root', repo]).stdout
  assert.match(out, /^LAST_ATTEMPT_HOURS=-1$/m); assert.match(out, /^CACHE_VERIFIED='false'$/m); assert.match(out, /^STALE=0$/m)
})

test('publish sweeps stale work files but leaves another batch that is still running', () => {
  const h = tmp(); const cache = path.join(h, '.claude/pr-style-cache/github.com/o/r.md')
  startBuild(h, 'live', cache); write(cache + '.work.live', 'in progress')          // step: drafting, fresh mtime
  startBuild(h, 'dead', cache); write(cache + '.work.dead', 'finished elsewhere')
  run(h, ['abandon', '--batch', 'dead'])                                             // step: done
  write(cache + '.work.orphan', 'no state at all')
  startBuild(h, 'b8', cache); write(cache + '.work.b8', GOOD_PROMPT()); buildThrough(h, 'b8')
  run(h, ['verified', '--batch', 'b8', '--verdict', 'unverified'])
  const r = run(h, ['publish', '--batch', 'b8']); assert.equal(r.code, 0, r.out); assert.match(r.out, /swept_work_files=2/)
  assert.ok(fs.existsSync(cache + '.work.live')); assert.ok(!fs.existsSync(cache + '.work.dead')); assert.ok(!fs.existsSync(cache + '.work.orphan'))
})

test('critique exhaustion: the cap ends the loop without two zeros', () => {
  const h = tmp(); const cache = path.join(h, '.claude/pr-style-cache/github.com/o/r.md')
  startBuild(h, 'b4', cache); write(cache + '.work.b4', GOOD_PROMPT()); run(h, ['drafted', '--batch', 'b4'])
  let out = ''
  for (let i = 0; i < 5; i++) out = run(h, ['critiqued', '--batch', 'b4', '--issues', '1']).out
  assert.match(out, /LAST READ/)
})

test('wrong verb for the step is refused and names the expected one; a draft verb on a build run is WRONG MACHINE', () => {
  const h = tmp(); const cache = path.join(h, '.claude/pr-style-cache/github.com/o/r.md')
  startBuild(h, 'b5', cache)
  let r = run(h, ['handed-off', '--batch', 'b5']); assert.equal(r.code, 3); assert.match(r.out, /NOT THIS STEP/); assert.match(r.out, /drafted --batch b5/)
  r = run(h, ['written', '--batch', 'b5']); assert.match(r.out, /WRONG MACHINE/)
  r = run(h, ['result', '--batch', 'nope']); assert.equal(r.code, 3); assert.match(r.out, /NO STATE FOR THIS RUN/)
})

// --------------------------------------------------------- draft machine ----

test('draft checks: invented file, path:line, branch permalink, wrapped link, banner, filler, invented heading', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  const prompt = path.join(h, 'prompt.md'); write(prompt, GOOD_PROMPT())
  const files = path.join(h, 'files.txt'); write(files, 'src/pool.py\n')
  const draft = path.join(h, 'draft.md')
  assert.equal(startDraft(h, repo, draft, prompt, files).code, 0)
  write(draft, `Title: core: fix pool shutdown

## Why
In order to stop the leak in \`src/pool.py:12\` we also touch \`tests/test_pool.py\`; see
[here](https://github.com/o/r/blob/main/src/pool.py#L12) and https://github.com/o/r/blob/main/src/pool.py#L12.

## What changed
- shutdown now joins workers

## Risk
None.

## Test plan
ran it

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`)
  const r = run(h, ['written', '--batch', 'd1']); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /do not exist in this repository at all[\s\S]*tests\/test_pool\.py/)
  assert.match(r.out, /references code as `src\/pool\.py:12`/)
  assert.match(r.out, /pinned to a branch or tag rather than a commit SHA \(main\)/)
  assert.match(r.out, /wrapped in markdown link text/)
  assert.match(r.out, /Claude Code banner/)
  assert.match(r.out, /in order to {2}-> {2}to/)
  assert.match(r.out, /not in this repo's vocabulary[\s\S]*## Test plan/)
})

test('draft checks: a permalink pinned to a commit no remote has yet is reported', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  const bare = path.join(h, 'bare.git'); execFileSync('git', ['init', '-q', '--bare', bare])
  execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', bare])
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'HEAD'])
  const pushed = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  write(path.join(repo, 'src', 'pool.py'), 'x = 2\n')
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'more'])
  const unpushed = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const prompt = path.join(h, 'prompt.md'); write(prompt, GOOD_PROMPT())
  const files = path.join(h, 'files.txt'); write(files, 'src/pool.py\n')
  const draft = path.join(h, 'draft.md'); startDraft(h, repo, draft, prompt, files)
  write(draft, `Title: core: fix pool shutdown

## Why
See the leak here.
https://github.com/o/r/blob/${unpushed}/src/pool.py#L1
and the old code
https://github.com/o/r/blob/${pushed}/src/pool.py#L1

## What changed
- one thing

## Risk
None.
`)
  const r = run(h, ['written', '--batch', 'd1'])
  assert.match(r.out, new RegExp('no remote branch contains yet \\(' + unpushed.slice(0, 12) + '\\)'))
  assert.doesNotMatch(r.out, new RegExp(pushed.slice(0, 12)))
})

test('draft machine: clean description passes after two unchanged passes and finishes', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  const prompt = path.join(h, 'prompt.md'); write(prompt, GOOD_PROMPT())
  const files = path.join(h, 'files.txt'); write(files, 'src/pool.py\n')
  const draft = path.join(h, 'draft.md')
  startDraft(h, repo, draft, prompt, files)
  write(draft, `Title: core: fix pool shutdown

## Why
Workers leaked on shutdown when a connection was mid-handshake. Fixes #42.

## What changed
- shutdown joins every worker before returning, in \`pool.py\`

## Risk
None. No public API changed.
`)
  assert.match(run(h, ['written', '--batch', 'd1']).out, /GO BACK OVER IT/)
  assert.match(run(h, ['revised', '--batch', 'd1', '--changed', 'no']).out, /GO AGAIN/)
  assert.match(run(h, ['revised', '--batch', 'd1', '--changed', 'no']).out, /LAST READ/)
  assert.match(run(h, ['finished', '--batch', 'd1']).out, /FINAL STATE: drafted/)
  assert.match(run(h, ['written', '--batch', 'd1']).out, /already finished/)
})

test('draft machine: over budget gets exactly one pass for length, then finishes long', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  const prompt = path.join(h, 'prompt.md'); write(prompt, GOOD_PROMPT().replace('max_bytes: 2000', 'max_bytes: 300'))
  const files = path.join(h, 'files.txt'); write(files, 'src/pool.py\n')
  const draft = path.join(h, 'draft.md'); startDraft(h, repo, draft, prompt, files)
  write(draft, `Title: core: fix pool shutdown

## Why
Workers leaked on shutdown when a connection was mid-handshake. ${'Long explanation. '.repeat(20)}Fixes #42.

## What changed
- shutdown joins every worker before returning

## Risk
None.
`)
  run(h, ['written', '--batch', 'd1'])
  run(h, ['revised', '--batch', 'd1', '--changed', 'no'])
  let r = run(h, ['revised', '--batch', 'd1', '--changed', 'no']); assert.match(r.out, /ONE PASS FOR LENGTH/); assert.match(r.out, /TOO LONG/)
  r = run(h, ['revised', '--batch', 'd1', '--changed', 'no']); assert.match(r.out, /LAST READ/); assert.match(r.out, /Still over the guide/)
  assert.match(run(h, ['finished', '--batch', 'd1']).out, /over the length guide and deliberately so/)
})

test('draft start refuses a missing prompt file loudly', () => {
  const h = tmp()
  const r = run(h, ['start', '--batch', 'd2', '--mode', 'draft', '--draft', path.join(h, 'd.md'), '--prompt', path.join(h, 'nope.md')])
  assert.equal(r.code, 2); assert.match(r.out, /no prompt at/)
})
