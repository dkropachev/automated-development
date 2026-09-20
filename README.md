# automated-development

A Claude Code plugin of development skills that learn a repository's own conventions before they
act on it. Three drafting skills — a PR description, an issue, a commit message — sharing one
driver, plus a PR review-and-fix pipeline; the layout expects more.

## Install

```
/plugin marketplace add dkropachev/automated-development
/plugin install automated-development@automated-development
```

## Skills

### `draft-pr-description`

Drafts a PR title and description **in the voice of the repository you are in**, rather than in a
generic one.

The first time it runs against a repo it learns how that repo writes PRs — from
`.github/PULL_REQUEST_TEMPLATE*`, from the contributing guide, and from the merged PRs of its top
contributors — and caches the result as a generation prompt. Every later draft is one cache read.
The cache is rebuilt after 90 days, when the PR template or contributing guide changes, a week
after a build that verification did not fully pass, or on `--refresh-cache`. A learn that failed is
not retried for a day.

It **drafts only**. It never runs `gh pr create` or `gh pr edit`; every `gh` call it makes is
read-only.

Run it in any git repo:

```
/draft-pr-description
```

#### How it works

Three pieces. The driver is the interesting one.

**The driver.** `bin/promptgen-driver.js` is a state machine with two jobs. Between agents it is the
orchestrator's tool: it resolves the repo from the `origin` remote (never `gh repo view`, which
answers for the upstream project in a fork clone), judges whether the cache is stale, names every
file, records the verifier's verdict and publishes — atomically, and only after a verdict exists.
Inside an agent's conversation it decides when the agent is finished, because that decision should
not be the writer's. It measures rather than asks:

- every canonical field in `schema.md` is claimed by a section of the learned prompt, and no
  covers-comment names a field that does not exist
- every section the cached prompt declares is present in a draft, and no heading outside that
  repo's vocabulary
- **no file named that does not exist in the repo** — an invented test file is the failure that bites
- code references are raw GitHub permalinks pinned to a pushed commit SHA, not `path:line`, not a
  branch ref, not wrapped in markdown link text
- no placeholder, no tooling banner, no filler phrase that carries nothing
- length and title length against the repo's own measured numbers — these two are soft: over the
  guide it asks for one trimming pass, then accepts what comes back rather than forcing a section out

Nothing an agent *says* about paths, PR numbers or outcomes is used. The driver reads all of it off
disk, including the verifier's report: it parses the report's own block, derives the verdict from
the findings rather than from the verifier's self-assessment, and refuses a report that checked only
the PRs the builder had already sampled.

**The learned prompt.** Two agents, each spawned once. A **builder** mines the repo under the driver
and cannot stop critiquing its own draft until two consecutive passes find nothing — it is never
told how close it is to the exit — and the coverage gate passes. A fresh, read-only **verifier**
then checks the draft against merged PRs the builder never sampled and against the repo's own
template and contributing guide. Blocking findings go back to the *same* builder, which still has
the sampled PRs in context, and the *same* verifier re-checks. The driver then stamps the verdict
into the cache and publishes. A build that ends with unresolved findings is published marked
`verified: false` and is rebuilt within a week.

**The draft.** Drafting runs in your own conversation, not in a subagent, because you know why the
change was made and which tests actually ran. A subagent would re-derive that from the diff and get
the plausible version instead of the true one. It runs under the same driver.

#### What it writes

| path | what |
|---|---|
| `~/.claude/pr-style-cache/<host>/<owner>/<repo>.md` | the learned prompt for one repo |
| `~/.claude/pr-style-cache/<host>/<owner>/<repo>.md.work.<batch>` | a build in progress; swept at publish once its batch is finished |
| `~/.claude/pr-style-cache/<host>/<owner>/<repo>.md.attempt` | when and why the last learn failed; cleared by a successful publish |
| `~/.claude/draft-pr-description/state/` | driver state and per-build result JSON, pruned after 7 days |
| `~/.claude/issue-style-cache/<host>/<owner>/<repo>.md` (+ `.work.<batch>`, `.attempt`) | the same three, for the issue skill |
| `~/.claude/draft-issue-description/state/` | the issue skill's driver state |
| `~/.claude/commit-style-cache/<host>/<owner>/<repo>.md` (+ `.work.<batch>`, `.attempt`) | the same three, for the commit skill |
| `~/.claude/draft-commit-message/state/` | the commit skill's driver state |
| `~/.claude/pr-review-fix/state/` | one file per live review or fix conversation, pruned after 7 days |
| `~/.claude/pr-review-fix/<owner>__<repo>/classify.js` (+ `meta.json`) | the generated reviewability rule and the repo fingerprint that invalidates it |
| `~/.claude/pr-review-fix/<owner>__<repo>/reviewed.json` | files recorded clean, keyed on content, kept across runs |
| `~/.claude/pr-review-fix/<owner>__<repo>/runs/<sha>/` | frozen chunk `.diff` files for one run |

Nothing else. It does not write to your repository, beyond a depth-limited `git fetch` when the base
branch is genuinely absent from the clone.

#### Configuring what a description must contain

`skills/draft-pr-description/schema.md` is the canonical field list —
motivation, summary of changes, risk, breaking changes, and `testing` only where the repo itself
writes about it. Edit it and run `/draft-pr-description --refresh-cache` in a repo to rebuild that
repo's prompt against the new shape.

### `draft-issue-description`

Drafts a GitHub issue — title, labels and body — **in the voice of the repository you are in**: a
bug report shaped like that repo's bug form, a feature request shaped like its feature form.

The first time it runs against a repo it learns how that repo files issues — from the markdown
templates and YAML issue forms under `.github/ISSUE_TEMPLATE/`, from `config.yml` (which says what
is *not* filed here), from the contributing guide, and from the issues its maintainers file
themselves — and caches the result as a generation prompt. A repo with more than one template gets
**kinds**: the prompt carries each kind's sections separately, says how to tell them apart and which
labels each takes, and the driver gates and checks every kind on its own. Staleness, back-off and
`--refresh-cache` work exactly as for PRs; the issue cache is a separate file, so the two skills
never read each other's.

It **drafts only**. It never runs `gh issue create`, `gh issue edit` or `gh issue comment`; every
`gh` call it makes is read-only, including the one duplicate search it does before drafting.

```
/draft-issue-description
```

It is the same three pieces as the PR skill, driven by the same `promptgen-driver.js` told
`--domain issue`. What differs:

- the **kind** is settled first, from the cache's `## Kinds` section and what the user described; a
  report the repo routes elsewhere (questions to Discussions) gets one line and no draft
- there is no diff, so a file the draft names is checked for existence in the repo and nothing else
- a template comment (`<!-- ... -->`) or placeholder line left in the body is rejected, as is a
  heading from another kind's form — a bug report does not carry "Proposed solution"
- the prompt is built to render YAML issue forms the way GitHub does: one `### <label>` per field, in
  the form's order, `type: markdown` items omitted

`skills/draft-issue-description/schema.md` is its canonical field list — problem, expected,
context — with reproduction, evidence, proposal and workaround only where the repo's template or
its maintainers' issues actually have them.

### `draft-commit-message`

Writes a commit message — subject, body, references, trailers — **in the voice of the repository
you are in**: its subject grammar, its wrap column, its `Fixes #N` form, a `Signed-off-by` only where
the repo requires one.

The first time it runs against a repo it learns how that repo commits — from commitlint, commitizen
or semantic-release config, a commit-msg hook, the commit template, the contributing guide, and the
recent commits of its top authors — and caches the result as a generation prompt. The whole learn
runs on `git log`; no `gh` is needed, so it works offline. Staleness, back-off and
`--refresh-cache` work exactly as for PRs, and `sources-changed` fires when commitlint, a hook, the
template or CONTRIBUTING changes.

It **drafts only**. It never runs `git commit`, `--amend`, `rebase` or `push`. The message is
printed and saved to a file for `git commit -F`.

```
/draft-commit-message
```

Same three pieces, same driver, told `--domain commit`. What differs:

- the change is the **staged diff** by default, the working tree when nothing is staged, or HEAD
  when amending; the changed-file list comes from the same place
- the checks are the terminal's, not the browser's: `path:line` is fine and permalinks are not
  asked for; instead the subject is measured against the repo's `title_max`, body lines against
  its `wrap_at`, every trailer the prompt marks required must be present, a `#` line is rejected
  where the repo's commits carry no markdown
- a prompt may declare `Problem:` / `Solution:`-style labelled parts as sections, and a
  `## Trailers` section whose `required` lines become checks
- a one-liner passes where the prompt says this repo commits one-liners for changes of that size

`skills/draft-commit-message/schema.md` is its canonical field list — summary, motivation,
references — with testing, sign-off, breaking-change and co-authors only where a rule requires them
or the repo's own commits carry them.

### `pr-review-fix`

Reviews a PR and, on your own PRs, fixes what it finds. The diff is split into size-capped chunks of
whole hunks, staged **code → tests → cicd → other** with a hard barrier between stages; read-only
reviewers run in parallel, then one fixer at a time validates and commits its own batch. Nothing is
ever reverted: a batch whose build fails leaves its edits in the tree for you to read.

```
/pr-review-fix 1234
```

Every reviewer and every fixer is walked through its work one step at a time by
`bin/pr-review-fix-driver.js`, which holds the decisions an agent should not make for itself: what
changed is measured with `git status` rather than taken from the agent's word, `COMMIT` is never
printed while the build is failing, and a review cannot stop looking until two passes in a row find
nothing — with the agent never told how close it is, so it cannot aim for the exit.

Scope is a label, not a filter. A defect this PR did not cause is reported and marked out-of-scope
rather than suppressed, so you can tell "you broke this" from "this was already broken". With
`detailedReview: true` reviewers may leave the hunk, trace callers, and *run* experiments in a
throwaway clone — which is what finds caller-side defects that reading past them does not.

Files a reviewer finds genuinely clean are recorded in a ledger keyed on content, so a later run
skips them until they change.

## Layout

```
agents/                  subagents the skills spawn, typed automated-development:pr-style-builder,
                         :pr-style-verifier, :issue-style-builder, :issue-style-verifier,
                         :commit-style-builder, :commit-style-verifier (plugin name is part of the type)
bin/promptgen-driver.js  the CLI: the two state machines and the orchestrator's verbs, --domain pr|issue|commit
bin/pr-review-fix-*.js   the review pipeline's helpers: -driver (fix and review state machines),
                         -chunker (diff -> capped chunks), -reviewed (the clean-file ledger),
                         -repofp (repo-shape fingerprint), -meter (token accounting, manual)
workflows/               Workflow scripts, run by scriptPath; not linted (see eslint.config.js)
lib/domains.js           everything that differs between the three domains: paths, keys, source files,
                         which checks apply, and every instruction that talks about "the diff" or "the maintainer"
lib/prompt-gate.js       coverage gate for a learned prompt, per kind where kinds exist; frontmatter helpers
lib/draft-checks.js      the checks on a draft, and their regexes
lib/repo.js              origin parsing, cache path, sources hash, staleness rule
skills/<name>/           SKILL.md plus the procedure files it hands to agents
Makefile                 the entry point for CI, release and evals; every target is a node script
scripts/                 check-consistency, syntax-check, eval-parse, eval, bump-version, release
evals/                   `claude plugin eval` cases: a scaffolded repo, deterministic graders, one LLM grader
test/                    node --test: lib unit tests and end-to-end driver tests
.github/workflows/       ci (test, lint, validate), release (manual), eval (manual + weekly)
```

## Development

```
make install
make ci           # lint + check + test, what a PR has to pass
make help         # every target
```

Every CI job and the release run through the Makefile, and every target is a `node scripts/*.js`
call, so what Actions does is exactly what runs locally. No workflow carries shell logic.

`test/lib.test.js` exercises the pure functions directly. `test/driver.test.js` runs the real driver
in a subprocess with `HOME` pointed at a temp dir, so state, caches and result files are inspected
where they land. `scripts/check-consistency.js` fails when a skill names a driver verb, flag, file or
agent type that does not exist, or when the version in `plugin.json` and `package.json` disagree.

## CI/CD

| workflow | when | what |
|---|---|---|
| `ci` | every PR and push to main | `test` on Node 20 and 22, `lint` (ESLint + `node --check`), `validate` (consistency script, `claude plugin validate`, eval suite parses) |
| `release` | manual, `workflow_dispatch` with `bump` = patch, minor, major or X.Y.Z | bumps the version everywhere, runs the full suite, commits to main, tags `vX.Y.Z`, publishes a GitHub Release with generated notes |
| `eval` | manual, or Mondays 06:17 UTC | runs `evals/` with real model calls under a $5 ceiling; skips itself with a notice when the `CLAUDE_CODE_OAUTH_TOKEN` secret is absent |

Main is protected by a ruleset requiring the four `ci` checks; only repository admins bypass it. The
`release` workflow pushes with the `RELEASE_TOKEN` secret, an admin's fine-grained PAT with Contents
read/write on this repo, which is how the version bump lands without a PR. It fails with a clear
message if the secret is missing.

Dependabot watches GitHub Actions and npm monthly. Locally: `make eval` (needs `claude` logged in),
`make eval-parse` to only validate the case files, `make release BUMP=minor` to cut a release from
a clean main checkout.
