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

test('review-and-fix-pr passes the whole-PR skill contract and documents advanced arguments', () => {
  const skill = rd('skills/review-and-fix-pr/SKILL.md')
  const ref = rd('skills/review-and-fix-pr/reference.md')
  for (const arg of ['pr', 'pluginRoot', 'reviewSkill', 'fix']) {
    assert.match(skill, new RegExp('^\\s+' + arg + ':', 'm'), `SKILL.md no longer passes ${arg}`)
  }
  assert.match(skill, /`reference\.md`/, 'SKILL.md does not point at reference.md')
  for (const arg of ['detailedReview', 'maxTokens', 'maxAgents', 'maxFixBatch']) {
    assert.match(ref, new RegExp('\\| `' + arg + '` \\|'), `reference.md does not document ${arg}`)
    assert.doesNotMatch(skill, new RegExp('\\| `' + arg + '` \\|'), `SKILL.md still carries the ${arg} row`)
  }
})

test('review-and-fix-pr uses one read-only whole-PR reviewer and fails closed on selected skills', () => {
  const wf = rd('workflows/review-and-fix-pr.js')
  assert.match(wf, /const RESOLVED_MODE = 'full'/)
  assert.match(wf, /const REVIEW_SKILL =/)
  assert.match(wf, /invoke that exact skill through the Skill tool/)
  assert.match(wf, /disallowedTools: DENY_READONLY, requireToolScope: true/)
  assert.match(wf, /required read-only tool scope is unavailable - refusing to launch this agent/)
  assert.match(wf, /review-skill-unavailable/)
  assert.match(wf, /Do not silently substitute your own review or another skill/)
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
