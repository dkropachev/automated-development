# review-and-fix-pr — reference

Internals and the full argument list. The skill reads this only when a run needs something the four
arguments in `SKILL.md` do not cover — a `detailedReview` pass, a re-review that ignores the ledger, a
token ceiling — or when a run behaved in a way that has to be explained.

## Every argument the workflow takes

| arg | default | meaning |
|---|---|---|
| `pr` | current branch's PR | PR number or URL |
| `fix` | `false` | `true` to edit and commit, `false` for a read-only pass. The skill always asks and passes this explicitly. |
| `mode` | `'auto'` | `parallel` \| `single` \| `full` \| `auto` (parallel above 20KB of diff, single at or below it; full forces one whole-PR pass) |
| `reviewConcurrency` | 5 | read-only reviewers in flight at once |
| `maxFixBatch` | 10 | findings per fixer; a fresh agent takes the next batch after this one commits |
| `maxOutstanding` | 10 | unfixed findings that pause the review. The in-flight wave is drained first - reviewers are read-only, so they must finish before a fixer edits the tree they are reading - then the stage resumes on its remaining chunks, ahead of every later stage. `0` restores the old behaviour: review the whole stage, then fix it. Ignored on a review-only run. |
| `chunkBytes` | `{code:20000, test:20000, cicd:20000, other:20000}` | per-stage cap on packed hunk bytes. A single hunk larger than the cap is **never split** — git emits a newly added file as one hunk, so a new 2,800-line file is one chunk by design. |
| `isolation` | `'./../'` | which files may share a chunk: `.` the file, `./../`×n n levels up, `*/`×n n levels down from the root. It no longer constrains scheduling — reviewers are read-only and fixers are serial, so nothing can collide. |
| `stages` | `['code','test','cicd','other']` | order and membership |
| `detailedReview` | false | let reviewers leave the hunk: trace every caller, and **run experiments** in a throwaway clone (`git clone --no-hardlinks --no-local`) rather than reasoning about the code. Costs ~2× and finds caller-side defects a reading-only pass looks straight past. The repo under review stays read-only; nothing may be pushed. |
| `ignoreLedger` | false | re-review files already recorded clean |
| `refreshRules` | false | regenerate the per-repo `classify.json` |
| `maxAgents` | 900 | hard stop on agents spawned (platform ceiling is 1000). Checked before every wave. A stage is planned as one reviewer per chunk plus one fixer per `maxFixBatch` findings; a review-only run reserves no fixers. |
| `findingsPerChunk` | 1 | findings a chunk is assumed to yield, for the agent estimate only. 1 is a floor, not a worst case - raise it on a PR you expect to be findings-heavy so the stage plans for the fixers it will actually need. |
| `maxTokens` | none | stop once this many tokens have been spent *by this run*. Measured as a delta of `budget.spent()`, because `budget.total`/`remaining()` are null unless a ceiling was configured. |
| `repoRoot` | (session cwd) | absolute path to the repository |

## Why the findings can be trusted

**The scope agent quotes, it does not infer.** `outOfScope` holds only sentences the author actually
wrote deferring something, verbatim; an empty list is the normal case. It used to be told to derive
"non-goals" and that an empty list was wrong — and one derived line ("caller behaviour is out of
scope") made a reviewer drop a reproduced process crash in the author's name.

**Nothing ends on a write.** A reviewer double-checks every candidate against the real code before
reporting it; a fixer re-reads everything it changed and reports what its re-read still sees.

**The ledger is keyed on content.** A reviewer that finds a file clean records it with
`review-and-fix-pr-reviewed.js` itself, keyed on the sha of that file's diff against the merge base,
so it is never reviewed again until its content changes. Only files it found nothing in are recorded,
so the content recorded is content nobody is about to change; if a later fix touches such a file
anyway, its sha changes and the next run reviews it again.

## Fitting a stage into the agents that are left

Before each stage the run estimates the agents it will need against the agents left. If it will not
fit, it widens `chunkBytes` and re-chunks so the same hunks pack into fewer, larger chunks. If even
that does not fit (a stage of single oversize hunks, which are never split), it reviews **the largest
chunks that fit** and lists the rest under **NOT REVIEWED** — nothing silently disappears, and nothing
skipped is written to the ledger, so a re-run picks it up.

Every re-chunk — the budget widening above, and the one a paused stage does when fixes have landed —
passes the `.hashes` sidecars of the chunks already reviewed to the chunker as `--exclude-hashes`, so
what comes back is the hunks nobody has reached rather than the whole stage. The filter is on hunks,
not on file names, because a file too big for one chunk is split across several: filtering by name
would either hand back chunks the run already paid for or drop hunks it never saw. An excluded hunk
also keeps its file out of `wholeFiles`, so a later round cannot record a file clean on the strength
of the half it happened to see.

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
