# automated-development

A Claude Code plugin of development skills that learn a repository's own conventions before they
act on it. One skill so far; the layout expects more.

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

Nothing else. It does not write to your repository, beyond a depth-limited `git fetch` when the base
branch is genuinely absent from the clone.

#### Configuring what a description must contain

`skills/draft-pr-description/schema.md` is the canonical field list —
motivation, summary of changes, risk, breaking changes, and `testing` only where the repo itself
writes about it. Edit it and run `/draft-pr-description --refresh-cache` in a repo to rebuild that
repo's prompt against the new shape.

## Layout

```
agents/                  subagents the skills spawn, typed automated-development:pr-style-builder
                         and automated-development:pr-style-verifier (plugin name is part of the type)
bin/promptgen-driver.js  the CLI: the two state machines and the orchestrator's verbs
lib/prompt-gate.js       coverage gate for a learned prompt; frontmatter helpers
lib/draft-checks.js      the checks on a PR description draft, and their regexes
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
