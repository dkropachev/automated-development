---
name: draft-issue-description
description: Draft a GitHub issue — title, labels and body — in this repo's own style, learned from its issue templates and forms and its maintainers' own issues and cached per repo. Use when asked to "file a bug", "write an issue", "draft an issue", "open a feature request", "report this", or to rewrite an existing issue in the repo's style. Use it before an issue is filed or its body changed — "create an issue", "open an issue", "file an issue", "file a ticket", "update the issue" — to write the text that issue is filed or updated with, and use it when the points the issue should make are handed to you rather than asked for.
---

# Issue draft

Produces **text**: a title, the labels the repo's template applies, and a body, printed for the
user. This skill never calls `gh issue create`, `gh issue edit`, `gh issue comment` or anything else
that writes to GitHub. Every `gh` call it makes is read-only. Filing the draft — `gh issue create`,
`gh issue edit` — is a separate step outside this skill, taken once it has returned by whoever asked
for it.

Drafts-only is a limit on what this skill does, **not** on when it runs. "Create an issue for this",
"open an issue", "file a ticket", "update the issue" all need a title, labels and a body, so they run
this skill first and the caller applies what it printed afterwards. It runs when the content is
supplied too: a report the user pastes or the symptoms they dictate are the material, and this skill
puts them in the kind, the labels and the sections the repo's forms ask for rather than inventing
different content. Their facts win. The one case it does not run is text handed over as final and
marked to be used verbatim.

The draft is written by a **cached, repo-specific generation prompt** — not by generic instincts
about what a bug report should look like. Each repo gets its own prompt, derived once from its issue
templates and forms and from how its maintainers actually write issues, then reused until it goes
stale. A repo with more than one template has **kinds** — a bug, a feature request — and the prompt
carries each kind's sections separately.

Everything mechanical is done by `promptgen-driver.js`, the same driver `draft-pr-description`
uses, told `--domain issue`. It resolves the repo, judges staleness, names every file, drives the
builder and the drafter step by step, records the verifier's verdict, and publishes. You hold no
state of your own; when in doubt, ask the driver.

```bash
DRIVER="${CLAUDE_PLUGIN_ROOT}/bin/promptgen-driver.js"
SCHEMA="${CLAUDE_PLUGIN_ROOT}/skills/draft-issue-description/schema.md"
LEARN="${CLAUDE_PLUGIN_ROOT}/skills/draft-issue-description/learn.md"
VERIFY="${CLAUDE_PLUGIN_ROOT}/skills/draft-issue-description/verify.md"
```

## 1. Resolve the repo and its cache

```bash
ROOT=$(git rev-parse --show-toplevel) || { echo "not a git repo"; exit 1; }
eval "$(node "$DRIVER" resolve --domain issue --root "$ROOT")" || exit 1
echo "cache=$CACHE stale=$STALE reason=$STALE_REASON learn_now=$LEARN_NOW verified=$CACHE_VERIFIED unresolved=$CACHE_UNRESOLVED kinds=$CACHE_KINDS"
cat "$CACHE" 2>/dev/null
```

`resolve` reads the **origin** remote — never `gh repo view`, which in a fork clone answers with the
upstream project — and prints shell assignments: `DOMAIN`, `HOST`, `NWO`, `CACHE`, `CACHE_KINDS`,
`STALE`, `STALE_REASON` (`fresh`, `missing`, `age`, `unverified`, `sources-changed`, `unreadable`),
`LEARN_NOW`, the last failed learn attempt (`LAST_ATTEMPT_HOURS`, `LAST_ATTEMPT_REASON`), and what the
cache's frontmatter says about itself. Every value is validated before it is printed, which is why
`eval` is safe here. The issue cache lives under `~/.claude/issue-style-cache/`, apart from the PR
one; the two skills never read each other's.

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

- `$BUILDER` = `automated-development:issue-style-builder`
- `$VERIFIER` = `automated-development:issue-style-verifier`
- `$ARTIFACT` = issue
- `$SAMPLES` = issues

It sends you to step 3 partway through, while the builder works; that is deliberate.

## 3. Gather context for *this* issue

**Use what is already in the conversation first.** In a session where the failure has just been
hit — a test that broke, a command that crashed, a behaviour the user described — the symptom, the
output, the version and the file involved are usually already known, and this step should make
almost no tool calls. It runs while the builder works, when there is one.

Settle three things, in this order:

**The kind.** If the cache declares kinds (`CACHE_KINDS` is non-empty), read its `## Kinds` section
and pick the one this report is: a failure is a bug, a wish is a feature, and the section says what
this repo does with the rest. Decide from what the user described; ask them only when the report
genuinely fits two kinds and the sections would differ. If the cache says the repo routes this sort
of report elsewhere — questions to Discussions, security to an address — say so in one line and
stop; there is nothing to draft. With no kinds, there is nothing to choose.

**The facts.** Only fetch what you genuinely do not have:

```bash
git describe --tags --always 2>/dev/null                      # the version the user is on, when the repo tags
git rev-parse HEAD                                             # for permalinks; must be pushed
gh issue view <n> --repo "$HOST/$NWO" --json title,body,labels  # when rewriting an existing issue
```

`--repo` on every `gh` call, for the same reason step 1 resolves from `origin`: in a fork clone
these commands otherwise answer for the upstream project.

**Duplicates and neighbours.** One read-only search, so the draft can link a related issue or say
this one differs from it:

```bash
gh issue list --repo "$HOST/$NWO" --state all --search "<three or four words from the symptom>" --limit 10 --json number,title,state,url
```

If something there is plainly the same bug, say so in your closing line rather than drafting a
duplicate; the user decides. If it is related but not the same, the draft links it in the form the
cached prompt says this repo uses.

## 4. Draft, under the driver

Drafting runs **in this conversation**, not in a subagent. You have seen the failure — the command,
the output, the version, the file the trace names, what was ruled out — and none of that is on GitHub
yet. A subagent would re-derive it and get the plausible version instead of the true one.

Write the working file into your scratchpad directory if this session has one, otherwise a
`mktemp -d`. There is no changed-file list — an issue describes no change — but `--root` is what
lets the driver tell a file you invented from one that exists:

```bash
WORK=<your scratchpad directory>                 # substitute the literal path; no env var holds it
[ -d "$WORK" ] || WORK=$(mktemp -d)              # sessions without one
DRAFT="$WORK/issue.md"

PROMPT="$CACHE"
[ "$CACHE_PATTERN" = none ] || [ ! -f "$CACHE" ] && PROMPT="$SCHEMA"   # no convention learned: the field list verbatim

node "$DRIVER" start --domain issue --batch "idd-$(openssl rand -hex 4)" \
  --mode draft --draft "$DRAFT" --prompt "$PROMPT" --kind "$KIND" --root "$ROOT"
```

`$KIND` is the slug you settled on in step 3; drop `--kind` when the cache declares none. If the
prompt declares kinds and the one you pass is not among them, `start` refuses and lists them — pick
again rather than draft against every template at once.

Then do exactly what it says, one step at a time, until it prints a line beginning `FINAL STATE:`.
It will send you back over the issue a few times and will not let you stop on the first pass that
changes nothing. Answer `--changed yes|no` honestly: it is a fact about the file, not a verdict on
your work, and the driver uses nothing else to decide.

What it checks mechanically, so none of it is a matter of opinion:

- every section the cached prompt declares **for this kind** is present, and no heading outside
  that kind's vocabulary — a bug report does not carry the feature form's headings
- **no file named that does not exist in the repo**
- code references are raw GitHub permalinks pinned to a pushed commit SHA, not `path:line`, not a
  branch ref, not wrapped in markdown link text
- no template comment left in, no placeholder, no tooling banner, no filler phrase that carries
  nothing
- length and title length against the repo's own numbers — these two are **soft**: over the length
  guide it asks you to cut, once, and then accepts what comes back rather than forcing you to drop
  the log line a maintainer needs

When `$PROMPT` is `schema.md` there is no measured length, so the driver falls back to a generic
3000-byte guide; pass `--max-bytes` if you know better.

## 5. Print

Print the result as:

```
Title: <title>
Labels: <labels, when the kind has them>

<body>
```

Then one line, at most, on anything the draft could not source from the context — a version you
could not determine, a reproduction you did not run, a possible duplicate you found in step 3 — and,
if `CACHE_VERIFIED=false`, that the repo's prompt carries `CACHE_UNRESOLVED` unresolved verification
findings and will be rebuilt within a week. Nothing else: no summary of what you did, no account of
the driver passes, no offer to file it.

Do not offer, and do not stop, when the request was the action. "Create an issue for this", "update
the issue" are asks this skill does not carry out itself, so filing or editing that issue is your
next step once the skill has returned — with this title, these labels and this body, unedited. Print
it either way: the user sees the text before it lands, and sees it even when the `gh` call fails.
