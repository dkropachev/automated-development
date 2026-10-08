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

test('review-and-fix-pr uses one dedicated structurally read-only lane controller', () => {
  const skill = rd('skills/review-and-fix-pr/SKILL.md')
  const ref = rd('skills/review-and-fix-pr/reference.md')
  const readme = rd('README.md')
  const agent = rd('agents/review-lane-controller.md')
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(agent)
  assert.ok(frontmatter, 'review-lane-controller agent has no frontmatter')

  const field = (name) => {
    const match = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(frontmatter[1])
    assert.ok(match, `review-lane-controller frontmatter has no ${name}`)
    return match[1].trim()
  }
  const csv = (name) => field(name).split(',').map((value) => value.trim())

  assert.equal(field('name'), 'review-lane-controller')
  assert.deepEqual(csv('tools'), ['Read', 'Grep', 'Glob'],
    'controller must have only structural read/search tools')
  assert.deepEqual(csv('disallowedTools'),
    ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'WebFetch', 'WebSearch'],
    'controller must explicitly deny execution, writes, nested agents, and web access')

  const agentType = 'automated-development:review-lane-controller'
  for (const [name, text] of [['SKILL.md', skill], ['reference.md', ref], ['README.md', readme]]) {
    const occurrences = text.split(agentType).length - 1
    assert.equal(occurrences, 1,
      `${name} must name the exact typed controller exactly once, found ${occurrences}`)
  }
  const skillInvocation =
    /Before any discovery agent, invoke exactly one\s+`automated-development:review-lane-controller` per review cycle/i
  const refInvocation =
    /At the start of every review cycle, after freezing scope and building the canonical inventory but\s+before discovery, invoke exactly one agent of type\s+`automated-development:review-lane-controller`/i
  assert.equal((skill.match(new RegExp(skillInvocation.source, 'gi')) || []).length, 1,
    'SKILL.md must invoke the typed controller exactly once per cycle and before discovery')
  assert.equal((ref.match(new RegExp(refInvocation.source, 'gi')) || []).length, 1,
    'reference.md must place one typed controller after inventory and before discovery')
  assert.ok(skill.indexOf('## 1. Preflight and inventory') < skill.search(skillInvocation) &&
    skill.search(skillInvocation) < skill.indexOf('## 3. Audit coverage'),
    'SKILL.md must order inventory, controller routing, then discovery coverage audit')
  assert.match(skill,
    /This is a new\s+review cycle, so invoke exactly one fresh typed controller before its discovery/i,
    'a post-fix rerun must start a new cycle with exactly one fresh controller')

  const skillRoute = skill.slice(skill.indexOf('## 2. Route, then discover in parallel'),
    skill.indexOf('## 3. Audit coverage'))
  const refRoute = ref.slice(ref.indexOf('## Lane controller'),
    ref.indexOf('## Core lane instructions'))
  const readmeRoute = readme.slice(readme.indexOf('Exactly once per review cycle'),
    readme.indexOf('These six core lanes'))
  const failureRules = [
    ['SKILL.md', skillRoute,
      /If this typed agent is unavailable or malformed, fail with\s+`lane-error`; do not use a generic agent, retry a controller, or route the lanes yourself\./gi],
    ['reference.md', refRoute,
      /If the typed agent is unavailable or its response is malformed, stop the\s+review with `lane-error`; never fall back to a generic agent, a second controller invocation, or\s+parent-authored routing\./gi],
    ['README.md', readmeRoute,
      /a missing or malformed response fails the review instead of\s+falling back to a generic agent\./gi],
    ['review-lane-controller.md', agent,
      /Missing or malformed input is a controller failure;\s+return exactly `CONTROLLER_INPUT_ERROR` so the parent rejects the response as malformed\. Never\s+invent missing input, recommend a generic agent, or imply a degraded review\./gi],
  ]
  const contradictions = [
    ['generic-agent fallback', /\b(?:generic|general-purpose|default) agent\b/i],
    ['fallback', /\bfall\s+back\b|\bfallback\b/i],
    ['controller retry', /\b(?:retry|re-?invoke|try)\b[^\n]{0,80}\bcontroller\b/i],
    ['an extra controller', /\b(?:another|second|additional|extra) controller\b/i],
    ['a repeated controller',
      /\b(?:invoke|launch|run|call)\b[^\n]{0,80}\bcontroller\b[^\n]{0,30}\bagain\b/i],
    ['a second controller invocation', /\b(?:another|second) controller invocation\b/i],
    ['a degraded review', /\bdegraded review\b/i],
    ['parent-authored routing', /\broute the lanes yourself\b|\bparent[- ]authored routing\b/i],
    ['synthesized routing',
      /\b(?:synthesi[sz]\w*|author|build|compose|create|generate|invent)\b[^\n]{0,60}\b(?:routing|route|lane map)\b/i],
  ]
  for (const [name, section, failureRule] of failureRules) {
    const rules = [...section.matchAll(failureRule)]
    assert.equal(rules.length, 1,
      `${name} must have exactly one complete fail-closed controller rule`)
    const residual = section.replace(failureRule, '')
    for (const [kind, pattern] of contradictions) {
      assert.doesNotMatch(residual, pattern, `${name} permits ${kind}`)
    }
  }
})

test('review lane controller requires the complete frozen routing input', () => {
  const prompts = [
    ['SKILL.md', rd('skills/review-and-fix-pr/SKILL.md')],
    ['reference.md', rd('skills/review-and-fix-pr/reference.md')],
    ['review-lane-controller.md', rd('agents/review-lane-controller.md')],
  ]
  const inputs = [
    ['frozen PR intent', /frozen PR\s+intent/i],
    ['acceptance criteria', /acceptance criteria/i],
    ['canonical diff inventory', /canonical\s+(?:diff\s+)?inventory/i],
    ['missing-source indicators', /missing-source\s+(?:indicators?|counters?)/i],
    ['ten methodology mappings',
      /(?:(?:exact|all)\s+)?ten[- ]methodolog(?:y|ies)(?:-to-lane)?(?:\s+to the six\s+mandatory lanes)?\s+mappings?/i],
  ]
  for (const [name, text] of prompts) {
    for (const [input, pattern] of inputs) {
      assert.match(text, pattern, `${name} does not require ${input}`)
    }
  }
})

test('controller input failure stops before discovery and projects onto schema v2', () => {
  const ref = rd('skills/review-and-fix-pr/reference.md')
  const agent = rd('agents/review-lane-controller.md')
  const section = ref.slice(ref.indexOf('## Lane controller'),
    ref.indexOf('## Core lane instructions'))

  assert.match(section,
    /before discovery, invoke exactly one agent of type\s+`automated-development:review-lane-controller`/i,
    'the parent must make only one controller invocation before discovery')
  assert.match(section,
    /Validate the complete controller input package before invocation\./,
    'the parent must validate the complete input package before that invocation')

  for (const [name, text] of [['reference.md', section], ['review-lane-controller.md', agent]]) {
    assert.equal(text.split('CONTROLLER_INPUT_ERROR').length - 1, 1,
      `${name} must name the input-error sentinel exactly once`)
  }
  assert.match(agent,
    /Missing or malformed input is a controller failure;\s+return exactly `CONTROLLER_INPUT_ERROR` so the parent rejects the response as malformed\. Never\s+invent missing input/i,
    'the controller must return only the sentinel for invalid input and the parent must reject it')
  assert.match(section,
    /missing or malformed input, it returns `CONTROLLER_INPUT_ERROR`; this deliberately fails the route\s+schema and takes the same `lane-error` path instead of synthesizing missing evidence\./i,
    'the sentinel must fail routing closed without synthesized evidence')
  const projection =
    /On controller failure, discovery does not begin\. Report `coverage: incomplete-lens`,\s+`verification: none`, `stopReason: lane-error`, empty `completedLenses` and `failedLenses`, and\s+`skippedLenses: \[([^\]]+)\]` in the schema-v2 result contract\./.exec(section)
  assert.ok(projection, 'controller failure must retain the exact schema-v2 failure projection')
  assert.deepEqual(projection[1].replace(/\s+/g, ' ').split(', '),
    ['correctness', 'spec', 'standards', 'security', 'reliability', 'contracts', 'testing',
      'performance', 'comments', 'maintainability'],
    'controller failure must skip all ten stable methodology IDs')
})

test('review lane controller emits only the exact routing schema and methodology assignments', () => {
  const sources = [
    ['reference.md', rd('skills/review-and-fix-pr/reference.md'),
      'The controller returns exactly one YAML mapping'],
    ['review-lane-controller.md', rd('agents/review-lane-controller.md'),
      'Return routing only'],
  ]
  const expectedKeys = ['intent', 'risk_map', 'lane_focus', 'optional_specialists', 'cross_cutting']
  const mappings = [
    ['root-cause / fix-completeness', ['spec']],
    ['correctness / dataflow', ['correctness']],
    ['lifecycle / concurrency / reliability', ['reliability']],
    ['tests / reproduction', ['testing']],
    ['contracts / compatibility / risk', ['security', 'contracts', 'performance']],
    ['standards / docs / maintainability', ['standards', 'comments', 'maintainability']],
  ]

  for (const [name, text, anchor] of sources) {
    const start = text.indexOf(anchor)
    assert.notEqual(start, -1, `${name} has no routing-schema introduction`)
    const fence = /```yaml\n([\s\S]*?)\n```/.exec(text.slice(start))
    assert.ok(fence, `${name} has no routing YAML schema`)
    const yaml = fence[1]
    const lines = yaml.split('\n')
    const shape = lines.map((line) => {
      const match = /^(\s*)(-\s+)?([^:{}]+?):(?:\s*(.*))?$/.exec(line)
      if (!match) return false
      const value = (match[4] || '').trim()
      const kind = value === '' ? 'mapping'
        : value.startsWith('[') ? 'sequence'
          : value.startsWith('{') ? 'inline-mapping' : 'scalar'
      return [match[1].length, Boolean(match[2]), match[3], kind]
    }).filter(Boolean)
    const field = (indent, key, kind = 'mapping', list = false) =>
      [indent, list, key, kind]
    const expectedShape = [
      field(0, expectedKeys[0]),
      field(2, 'claimed_problem', 'scalar'),
      field(2, 'acceptance_criteria', 'sequence'),
      field(0, expectedKeys[1]),
      field(2, 'surface', 'scalar', true),
      field(4, 'risks', 'sequence'),
      field(0, expectedKeys[2]),
      ...mappings.map(([lane]) => field(2, lane, 'inline-mapping')),
      field(0, expectedKeys[3]),
      field(2, 'specialist', 'scalar', true),
      field(4, 'reason', 'scalar'),
      field(4, 'surface', 'scalar'),
      field(0, expectedKeys[4]),
      field(2, 'interactions', 'sequence'),
      field(2, 'subsystem_shards'),
      field(4, 'lane', 'scalar', true),
      field(6, 'subsystem', 'scalar'),
      field(6, 'reason', 'scalar'),
    ]
    assert.deepEqual(shape, expectedShape,
      `${name} routing schema must retain every exact nested field and no extras`)
    assert.match(yaml,
      /^ {2}# Optional; omit when no additive subsystem shard is useful\.\n {2}subsystem_shards:/m,
      `${name} must keep subsystem shards optional while retaining their schema`)

    for (const [lane, methodologies] of mappings) {
      const prefix = `  ${lane}: `
      const laneLine = lines.find((line) => line.startsWith(prefix))
      assert.ok(laneLine, `${name} is missing the ${lane} lane`)
      const assignment = /^\{methodologies: \[([^\]]*)\], priorities: \[[^\]]*\]\}$/
        .exec(laneLine.slice(prefix.length))
      assert.ok(assignment,
        `${name} must give ${lane} exactly methodologies and priorities`)
      assert.deepEqual(assignment[1].split(', '), methodologies,
        `${name} changed the methodology assignment for ${lane}`)
    }
  }
})

test('review lane controller can add depth but cannot review or narrow coverage', () => {
  const prompts = [
    ['reference.md', rd('skills/review-and-fix-pr/reference.md')],
    ['review-lane-controller.md', rd('agents/review-lane-controller.md')],
  ]
  for (const [name, text] of prompts) {
    assert.match(text,
      /(?:optional specialists and subsystem shards|specialist or shard)[\s\S]{0,60}additive/i,
      `${name} does not make specialists and shards additive-only`)
    assert.match(text, /(?:must not|do not)[\s\S]{0,80}(?:emit|produce)[\s\S]{0,100}findings/i,
      `${name} lets the controller produce findings`)
    assert.match(text, /(?:must not|do not)[\s\S]{0,80}(?:emit|produce)[\s\S]{0,180}verdicts/i,
      `${name} lets the controller produce verdicts`)
    assert.match(text, /(?:(?:do not|must not)[\s\S]{0,100}suppress|reject[\s\S]{0,320}suppresses)/i,
      `${name} lets the controller suppress a mandatory lane`)
    assert.match(text, /(?:(?:do not|must not)[\s\S]{0,120}replace|reject[\s\S]{0,340}replaces)/i,
      `${name} lets the controller replace a mandatory lane`)
    assert.match(text, /(?:(?:do not|must not)[\s\S]{0,160}narrow|reject[\s\S]{0,380}narrows)/i,
      `${name} lets the controller narrow mandatory coverage`)
  }
})

test('review-and-fix-pr controller routes optional work without skipping core lanes', () => {
  const procedure = rd('skills/review-and-fix-pr/SKILL.md') + '\n' +
    rd('skills/review-and-fix-pr/reference.md')

  assert.match(procedure, /(?:lane|review) controller/i)
  assert.match(procedure,
    /(?:cannot|must not|never)[\s\S]{0,100}skip[\s\S]{0,100}(?:mandatory|core) (?:lane|review)/i)
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
  assert.match(procedure, /form a canonical cluster only|merge only the same trigger or rule/i)
  assert.match(procedure, /required Codex adjudication/i)
  assert.match(procedure, /originating invocation cannot judge its own lead/i)
})

test('review-and-fix-pr adjudicates candidates, can fix and rereview, and emits the v3 marker', () => {
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
    'benchmark v3 marker must retain ten methodology IDs rather than six execution-lane IDs')
  assert.match(procedure, /"schemaVersion":3/)
  assert.match(procedure, /"candidateLedger":\[\]/)
  assert.match(procedure, /"newLeadResolutions":\[\]/)
  assert.match(procedure, /"provider":"openai","model":"gpt-5\.6-sol","reasoningEffort":"high"/)
  assert.match(procedure, /V1 and v2 manifests and result markers remain reader-compatible only/i)
})

test('every discovery lane receives exact delimited PR evidence instead of a summary', () => {
  const skill = rd('skills/review-and-fix-pr/SKILL.md')
  const ref = rd('skills/review-and-fix-pr/reference.md')
  const controller = rd('agents/review-lane-controller.md')
  for (const [name, text] of [['SKILL.md', skill], ['reference.md', ref],
    ['review-lane-controller.md', controller]]) {
    for (const [label, pattern] of [
      ['exact package', /exact delimited evidence package/i],
      ['PR title/body', /(?:verbatim )?PR\s+title(?:\/|,\s*)body|PR title\/body/i],
      ['commit messages', /commit messages|commit subjects and\s+bodies/i],
      ['repository identity', /repository\/remote\/upstream identity|repository identity[\s\S]{0,80}remote/i],
      ['canonical diff', /canonical patch and inventory|canonical patch\/inventory|canonical diff inventory and patch/i],
      ['base/head rules', /applicable (?:merge-)?base(?: and |\/)head rule/i],
    ]) assert.match(text, pattern, `${name} omits exact ${label}`)
  }
  for (const [name, text] of [['SKILL.md', skill], ['reference.md', ref]]) {
    assert.match(text, /every\s+mandatory lane and gap assignee/i, `${name} does not preserve evidence per lane`)
    assert.match(text, /summary[\s\S]{0,60}never\s+replac(?:e|es)[\s\S]{0,40}(?:truncate|truncates|full evidence)/i,
      `${name} permits lossy evidence summaries`)
    assert.match(text, /Exclude other reviewers' output, benchmark judgments, and sealed\s+baseline\s+issues/i,
      `${name} exposes benchmark answers to a review run`)
  }
})

test('discovery admits atomic candidates and retains checked nonissues only in coverage', () => {
  const procedure = rd('skills/review-and-fix-pr/SKILL.md') + '\n' +
    rd('skills/review-and-fix-pr/reference.md')
  for (const field of ['basisType', 'basis', 'mechanisms', 'consequence', 'defectClass', 'category',
                       'locations', 'evidence', 'sourceIds']) {
    assert.match(procedure, new RegExp(`\\b${field}\\"?:`), `candidate schema omits ${field}`)
  }
  assert.match(procedure, /`mechanisms` must contain exactly one item/i)
  assert.match(procedure, /Split a mixed row before admission|Split mixed claims/i)
  assert.match(procedure,
    /Merge repeated\s+instances only when basis\/trigger, mechanism, defect class, and consequence are the same/i)
  assert.match(procedure, /preserve\s+all locations, evidence, and source IDs/i)
  assert.match(procedure, /checked_nonissues"?:/)
  for (const kind of ['disproved', 'impact-free', 'inapplicable-rule', 'base-parity',
                      'counterfactual-design']) assert.match(procedure, new RegExp(kind))
  assert.match(procedure, /never enter paid Codex input|out of paid adjudication/i)
})

test('review category standards include nit and do not require runtime failure for semantic findings', () => {
  const ref = rd('skills/review-and-fix-pr/reference.md')
  assert.match(ref, /Severity is `critical\|high\|medium\|low\|nit`/)
  for (const category of ['runtime and security', 'docs and comments', 'tests', 'standards',
                          'maintainability']) {
    assert.match(ref, new RegExp(`- ${category}:`, 'i'), `missing ${category} admission standard`)
  }
  assert.match(ref, /Do not require a runtime failure from docs, tests, standards, or maintainability/i)
  for (const matrix of [
    /exception origin[\s\S]{0,100}destruction owner/i,
    /client\/server[\s\S]{0,100}close-before\/close-during\/close-after/i,
    /supported API\/version/i,
    /every touched line[\s\S]{0,100}casts/i,
    /duplicated comment\/helper\/implementation/i,
    /proliferating state/i,
    /reference\/container invalidation/i,
  ]) assert.match(ref, matrix)
})

test('standards and test lanes retain judgment-call discovery without routine nonissue prose', () => {
  const standards = rd('skills/review-and-fix-pr/lenses/standards.md')
  const testing = rd('skills/review-and-fix-pr/lenses/testing.md')
  const reference = rd('skills/review-and-fix-pr/reference.md')
  for (const smell of ['mysterious', 'duplicated', 'switches', 'wrappers']) {
    assert.match(standards, new RegExp(smell))
  }
  assert.match(testing, /unbounded waits that hide failures/)
  assert.match(testing, /hook setup, negotiation, and\s+fixture entry points differ/)
  assert.match(rd('skills/review-and-fix-pr/lenses/reliability.md'), /newly explicit wait/)
  assert.match(rd('skills/review-and-fix-pr/lenses/comments.md'), /hard assertion, abort, or hang/)
  assert.match(reference, /routine\s+passing checks as short coverage-unit and evidence IDs/)
  assert.match(reference, /Keep all screened lead reasons substantive/)
})

test('controller optional routing is distinct, nonduplicative, and keeps its YAML shape', () => {
  for (const [name, text] of [
    ['reference.md', rd('skills/review-and-fix-pr/reference.md')],
    ['review-lane-controller.md', rd('agents/review-lane-controller.md')],
  ]) {
    assert.match(text, /distinct inventory surface or (?:review )?question/i,
      `${name} does not demand a distinct optional surface`)
    assert.match(text, /ordinary lane priorit(?:y|ization) is insufficient/i,
      `${name} permits avoidable specialist fan-out`)
    assert.match(text, /Consolidate (?:overlapping optional work|related\s+optional work)/i,
      `${name} does not consolidate duplicate routing`)
  }
})

test('coverage work externalizes compact receipts and constrains Claude orchestration', () => {
  const procedure = rd('skills/review-and-fix-pr/SKILL.md') + '\n' +
    rd('skills/review-and-fix-pr/reference.md')
  assert.match(procedure, /compact receipts in agent transcripts/i)
  assert.match(procedure, /only receipt IDs in root context|only IDs and evidence\s+references/i)
  assert.match(procedure, /Consolidate all gaps into at most one fresh\s+assignment/i)
  const tool = JSON.parse(rd('bench/tools.json')).tools.find(({ id }) => id === 'review-and-fix-pr')
  assert.match(tool.prompt, /at most one consolidated gap-review subagent/i)
  assert.match(procedure, /no more than 15 Claude subagents/i)
  assert.match(procedure, /root context (?:below|under) 100k tokens/i)
  assert.match(procedure, /never finding, severity, confidence, or coverage cutoffs/i)
})

test('Codex adjudication is script-backed, blind, read-only, and reaches a fixed point', () => {
  const skill = rd('skills/review-and-fix-pr/SKILL.md')
  const ref = rd('skills/review-and-fix-pr/reference.md')
  const procedure = skill + '\n' + ref
  const command = 'node "${CLAUDE_PLUGIN_ROOT}/bin/review-and-fix-pr-codex.js" --root ' +
    "'<repo-root>' --base '<base-sha>' --head '<review-target-head>' --input " +
    "'<outside-target judge-input.json>' --receipt \"$REVIEW_AND_FIX_PR_CODEX_RECEIPT\""
  assert.equal(skill.includes(command), true, 'SKILL.md has the wrong Codex helper invocation')
  assert.equal(ref.includes(command), true, 'reference.md has the wrong Codex helper invocation')
  assert.match(ref, /`codex exec`/)
  for (const option of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--json',
                        '--output-schema']) assert.match(ref, new RegExp(option.replaceAll('-', '\\-')))
  assert.match(ref, /read-only sandbox, approvals disabled, no web search/i)
  assert.match(ref, /pinned to `gpt-5\.6-sol` with high reasoning/i)
  assert.match(ref, /Codex CLI `0\.149\.0\+`/)
  assert.match(ref, /successful authentication/i)
  assert.match(procedure, /lane identity, support\s+count, Claude disposition/i)
  assert.match(procedure, /Matt or other benchmark output, or sealed baseline issues/i)
  assert.match(procedure, /originating invocation cannot judge its own lead/i)
  assert.match(procedure, /Continue to a fixed point with no queued lead/i)
  assert.match(procedure, /Always run at least one invocation, even with zero Claude candidates/i)
  assert.match(procedure, /Never retry a failed invocation or fall back to Claude self-judgment/i)
  assert.match(procedure, /Never fall back to Claude self-judgment/i)
  assert.match(procedure, /Claude perform(?:ed|s) discovery[\s\S]{0,80}OpenAI Codex perform(?:ed|s) adjudication/i)
})

test('Codex helper runs in foreground and blocks finalization until stdout is parsed', () => {
  const tool = JSON.parse(rd('bench/tools.json')).tools.find(({ id }) => id === 'review-and-fix-pr')
  assert.ok(tool, 'bench/tools.json has no review-and-fix-pr tool')
  for (const [name, text] of [
    ['SKILL.md', rd('skills/review-and-fix-pr/SKILL.md')],
    ['reference.md', rd('skills/review-and-fix-pr/reference.md')],
    ['benchmark prompt', tool.prompt],
  ]) {
    assert.match(text, /Bash[\s\S]{0,120}`run_in_background: false`/i,
      `${name} does not require a foreground Bash invocation`)
    assert.match(text, /foreground[\s\S]{0,120}`run_in_background: false`|`run_in_background: false`[\s\S]{0,120}foreground/i,
      `${name} does not keep the Bash invocation in the foreground`)
    assert.match(text, /`timeout: 600000`[\s\S]{0,50}maximum foreground timeout/i,
      `${name} does not require the maximum foreground timeout`)
    assert.match(text, /wait for\s+(?:the |its )?(?:(?:helper )?process (?:to )?)?exit/i,
      `${name} does not wait for the helper process to exit`)
    assert.match(text, /never\s+respond or finalize[\s\S]{0,80}(?:helper|background task)[\s\S]{0,40}pending/i,
      `${name} permits finalization while work is pending`)
    assert.match(text, /parse\s+(?:its\s+)?stdout[\s\S]{0,50}`markerBinding`[\s\S]{0,30}`counts`[\s\S]{0,30}`usage`/i,
      `${name} does not parse required helper stdout`)
    assert.match(text, /entire\s+(?:foreground\s+)?(?:Bash\s+)?command[\s\S]{0,100}no\s+prefix,\s+suffix,\s+pipe,\s+or\s+redirection/i,
      `${name} permits wrapping or redirecting the helper command`)
  }
})

test('Codex helper input uses the runner paths, immutable identity, and exact strict schema', () => {
  const ref = rd('skills/review-and-fix-pr/reference.md')
  for (const name of ['REVIEW_AND_FIX_PR_CODEX_INPUT', 'REVIEW_AND_FIX_PR_CODEX_CONTEXT',
                      'REVIEW_AND_FIX_PR_CODEX_RECEIPT',
                      'REVIEW_AND_FIX_PR_CODEX_EXPECTED_JSON']) assert.match(ref, new RegExp(name))
  const inputSection = ref.slice(ref.indexOf('Before invoking, serialize exactly'))
  const fence = /```json\n([\s\S]*?)\n```/.exec(inputSection)
  assert.ok(fence, 'reference.md has no strict helper-input example')
  const input = JSON.parse(fence[1])
  assert.deepEqual(Object.keys(input), [
    'schemaVersion', 'contract', 'sourceDisclosure', 'target', 'pluginFingerprint',
    'reviewContext', 'candidates',
  ])
  assert.equal(input.schemaVersion, 2)
  assert.equal(input.contract, 'review-and-fix-pr-v3')
  assert.deepEqual(input.sourceDisclosure,
    { discovery: 'Anthropic Claude', adjudication: 'OpenAI Codex' })
  assert.deepEqual(Object.keys(input.target), ['repository', 'baseSha', 'headSha'])
  assert.deepEqual(Object.keys(input.reviewContext), [
    'acceptanceCriteria', 'applicableBaseRules', 'applicableHeadRules',
    'canonicalDiffInventory', 'commitMessages', 'linkedSources', 'missingSourceIndicators',
    'prBody', 'prTitle', 'remoteIdentity', 'repositoryIdentity', 'upstreamIdentity',
  ])
  assert.deepEqual(Object.keys(input.candidates[0]), [
    'id', 'claim', 'basisType', 'basis', 'mechanisms', 'consequence', 'defectClass', 'category',
    'locations', 'evidence', 'sourceIds',
  ])
  assert.deepEqual(Object.keys(input.candidates[0].locations[0]), ['path', 'line'])
  assert.deepEqual(Object.keys(input.candidates[0].evidence[0]), ['path', 'line', 'detail'])
  assert.match(ref, /Resolve every discovery evidence fact ID[\s\S]{0,80}`\{path,line,detail\}`/i)
  assert.match(ref, /strip lane-only title, severity, confidence, scope, and counterevidence/i)
  assert.match(ref, /canonical diff\s+inventory is merge-base-derived[\s\S]{0,120}`target\.baseSha` and `--base` use the immutable base SHA/i)
  assert.match(ref, /context file contains the independently fetched[\s\S]{0,220}broker rejects any difference/i)
  assert.match(ref, /copy helper stdout `markerBinding\.candidateLedger`[\s\S]{0,320}Never manually reconstruct/i)
  assert.match(ref, /copy\s+stdout `counts` verbatim as `findings`[\s\S]{0,100}stdout `usage` separately/i)
})

test('schema v3 binds every candidate and new lead to the external Codex receipt', () => {
  const ref = rd('skills/review-and-fix-pr/reference.md')
  const markerSection = ref.slice(ref.indexOf('## Exact schema-v3 result marker'))
  const fence = /```json\n([^\n]+)\n```/.exec(markerSection)
  assert.ok(fence, 'reference.md has no compact v3 marker example')
  const marker = JSON.parse(fence[1])
  assert.equal(marker.schemaVersion, 3)
  assert.deepEqual(marker.candidateLedger, [])
  assert.deepEqual(marker.newLeadResolutions, [])
  assert.deepEqual(Object.keys(marker.codex),
    ['provider', 'model', 'reasoningEffort', 'cliVersion', 'receiptSha256'])
  assert.deepEqual(marker.codex.provider, 'openai')
  assert.deepEqual(marker.codex.model, 'gpt-5.6-sol')
  assert.deepEqual(marker.codex.reasoningEffort, 'high')
  for (const field of ['candidateId', 'claimHash', 'originInvocationId', 'judgeInvocationId',
                       'verdict', 'finalDisposition']) assert.match(markerSection, new RegExp(`\\b${field}\\b`))
  for (const field of ['leadId', 'resolution']) assert.match(markerSection, new RegExp(`\\b${field}\\b`))
  assert.match(markerSection, /`real\|suggestion\|false_positive\|unresolved`/)
  assert.match(markerSection, /`confirmed\|suggestion\|rejected\|unresolved`/)
  assert.match(markerSection, /`admitted\|duplicate`/)
  assert.match(markerSection, /`codex` is null[\s\S]{0,100}intentionally\s+unpublishable/i)
  assert.match(markerSection, /V1 and v2 manifests and result markers remain reader-compatible only/i)
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
    const bytes = Buffer.byteLength(rd(path.join('skills', d, 'SKILL.md')), 'utf8')
    assert.ok(bytes <= 13000, `skills/${d}/SKILL.md is ${bytes} bytes, over the 13000 ceiling`)
  }
})
