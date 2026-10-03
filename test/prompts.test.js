'use strict'
// The prompt text itself, checked the way the code is. Moving the learn loop out of the three draft
// skills into shared/learn-loop.md put a pointer where a procedure used to be: nothing at runtime
// notices a pointer that goes nowhere, or a binding the shared file expects and no skill sets, until
// a cache miss in somebody's repo months later. These tests are that notice.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const DRAFT_SKILLS = ['draft-pr-description', 'draft-issue-description', 'draft-commit-message']
const LEARN_LOOP = 'shared/learn-loop.md'

test('every draft skill points at the shared learn loop and binds what it expects', () => {
  const loop = rd(LEARN_LOOP)
  // The bindings the shared file documents in its own table, so adding one there fails here until
  // all three skills set it.
  const expected = [...loop.matchAll(/^\| `\$(\w+)` \|/gm)].map((m) => m[1])
  assert.deepEqual(expected, ['BUILDER', 'VERIFIER', 'ARTIFACT', 'SAMPLES'])
  for (const s of DRAFT_SKILLS) {
    const t = rd(path.join('skills', s, 'SKILL.md'))
    assert.match(t, new RegExp('\\$\\{CLAUDE_PLUGIN_ROOT\\}/' + LEARN_LOOP.replace('/', '\\/')),
                 `${s} does not read ${LEARN_LOOP}`)
    for (const b of expected) {
      assert.match(t, new RegExp('`\\$' + b + '` = '), `${s} does not bind $${b}`)
    }
  }
})

test('the shared learn loop uses only variables a skill has in hand by then', () => {
  // Step 1 exports these through `eval "$(promptgen-driver resolve ...)"`; the skill's own header
  // sets the four paths; the loop sets BATCH and WORK itself. Anything else is a typo that would
  // expand to nothing inside an agent prompt.
  const known = new Set(['BUILDER', 'VERIFIER', 'ARTIFACT', 'SAMPLES', 'DRIVER', 'SCHEMA', 'LEARN',
                         'VERIFY', 'DOMAIN', 'ROOT', 'NWO', 'HOST', 'CACHE', 'CACHE_EXISTS',
                         'BATCH', 'WORK', 'CLAUDE_PLUGIN_ROOT'])
  const used = new Set([...rd(LEARN_LOOP).matchAll(/\$\{?([A-Z][A-Z_]*)\}?/g)].map((m) => m[1]))
  const unknown = [...used].filter((v) => !known.has(v))
  assert.deepEqual(unknown, [], 'undefined variables in ' + LEARN_LOOP)
})

test('the learn loop lives outside the skills, so none of them carries a second copy', () => {
  for (const s of DRAFT_SKILLS) {
    const t = rd(path.join('skills', s, 'SKILL.md'))
    assert.doesNotMatch(t, /^### 2[a-e]\./m, `${s} still has the inlined learn steps`)
    assert.doesNotMatch(t, /\$DRIVER" (result|verified|publish|abandon|reopen)/,
                        `${s} still runs a build verb itself`)
  }
})

test('review-and-fix-pr is a stateless parent-session procedure with direct preflight', () => {
  const skill = rd('skills/review-and-fix-pr/SKILL.md')
  const ref = rd('skills/review-and-fix-pr/reference.md')

  assert.match(skill, /parent session/i)
  for (const command of ['git rev-parse', 'git status --porcelain', 'git merge-base',
                         'git log', 'gh pr view']) {
    assert.match(skill, new RegExp(command.replaceAll(' ', '\\s+')),
                 `SKILL.md does not run ${command} directly`)
  }
  assert.match(skill, /^git [^\n]*\bdiff --no-color --no-ext-diff --no-textconv/m,
    'SKILL.md does not run the canonical diff directly')
  const scopeCall = skill.indexOf('review-and-fix-pr-scope.js')
  const mergeBaseCall = skill.indexOf("git merge-base")
  assert.ok(scopeCall >= 0 && scopeCall < mergeBaseCall,
            'scope helper must fetch exact OIDs before the direct merge-base check')
  assert.match(skill, /review-and-fix-pr-diff\.js/)
  assert.match(skill, /originalPrHead[\s\S]{0,200}reviewTargetHead/)
  assert.match(skill, /Before reporting[\s\S]{0,300}git status --porcelain/)
  assert.match(skill, /untrusted review evidence/)
  assert.match(skill, /`reference\.md`/, 'SKILL.md does not point at reference.md')

  for (const text of [skill, ref]) {
    assert.doesNotMatch(text, /Workflow\s*\(/, 'review still delegates orchestration to Workflow')
    assert.doesNotMatch(text, /stopAt|severityWeights|maxTokens|token (?:limit|meter|budget)|budget control/i,
                        'review still exposes internal budget controls')
    assert.doesNotMatch(text, /review-and-fix-pr-state|\b(?:checkpoint|resume|nonce|lease)\b|journal import/i,
                        'review still carries durable execution state')
  }
})

test('review-and-fix-pr controller routes optional work without skipping core lanes', () => {
  const procedure = rd('skills/review-and-fix-pr/SKILL.md') + '\n' +
    rd('skills/review-and-fix-pr/reference.md')

  assert.match(procedure, /(?:lane|review) controller/i)
  assert.match(procedure, /(?:cannot|must not|never) skip[\s\S]{0,200}(?:mandatory|core) (?:lane|review)/i)
  const coreLanes = [
    /root[ -]cause\s*\/\s*fix[ -]completeness/i,
    /correctness\s*\/\s*dataflow/i,
    /lifecycle\s*\/\s*concurrency\s*\/\s*reliability/i,
    /tests\s*\/\s*reproduction/i,
    /contracts\s*\/\s*compatibility\s*\/\s*risk/i,
    /standards\s*\/\s*docs\s*\/\s*maintainability/i,
  ]
  for (const lane of coreLanes) {
    assert.match(procedure, lane, `mandatory ${lane} lane is missing`)
  }
  assert.match(procedure, /root cause/i)
  assert.match(procedure, /(?:complete|partial|not-fixed|cannot-prove|new-regression)/i)
  assert.match(procedure, /fix_completeness:[\s\S]{0,300}original_failure_or_obligation/)
  assert.match(procedure, /(?:coverage audit|coverage auditor)/i)
  assert.match(procedure, /(?:gap pass|gap review|gap wave|targeted gap)/i)
  assert.match(procedure, /conservative(?:ly)? (?:cluster|deduplicat)|merge candidates only/i)
  assert.match(procedure, /independent verif/i)
  assert.match(procedure, /challenge[\s\S]{0,160}(?:reject|critical|high)|(?:reject|critical|high)[\s\S]{0,160}challenge/i)
})

test('review-and-fix-pr verifies candidates, can fix and rereview, and emits the exact marker', () => {
  const procedure = rd('skills/review-and-fix-pr/SKILL.md') + '\n' +
    rd('skills/review-and-fix-pr/reference.md')

  assert.match(procedure, /fix(?:es|ing)? (?:are|is )?optional|only (?:edit|fix)[\s\S]{0,100}(?:asked|authorized)/i)
  assert.match(procedure, /(?:after|following)[\s\S]{0,120}(?:fix|commit)[\s\S]{0,160}(?:rerun|re-run|rereview|re-review)/i)
  assert.match(procedure, /REVIEW_AND_FIX_PR_RESULT_JSON=/)
  assert.match(procedure, /exactly one/i)
  assert.match(procedure, /(?:final|last) (?:non-empty )?line/i)
  assert.match(procedure, /(?:compact|single-line|one-line) JSON/i)
  assert.match(procedure,
    /"completedLenses":\["correctness","spec","standards","security","reliability","contracts","testing","performance","comments","maintainability"\]/,
    'benchmark v1 marker must retain ten methodology IDs rather than six execution-lane IDs')
})

test('native lens prompt assets exist and stay methodology-only', () => {
  const lenses = ['correctness', 'spec', 'standards', 'security', 'reliability', 'contracts',
                  'testing', 'performance', 'comments', 'maintainability']
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'skills/review-and-fix-pr/lenses')).sort(),
                   lenses.map(lens => `${lens}.md`).sort())
  for (const lens of lenses) {
    const text = rd(`skills/review-and-fix-pr/lenses/${lens}.md`)
    assert.match(text, new RegExp('^# ', 'm'), `${lens} has no heading`)
    assert.doesNotMatch(text, /git (?:commit|push|reset)|Workflow\(|threshold/i,
                        `${lens} owns orchestration instead of review methodology`)
  }
})

test('nothing injected into every session grew back', () => {
  // Frontmatter descriptions are the only part of this plugin that is in context whether or not it
  // is used, so they are the bytes worth a ceiling. Skills and agents are budgeted apart: a skill's
  // description has to carry its trigger phrases, an agent's only has to say what it is for.
  const sum = (files) => files.reduce((n, f) => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(rd(f))
    const d = /^description:\s*([\s\S]*?)(?=\n[\w-]+:|$)/m.exec(m[1])
    return n + d[1].trim().length
  }, 0)
  const skills = fs.readdirSync(path.join(ROOT, 'skills')).map((d) => path.join('skills', d, 'SKILL.md'))
  const agents = fs.readdirSync(path.join(ROOT, 'agents')).map((f) => path.join('agents', f))
  assert.ok(sum(skills) <= 2500, `skill descriptions are ${sum(skills)} bytes, over the 2500 ceiling`)
  assert.ok(sum(agents) <= 1400, `agent descriptions are ${sum(agents)} bytes, over the 1400 ceiling`)
})

test('a skill body stays under the size a whole invocation pays for it', () => {
  // Read in full every time the skill runs, unlike learn.md/verify.md/schema.md (a subagent's
  // context) and reference.md (read on demand). A rule that has to be stated belongs in one of
  // those unless it is needed on every run.
  for (const d of fs.readdirSync(path.join(ROOT, 'skills'))) {
    const bytes = rd(path.join('skills', d, 'SKILL.md')).length
    assert.ok(bytes <= 13000, `skills/${d}/SKILL.md is ${bytes} bytes, over the 13000 ceiling`)
  }
})
