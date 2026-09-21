---
name: draft-commit-message
description: Write a commit message — subject, body, references and trailers — in this repo's own style, learned from its commitlint or commit-msg hook config, its commit template and its authors' recent commits and cached per repo. Use when asked to "write the commit message", "commit message for this", "draft a commit", "what should the commit say", or to rewrite the message of the commit being amended. Use it before a commit is made or its message rewritten — "commit this", "commit these changes", "stage and commit", "reword the commit", "fix the commit message" — to write the message that commit is made or amended with, and use it when the points the message should make are handed to you rather than asked for.
---

# Commit message draft

Produces **text**: a commit message, printed for the user and written to a file they can hand to
`git commit -F`. This skill never runs `git commit`, `git commit --amend`, `git rebase` or `git push`.
Every git command it runs is a read. Committing the message is a separate step outside this skill,
taken once it has returned by whoever asked for it.

Drafts-only is a limit on what this skill does, **not** on when it runs. "Commit this", "stage and
commit these changes", "reword the commit" all need a message, so they run this skill first and the
caller applies what it printed afterwards. It runs when the content is supplied too: points the user
dictates or a message they paste are the material, and this skill puts them in the repo's subject
grammar, wrap column and trailer form rather than inventing different content. Their facts win. The
one case it does not run is a message handed over as final and marked to be used verbatim.

The message is written by a **cached, repo-specific generation prompt** — not by generic instincts
about Conventional Commits or the fifty-character rule. Each repo gets its own prompt, derived once
from its configuration and from how its authors actually commit, then reused until it goes stale.

Everything mechanical is done by `promptgen-driver.js`, the same driver the PR and issue skills use,
told `--domain commit`. It resolves the repo, judges staleness, names every file, drives the builder
and the drafter step by step, records the verifier's verdict, and publishes. You hold no state of
your own; when in doubt, ask the driver.

```bash
DRIVER="${CLAUDE_PLUGIN_ROOT}/bin/promptgen-driver.js"
SCHEMA="${CLAUDE_PLUGIN_ROOT}/skills/draft-commit-message/schema.md"
LEARN="${CLAUDE_PLUGIN_ROOT}/skills/draft-commit-message/learn.md"
VERIFY="${CLAUDE_PLUGIN_ROOT}/skills/draft-commit-message/verify.md"
```

## 1. Resolve the repo and its cache

```bash
ROOT=$(git rev-parse --show-toplevel) || { echo "not a git repo"; exit 1; }
eval "$(node "$DRIVER" resolve --domain commit --root "$ROOT")" || exit 1
echo "cache=$CACHE stale=$STALE reason=$STALE_REASON learn_now=$LEARN_NOW verified=$CACHE_VERIFIED unresolved=$CACHE_UNRESOLVED"
cat "$CACHE" 2>/dev/null
```

`resolve` reads the **origin** remote — never `gh repo view` — and prints shell assignments:
`DOMAIN`, `HOST`, `NWO`, `CACHE`, `STALE`, `STALE_REASON` (`fresh`, `missing`, `age`, `unverified`,
`sources-changed`, `unreadable`), `LEARN_NOW`, the last failed learn attempt (`LAST_ATTEMPT_HOURS`,
`LAST_ATTEMPT_REASON`), and what the cache's frontmatter says about itself. Every value is validated
before it is printed, which is why `eval` is safe here. The commit cache lives under
`~/.claude/commit-style-cache/`, apart from the PR and issue ones. `sources-changed` fires when
commitlint, a commit-msg hook, the commit template or the contributing guide changed since the
cache was built.

If it exits 2, the directory is not a git repo or has no `origin`: say so and stop. The cache is
keyed by the remote, and a clone without one has no key.

Run LEARN (step 2) when `LEARN_NOW=1`, or whenever the user passed `--refresh-cache`. `LEARN_NOW`
is `STALE` minus a back-off: a learn that failed in the last 24 hours is not retried on every draft.
When `STALE=1` but `LEARN_NOW=0`, skip to step 3 and draft from the cache you have — or from
`schema.md` if there is none — and mention the last attempt's reason in your one closing line. Otherwise skip to step 3 with the cache contents you
just printed.

## 2. LEARN — only when `LEARN_NOW=1` or the user passed `--refresh-cache`

Read `${CLAUDE_PLUGIN_ROOT}/shared/learn-loop.md` and follow it end to end, then come back to step 3.
It holds the whole build: the two agent prompts, the `result` / `verified` / `publish` verbs, and the
fix rounds. Bind it with:

- `$BUILDER` = `automated-development:commit-style-builder`
- `$VERIFIER` = `automated-development:commit-style-verifier`
- `$ARTIFACT` = commit-message
- `$SAMPLES` = commits

Neither agent needs `gh`: a commit learn runs on `git log` alone, so it works offline. It sends you
to step 3 partway through, while the builder works; that is deliberate.

## 3. Gather context for *this* change

**Use what is already in the conversation first.** In a session where the change has just been made,
you know why it was made, what was tried and abandoned, and which tests ran. None of that is in the
diff, and it is the part a commit body exists to carry. This step should make very few tool calls.
It runs while the builder works, when there is one.

Settle what is being described:

**The staged change** is the default. If nothing is staged, say so in your closing line and draft
from the working-tree diff — the user stages before they commit, and the message is the same.

```bash
git diff --cached --stat                  # what is staged
git diff --cached                         # the change itself, if it is not already in the conversation
git diff --cached --quiet && git diff --stat   # nothing staged: the working tree instead
```

**Amending.** When the user asks to rewrite the message of the last commit (`--amend`, "fix the
commit message", "reword HEAD"), the change is HEAD's and the old message is the starting point:

```bash
git log -1 --format=%B HEAD               # the message being replaced
git show --stat --format= HEAD            # the files it touched
```

**References.** The issue or ticket, if the conversation or the branch name carries one
(`fix/issue-88`, `JIRA-1234-...`): `git rev-parse --abbrev-ref HEAD`. Do not invent one.

**Identity**, only when the cached prompt requires a `Signed-off-by` or the user asks for one:

```bash
git var GIT_COMMITTER_IDENT               # "Name <email> timestamp tz" - the trailer is the first two parts
```

## 4. Draft, under the driver

Drafting runs **in this conversation**, not in a subagent. You made this change; a subagent would
re-derive the reason from the diff and get the plausible version instead of the true one.

Write the working file into your scratchpad directory if this session has one, otherwise a
`mktemp -d`. Give the driver the changed-file list too — it is what stops an invented test file
reaching the message:

```bash
WORK=<your scratchpad directory>                 # substitute the literal path; no env var holds it
[ -d "$WORK" ] || WORK=$(mktemp -d)              # sessions without one
DRAFT="$WORK/commit-message.md"
FILES="$WORK/commit-changed-files.txt"

git diff --cached --name-only > "$FILES"                         # the staged files
[ -s "$FILES" ] || git diff --name-only > "$FILES"                # or the working tree's
# when amending: git show --name-only --format= HEAD > "$FILES"

PROMPT="$CACHE"
[ "$CACHE_PATTERN" = none ] || [ ! -f "$CACHE" ] && PROMPT="$SCHEMA"   # no convention learned: the field list verbatim

node "$DRIVER" start --domain commit --batch "cdd-$(openssl rand -hex 4)" \
  --mode draft --draft "$DRAFT" --prompt "$PROMPT" --files "$FILES" --root "$ROOT"
```

Then do exactly what it says, one step at a time, until it prints a line beginning `FINAL STATE:`.
It will send you back over the message a few times and will not let you stop on the first pass that
changes nothing. Answer `--changed yes|no` honestly: it is a fact about the file, not a verdict on
your work, and the driver uses nothing else to decide.

What it checks mechanically, so none of it is a matter of opinion:

- the subject against the repo's own ceiling (`title_max`, or 72), soft: over it, it asks for a cut
- every labelled part the prompt declares (`Problem:`, `Solution:`) present; no markdown heading
  where the repo's commits carry none
- body lines against the repo's wrap column (`wrap_at`), when the prompt records one — URLs and
  quoted output excepted
- every trailer the prompt marks required, spelled exactly, at the end
- **no file named that does not exist in the repo**, and a note on files this change does not touch
- no tooling banner, no placeholder, no filler phrase that carries nothing
- total length against the repo's own `max_bytes`, soft: one trimming pass, then it accepts

`path/to/file.py:42` is **not** rejected here, unlike in a PR description — a commit message is read
in a terminal. Web permalinks are not asked for.

When `$PROMPT` is `schema.md` there is no measured length, so the driver falls back to a generic
3000-byte guide; pass `--max-bytes` if you know better.

## 5. Print

Copy the message out of the working file — everything below the `Title:` line's subject, i.e. the
subject, a blank line and the body — into `$WORK/commit-message.txt`, and print it in one fenced
block exactly as the file has it:

```
pool: join workers on shutdown so the process can exit

Workers still mid-handshake kept the process alive after shutdown()
returned. ...

Fixes #88
```

Then one line, at most: the path of `commit-message.txt` so the user can `git commit -F` it (or
`git commit --amend -F` it), plus anything the draft could not source — an issue you could not
identify, nothing staged, a `Signed-off-by` identity you could not read — and, if
`CACHE_VERIFIED=false`, that the repo's prompt carries `CACHE_UNRESOLVED` unresolved verification
findings and will be rebuilt within a week. Nothing else: no summary of what you did, no account of
the driver passes, and no `git commit` from inside these steps.

Do not offer, and do not stop, when the request was the action. "Commit this", "reword the commit"
are asks this skill does not carry out itself, so the commit is your next step once the skill has
returned: `git commit -F "$WORK/commit-message.txt"`, or `git commit --amend -F` it, with the message
exactly as drafted. Print it either way: the user sees the message before it lands.
