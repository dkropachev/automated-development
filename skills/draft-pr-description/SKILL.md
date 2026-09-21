---
name: draft-pr-description
description: Draft a PR title and description in this repo's own style, learned from its config and its top contributors' merged PRs and cached per repo. Use when asked to "draft a PR description", "write the PR description", "pr description", or to rewrite an existing one in the repo's style. Use it before a PR is opened or its description changed — "create a PR", "open a PR", "raise a PR", "push this and open a PR", "update the PR description", "fix the PR body" — to write the text that PR is opened or updated with, and use it when the points the description should make are handed to you rather than asked for.
---

# PR description draft

Produces **text**: a title and a description body, printed for the user. This skill never calls
`gh pr edit`, `gh pr create`, or anything else that writes to GitHub. Every `gh` call it makes is
read-only. Applying the draft — `gh pr create`, `gh pr edit` — is a separate step outside this
skill, taken once it has returned by whoever asked for it.

Drafts-only is a limit on what this skill does, **not** on when it runs. "Create the PR", "open a
PR for this", "push it and raise a PR", "update the PR description", "fix the PR body" all want a
title and a body, so they run this skill first and the caller applies what it printed afterwards.
Writing the text by hand because the request said *create* rather than *draft* is the failure this
skill exists to prevent. It runs when the content is supplied too: points the user dictates, a rough
draft they paste, an existing description they want kept are the material, and this skill puts them
in the repo's shape rather than inventing different content. Their facts win; what the skill decides
is the title form, the sections, the order and the permalinks. The one case it does not run is text
handed over as final and marked to be used verbatim.

The draft is written by a **cached, repo-specific generation prompt** — not by generic instincts
about what a PR description should look like. Each repo gets its own prompt, derived once from that
repo's configuration and from how its top contributors actually write PRs, then reused until it
goes stale.

Everything mechanical is done by `promptgen-driver.js`. It resolves the repo, judges staleness,
names every file, drives the builder and the drafter step by step, records the verifier's verdict,
and publishes. You hold no state of your own; when in doubt, ask the driver.

```bash
DRIVER="${CLAUDE_PLUGIN_ROOT}/bin/promptgen-driver.js"
SCHEMA="${CLAUDE_PLUGIN_ROOT}/skills/draft-pr-description/schema.md"
LEARN="${CLAUDE_PLUGIN_ROOT}/skills/draft-pr-description/learn.md"
VERIFY="${CLAUDE_PLUGIN_ROOT}/skills/draft-pr-description/verify.md"
```

## 1. Resolve the repo and its cache

```bash
ROOT=$(git rev-parse --show-toplevel) || { echo "not a git repo"; exit 1; }
eval "$(node "$DRIVER" resolve --root "$ROOT")" || exit 1
echo "cache=$CACHE stale=$STALE reason=$STALE_REASON learn_now=$LEARN_NOW verified=$CACHE_VERIFIED unresolved=$CACHE_UNRESOLVED"
cat "$CACHE" 2>/dev/null
```

`resolve` reads the **origin** remote — never `gh repo view`, which in a fork clone answers with the
upstream project — and prints shell assignments: `HOST`, `NWO`, `CACHE`, `STALE`, `STALE_REASON`
(`fresh`, `missing`, `age`, `unverified`, `sources-changed`, `unreadable`), `LEARN_NOW`, the last
failed learn attempt (`LAST_ATTEMPT_HOURS`, `LAST_ATTEMPT_REASON`), and what the cache's frontmatter
says about itself. Every value is validated before it is printed, which is why `eval` is safe here.

If it exits 2, the directory is not a git repo or has no `origin`: say so and stop. There is no repo
whose style could be learned.

Run LEARN (step 2) when `LEARN_NOW=1`, or whenever the user passed `--refresh-cache`. `LEARN_NOW`
is `STALE` minus a back-off: a learn that failed in the last 24 hours is not retried on every draft.
When `STALE=1` but `LEARN_NOW=0`, skip to step 3 and draft from the cache you have — or from
`schema.md` if there is none — and mention the last attempt's reason in your one closing line. Otherwise skip to step 3 with the cache contents you
just printed.

## 2. LEARN — only when `LEARN_NOW=1` or the user passed `--refresh-cache`

Read `${CLAUDE_PLUGIN_ROOT}/shared/learn-loop.md` and follow it end to end, then come back to step 3.
It holds the whole build: the two agent prompts, the `result` / `verified` / `publish` verbs, and the
fix rounds. Bind it with:

- `$BUILDER` = `automated-development:pr-style-builder`
- `$VERIFIER` = `automated-development:pr-style-verifier`
- `$ARTIFACT` = PR-description
- `$SAMPLES` = merged PRs

It sends you to step 3 partway through, while the builder works; that is deliberate.

## 3. Gather context for *this* PR

**Use what is already in the conversation first.** In a session where the branch has just been
worked on, the diff, the commit messages and the existing description are usually already known,
and this step should make zero tool calls. It runs while the builder works, when there is one.

Only fetch what you genuinely do not have:

```bash
gh pr view --repo "$HOST/$NWO" --json number,title,body,baseRefName,url   # current branch's PR, if any
gh pr diff --repo "$HOST/$NWO"                                            # its diff
```

`--repo` on both, for the same reason step 1 resolves from `origin`: in a fork clone these
commands otherwise resolve against the upstream project and hand you somebody else's PR.

If the branch has no PR yet, `gh pr view` fails — that is fine and expected. Fall back to the local
branch, resolving the base ref defensively: plenty of working clones are single-branch or shallow
and simply do not have `origin/<default>` locally.

```bash
BASE=$(gh repo view "$HOST/$NWO" --json defaultBranchRef -q .defaultBranchRef.name)
REF=$(git rev-parse --verify -q "origin/$BASE" || git rev-parse --verify -q "$BASE") || true
if [ -z "$REF" ]; then
  git fetch --no-tags --depth=200 origin "$BASE" && REF=FETCH_HEAD
fi
git log --format='%s%n%n%b' "$REF"..HEAD
git diff "$REF"...HEAD
```

That `git fetch` is the only thing this skill ever writes to the repository, it writes only into
`.git`, and it runs only when the base genuinely is not present. If it fails too — no network, a
fork with no such branch — say the base could not be resolved and draft from
`git log -20 --format='%s%n%n%b' HEAD` alone, noting in your one closing line that the diff was
unavailable.

If the existing description or the commits reference an issue, read it
(`gh issue view <n> --json title,body`) — the repo's prompt often expects the motivation to come
from there.

## 4. Draft, under the driver

Drafting runs **in this conversation**, not in a subagent. You know why this change was made, what
was abandoned and which tests actually ran; none of that is in the diff, and it is the part a
description exists to carry. A subagent would re-derive it and get the plausible version instead of
the true one.

Write the working file into your scratchpad directory if this session has one, otherwise a
`mktemp -d`. Give the driver the changed-file list too — it is what stops an invented test file
reaching the user:

```bash
WORK=<your scratchpad directory>                 # substitute the literal path; no env var holds it
[ -d "$WORK" ] || WORK=$(mktemp -d)              # sessions without one
DRAFT="$WORK/pr-description.md"
FILES="$WORK/pr-changed-files.txt"

# The PR's own file list when there is a PR, the branch's otherwise. $REF is the base ref resolved
# in step 3; fall back to the default branch if that path was never taken.
gh pr diff --repo "$HOST/$NWO" --name-only > "$FILES" 2>/dev/null \
  || git diff --name-only "${REF:-origin/$BASE}"...HEAD > "$FILES" 2>/dev/null \
  || : > "$FILES"

PROMPT="$CACHE"
[ "$CACHE_PATTERN" = none ] || [ ! -f "$CACHE" ] && PROMPT="$SCHEMA"   # no convention learned: the field list verbatim

node "$DRIVER" start --batch "pdd-$(openssl rand -hex 4)" \
  --mode draft --draft "$DRAFT" --prompt "$PROMPT" --files "$FILES" --root "$ROOT"
```

`--root` matters: with it, a file your description names that does not exist in the repo is an
invention and is rejected, while one that exists but this change does not touch is merely pointed
out — a description may legitimately point at context. Without it every untouched file is treated
as invented.

Then do exactly what it says, one step at a time, until it prints a line beginning `FINAL STATE:`.
It will send you back over the description a few times and will not let you stop on the first pass
that changes nothing. Answer `--changed yes|no` honestly: it is a fact about the file, not a verdict
on your work, and the driver uses nothing else to decide.

What it checks mechanically, so none of it is a matter of opinion:

- every section the cached prompt declares is present, and no heading outside that repo's vocabulary
- **no file named that does not exist in the repo** — an invented test file is the failure that bites
- code references are raw GitHub permalinks pinned to a pushed commit SHA, not `path:line`, not a
  branch ref, not wrapped in markdown link text
- no placeholder, no tooling banner, no filler phrase that carries nothing
- length and title length against the repo's own numbers — these two are **soft**: over the length
  guide it asks you to cut, once, and then accepts what comes back rather than forcing you to drop
  something a reviewer needs

When `$PROMPT` is `schema.md` there is no measured length, so the driver falls back to a generic
3000-byte guide; pass `--max-bytes` if you know better.

## 5. Print

Print the result as:

```
Title: <title>

<body>
```

Then one line, at most, on anything the draft could not source from the context — an empty test
plan, a missing issue link, a risk you could not assess — and, if `CACHE_VERIFIED=false`, that the
repo's prompt carries `CACHE_UNRESOLVED` unresolved verification findings and will be rebuilt within
a week. Nothing else: no summary of what you did, no account of the driver passes, no offer to apply
it.

Do not offer, and do not stop, when the request was the action. "Create the PR", "update the PR
body" are asks this skill does not carry out itself, so opening or editing that PR is your next step
once the skill has returned — with this title and this body, unedited. Print it either way: the user
sees the text before it lands, and sees it even when the `gh` call fails.
