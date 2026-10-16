# Plan: make the Opus 5.5 `review-and-fix-pr` benchmark viable

## Current status

Work is on local branch `bench/opus-5-5-review-and-fix-pr`, created from `origin/main`.
No benchmark result, finding, judgement, seal, completion marker, publication, push, or pull request
has been created for `review-and-fix-pr`.

Paid work is paused. The original pilot envelope is exhausted: five audit-only processes spent
`$24.0129718` in total. Starting another paid pilot requires explicit authorization for a new
budget; it must not be presented as a continuation of the original `$20` envelope.

The implementation worktree is intentionally uncommitted while the harness is still being fixed.
The functional test suite passes except for the generated report/dashboard freshness tests. Those
files must remain stale until the final completed cohort is published with `make bench-publish`.

Checkpoint transport implementation and local harness validation completed on 2026-10-02. Agent
results now use one provenance-checked Workflow-journal import; derived state and fix receipts are
compact/reconstructible; new control records never use multipart model relays. The only remaining
checkpoint-transport acceptance item is live three-lens wall-time evidence, which belongs to the
new explicitly funded pilot below. No paid work was run while completing this implementation.

## Goal

Measure the checkout's v0.5.0 `review-and-fix-pr` skill on Opus 5.5 across Ironweave,
Quillstone, and Tidepool without admitting partial workflow output, silently changing plugin code,
exceeding approved budgets, or mixing experimental cohort-local evidence with canonical gold.

Before the three final cells can run, one capped Ironweave pilot must terminate normally and prove
that token stopping, workflow persistence, process timeout, and cumulative cost accounting all work.

## Problem description

### 1. Checkpoint transport uses model agents as an expensive byte pipe

Claude Workflow JavaScript has no direct filesystem or subprocess API. To persist state, the
workflow asks a tool-running helper agent to execute an exact command such as:

```text
node review-and-fix-pr-state.js put ... --base64 <checkpoint>
```

Claude's `bashCommandClamp` structure verifier rejected a roughly 17 KB command even though it was
well below the operating system's `ARG_MAX`. The current workaround divides large JSON checkpoints
into 8 KB base64 pieces. Every piece is sent through a separate `agentSafe(...)` call, and another
helper agent composes the pieces.

This is mechanically correct but operationally unacceptable. A helper agent pays for a full model
context merely to copy 8 KB. In the last pilot, the three first-wave lens results were approximately
17–21 KB each and required eleven part agents plus three compose/journal sequences. Persisting that
wave consumed roughly twelve minutes of a thirty-minute pilot.

The per-part agents do no review or reasoning. They exist only because the Workflow runtime cannot
write bytes directly and the exact-command verifier rejected the larger payload.

### 2. The original token stop measured the wrong quantity

Workflow `budget.spent()` counts output tokens only. The committed benchmark accounting counts fresh
input, output, cache-read, and cache-creation tokens. The pilot therefore remained below its
one-million-token Workflow counter while its transcript reached 6,306,499 tokens and it launched a
second lens wave.

This has been changed locally: a trusted transcript meter now deduplicates requests and measures all
four token classes at every paid-agent boundary. It also reserves the meter agent's not-yet-written
final context. A missing or malformed measurement fails closed as a token stop.

### 3. The original dollar cap reset on every process

`--max-budget-usd 20` limits one Claude process. It does not remember prior attempts. Fresh setup
attempts therefore each received another `$20` ceiling, producing `$24.0129718` of cumulative spend.

This has been changed locally: `bench/pilot.js` maintains a crash-safe cumulative ledger under the
ignored `bench/work/pilots/<id>/` directory. It reserves all remaining money before spawning,
passes only that remainder to Claude, and charges the larger of reported and transcript-derived
cost. Unknown cost or an unresolved crash reservation exhausts the remaining budget.

### 4. Pilot qualification exposed additional setup/runtime incompatibilities

The local changes also address these pre-review failures:

- blinded PRs can retain issue references whose issues were not republished;
- transient REST exhaustion can make `gh api user` fail while authenticated GraphQL still works;
- print mode killed background Workflows after 600 seconds;
- large state checkpoints needed an integrity-preserving transport;
- plugin-backed metadata needed structural rather than object-identity comparison;
- partial workflow output needed a strict machine-readable publication contract.

These fixes need to remain covered while checkpoint transport is redesigned.

## Required next steps

### 1. Replace per-8-KB checkpoint agents — implementation complete

Do not merely increase the chunk size. Remove model-mediated byte copying from the normal large
checkpoint path.

Implement a short-command journal-import path in `review-and-fix-pr-state.js`:

1. [x] For agent-backed artifacts (lens, gap, coverage-audit, and verification results), pass only the
   unique workflow label/key, target artifact name, repository identity, and expected binding.
2. [x] Have the trusted state helper locate the current Workflow journal for the unique checkout,
   require exactly one completed matching result, validate its schema/identity, and copy the JSON
   directly into the hash-bound state store.
3. [x] For derived artifacts, stop duplicating full lens prose. Reconstruct raw candidates and receipts
   from the immutable lens artifacts on resume; persist only compact dispositions, indexes, hashes,
   and state that cannot be derived.
4. [x] Keep the existing small-payload relay only for genuinely small control records.
5. [x] Delete the multipart `checkpoint-parts/...` and `compose` normal path once every large checkpoint
   has a direct or reconstructible representation. If an unexpected derived payload is still too
   large, fail closed with a clear error; never fan it out into one model agent per chunk.

Acceptance tests:

- [x] a synthetic 100 KB lens result persists with at most one state-operation helper call;
- [x] the helper rejects an ambiguous label, missing result, wrong workflow, wrong repository, changed
  head, malformed result, symlink, or post-write hash mismatch;
- [x] crash/retry is idempotent and append-only;
- [x] resume reconstructs the same candidates, receipts, dispositions, completed lenses, and coverage;
- [x] no `checkpoint-parts` artifacts or per-part agent labels are produced;
- [ ] a three-lens wave checkpoints comfortably inside the pilot wall-time budget — requires the newly
  approved paid pilot; synthetic/local tests cannot establish live model wall time.

### 2. Finish validation of transcript-token stopping — fixture/static validation complete

The local implementation is in:

- `bin/review-and-fix-pr-meter.js`;
- `workflows/review-and-fix-pr.js`;
- `test/review-meter.test.js`.

Verify with fixtures and a fresh review that:

- token totals equal deduplicated `input + output + cache-read + cache-creation` usage;
- the in-flight meter response reserve cannot authorize another wave near the boundary;
- the meter runs before review waves, gap waves, re-audit, verification, challenges, fix batches,
  and terminal sealing;
- one in-flight wave may overshoot, but no subsequent paid review/verifier/fixer wave starts;
- meter failure produces `coverage: partial-stop`, `stopTrigger: tokens`, and an unpublishable result.

All fixture, boundary-ordering, failure, and result-contract checks pass. The fresh live review remains
part of the newly funded pilot; no paid run was made during implementation.

### 3. Finish validation of cumulative pilot budgeting — local validation complete

The local implementation is in:

- `bench/pilot.js`;
- `test/pilot-budget.test.js`;
- the `bench-pilot` Make target.

Verify that:

- the first attempt receives the total ceiling and each later attempt receives only the remainder;
- prompt bytes, plugin fingerprint, clean target HEAD/tree/base pins, model, effort, timeout, and total
  budget are immutable for one pilot ID, while an identical fresh checkout path is allowed;
- concurrent launch, dirty checkout, truncated/tampered ledger, unknown cost, or crash reservation
  fails closed;
- timeout and nonzero exits are still charged;
- money is represented conservatively as integer nano-USD;
- pilot files never appear under `bench/runs`, canonical results, findings, judgement, or gold.

The already-spent pilot must not be imported into a fresh `$20` ledger or silently reset. A new
pilot budget requires user approval and a new pilot ID.

The focused pilot-budget/runner tests pass, including concurrent launch, crash reservation, unknown
cost, immutable identity, dirty checkout, timeout/nonzero charging, and canonical-path exclusion.

### 4. Review and verify the whole harness diff — complete locally

After checkpoint transport is fixed:

1. [x] Run the focused meter, state, pilot-budget, runner-control, post-processing, result-contract, and
   dashboard metadata tests.
2. [x] Run `npm run lint`, `npm run check`, `node scripts/syntax-check.js`,
   `claude plugin validate .`, and `git diff --check`.
3. [x] Run the complete unit suite. Before publication, the only permitted failures are the generated
   report/dashboard freshness assertions.
4. [x] Obtain fresh independent reviews of:
   - token/budget fail-closed behavior;
   - state persistence, crash recovery, and resume equivalence;
   - plugin fingerprint and scoped-manifest integrity;
   - experimental/cohort-local versus canonical-gold separation.
5. [x] Resolve every correctness finding before spending again.

### 5. Run a new pilot only after explicit budget approval

Create a new disposable Ironweave checkout and a new pilot ID. Use `make bench-pilot`, not a raw
`claude` command. Required controls:

- `claude-opus-5-5`, medium effort;
- workflow `fix: false`, explicit model, and `stopAt.tokens: 1_000_000`;
- one process, zero automatic retries;
- thirty-minute process timeout;
- newly approved cumulative dollar ceiling;
- installed v0.4.1 plugin disabled and this checkout loaded explicitly;
- GraphQL/REST-authenticated GitHub user and pinned Ironweave base/head;
- no result/extraction/judgement/publication path.

Pilot acceptance criteria:

- the process exits normally before thirty minutes;
- cumulative ledger spend stays within its approved ceiling;
- result ends with exactly one valid `REVIEW_AND_FIX_PR_RESULT_JSON=` marker;
- contract reports `coverage: partial-stop`, `stopTrigger: tokens`, `fix: not-requested`, and
  `fixRequested: false`;
- completed, failed, and skipped lenses are explicit;
- no wave starts after the measured token limit;
- token total and overshoot reconcile with the transcript meter;
- checkout remains clean and no canonical benchmark artifact exists.

Report cost, token classes, overshoot, wall time, completed lenses, coverage status, raw/unverified
findings, and every discarded attempt. Pause again for explicit approval.

### 6. Run final cells only after pilot approval

If approved, create cohort `opus-5-5-review-and-fix-pr-2026-10-01`, scoped to only
`review-and-fix-pr` across the three targets. Run sequentially:

1. Ironweave;
2. Quillstone;
3. Tidepool.

Each cell uses concurrency 1, zero retries, a two-hour timeout, a `$50` hard process ceiling, no
workflow `stopAt`, and the pinned local plugin. Pause and report usage after every cell. A timeout,
partial contract, budget stop, incomplete coverage, requested fix, or other stop trigger records no
result and ends the sequence.

### 7. Extract, judge, publish, and open the draft PR

Only after all three review results validate:

1. Extract and judge one target at a time with pinned Sonnet and `$5` per-call ceilings.
2. Require the three-cell seal and `complete.json` hashes to validate.
3. Run `make bench-publish` and `make bench-publish-check`.
4. Run browser route checks, `make ci`, `make validate`, and `git diff --check`.
5. Verify the experimental/self-authored badge at:
   - `/#skills/review-and-fix-pr?model=claude-opus-5-5`;
   - `/#runs?model=claude-opus-5-5&skills=review-and-fix-pr`;
   - `/#choose?tab=models`.
6. Verify the completed cohort appears automatically on `#choose?tab=models` without an allow-list.
7. Leave `bench/gold/` unchanged and make no canonical-inclusion claim.
8. Serve `docs/` on `127.0.0.1:8000`, commit, push only the feature branch, and open—but never
   merge—the draft PR.

## Stop conditions

Stop without further paid work if any of the following occurs:

- cumulative pilot budget is exhausted or uncertain;
- GitHub or Claude authentication cannot be proven;
- plugin fingerprint, target pins, prompt hash, or pilot ledger changes;
- token meter is missing, malformed, ambiguous, or stale;
- checkpoint import cannot prove the exact workflow result and repository identity;
- checkout becomes dirty;
- a partial or stopped response reaches a canonical artifact path;
- publication validation or the canonical/cohort-local boundary fails.
