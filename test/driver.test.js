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

test('gate rejects impossible dates and empty evidence for learned patterns', () => {
  const h = tmp(); const p = path.join(h, 'p.md')
  write(p, GOOD_PROMPT().replace(`learned_at: ${today()}`, 'learned_at: 2026-99-99').replace('source_prs: [101, 102, 103]', 'source_prs: []'))
  const r = run(h, ['gate', '--draft', p, '--schema', SCHEMA])
  assert.equal(r.code, 5); assert.match(r.out, /YYYY-MM-DD/); assert.match(r.out, /well-formed id/)
})

// --------------------------------------------------------------- resolve ----

test('resolve parses ssh, scp-style and https origins and never asks gh', () => {
  for (const [origin, host, nwo] of [
    ['git@github.com:scylladb/python-driver.git', 'github.com', 'scylladb/python-driver'],
    ['ssh://git@ghe.example.com:2222/team/repo', 'ghe.example.com', 'team/repo'],
    ['https://github.com/group/repo.git', 'github.com', 'group/repo'],
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

test('resolve refuses a gitlab or bitbucket origin: this plugin speaks gh', () => {
  for (const origin of ['https://gitlab.com/group/repo.git', 'git@bitbucket.org:team/repo.git']) {
    const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, origin)
    const r = run(h, ['resolve', '--root', repo])
    assert.equal(r.code, 2, r.out); assert.match(r.out, /is not supported/)
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
  const foreign = path.join(tmp(), '.claude/pr-style-cache/github.com/o/r.md')
  r = startBuild(h, 'foreign', foreign); assert.equal(r.code, 2)
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
  write(report, 'VERDICT: garbage\nCHECKED_PRS: 104, 105\nFINDINGS:\n')
  assert.equal(run(h, ['verified', '--batch', 'b1', '--report-file', report]).code, 2)
  write(report, 'VERDICT: sound\nCHECKED_ISSUES: 104, 105\nFINDINGS:\n')
  assert.equal(run(h, ['verified', '--batch', 'b1', '--report-file', report]).code, 2)
  write(report, 'VERDICT: sound\nCHECKED_PRS: 104, 104\nFINDINGS:\n')
  assert.equal(run(h, ['verified', '--batch', 'b1', '--report-file', report]).code, 3)
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

test('draft checks enforce top-line format, required labels, heading lines, and paths without a file list', () => {
  const h = tmp(); const repoDir = path.join(h, 'r'); gitRepo(repoDir, 'git@github.com:o/r.git')
  const prompt = path.join(h, 'prompt.md'); write(prompt, ISSUE_PROMPT())
  const draft = path.join(h, 'draft.md')
  startIssueDraft(h, repoDir, draft, prompt, 'bug', 'fmt')
  write(draft, `intro\nTitle: [Bug]: bad\nLabels: wrong\nI mention ### What happened? inline and src/never.js.\n${'padding '.repeat(20)}`)
  const r = run(h, ['written', '--batch', 'fmt'])
  assert.match(r.out, /no non-empty `Title:` line/)
  assert.match(r.out, /requires a `Labels:` line|must be exactly: bug/)
  assert.match(r.out, /Sections the cached prompt asks for/)
  assert.match(r.out, /src\/never\.js/)
})

test('draft checks reject code links in fences or embedded in prose', () => {
  const h = tmp(); const repoDir = path.join(h, 'r'); gitRepo(repoDir, 'git@github.com:o/r.git')
  const prompt = path.join(h, 'prompt.md'); write(prompt, GOOD_PROMPT())
  const files = path.join(h, 'files'); write(files, '')
  const draft = path.join(h, 'draft.md'); startDraft(h, repoDir, draft, prompt, files)
  const sha = '0123456789012345678901234567890123456789'
  write(draft, `Title: core: links\n\n## Why\n\`\`\`\nhttps://github.com/o/r/blob/main/a.js#L1\n\`\`\`\nSee https://github.com/o/r/blob/${sha}/a.js#L1 here.\n\n## What changed\n${'content '.repeat(10)}\n\n## Risk\nNone.\n`)
  const r = run(h, ['written', '--batch', 'd1'])
  assert.match(r.out, /inside a fenced block/); assert.match(r.out, /not a bare URL on its own line/)
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

// ---------------------------------------------------------- issue domain ----
// The same driver, told --domain issue: its own cache root and state directory, the issue templates
// in the sources hash, `source_issues` and CHECKED_ISSUES in place of the PR names, and KINDS - a
// prompt whose sections belong to a bug report or a feature request, gated and checked per kind.

const ISCHEMA = path.join(__dirname, '..', 'skills', 'draft-issue-description', 'schema.md')
const ILEARN = path.join(__dirname, '..', 'skills', 'draft-issue-description', 'learn.md')

const ISSUE_PROMPT = (extra) => `---
learned_at: ${today()}
source_issues: [1041, 1050, 1102]
contributors: [alice, bob]
pattern: template
max_bytes: 2500
kinds: [bug, feature]
${extra || ''}---

## Title
Bugs: \`[Bug]: <symptom>\`, declarative, under 80 characters. Features: imperative, no prefix.

## Kinds
### \`bug\` — \`.github/ISSUE_TEMPLATE/bug.yml\`, title prefix \`[Bug]: \`, labels \`bug\`
Something that worked or should work does not.
### \`feature\` — \`.github/ISSUE_TEMPLATE/feature.yml\`, labels \`enhancement\`
Something the project does not do yet. Questions go to Discussions and are not filed here.

## Body
### \`### What happened?\`  <!-- kinds: bug --> <!-- covers: problem -->
The symptom as a user meets it, two to four sentences. Required by the form.

### \`### What did you expect?\`  <!-- kinds: bug --> <!-- covers: expected -->
One or two sentences of the correct behaviour.

### \`### Steps to reproduce\`  <!-- kinds: bug --> <!-- covers: reproduction -->
Numbered, minimal, actually run.

### \`### Version\`  <!-- covers: context -->
The released version as a number, and the platform where it matters.

### \`### Problem\`  <!-- kinds: feature --> <!-- covers: problem -->
What cannot be done today and who needs it.

### \`### Proposed solution\`  <!-- kinds: feature --> <!-- covers: expected, proposal -->
The outcome wanted as behaviour; a design sketch only if you have one.

## Style
Lead with the fact. No "in order to", no "it is worth noting". Logs trimmed to the failing lines. Median 900 characters, middle half 500-1600.

## Notes
No sign-off line. A proposed-fix section appears in 2 of 12 sampled bugs; excluded for the bug kind.
`

function startIssueBuild(h, batch, cache) {
  return run(h, ['start', '--domain', 'issue', '--batch', batch, '--cache', cache, '--schema', ISCHEMA, '--learn', ILEARN,
                 '--nwo', 'o/r', '--host', 'github.com', '--root', h])
}
function startIssueDraft(h, repo, draft, prompt, kind, batch) {
  return run(h, ['start', '--domain', 'issue', '--batch', batch || 'i1', '--mode', 'draft', '--draft', draft, '--prompt', prompt,
                 '--root', repo, ...(kind ? ['--kind', kind] : [])])
}

test('issue gate: coverage is judged per kind, kinds must be declared, and the PR gate rejects an issue prompt', () => {
  const h = tmp(); const p = path.join(h, 'p.md'); write(p, ISSUE_PROMPT())
  let r = run(h, ['gate', '--domain', 'issue', '--draft', p, '--schema', ISCHEMA])
  assert.equal(r.code, 0, r.out); assert.match(r.out, /kinds: {3}bug, feature/); assert.match(r.out, /GATE: pass/)

  // restrict the shared Version section to bugs: the feature kind loses `context`
  write(p, ISSUE_PROMPT().replace('### `### Version`  <!-- covers: context -->', '### `### Version`  <!-- kinds: bug --> <!-- covers: context -->'))
  r = run(h, ['gate', '--domain', 'issue', '--draft', p, '--schema', ISCHEMA])
  assert.equal(r.code, 5); assert.match(r.out, /not covered:\n {2}- context \(kind: feature\)/); assert.doesNotMatch(r.out, /kind: bug\)/)

  // a kinds-comment naming a kind the frontmatter does not declare
  write(p, ISSUE_PROMPT().replace('<!-- kinds: feature --> <!-- covers: problem -->', '<!-- kinds: docs --> <!-- covers: problem -->'))
  r = run(h, ['gate', '--domain', 'issue', '--draft', p, '--schema', ISCHEMA])
  assert.equal(r.code, 5); assert.match(r.out, /not in the frontmatter:\n {2}- docs/); assert.match(r.out, /problem \(kind: feature\)/)

  // kinds declared but no ## Kinds section to choose one by
  write(p, ISSUE_PROMPT().replace('## Kinds', '## Templates'))
  r = run(h, ['gate', '--domain', 'issue', '--draft', p, '--schema', ISCHEMA])
  assert.equal(r.code, 5); assert.match(r.out, /no `## Kinds` section/)

  // a malformed kinds list
  write(p, ISSUE_PROMPT().replace('kinds: [bug, feature]', 'kinds: bug feature'))
  assert.match(run(h, ['gate', '--domain', 'issue', '--draft', p, '--schema', ISCHEMA]).out, /`kinds` must be a \[\.\.\] list/)

  // no kinds at all is fine: every section covers every issue
  write(p, ISSUE_PROMPT().replace('kinds: [bug, feature]\n', '').replace(/<!-- kinds: [a-z, ]+ -->\s*/g, '').replace('## Kinds', '## Templates'))
  assert.equal(run(h, ['gate', '--domain', 'issue', '--draft', p, '--schema', ISCHEMA]).code, 0)

  // the PR gate reads source_prs, which an issue prompt does not have
  write(p, ISSUE_PROMPT())
  r = run(h, ['gate', '--draft', p, '--schema', ISCHEMA]); assert.equal(r.code, 5); assert.match(r.out, /`source_prs` is missing/)
  assert.equal(run(h, ['gate', '--domain', 'ticket', '--draft', p, '--schema', ISCHEMA]).code, 2)
})

test('issue resolve: its own cache root, issue templates in the sources hash, kinds read off the cache', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  let r = run(h, ['resolve', '--domain', 'issue', '--root', repo])
  assert.equal(r.code, 0, r.out)
  assert.match(r.stdout, /^DOMAIN='issue'$/m)
  assert.match(r.stdout, new RegExp(`^CACHE='${path.join(h, '.claude/issue-style-cache/github.com/o/r.md')}'$`, 'm'))
  assert.match(r.stdout, /^SOURCES_HASH='none'$/m); assert.match(r.stdout, /^CACHE_KINDS=''$/m)

  // a PR template does not touch the issue hash; an issue form and config.yml do
  write(path.join(repo, '.github', 'PULL_REQUEST_TEMPLATE.md'), '## Why\n')
  assert.match(run(h, ['resolve', '--domain', 'issue', '--root', repo]).stdout, /^SOURCES_HASH='none'$/m)
  write(path.join(repo, '.github', 'ISSUE_TEMPLATE', 'bug.yml'), 'name: Bug\nbody:\n  - type: textarea\n    id: what\n    attributes:\n      label: What happened?\n')
  const h1 = /SOURCES_HASH='([0-9a-f]+)'/.exec(run(h, ['resolve', '--domain', 'issue', '--root', repo]).stdout)[1]
  assert.equal(h1.length, 12)
  write(path.join(repo, '.github', 'ISSUE_TEMPLATE', 'config.yml'), 'blank_issues_enabled: false\n')
  const h2 = /SOURCES_HASH='([0-9a-f]+)'/.exec(run(h, ['resolve', '--domain', 'issue', '--root', repo]).stdout)[1]
  assert.notEqual(h1, h2)
  // and the PR hash saw the PR template but neither issue file
  const prHash = /SOURCES_HASH='([0-9a-f]+)'/.exec(run(h, ['resolve', '--root', repo]).stdout)[1]
  assert.notEqual(prHash, 'none'); assert.notEqual(prHash, h2)

  const cache = path.join(h, '.claude/issue-style-cache/github.com/o/r.md')
  write(cache, ISSUE_PROMPT(`verified: true\nsources_hash: ${h2}\n`))
  r = run(h, ['resolve', '--domain', 'issue', '--root', repo]).stdout
  assert.match(r, /^STALE=0$/m); assert.match(r, /^CACHE_KINDS='bug feature'$/m); assert.match(r, /^CACHE_PATTERN='template'$/m)
  // the PR cache for the same repo is a different file and is still missing
  assert.match(run(h, ['resolve', '--root', repo]).stdout, /^STALE_REASON='missing'$/m)
})

test('issue build: PR cache path refused, state lands in the issue state dir, CHECKED_ISSUES recorded, later verbs need no --domain', () => {
  const h = tmp()
  let r = startIssueBuild(h, 'ib1', path.join(h, '.claude/pr-style-cache/github.com/o/r.md'))
  assert.equal(r.code, 2); assert.match(r.out, /inside ~\/.claude\/issue-style-cache/); assert.match(r.out, /resolve --domain issue/)

  const cache = path.join(h, '.claude/issue-style-cache/github.com/o/r.md'); const work = cache + '.work.ib1'
  r = startIssueBuild(h, 'ib1', cache); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /draft an issue title and body/)
  assert.ok(fs.existsSync(path.join(h, '.claude/draft-issue-description/state/ib1.state.json')))
  assert.ok(!fs.existsSync(path.join(h, '.claude/draft-pr-description/state/ib1.state.json')))

  write(work, ISSUE_PROMPT())
  r = run(h, ['drafted', '--batch', 'ib1']); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /CRITIQUE YOUR OWN DRAFT/); assert.match(r.out, /sampled issues/); assert.match(r.out, /WHICH kind/)
  r = run(h, ['critiqued', '--batch', 'ib1', '--issues', '0']); assert.match(r.out, /raw issue bodies/)
  r = run(h, ['critiqued', '--batch', 'ib1', '--issues', '0']); assert.match(r.out, /LAST READ/)
  r = run(h, ['handed-off', '--batch', 'ib1']); assert.match(r.out, /FINAL STATE: built template/)

  const res = JSON.parse(run(h, ['result', '--batch', 'ib1']).stdout)
  assert.equal(res.domain, 'issue'); assert.deepEqual(res.sourceIssues, [1041, 1050, 1102]); assert.deepEqual(res.kinds, ['bug', 'feature'])
  assert.equal(res.sourcePrs, undefined)

  const report = path.join(h, 'report.txt')
  write(report, 'VERDICT: sound\nCHECKED_ISSUES: 1041, 1050\nFINDINGS:\n')
  r = run(h, ['verified', '--batch', 'ib1', '--report-file', report]); assert.equal(r.code, 3); assert.match(r.out, /checked 2 issue\(s\), of which only 0/)
  write(report, 'VERDICT: sound\nCHECKED_ISSUES: #870, 1120, 1041\nFINDINGS:\n  - [worth-fixing] ## Title: example predates the prefix  (evidence: #870)\n')
  r = run(h, ['verified', '--batch', 'ib1', '--report-file', report]); assert.equal(r.code, 0, r.out); assert.match(r.out, /RECORDED verdict=sound/)

  r = run(h, ['publish', '--batch', 'ib1']); assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(cache)); assert.ok(!fs.existsSync(work))
  const fm = fs.readFileSync(cache, 'utf8').split('\n---\n')[0]
  assert.match(fm, /^kinds: \[bug, feature\]$/m); assert.match(fm, /^source_issues: /m); assert.match(fm, /^verified: true$/m)

  const repo = path.join(h, 'repo'); gitRepo(repo, 'git@github.com:o/r.git')
  const out = run(h, ['resolve', '--domain', 'issue', '--root', repo]).stdout
  assert.match(out, /^STALE=0$/m); assert.match(out, /^CACHE_KINDS='bug feature'$/m)
})

test('issue draft: --kind is required when the prompt declares kinds, and must be one of them', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  const prompt = path.join(h, 'prompt.md'); write(prompt, ISSUE_PROMPT())
  const draft = path.join(h, 'draft.md')
  let r = startIssueDraft(h, repo, draft, prompt, '')
  assert.equal(r.code, 2); assert.match(r.out, /--kind was not given/); assert.match(r.out, /kinds: bug, feature/)
  r = startIssueDraft(h, repo, draft, prompt, 'docs')
  assert.equal(r.code, 2); assert.match(r.out, /"docs" is not a kind this prompt declares/)
  r = startIssueDraft(h, repo, draft, prompt, 'bug')
  assert.equal(r.code, 0, r.out); assert.match(r.out, /WRITE THE ISSUE/); assert.match(r.out, /^ {2}kind: bug$/m)
  assert.match(r.out, /Labels: <comma-separated>/); assert.doesNotMatch(r.out, /no --files given/)
  // no kinds in the prompt: --kind is ignored and nothing is asked for
  const flat = path.join(h, 'flat.md'); write(flat, GOOD_PROMPT().replace('source_prs', 'source_issues'))
  r = startIssueDraft(h, repo, draft, flat, '', 'i2'); assert.equal(r.code, 0, r.out); assert.doesNotMatch(r.out, /kind:/)
})

test('issue draft checks: other kind\'s heading, template comment, invented file; then a clean bug report passes', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  const prompt = path.join(h, 'prompt.md'); write(prompt, ISSUE_PROMPT())
  const draft = path.join(h, 'draft.md')
  assert.equal(startIssueDraft(h, repo, draft, prompt, 'bug').code, 0)
  write(draft, `Title: [Bug]: process stays alive after PoolManager.shutdown() returns
Labels: bug

### What happened?
<!-- A clear and concise description of what the bug is. -->
After shutdown() returns the process does not exit; see \`src/pool.py\` and \`tests/test_pool.py\`.

### What did you expect?
The process exits.

### Steps to reproduce
1. start a pool
2. call shutdown() during a handshake

### Version
2.3.1 on Linux

### Proposed solution
join the workers
`)
  let r = run(h, ['written', '--batch', 'i1']); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /not in this repo's vocabulary for this kind of issue[\s\S]*### Proposed solution/)
  assert.match(r.out, /still contains an HTML comment/)
  assert.match(r.out, /do not exist in this repository at all[\s\S]*tests\/test_pool\.py/)
  assert.doesNotMatch(r.out, /src\/pool\.py/)                     // exists: nothing to say about it for an issue
  assert.doesNotMatch(r.out, /no changed-file list/)
  assert.match(r.out, /maintainer who will triage it/)

  write(draft, `Title: [Bug]: process stays alive after PoolManager.shutdown() returns
Labels: bug

### What happened?
After shutdown() returns, the process does not exit while a worker is mid-handshake. Seen in \`src/pool.py\`.

### What did you expect?
The process exits once shutdown() returns.

### Steps to reproduce
1. start a pool of two workers
2. call shutdown() while one is connecting

### Version
2.3.1 on Linux
`)
  r = run(h, ['revised', '--batch', 'i1', '--changed', 'yes']); assert.match(r.out, /GO AGAIN/); assert.match(r.out, /log block pasted whole/)
  r = run(h, ['revised', '--batch', 'i1', '--changed', 'no']); assert.match(r.out, /GO AGAIN/); assert.match(r.out, /terminal closed/)
  r = run(h, ['revised', '--batch', 'i1', '--changed', 'no'])
  assert.match(r.out, /LAST READ/); assert.match(r.out, /every file named exists in the repository/)
  assert.match(r.out, /print the title, labels and body/); assert.match(r.out, /maintainer who gets this/)
  r = run(h, ['finished', '--batch', 'i1']); assert.match(r.out, /FINAL STATE: drafted/)
})

test('issue draft: a feature is checked against the feature sections only', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  const prompt = path.join(h, 'prompt.md'); write(prompt, ISSUE_PROMPT())
  const draft = path.join(h, 'draft.md')
  assert.equal(startIssueDraft(h, repo, draft, prompt, 'feature').code, 0)
  write(draft, `Title: Let shutdown() take a join timeout
Labels: enhancement

### Problem
Callers cannot bound how long shutdown() blocks, so a stuck worker stalls process exit indefinitely.

### Version
2.3.1

### Proposed solution
shutdown(timeout=None) returns once every worker has stopped or the timeout has passed, whichever is first.
`)
  let r = run(h, ['written', '--batch', 'i1']); assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /Sections the cached prompt asks for/)   // no bug section is demanded of a feature
  assert.doesNotMatch(r.out, /not in this repo's vocabulary/)
  // drop the shared Version section: it applies to every kind and is reported missing
  write(draft, fs.readFileSync(draft, 'utf8').replace('### Version\n2.3.1\n\n', ''))
  run(h, ['revised', '--batch', 'i1', '--changed', 'yes'])
  run(h, ['revised', '--batch', 'i1', '--changed', 'no']); r = run(h, ['revised', '--batch', 'i1', '--changed', 'no'])
  assert.match(r.out, /THE CHECKS REJECTED THIS DRAFT/); assert.match(r.out, /and the repository\./)
  assert.match(r.out, /asks for that are not in your draft:\n {2}- ### Version/)
})

// --------------------------------------------------------- commit domain ----
// The same driver, told --domain commit: its own cache root and state directory, commitlint and the
// commit template in the sources hash, `source_commits` and CHECKED_COMMITS with SHAs matched by
// prefix, and the terminal-side checks - a subject ceiling, a wrap column, required trailers,
// Label:-style body parts, no markdown - in place of the browser-side permalink rules.

const CSCHEMA = path.join(__dirname, '..', 'skills', 'draft-commit-message', 'schema.md')
const CLEARN = path.join(__dirname, '..', 'skills', 'draft-commit-message', 'learn.md')

const COMMIT_PROMPT = (extra) => `---
learned_at: ${today()}
source_commits: [a1b2c3d, b2c3d4e, c3d4e5f]
contributors: [alice, bob]
pattern: derived
max_bytes: 1200
title_max: 60
wrap_at: 72
${extra || ''}---

## Title
\`<component>: <imperative clause>\` - lowercase component, no period, under 60 characters:
\`pool: join workers on shutdown\`, \`cli: drop the --legacy flag\`.  <!-- covers: summary -->

## Body
A body on every change that is not a typo fix, wrapped at 72, opening with the reason.
### \`Problem:\`  <!-- covers: motivation -->
One paragraph: what was wrong and why it mattered.
### \`Solution:\`
One paragraph: what was done and what was rejected.
The issue as \`Fixes #N\` on its own line after the body, before any trailer, when one exists.  <!-- covers: references -->

## Trailers
- \`Signed-off-by:\` required - CONTRIBUTING "Sign your work"
- \`Co-authored-by:\` optional - human pair authors only

## Style
Subject says what, body says why. Never narrate the diff. \`path:line\` is fine; no markdown, no permalinks.
Median body 6 lines, middle half 3-11.

## Notes
Reverts use git's own \`Revert "<subject>"\` form with the original SHA in the body.
`

function startCommitBuild(h, batch, cache) {
  return run(h, ['start', '--domain', 'commit', '--batch', batch, '--cache', cache, '--schema', CSCHEMA, '--learn', CLEARN,
                 '--nwo', 'o/r', '--host', 'github.com', '--root', h])
}
function startCommitDraft(h, repo, draft, prompt, files, batch) {
  // The exit code is asserted here because `start` saves state BEFORE it validates the prompt: a
  // refused start still leaves a usable batch, so every later step passes and a test that only
  // checks those steps never notices the refusal.
  const r = run(h, ['start', '--domain', 'commit', '--batch', batch || 'c1', '--mode', 'draft', '--draft', draft, '--prompt', prompt,
                    '--files', files, '--root', repo])
  assert.equal(r.code, 0, r.out)
  return r
}

test('commit gate: source_commits with SHAs, and the PR gate rejects a commit prompt', () => {
  const h = tmp(); const p = path.join(h, 'p.md'); write(p, COMMIT_PROMPT())
  let r = run(h, ['gate', '--domain', 'commit', '--draft', p, '--schema', CSCHEMA])
  assert.equal(r.code, 0, r.out); assert.match(r.out, /GATE: pass/)
  write(p, COMMIT_PROMPT().replace('<!-- covers: references -->', ''))
  r = run(h, ['gate', '--domain', 'commit', '--draft', p, '--schema', CSCHEMA])
  assert.equal(r.code, 5); assert.match(r.out, /not covered:\n {2}- references/)
  write(p, COMMIT_PROMPT())
  r = run(h, ['gate', '--draft', p, '--schema', CSCHEMA]); assert.equal(r.code, 5); assert.match(r.out, /`source_prs` is missing/)
})

test('commit resolve: its own cache root; commitlint, the template and a commit-msg hook in the sources hash', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  let r = run(h, ['resolve', '--domain', 'commit', '--root', repo])
  assert.equal(r.code, 0, r.out); assert.match(r.stdout, /^DOMAIN='commit'$/m)
  assert.match(r.stdout, new RegExp(`^CACHE='${path.join(h, '.claude/commit-style-cache/github.com/o/r.md')}'$`, 'm'))
  assert.match(r.stdout, /^SOURCES_HASH='none'$/m)
  // neither a PR template nor an issue form touches the commit hash
  write(path.join(repo, '.github', 'PULL_REQUEST_TEMPLATE.md'), '## Why\n')
  write(path.join(repo, '.github', 'ISSUE_TEMPLATE', 'bug.yml'), 'name: Bug\n')
  assert.match(run(h, ['resolve', '--domain', 'commit', '--root', repo]).stdout, /^SOURCES_HASH='none'$/m)
  const hashes = []
  for (const [f, body] of [['commitlint.config.js', 'module.exports = {}'], ['.gitmessage', '\n# subject\n'],
                           ['.husky/commit-msg', 'npx commitlint --edit $1'], ['.github/workflows/dco.yml', 'name: dco\n']]) {
    write(path.join(repo, f), body)
    hashes.push(/SOURCES_HASH='([0-9a-f]+)'/.exec(run(h, ['resolve', '--domain', 'commit', '--root', repo]).stdout)[1])
  }
  assert.equal(new Set(hashes).size, 4, 'each file changes the hash: ' + hashes.join(' '))
  // and the PR hash saw commitlint but not the template, the hook or the DCO workflow
  const prHash = /SOURCES_HASH='([0-9a-f]+)'/.exec(run(h, ['resolve', '--root', repo]).stdout)[1]
  assert.notEqual(prHash, 'none'); assert.notEqual(prHash, hashes[3])
})

test('commit build: SHAs in the result, CHECKED_COMMITS matched by prefix, PR header refused', () => {
  const h = tmp(); const cache = path.join(h, '.claude/commit-style-cache/github.com/o/r.md'); const work = cache + '.work.cb1'
  let r = startCommitBuild(h, 'cb1', path.join(h, '.claude/pr-style-cache/github.com/o/r.md'))
  assert.equal(r.code, 2); assert.match(r.out, /inside ~\/.claude\/commit-style-cache/)
  r = startCommitBuild(h, 'cb1', cache); assert.equal(r.code, 0, r.out); assert.match(r.out, /write a commit message in that repo/)
  assert.ok(fs.existsSync(path.join(h, '.claude/draft-commit-message/state/cb1.state.json')))

  write(work, COMMIT_PROMPT())
  r = run(h, ['drafted', '--batch', 'cb1']); assert.equal(r.code, 0, r.out); assert.match(r.out, /a staged diff/)
  run(h, ['critiqued', '--batch', 'cb1', '--issues', '0']); run(h, ['critiqued', '--batch', 'cb1', '--issues', '0'])
  assert.match(run(h, ['handed-off', '--batch', 'cb1']).out, /FINAL STATE: built derived/)
  const res = JSON.parse(run(h, ['result', '--batch', 'cb1']).stdout)
  assert.equal(res.domain, 'commit'); assert.deepEqual(res.sourceCommits, ['a1b2c3d', 'b2c3d4e', 'c3d4e5f'])

  const report = path.join(h, 'report.txt')
  // the PR header on a commit build is not a report for this build
  write(report, 'VERDICT: sound\nCHECKED_PRS: 1, 2, 3\nFINDINGS:\n')
  assert.equal(run(h, ['verified', '--batch', 'cb1', '--report-file', report]).code, 2)
  // a full SHA of a sampled commit is the same commit, so only 0 are outside
  write(report, 'VERDICT: sound\nCHECKED_COMMITS: a1b2c3d0123456789abcdef0123456789abcdef0, B2C3D4E\nFINDINGS:\n')
  r = run(h, ['verified', '--batch', 'cb1', '--report-file', report]); assert.equal(r.code, 3); assert.match(r.out, /checked 2 commit\(s\), of which only 0/)
  // two others, one quoted twice in different lengths, count as two
  write(report, 'VERDICT: sound\nCHECKED_COMMITS: a1b2c3d, deadbee, deadbeef01, f00dcafe\nFINDINGS:\n  - [worth-fixing] ## Title: example predates the prefix  (evidence: deadbee)\n')
  r = run(h, ['verified', '--batch', 'cb1', '--report-file', report]); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /RECORDED verdict=sound blocking=0 checked_prs=3/)
  r = run(h, ['publish', '--batch', 'cb1']); assert.equal(r.code, 0, r.out)
  const fm = fs.readFileSync(cache, 'utf8').split('\n---\n')[0]
  assert.match(fm, /^source_commits: \[a1b2c3d/m); assert.match(fm, /^wrap_at: 72$/m); assert.match(fm, /^title_max: 60$/m)
})

test('commit draft checks: trailer, wrap, # line, label part, subject ceiling; path:line is fine', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  const prompt = path.join(h, 'prompt.md'); write(prompt, COMMIT_PROMPT())
  const files = path.join(h, 'files.txt'); write(files, 'src/pool.py\n')
  const draft = path.join(h, 'draft.md')
  let r = startCommitDraft(h, repo, draft, prompt, files)
  assert.equal(r.code, 0, r.out); assert.match(r.out, /WRITE THE COMMIT MESSAGE/); assert.match(r.out, /path\/to\/file\.py:42` is fine here/)
  assert.doesNotMatch(r.out, /PERMALINKS/)
  write(draft, `Title: pool: join every worker on shutdown so that the process can finally exit cleanly

# Why
Problem: workers still mid-handshake in \`src/pool.py:12\` kept the process alive after shutdown() returned, which is bad.
See also \`tests/test_pool.py\`.

Solution: join them.
`)
  r = run(h, ['written', '--batch', 'c1']); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /The subject is 8\d characters against this repo's guide of 60/)
  assert.match(r.out, /Lines beginning with # \(# Why\)/)
  assert.match(r.out, /Trailers this repo requires that are not in the draft: Signed-off-by:/)
  assert.match(r.out, /1 line\(s\) run past the 72-column wrap/)
  assert.match(r.out, /do not exist in this repository at all[\s\S]*tests\/test_pool\.py/)
  assert.doesNotMatch(r.out, /references code as/); assert.doesNotMatch(r.out, /permalink/i)
  assert.match(r.out, /git blame/)

  write(draft, `Title: pool: join workers on shutdown

Problem: workers still mid-handshake kept the process alive after
shutdown() returned, so a clean exit hung until the handshake timed out.

Solution: stop() then join() each worker (src/pool.py:12), bounded by
the existing 5s timeout. Draining the queue first was rejected: it
reorders in-flight requests.

Fixes #42

Signed-off-by: Alice <alice@example.com>
`)
  run(h, ['revised', '--batch', 'c1', '--changed', 'yes'])
  r = run(h, ['revised', '--batch', 'c1', '--changed', 'no']); assert.match(r.out, /GO AGAIN/); assert.match(r.out, /git log --oneline/)
  r = run(h, ['revised', '--batch', 'c1', '--changed', 'no'])
  assert.match(r.out, /LAST READ/); assert.match(r.out, /every part the prompt asks for present/); assert.match(r.out, /in one fenced block/)
  assert.match(run(h, ['finished', '--batch', 'c1']).out, /FINAL STATE: drafted/)
})

test('commit draft: a prose prompt with no labelled parts is a shape, an empty one is not', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  const files = path.join(h, 'files.txt'); write(files, 'src/pool.py\n')
  const fm = `---\nlearned_at: ${today()}\nsource_commits: [a1b2c3d, b2c3d4e]\ncontributors: [alice]\npattern: derived\nmax_bytes: 600\n---\n`
  // What learn.md tells the builder to write for a repo whose bodies are prose: plain `##` headings,
  // no `### \`Label:\`` parts, the fields claimed by covers-comments. Most repos are this one.
  const prose = path.join(h, 'prose.md')
  write(prose, fm + '\n## Title\n`<component>: <clause>`  <!-- covers: summary -->\n\n## Body\nA paragraph on why.  <!-- covers: motivation -->\n`Fixes #N` when there is one.  <!-- covers: references -->\n')
  assert.equal(run(h, ['start', '--domain', 'commit', '--batch', 'p1', '--mode', 'draft', '--draft', path.join(h, 'd1.md'),
                       '--prompt', prose, '--files', files, '--root', repo]).code, 0)

  // Frontmatter and prose, but nothing that says what the message must carry: still refused.
  const empty = path.join(h, 'empty.md'); write(empty, fm + '\n## Title\nSomething about subjects.\n\n## Body\nSomething about bodies.\n')
  const r = run(h, ['start', '--domain', 'commit', '--batch', 'p2', '--mode', 'draft', '--draft', path.join(h, 'd2.md'),
                    '--prompt', empty, '--files', files, '--root', repo])
  assert.equal(r.code, 2); assert.match(r.out, /neither a readable learned prompt nor a canonical schema/)
})

test('commit draft: a missing labelled part is reported by its label; a one-liner passes a prompt that allows one', () => {
  const h = tmp(); const repo = path.join(h, 'r'); gitRepo(repo, 'git@github.com:o/r.git')
  const files = path.join(h, 'files.txt'); write(files, 'src/pool.py\n')
  const prompt = path.join(h, 'prompt.md'); write(prompt, COMMIT_PROMPT())
  const draft = path.join(h, 'draft.md'); startCommitDraft(h, repo, draft, prompt, files)
  write(draft, `Title: pool: join workers on shutdown\n\nWorkers kept the process alive. Problem: solved.\n\nSigned-off-by: A <a@x>\n`)
  let r = run(h, ['written', '--batch', 'c1'])
  assert.match(r.out, /asks for that are not in your draft:\n {2}- Problem:\n {2}- Solution:/)

  const flat = path.join(h, 'flat.md')
  write(flat, `---\nlearned_at: ${today()}\nsource_commits: [a1b2c3d, b2c3d4e]\ncontributors: [alice]\npattern: derived\nmax_bytes: 600\n---\n\n## Title\n\`<component>: <clause>\`  <!-- covers: summary -->\n\n## Body\nOne-liners for typo and comment fixes; otherwise a paragraph on why.  <!-- covers: motivation -->\n\`Fixes #N\` when there is one.  <!-- covers: references -->\n\n## Style\nWhat in the subject, why in the body.\n`)
  const d2 = path.join(h, 'd2.md'); startCommitDraft(h, repo, d2, flat, files, 'c2')
  write(d2, 'Title: pool: fix typo in shutdown comment\n')
  r = run(h, ['written', '--batch', 'c2']); assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /Structural problems/); assert.doesNotMatch(r.out, /under \d+ bytes/)
  run(h, ['revised', '--batch', 'c2', '--changed', 'no'])
  assert.match(run(h, ['revised', '--batch', 'c2', '--changed', 'no']).out, /LAST READ/)
})
