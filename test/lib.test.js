'use strict'
// Unit tests for the pure functions in lib/, no subprocess.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const gate = require('../lib/prompt-gate')
const checks = require('../lib/draft-checks')
const repo = require('../lib/repo')

test('frontmatter parses key: value lines and nothing else', () => {
  assert.deepEqual(gate.frontmatter('---\nlearned_at: 2026-01-02\npattern: derived\n---\nbody'), { learned_at: '2026-01-02', pattern: 'derived' })
  assert.equal(gate.frontmatter('no frontmatter'), null)
})

test('claimedFields reads covers comments, deduplicated, backticks stripped', () => {
  assert.deepEqual(gate.claimedFields('<!-- covers: motivation --> x <!-- covers: `risk`, breaking-changes, risk -->'),
                   ['motivation', 'risk', 'breaking-changes'])
})

test('fmList parses [a, 1, "b"] into values with numbers as numbers', () => {
  assert.deepEqual(gate.fmList('[4412, alice, "bob"]'), [4412, 'alice', 'bob'])
  assert.deepEqual(gate.fmList('nope'), []); assert.deepEqual(gate.fmList('[]'), [])
})

test('stampFrontmatter replaces existing keys and appends new ones without touching the body', () => {
  const out = gate.stampFrontmatter('---\na: 1\nb: 2\n---\nbody\n', { b: '3', c: '4' })
  assert.equal(out, '---\na: 1\nb: 3\nc: 4\n---\nbody\n')
  assert.equal(gate.stampFrontmatter('no fm', { a: '1' }), null)
})

test('parseOrigin handles every common remote shape and rejects garbage', () => {
  assert.deepEqual(repo.parseOrigin('git@github.com:o/r.git'), { host: 'github.com', nwo: 'o/r' })
  assert.deepEqual(repo.parseOrigin('ssh://git@ghe.corp:2222/team/repo/'), { host: 'ghe.corp', nwo: 'team/repo' })
  assert.deepEqual(repo.parseOrigin('https://user@gitlab.com/g/r.git'), { host: 'gitlab.com', nwo: 'g/r' })
  assert.equal(repo.parseOrigin('https://user@gitlab.com/g/sub/r.git'), null)
  assert.deepEqual(repo.parseOrigin('git://github.com/o/r'), { host: 'github.com', nwo: 'o/r' })
  assert.equal(repo.parseOrigin('/local/path'), null)
  assert.equal(repo.parseOrigin('git@github.com:o/../r'), null)
  assert.equal(repo.parseOrigin('https://github.com/o'), null)
})

test('utcDay parses only YYYY-MM-DD', () => {
  assert.equal(repo.utcDay('2026-09-18'), Date.UTC(2026, 8, 18)); assert.ok(isNaN(repo.utcDay('yesterday')))
  assert.ok(isNaN(repo.utcDay('2026-99-99')))
})

test('citedPaths finds backticked file paths and ignores identifiers, flags and versions', () => {
  assert.deepEqual(checks.citedPaths('see `src/pool.py`, `Session::new`, `--limit`, `v1.2.3`, `1.2`, `foo_test.rs`; also src/plain.js and Makefile'),
                   ['src/pool.py', 'foo_test.rs', 'src/plain.js', 'Makefile'])
})

test('prose strips fenced blocks so quoted commands are not read as headings', () => {
  assert.equal(checks.prose('a\n```sh\n# not a heading\n```\nb\n'), 'a\n\nb\n')
})

test('filler, placeholder, banner and permalink regexes fire where they should and not elsewhere', () => {
  assert.deepEqual(checks.fillerFound('we do this in order\nto win'), ['in order to  ->  to'])
  assert.deepEqual(checks.fillerFound('we do this to win'), [])
  assert.ok(checks.PLACEHOLDER.test('fill in <describe the problem>')); assert.ok(!checks.PLACEHOLDER.test('a <b> tag'))
  assert.ok(!checks.PLACEHOLDER.test('<details><summary>trace</summary></details>'))
  assert.ok(checks.BANNER.test('🤖 Generated with [Claude Code](https://claude.com/claude-code)'))
  assert.ok(checks.BANNER.test('Co-Authored-By: Claude <noreply@anthropic.com>')); assert.ok(!checks.BANNER.test('Claude reviewed it'))
  assert.ok(checks.FILE_LINE.test('see src/pool.py:42 here')); assert.ok(!checks.FILE_LINE.test('at 12:30 today'))
  assert.ok(checks.WRAPPED.test('[x](https://github.com/o/r/blob/main/a.py#L1)'))
  assert.ok(!checks.WRAPPED.test('https://github.com/o/r/blob/main/a.py#L1'))
})

test('unknownPaths splits invented from merely-untouched using the tracked file list', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-'))
  execFileSync('git', ['init', '-q', root])
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', 'pool.py'), ''); fs.writeFileSync(path.join(root, 'src', 'util.py'), '')
  execFileSync('git', ['-C', root, 'add', '.'])
  const r = checks.unknownPaths(['pool.py', 'util.py', 'tests/test_pool.py'], ['src/pool.py'], root)
  assert.deepEqual(r, { invented: ['tests/test_pool.py'], referenced: ['util.py'] })
  assert.deepEqual(checks.unknownPaths(['fake/src/pool.py', '../outside.py'], ['src/pool.py'], root).invented,
                   ['../outside.py', 'fake/src/pool.py'])
})

test('sourceFiles picks each domain\'s own authoritative files', () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const { DOMAINS } = require('../lib/domains')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-'))
  const w = (p) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), 'x') }
    w('.github/PULL_REQUEST_TEMPLATE.md'); w('.github/ISSUE_TEMPLATE/bug.yml'); w('.github/ISSUE_TEMPLATE/config.yml')
    w('.github/ISSUE_TEMPLATE.md'); w('.github/SUPPORT.md'); w('.github/workflows/title-lint.yml')
    w('CONTRIBUTING.md'); w('README.md'); w('commitlint.config.js')
    assert.deepEqual(repo.sourceFiles(root), ['.github/PULL_REQUEST_TEMPLATE.md', '.github/workflows/title-lint.yml', 'CONTRIBUTING.md', 'commitlint.config.js'])
    assert.deepEqual(repo.sourceFiles(root, DOMAINS.issue.sources),
                     ['.github/ISSUE_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/config.yml', '.github/SUPPORT.md', 'CONTRIBUTING.md'])
    // The commit spec says "no template directory" with /$^/, which matches the empty string the
    // root is spelled as. The root still takes the filename filter, so README.md is not a commit
    // source and editing it does not make the commit cache stale.
    assert.deepEqual(repo.sourceFiles(root, DOMAINS.commit.sources), ['CONTRIBUTING.md', 'commitlint.config.js'])
  assert.notEqual(repo.sourcesHash(root), repo.sourcesHash(root, DOMAINS.issue.sources))
})

test('claimedByKind reads covers and kinds comments line by line', () => {
  assert.deepEqual(gate.claimedByKind('### `### A`  <!-- kinds: bug --> <!-- covers: problem -->\n### `### V` <!-- covers: context -->\nprose\n'),
                   [{ fields: ['problem'], kinds: ['bug'] }, { fields: ['context'], kinds: null }])
  assert.deepEqual(gate.slugList('[bug, feature]'), ['bug', 'feature']); assert.deepEqual(gate.slugList(''), [])
})

test('promptSections carries kinds, and sectionsForKind drops the other kinds\' sections and headings', () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-')), 'p.md')
  fs.writeFileSync(p, '---\nkinds: [bug, feature]\n---\n## Body\n### `### A` <!-- kinds: bug -->\n### `### V`\n### `### P` — also `### Q` <!-- kinds: feature -->\nThe `## Notes` heading is allowed in prose.\n## Forbidden headings\n- `## Summary`\n')
  const ps = checks.promptSections(p)
  assert.deepEqual(ps.kinds, ['bug', 'feature'])
  assert.deepEqual(ps.sections, [{ names: ['### A'], kinds: ['bug'] }, { names: ['### V'], kinds: null }, { names: ['### P', '### Q'], kinds: ['feature'] }])
  assert.deepEqual(ps.forbidden, ['## Summary']); assert.ok(!ps.allowed.includes('## Summary'))
  const bug = checks.sectionsForKind(ps, 'bug')
  assert.deepEqual(bug.sections.map(s => s.names[0]), ['### A', '### V'])
  assert.deepEqual(bug.allowed, ['### A', '### V', '## Notes'])
  const any = checks.sectionsForKind(ps, '')
  assert.deepEqual(any.sections.map(s => s.names[0]), ['### A', '### V', '### P']); assert.deepEqual(any.allowed, ps.allowed)
  assert.ok(checks.HTML_COMMENT.test('a <!-- hint --> b')); assert.ok(!checks.HTML_COMMENT.test('a < b -- c > d'))
})

test('commit-domain helpers: label sections, trailers, frontmatter numbers, SHA identity', () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const { sameId, DOMAINS } = require('../lib/domains')
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-')), 'p.md')
  fs.writeFileSync(p, '---\nwrap_at: 72\ntitle_max: 60\n---\n## Body\n### `Problem:` <!-- covers: motivation -->\n### `## Why`\n## Trailers\n- `Signed-off-by:` required - DCO\n- `Fixes:` optional\n- `Reviewed-by:` REQUIRED\n')
  assert.deepEqual(checks.promptSections(p, { labels: true }).sections.map(s => s.names[0]), ['Problem:', '## Why'])
  assert.deepEqual(checks.promptSections(p).sections.map(s => s.names[0]), ['## Why'])
  assert.deepEqual(checks.promptTrailers(p), ['Signed-off-by', 'Reviewed-by'])
  assert.equal(checks.promptNumber(p, 'wrap_at'), 72); assert.equal(checks.promptNumber(p, 'title_max'), 60); assert.equal(checks.promptNumber(p, 'nope'), 0)
  assert.ok(checks.hasSection('x\nProblem: y', 'Problem:')); assert.ok(!checks.hasSection('the Problem: y', 'Problem:')); assert.ok(checks.hasSection('a ## Why b', '## Why'))
  assert.ok(sameId('a1b2c3d', 'A1B2C3D0123456789')); assert.ok(!sameId('a1b2c3d', 'a1b2c3e')); assert.ok(sameId(7, 7)); assert.ok(!sameId(101, 1010))
  assert.ok(DOMAINS.commit.idPattern.test('deadbeef')); assert.ok(!DOMAINS.commit.idPattern.test('123456')); assert.ok(!DOMAINS.pr.idPattern.test('deadbeef'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-'))
  const w = (f) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), 'x') }
  w('.gitmessage'); w('commitlint.config.js'); w('.husky/commit-msg'); w('.github/workflows/commitlint.yml'); w('.github/workflows/ci.yml'); w('.github/PULL_REQUEST_TEMPLATE.md'); w('CONTRIBUTING.md')
  assert.deepEqual(repo.sourceFiles(root, DOMAINS.commit.sources),
                   ['.github/workflows/commitlint.yml', '.gitmessage', '.husky/commit-msg', 'CONTRIBUTING.md', 'commitlint.config.js'])
})

test('a heading declared for one kind is not globally removed by Forbidden headings', () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-')), 'p.md')
  fs.writeFileSync(p, '---\nkinds: [bug, feature]\n---\n## Body\n### `### Proposed solution` <!-- kinds: feature -->\n## Forbidden headings\n- `### Proposed solution` is forbidden for bugs\n')
  const feature = checks.sectionsForKind(checks.promptSections(p), 'feature')
  assert.ok(feature.allowed.includes('### Proposed solution'))
  assert.ok(!checks.sectionsForKind(checks.promptSections(p), 'bug').allowed.includes('### Proposed solution'))
})

test('canonical schema fallback declares required generic sections', () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-'))
  const draft = path.join(root, 'draft.md'); fs.writeFileSync(draft, 'Title: vague\n\n' + 'generic prose '.repeat(20))
  const prompt = path.join(__dirname, '..', 'skills', 'draft-pr-description', 'schema.md')
  const r = checks.inspectDraft(draft, prompt, '', root, 3000, {})
  assert.equal(r.ok, false); assert.deepEqual(r.missingHeadings, ['## Motivation', '## Summary of changes', '## Risk', '## Breaking changes'])
})

test('promptLabels reads the run of backticked items after `labels` and nothing else on the line', () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-')), 'p.md')
  fs.writeFileSync(p, ['## Kinds',
    '### `bug` — `.github/ISSUE_TEMPLATE/bug.yml`, title prefix `[Bug]: `, labels `kind/bug`, `needs-triage`',
    '### `feature` — labels `enhancement` and `area/api`',
    '### `docs` — `.github/ISSUE_TEMPLATE/docs.yml`, labels `docs`, title prefix `[Docs] `',
    '### `task` — no labels are applied',
  ].join('\n'))
  // A namespaced label is a label, not the template path: `kind/bug` and `area/api` survive.
  assert.deepEqual(checks.promptLabels(p, 'bug'), ['kind/bug', 'needs-triage'])
  assert.deepEqual(checks.promptLabels(p, 'feature'), ['enhancement', 'area/api'])
  // The run stops where the line goes back to prose, so a trailing title prefix is not a label.
  assert.deepEqual(checks.promptLabels(p, 'docs'), ['docs'])
  assert.deepEqual(checks.promptLabels(p, 'task'), [])
  assert.deepEqual(checks.promptLabels(p, 'absent'), []); assert.deepEqual(checks.promptLabels(p, ''), [])
})

test('a kindless prompt carries its one template\'s labels in the frontmatter', () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-'))
  const p = path.join(dir, 'p.md')
  fs.writeFileSync(p, '---\nlabels: [bug, needs-triage]\n---\n## Title\nx\n')
  assert.deepEqual(checks.promptLabels(p, ''), ['bug', 'needs-triage'])
  fs.writeFileSync(p, '---\npattern: template\n---\n## Title\nx\n')
  assert.deepEqual(checks.promptLabels(p, ''), [])
  // A kinded prompt answers from its `## Kinds` line, and the key is refused beside it.
  const schema = path.join(__dirname, '..', 'skills', 'draft-issue-description', 'schema.md')
  const fm = (extra) => '---\nlearned_at: 2026-09-18\nsource_issues: [1]\npattern: template\nmax_bytes: 2600\n' + extra + '---\n' +
    '## Title\nx\n## Body\n### `### A` <!-- covers: problem, expected, context -->\n' + 'prose. '.repeat(70) + '\n## Style\nbe concise\n'
  const draft = path.join(dir, 'd.md')
  fs.writeFileSync(draft, fm('labels: [bug]\n'))
  assert.ok(gate.inspect(draft, schema, { sourceKey: 'source_issues', idPattern: /^\d+$/ }).ok)
  fs.writeFileSync(draft, fm('labels: bug\n'))
  assert.match(gate.inspect(draft, schema, { sourceKey: 'source_issues', idPattern: /^\d+$/ }).problems.join('\n'), /`labels` must be a \[\.\.\] list/)
  fs.writeFileSync(draft, fm('kinds: [bug]\nlabels: [bug]\n'))
  assert.match(gate.inspect(draft, schema, { sourceKey: 'source_issues', idPattern: /^\d+$/ }).problems.join('\n'), /cannot both be present/)
})

test('citedPaths ignores prose that merely contains a slash', () => {
  assert.deepEqual(checks.citedPaths('the client/server handshake fails and/or hangs on read/write, ' +
                                     '50/50 of runs, on Linux/6.1; see src/plain.js and tests/test_pool.py'),
                   ['src/plain.js', 'tests/test_pool.py'])
})

test('eval-parse fails when the claude subprocess exits nonzero', () => {
  const path = require('path'), { spawnSync } = require('child_process')
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'eval-parse.js')], {
    env: { ...process.env, CLAUDE: '/bin/false' }, encoding: 'utf8',
  })
  assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /claude exited/)
})
