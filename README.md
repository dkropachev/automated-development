# automated-development

A Claude Code plugin of development workflows that learn a repository's own conventions before they
act on it. One workflow so far; the layout expects more.

## Install

```
/plugin marketplace add dkropachev/automated-development
/plugin install automated-development@automated-development
```

## Workflows

### `draft-pr-description`

Drafts a PR title and description **in the voice of the repository you are in**, rather than in a
generic one.

The first time it runs against a repo it learns how that repo writes PRs — from
`.github/PULL_REQUEST_TEMPLATE*`, from the contributing guide, and from the merged PRs of its top
contributors — and caches the result as a generation prompt. Every later draft is one cache read.
The cache is rebuilt after 90 days or on `--refresh-cache`.

It **drafts only**. It never runs `gh pr create` or `gh pr edit`; every `gh` call it makes is
read-only.

Run it in any git repo:

```
/draft-pr-description
```

#### How it works

Two pieces, and the interesting part is the second one.

**The learned prompt.** A background workflow (`workflows/pr-description-prompt.js`) mines the repo with one agent, has it
critique its own draft up to 8 times — it cannot stop until two consecutive passes find nothing, and
it is never told how close it is to the exit — then hands the result to a *fresh* agent that checks
it against PRs the first one never sampled. Only then is it published.

**The driver.** `bin/promptgen-driver.js` is a state machine that runs inside the drafting
conversation and decides when it is finished, because that decision should not be the writer's. It
measures rather than asks:

- every section the cached prompt declares is present, and no heading outside that repo's vocabulary
- **no file named that does not exist in the repo** — an invented test file is the failure that bites
- code references are raw GitHub permalinks pinned to a pushed commit SHA, not `path:line`, not a
  branch ref, not wrapped in markdown link text
- no placeholder, no tooling banner, no filler phrase that carries nothing
- length and title length against the repo's own measured numbers — these two are soft: over the
  guide it asks for one trimming pass, then accepts what comes back rather than forcing a section out

Drafting runs in your own conversation, not in a subagent, because you know why the change was made
and which tests actually ran. A subagent would re-derive that from the diff and get the plausible
version instead of the true one.

#### What it writes

| path | what |
|---|---|
| `~/.claude/pr-style-cache/<host>/<owner>/<repo>.md` | the learned prompt for one repo |
| `~/.claude/draft-pr-description/state/` | driver state, pruned after 7 days |

Nothing else. It does not write to your repository, beyond a depth-limited `git fetch` when the base
branch is genuinely absent from the clone.

#### Configuring what a description must contain

`skills/draft-pr-description/schema.md` is the canonical field list —
motivation, summary of changes, risk, breaking changes, and `testing` only where the repo itself
writes about it. Edit it and run `/draft-pr-description --refresh-cache` in a repo to rebuild that
repo's prompt against the new shape.
