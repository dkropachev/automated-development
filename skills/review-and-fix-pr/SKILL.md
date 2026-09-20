---
name: review-and-fix-pr
description: Review a PR hunk by hunk, fix what it finds, defer what is too big, and report what is still broken after the fixes — chunking the diff into size-capped batches, staged code → tests → cicd → other, remembering clean hunks across runs. Use when asked to "review this PR and fix it", "review and fix PR 1234", "review and fix pr", or to iterate on review findings until a PR is clean. Not for a read-only review (use /code-review for that).
---

# PR review-and-fix, chunked and staged

Runs the `review-and-fix-pr` workflow. The diff is split into **chunks** — size-capped batches of
whole hunks drawn from files that share an isolation lock key — and each chunk is reviewed, fixed and
**reviewed again** until it comes back clean. Stages run in a fixed order with a hard barrier
between them: **code → tests → cicd → other**. Each fixer validates and commits its own batch.
Nothing is ever pushed, and nothing is ever reverted.

Two shapes, picked by size:

- **parallel** (big PRs) — the diff is split into **chunks** (size-capped batches of whole hunks) and
  up to 5 **read-only reviewers** work on them at once. Reviewers never edit anything, so nothing they
  do can collide. Their findings are pooled per stage, then **one fixer at a time** takes a batch of
  10, fixes, re-reads its own work, validates it and commits it — all in its own conversation —
  before a brand-new fixer starts the next 10.
- **single** (small PRs) — one agent reviews and fixes the whole PR, driven through both loops by
  `review-and-fix-pr-driver.js` exactly as a reviewer and a fixer are. At or below 20KB of diff the
  per-agent overhead of splitting costs more than it saves.

What else is worth knowing:

- **`detailedReview: true` changes what a reviewer is allowed to do**, not just how hard it tries. It
  may follow the code out of its chunk to every caller, and it may clone the repo and *run* things:
  feed the degenerate input, delete a guard the diff adds and see whether any test notices, compare
  behaviour at head against the merge base. Measured on one PR, a reading-only reviewer read the exact
  lines of two caller-side panics and reported neither; reviewers that ran the input found both.
- **Three different things can happen to a candidate, and the report keeps them apart.** *Rejected —
  not a bug*: the reviewer re-read the code and it is correct; recorded so no later run re-raises it.
  *Set aside — out of scope, not investigated*: a real-looking defect this PR did not cause, which a
  default run is told not to spend time on; nobody verified it, the report says so, and a later
  `detailedReview: true` run **will** pick it up. *Out of scope — real*: in a detailed run the same
  defect is investigated, reproduced and reported in its own section — never fixed, because a bug the
  PR did not cause is not its to change. Scope is a label decided after a candidate is known to be
  real, never a filter applied before looking; if the PR's change makes a defect reachable or worse,
  it is *in* scope even on an untouched line, and undecidable means *in*.
- **The scope agent quotes, it does not infer.** `outOfScope` holds only sentences the author actually
  wrote deferring something, verbatim; an empty list is the normal case. It used to be told to derive
  "non-goals" and that an empty list was wrong — and one derived line ("caller behaviour is out of
  scope") made a reviewer drop a reproduced process crash in the author's name.
- **Nothing ends on a write.** A reviewer double-checks every candidate against the real code before
  reporting it; a fixer re-reads everything it changed and reports what its re-read still sees.
- **Reviewed files are remembered across runs.** A reviewer that finds a file clean records it with
  `review-and-fix-pr-reviewed.js` itself, keyed on the sha of that file's diff against the merge base, so it is never
  reviewed again until its content changes. Only files it found nothing in are recorded, so the
  content recorded is content nobody is about to change; if a later fix touches such a file anyway,
  its sha changes and the next run reviews it again.
- **Small follow-ups are done, not filed.** The fixer carries out anything that belongs in this PR and
  fits inside the files it was granted; big ones are reported.
- **Release blockers are called out first**, each with one sentence naming what breaks if you ship.

`$1` is an optional PR number or URL. With no argument it uses the PR for the current branch.

## Preflight — do this inline first, it is much faster than finding out from an agent

```bash
git rev-parse --abbrev-ref HEAD && git status --porcelain && gh auth status 2>&1 | head -3
gh pr view $1 --json number,title,headRefOid,baseRefName,url,author   # omit $1 for the current branch
gh api user --jq .login                                              # who you are authenticated as
```

Refuse, and say which check failed, if any of these hold:

- `git status --porcelain` printed anything → the tree is dirty. The workflow commits to this branch,
  and a batch whose build fails leaves its edits in the tree for you to look at — neither is safe over
  uncommitted work of your own. Tell the user to commit or stash.
- `git rev-parse HEAD` ≠ the PR's `headRefOid` → fixes would land on the wrong branch. Offer
  `gh pr checkout <number>`.
- `gh auth status` is not logged in, or no PR resolves.

Also confirm the helper scripts exist (`review-and-fix-pr-chunker.js`,
`review-and-fix-pr-driver.js`, `review-and-fix-pr-reviewed.js`, `review-and-fix-pr-repofp.js`) —
the workflow refuses to start without them. `review-and-fix-pr-driver.js` matters most: every
reviewer and every fixer is walked through its work by it.

```bash
ls "${CLAUDE_PLUGIN_ROOT}/bin/" | grep review-and-fix-pr
```
Run `npm test` in the plugin checkout if you suspect one of them.

The workflow re-checks all of this itself, so never skip the gate to "save a step" — just report it
sooner.

## Offer the user the choice, then run it

Chunking only earns its keep on a diff with something to chunk, so measure before you ask. This is
one cheap local command and no agent. **Pass `--ledger`** — files already reviewed in an earlier run
are not work, and leaving it out inflates the numbers and can offer a choice for a PR that has almost
nothing left to do:

```bash
SLUG=<owner>__<repo>
node "${CLAUDE_PLUGIN_ROOT}/bin/review-and-fix-pr-chunker.js" --root <repo> --base <mergeBase> --head <headSha> \
  --classify ~/.claude/review-and-fix-pr/$SLUG/classify.json \
  --ledger   ~/.claude/review-and-fix-pr/$SLUG/reviewed.json \
  --out /tmp/prfix-probe --isolation './../' 2>/dev/null | python3 -c \
  'import json,sys; m=json.load(sys.stdin); print(m["totals"]["chunks"], m["totals"]["bytes"])'
```

(If `classify.json` does not exist yet the flag is harmless — the chunker falls back to a built-in rule
for the probe, and the run generates the real one.)

**Small PR — `chunks == 0` or `bytes <= 20000`: do not offer anything.** Run it with
`mode: 'single'` and say in one line that the PR was too small to be worth splitting. Splitting a
diff this size costs more in per-agent overhead than it saves, so there is no decision to make.

**Big PR — otherwise: ask, with chunked as the default.** Use `AskUserQuestion`, put the parallel
option **first and label it `(Recommended)`**, and name the real chunk count:

- **"Parallel review (N chunks) (Recommended)"** — N read-only reviewers over the chunks, then fixes
  applied one batch at a time. The only mode with per-hunk coverage, and the only one whose clean
  files are remembered for next time.
- **"Single agent"** — one agent reads the whole diff. It sees interactions *between* chunks that a
  per-chunk review structurally cannot, but it has no coverage guarantee and does not scale.

**Always ask the second question too, whatever the size: fix, or review only?** Compare the PR's
`author.login` with `gh api user --jq .login` and let that pick the default — but always offer both,
because wanting a read-only pass over your own PR, or having authority to fix someone else's, are
both perfectly normal.

- **The PR is yours** → default **"Review and fix (Recommended)"**, with "Review only" offered.
- **The PR is someone else's, or authorship could not be determined** → default
  **"Review only (Recommended)"**, with "Review and fix" offered, and say whose PR it is in the
  option description. Fixing writes commits onto their branch, which is their call, not yours.

Pass the answer through as `fix: true` or `fix: false`. Omitting it is deliberately review-only;
repository ownership is not delegated to a model-produced boolean.

```
Workflow({
  scriptPath: '${CLAUDE_PLUGIN_ROOT}/workflows/review-and-fix-pr.js',
  args: {
    pr: '<number>',
    pluginRoot: '${CLAUDE_PLUGIN_ROOT}',   // REQUIRED - how the workflow finds its own helper scripts
    mode: 'parallel' | 'single',
    fix: true | false,
  },
})
```

`mode` defaults to `'auto'`: pick by diff size, and if the parallel pass finds **nothing at all**,
escalate to one whole-PR pass rather than believing it. Pass `repoRoot` when the session's working directory
is not the repository itself.

| arg | default | meaning |
|---|---|---|
| `pr` | current branch's PR | PR number or URL |
| `fix` | `false` | `true` to edit and commit, `false` for a read-only pass. The skill always asks and passes this explicitly. |
| `mode` | `'auto'` | `parallel` \| `single` \| `full` \| `auto` (parallel above 20KB of diff, single at or below it; full forces one whole-PR pass) |
| `reviewConcurrency` | 5 | read-only reviewers in flight at once |
| `maxFixBatch` | 10 | findings per fixer; a fresh agent takes the next batch after this one commits |
| `chunkBytes` | `{code:20000, test:20000, cicd:20000, other:20000}` | per-stage cap on packed hunk bytes. A single hunk larger than the cap is **never split** — git emits a newly added file as one hunk, so a new 2,800-line file is one chunk by design. |
| `isolation` | `'./../'` | which files may share a chunk: `.` the file, `./../`×n n levels up, `*/`×n n levels down from the root. It no longer constrains scheduling — reviewers are read-only and fixers are serial, so nothing can collide. |
| `stages` | `['code','test','cicd','other']` | order and membership |
| `detailedReview` | false | let reviewers leave the hunk: trace every caller, and **run experiments** in a throwaway clone (`git clone --no-hardlinks --no-local`) rather than reasoning about the code. Costs ~2× and finds caller-side defects a reading-only pass looks straight past. The repo under review stays read-only; nothing may be pushed. |
| `ignoreLedger` | false | re-review files already recorded clean |
| `refreshRules` | false | regenerate the per-repo `classify.json` |
| `maxAgents` | 900 | hard stop on agents spawned (platform ceiling is 1000). Checked before every wave. |
| `maxTokens` | none | stop once this many tokens have been spent *by this run*. Measured as a delta of `budget.spent()`, because `budget.total`/`remaining()` are null unless a ceiling was configured. |
| `repoRoot` | (session cwd) | absolute path to the repository |

Before each stage the run estimates the agents it will need against the agents left. If it will not
fit, it widens `chunkBytes` and re-chunks so the same hunks pack into fewer, larger chunks. If even
that does not fit (a stage of single oversize hunks, which are never split), it reviews what fits and
lists the rest under **NOT REVIEWED** — nothing silently disappears, and nothing skipped is written to
the ledger, so a re-run picks it up.

## How the driver runs an agent

`bin/review-and-fix-pr-driver.js` is a state machine that runs *inside* an agent's conversation: the agent runs a
command, the driver prints the next step, the agent does it and runs the next command. It holds the
decisions the agent should not make for itself, and the step it prints is a command, not a rule —
a gate the agent cannot talk itself past. Each machine has its own verbs so the two cannot be
confused:

```
fix     start  →  fixed --followups N  →  validated --passed yes|no  →  committed
review  start  →  found --new N        →  checked --kept N --clean-files ...  →  marked
```

**Fix.** `fixed --followups N` loops on itself until N is 0, so small follow-ups get done rather
than filed. What changed is then measured with `git status`, never taken from the agent's word, and
the agent is told what it actually touched. `COMMIT` is not printed until `--passed yes`; a failure
gets exactly one repair attempt and then ends at `not-committed`. **Nothing is ever reverted** — if
the build does not pass, nothing was committed, so there is nothing to undo, and the edits stay in
the tree as the evidence of what was tried. `committed` re-reads HEAD and refuses to close the batch
if it has not moved.

**Review.** `found --new N` asks only for what is new that pass. The driver counts consecutive empty
passes and **never tells the agent the count**, so it cannot aim for the exit; two in a row (or eight
passes) move it to the double-check, and only then may it name clean files. Those names are
intersected with the files the chunk wholly contains — a file with hunks in another chunk is refused
and never reaches a `review-and-fix-pr-reviewed.js --mark` command, because no single reviewer can speak for it.

**When the agent gets out of step.** A refused command is not a one-line error: the driver names
which machine the verb belongs to, says where the batch actually is in the agent's own terms, prints
the one command to run and the whole sequence around it. Running the right verb with the wrong flags
counts as a miss too, not as progress.

**Circuit breakers**, so a confused agent cannot spin on requests forever: four misses on one step,
eight in a batch, forty accepted steps, or three hours alive, and the driver gives up with
`FINAL STATE: driver-error`. A batch whose state file has gone is told to check its batch name first
and then to stop — never to run `start` again, which would redo work already on disk. An aborted
batch stays aborted. The run treats a fixer's `driver-error` like a failed build: nothing committed,
edits left in the tree, stage stopped, and the report says so. A *reviewer's* abort is different —
its findings are kept and still fixed, but the chunk is listed under **NOT REVIEWED**, is not counted
clean, and any file it tried to record clean is ignored, because it never finished looking.

There is no validate agent, no commit agent and no rollback agent. If the fixer dies mid-batch
nothing guesses: the run stops, says the tree may hold uncommitted edits, and prints the undo line
for you to decide.

## State it keeps, outside the repo

```
SHIPS WITH THE PLUGIN - read-only, never written to at runtime:

${CLAUDE_PLUGIN_ROOT}/
  workflows/review-and-fix-pr.js            the orchestrator; Workflow runs it by scriptPath
  bin/review-and-fix-pr-chunker.js          diff -> hunks -> lock-key groups -> capped chunks
                                        (--lock-key --isolation X --path P prints one lock key)
  bin/review-and-fix-pr-driver.js           two state machines: fix, and review
  bin/review-and-fix-pr-reviewed.js         agents mark files reviewed-clean, keyed on content
  bin/review-and-fix-pr-repofp.js           deterministic repo-shape fingerprint
  bin/review-and-fix-pr-meter.js            token accounting, dedupes by requestId (manual tool -
                                        no agent runs it, and a run does not need it present)

ACCUMULATES PER USER - state, not code, so it lives beside the plugin's other caches:

~/.claude/review-and-fix-pr/
  state/<batch>.state.json              one live driver conversation; pruned after 7 days
  <owner>__<repo>/classify.json         the generated declarative reviewability rule
  <owner>__<repo>/meta.json             repo fingerprint; a change regenerates the rule
  <owner>__<repo>/reviewed.json         the reviewed-files ledger, kept across runs
  <owner>__<repo>/runs/<sha>/           frozen chunk .diff files for one run
```

The split matters: the plugin directory is a git checkout that `git status` should keep clean, so
nothing derived from a repository under review is ever written into it.

Nothing is written inside the repository, because the workflow refuses to run on a dirty tree.

## Afterwards

Relay the workflow's returned summary — the user does not see it otherwise. Lead with the four
things that need a human, and keep them separate, because they are different kinds of debt:

1. **RELEASE BLOCKERS**, if present — lead with these. Every entry carries a one-sentence reason
   naming the concrete consequence of shipping. They are drawn from all three lists below.
2. **Still present after fixes** — found, a fix was attempted, the last review still sees it.
3. **Deferred** — real, but the fix was judged disproportionate.
4. **Open follow-ups** — big ones only; small ones were already carried out and are listed separately.
5. Whether validation ran at all, and whether any batch failed it and so committed nothing —
   its edits are still sitting in the working tree.
6. **NOT REVIEWED**, if present — the run hit a ceiling and this PR is not fully reviewed.

If the report says the run stopped with **uncommitted edits in the working tree**, deal with that
before anything else. Those edits are the unfinished batch's work, kept on purpose. Do not offer
`git reset --hard` — it destroys them.

Do not hand the user a list of commands to type. Show them what is there and **propose committing it
for them**, in one message:

1. Run `git status` and `git diff` yourself and summarise what the batch actually changed — a couple
   of lines per file, what it was trying to fix, and whether it looks finished.
2. Say plainly whether it is worth keeping. If part of it is half-done or wrong, say which file and
   propose dropping just that one with `git checkout -- <path>`.
3. Then offer: *"I can commit the rest as `<message>` — want me to?"* Draft the message from the
   findings the batch was fixing, not from the diff. On a yes, `git add --` exactly those paths
   (never `-A`, `.` or `-u`: a failed build leaves artifacts) and commit.

Wait for the yes before committing — it is their branch and their history — but make saying yes the
only thing left for them to do.

Otherwise offer, without doing any of it unasked: working through the follow-ups, pushing the branch,
posting the still-present and deferred lists as a PR comment (`gh pr comment`), squashing the
per-batch commits, or undoing everything with the `git reset --hard <startSha>` line the report
prints. The workflow itself never pushes, never comments and never reverts.

If the report says files were skipped as already-reviewed and the user doubts that, re-run with
`ignoreLedger: true` rather than deleting `reviewed.json`.
