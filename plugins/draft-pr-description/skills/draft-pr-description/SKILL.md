---
name: draft-pr-description
description: Draft a PR title and description that match how this specific repo actually writes them — learned once from the repo's own config and its top contributors' last 20 merged PRs, cached per repo, refreshed every 90 days. Use when asked to "draft a PR description", "write the PR description", "pr description", or to rewrite an existing one in the repo's style. Drafts only — never edits or creates a PR on GitHub.
---

# PR description draft

Produces **text**: a title and a description body, printed for the user. This skill never calls
`gh pr edit`, `gh pr create`, or anything else that writes to GitHub. Every `gh` call it makes is
read-only. If the user wants the draft applied, they say so and that is a separate action outside
this skill.

The draft is written by a **cached, repo-specific generation prompt** — not by generic instincts
about what a PR description should look like. Each repo gets its own prompt, derived once from that
repo's configuration and from how its top contributors actually write PRs, then reused until it
goes stale.

## 1. Resolve the repo and its cache

```bash
# Resolve from the ORIGIN remote, not from `gh repo view` alone. In a fork clone that also has an
# `upstream` remote, gh answers with the upstream repo: in ~/python-driver, whose origin is
# scylladb/python-driver, bare `gh repo view` returns apache/cassandra-python-driver. That would
# cache under the wrong path and learn a different project's conventions.
ORIGIN=$(git remote get-url origin)
HOST=$(printf '%s' "$ORIGIN" | sed -E 's#^git@([^:]+):.*#\1#; s#^ssh://git@([^/]+)/.*#\1#; s#^https?://([^/]+)/.*#\1#')
NWO=$(printf '%s' "$ORIGIN" | sed -E 's#^(git@[^:]+:|ssh://git@[^/]+/|https?://[^/]+/)##; s#\.git$##')
CACHE="$HOME/.claude/pr-style-cache/$HOST/$NWO.md"

STALE=0
if [ ! -f "$CACHE" ]; then
  STALE=1
else
  LEARNED=$(sed -n 's/^learned_at: //p' "$CACHE" | head -1)
  AGE=$(( ( $(date +%s) - $(date -d "${LEARNED:-1970-01-01}" +%s 2>/dev/null || echo 0) ) / 86400 ))
  [ "$AGE" -gt 90 ] && STALE=1
fi
echo "cache=$CACHE stale=$STALE"
cat "$CACHE" 2>/dev/null
```

Run LEARN (step 2) when `stale=1`, or whenever the user passed `--refresh-cache`. Otherwise skip
straight to step 3 with the cache contents you just printed.

If the working directory is not a git repo, or it has no `origin` remote, say so and stop — there is
no repo whose style could be learned. Do not fall back to bare `gh repo view` to recover: that is
the very call whose answer this step exists to avoid.

## 2. LEARN (only on a miss, on staleness, or on `--refresh-cache`)

Run the **`pr-description-prompt` workflow**. Building this prompt well matters more than building
it cheaply — it is built once and then reused for 90 days — so it gets its own agents rather than an
inline pass:

```
Workflow(scriptPath: '${CLAUDE_PLUGIN_ROOT}/workflows/pr-description-prompt.js', args: {
  repoRoot:   '<absolute repo root>',
  pluginRoot: '${CLAUDE_PLUGIN_ROOT}',
})
```

By `scriptPath`, not by `name`: a plugin's workflows are not a registered component the way its
skills are, so there is no name for this one to resolve to. The path is.

A builder agent mines the repo and is driven by `promptgen-driver.js` through up to 8 critique
passes over its own draft, unable to stop until two consecutive passes find nothing. Coverage of
every **required** field in `schema.md` is measured mechanically, not asserted — the repo-conditional
ones, `testing` above all, are included only if that repo actually writes them. A fresh read-only agent then
verifies the draft against PRs the builder never sampled, and only then is it moved into place.
The workflow returns a short report; relay what matters from it and carry on.

It writes the cache itself. Do not write, edit or pre-create the cache file yourself — if the
workflow fails, the previous prompt (or no prompt) is the correct state, and step 4 handles both.

The workflow runs in the background and its result arrives as a notification. Wait for it before
step 3: without the cache there is nothing to draft with.

## 3. Gather context for *this* PR

**Use what is already in the conversation first.** In a session where the branch has just been
worked on, the diff, the commit messages and the existing description are usually already known,
and this step should make zero tool calls.

Only fetch what you genuinely do not have:

```bash
gh pr view --repo "$NWO" --json number,title,body,baseRefName,url   # current branch's PR, if any
gh pr diff --repo "$NWO"                                            # its diff
```

`--repo "$NWO"` on both, for the same reason step 1 resolves from `origin`: in a fork clone these
commands otherwise resolve against the upstream project and hand you somebody else's PR.

If the branch has no PR yet, `gh pr view` fails — that is fine and expected. Fall back to the local
branch, resolving the base ref defensively: plenty of working clones are single-branch or shallow
and simply do not have `origin/<default>` locally.

```bash
BASE=$(gh repo view "$NWO" --json defaultBranchRef -q .defaultBranchRef.name)
REF=$(git rev-parse --verify -q "origin/$BASE" || git rev-parse --verify -q "$BASE") || true
if [ -z "$REF" ]; then
  git fetch --no-tags --depth=200 origin "$BASE" && REF=FETCH_HEAD
fi
git log --format='%s%n%n%b' "$REF"..HEAD
git diff "$REF"...HEAD
```

That `git fetch` is the only thing this skill ever writes, it writes only into `.git`, and it runs
only when the base genuinely is not present. If it fails too — no network, a fork with no such
branch — say the base could not be resolved and draft from `git log -20 --format='%s%n%n%b' HEAD`
alone, noting in your one closing line that the diff was unavailable.

If the existing description or the commits reference an issue, read it
(`gh issue view <n> --json title,body`) — the repo's prompt often expects the motivation to come
from there.

## 4. Draft, under the driver

Drafting runs **in this conversation**, not in a subagent. That is the point: you have been working
on this change and know why it was made, what was abandoned, and which tests actually ran. None of
that is in the diff, and it is the part a description exists to carry. A subagent would have to
re-derive it from the code and would get the plausible version instead of the true one.

Write the working file into your scratchpad directory if this session has one,
otherwise a `mktemp -d`. Give the driver the changed-file list too — it is what
stops an invented test file reaching the user:

```bash
WORK=<your scratchpad directory>                 # substitute the literal path; no env var holds it
[ -d "$WORK" ] || WORK=$(mktemp -d)              # sessions without one
DRAFT="$WORK/pr-description.md"
FILES="$WORK/pr-changed-files.txt"

# The PR's own file list when there is a PR, the branch's otherwise. $REF is the base ref resolved
# in step 3; fall back to the default branch if that path was never taken.
gh pr diff --repo "$NWO" --name-only > "$FILES" 2>/dev/null \
  || git diff --name-only "${REF:-origin/$BASE}"...HEAD > "$FILES" 2>/dev/null \
  || : > "$FILES"

node "${CLAUDE_PLUGIN_ROOT}/bin/promptgen-driver.js" start --batch "pdd-$(openssl rand -hex 4)" \
  --mode draft --draft "$DRAFT" --prompt "$CACHE" --files "$FILES" --root "$(git rev-parse --show-toplevel)"
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
- no placeholder, no tooling banner, no filler phrase that carries nothing
- length and title length against the repo's own numbers — these two are **soft**: over the length
  guide it asks you to cut, once, and then accepts what comes back rather than forcing you to drop
  something a reviewer needs

If the cache says `pattern: none`, the repo has no discernible convention — pass `schema.md` as
`--prompt` instead and use its fields verbatim. That file carries no measured length, so the driver
falls back to a generic 3000-byte guide; pass `--max-bytes` if you know better.

## 5. Print

Print the result as:

```
Title: <title>

<body>
```

Then one line, at most, on anything the draft could not source from the context — an empty test
plan, a missing issue link, a risk you could not assess. Nothing else: no summary of what you did,
no account of the driver passes, no offer to apply it.
