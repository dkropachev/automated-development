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
  before a brand-new fixer starts the next 10. Review does not run to the end of the stage first:
  once **10 unfixed findings** have piled up (`maxOutstanding`) no new review wave starts, the wave in
  flight is drained, those findings are fixed and committed, and the stage resumes on the chunks it
  had not reached. A run that dies mid-way therefore holds commits rather than a list of findings, and
  a later reviewer does not re-raise what an earlier one already had fixed.
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
  not a bug*: re-read and found correct, recorded so no later run re-raises it. *Set aside — out of
  scope, not investigated*: a real-looking defect this PR did not cause, which a default run does not
  spend time on and a `detailedReview: true` run **will** pick up. *Out of scope — real*: in a detailed
  run, investigated and reported in its own section — never fixed, because a bug the PR did not cause
  is not its to change. Scope is a label decided after a candidate is known to be real, never a filter
  applied before looking; if the PR's change makes a defect reachable or worse it is *in* scope even on
  an untouched line, and undecidable means *in*.
- **Reviewed files are remembered across runs**, keyed on their content, so a re-run skips what was
  already found clean and reviews again anything a later fix touched.
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
escalate to one whole-PR pass rather than believing it. Pass `repoRoot` when the session's working
directory is not the repository itself.

Those four are all a normal run needs. The other fifteen arguments — `detailedReview`,
`ignoreLedger`, `maxTokens`, `chunkBytes`, `maxAgents` and the rest — are in `reference.md`, next to
this file, along with how the driver walks an agent through a batch, how a stage is re-chunked to fit
the agents left, and where the run's state lives on disk. Read it when a request needs one of them or
when a run has to be explained; a default run does not.

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
