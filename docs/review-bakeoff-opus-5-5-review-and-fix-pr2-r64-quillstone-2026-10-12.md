# Review-tool bake-off: 1 review configuration, 1 real PR

**Cohort:** `opus-5-5-review-and-fix-pr2-r64-quillstone-2026-10-12`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.296 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr2` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=opus-5-5-review-and-fix-pr2-r64-quillstone-2026-10-12`.
This complete cohort contains 1 hash-pinned review cells.
Every run used its own headless `claude -p` process and
working directory so its token spend is attributable.

## What was reviewed

| Target | Language | Diff | Commits | PR under review | Upstream original |
|---|---|---:|---:|---|---|
| `quillstone` | Rust | 26,179 B | 4 commits | https://github.com/dkropachev/quillstone/pull/1 | https://github.com/scylladb/scylla-rust-driver/pull/1801 |

Each PR was replayed in its own fork with its commits under a neutral author. The preparer rewrote
repository references in review material and denied `WebSearch`/`WebFetch`. The benchmark freezes
the review inputs because access to upstream comments would bias discovery.

## Cohort accounting

- Reviews: 1 calls, 1,639,684 tokens, $2.44, 3.3 minutes wall time.
- Extraction: 1 calls, 21 raw claims, $0.30.
- Judging: 1 calls, 20 merged issues (20 real, 0 false-positive, 0 unproven), $1.53.
- Total known cohort spend: $4.28. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr2 |
|---|---|---|---|---|---|---|
| | **quillstone (Rust)** | | | | |  |
| 1 | Persistent USE-keyspace failure breaks the pool instead of base's warn+keep `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | high | ✓ |
| 2 | USE-keyspace failure during connection setup now logs at debug! instead of warn! `scylla/src/network/connection_pool.rs:903` | real | in-scope | yes | medium | ✓ |
| 3 | New UseKeyspaceError-to-ConnectionError mapping violates ConnectionError's own contract `scylla/src/errors.rs:600` | real | in-scope | yes | medium | ✓ |
| 4 | keyspace_setup_failure_triggers_refill never drives a refill and feeds an impossible event `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low | ✓ |
| 5 | keyspace_setup_failure_preserves_pool_state has unbounded waits and skips… `scylla/src/network/connection_pool.rs:1526` | real | in-scope | yes | low | ✓ |
| 6 | New metric tests never exercise the excess-connections decrement term or real open/close… `scylla/src/network/connection_pool.rs:1114` | real | in-scope | yes | low | ✓ |
| 7 | total_connections gauge leaks on shard-aware excess rejection and on pool teardown `scylla/src/network/connection_pool.rs:994` | real | out-of-scope | no | low | ✓ |
| 8 | decrement_total_connections loops per-connection instead of atomic batch subtract,… `scylla/src/network/connection_pool.rs:1360` | real | in-scope | yes | nit | ✓ |
| 9 | New metrics test busy-polls on a 1ms sleep instead of an event-driven wait `scylla/src/network/connection_pool.rs:2003` | real | in-scope | yes | nit | ✓ |
| 10 | Metric decrement is split asymmetrically between the Connection and Keyspace error… `scylla/src/network/connection_pool.rs:895` | real | in-scope | yes | nit | ✓ |
| 11 | ConnectionSetupError has no Debug derive and its name is easily confused with… `scylla/src/network/connection_pool.rs:1418` | real | in-scope | yes | nit | ✓ |
| 12 | unrequested_connection_event is an undocumented near-duplicate of the existing… `scylla/src/network/connection_pool.rs:1855` | real | in-scope | yes | nit | ✓ |
| 13 | New keyspace tests hand-roll scaffolding instead of reusing existing test helpers `scylla/src/network/connection_pool.rs:1485` | real | in-scope | yes | nit | ✓ |
| 14 | All four commits lack bodies explaining what and why, hiding several bundled changes `CONTRIBUTING.md:10` | real | in-scope | yes | low | ✓ |
| 15 | Metrics fix and its tests are split across commits, with an unsquashed fixup commit `CONTRIBUTING.md:9` | real | in-scope | yes | low | ✓ |
| 16 | PR body omits the metrics fix/tests, cites an unresolvable issue, and its validation…  | real | in-scope | yes | low | ✓ |
| 17 | New keyspace-failure tests skip the required setup_tracing() call `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low | ✓ |
| 18 | New ConnectionError::UseKeyspaceError message breaks the established… `scylla/src/errors.rs:601` | real | in-scope | yes | low | ✓ |
| 19 | Keyspace check now blocks resharding/shard-aware-port updates until USE completes,… `scylla/src/network/connection_pool.rs:913` | real | in-scope | yes | medium | ✓ |
| 20 | PR description doesn't call out the log-level downgrade or the new public error variant…  | real | in-scope | yes | medium | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 83.3% of it is cache reads, which bill at a tenth of
input; cache creation, another 14.2%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 2.5% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(15,147 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr2 | 1 | 20 | 20 | 0 | 0 | 19 | 1 | 1,639,684 | $2.44 | 3.3 min | - |

### Spend per run

| Tool | quillstone |
|---|---:|
| Automated Development review-and-fix-pr2 | 1,639,684 tok / $2.44 / 3.3 min |

**The 1 scored reviews' recorded attempts cost 1,639,684 tokens, $2.44.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

What each run said before verification. Self-rejected claims are excluded, and the judge may merge several claims about one mechanism. The gap from *Raised* is not a miss count.

| Tool | quillstone |
|---|---:|
| Automated Development review-and-fix-pr2 | 21 |

## What the maintainers actually said

The upstream reviews, fetched at prepare time and never shown to any reviewer or to the judge.
Bot comments are dropped, and so are the PR author's own replies, which are answers rather than
findings.

Read these as context, not as a scoreboard. The PRs were reviewed at their pinned revisions,
after some upstream comments may already have been addressed. Not repeating a comment is not
automatically a miss; the useful question is whether a concern still applies to the pinned code.

**`quillstone`** - https://github.com/scylladb/scylla-rust-driver/pull/1801 - 7 inline review comments, 1 thread comments.

| Who | Where | What they said |
|---|---|---|
| wprzytula | `scylla/src/network/connection_pool.rs:1692` | Oh, this was a pre-existing bug, right? @Guflly |
| wprzytula | `scylla/src/network/connection_pool.rs:1692` | cc @Lorak-mmk |
| wprzytula | `scylla/src/network/connection_pool.rs:2004` | 🔧 Using `tokio::timeout::sleep(Duration::from_millis(1))` could decrease CPU burn. |
| wprzytula | `scylla/src/network/connection_pool.rs:2004` | Especially that otherwise we keep burning the CPU for 5 seconds. |
| Lorak-mmk | `scylla/src/network/connection_pool.rs:930` | Commit: connection: discard connections after keyspace setup failure This is the only thing that is not clear to me. Why is this block moved? The thing we do between the two locactions: - Blocking shard awareness if n... |
| Lorak-mmk | `scylla/src/network/connection_pool.rs:930` | If there is some reason for the block to be moved, can you put it in the comment, so noone accidentaly moves it back? |
| Lorak-mmk | `scylla/src/network/connection_pool.rs:930` | After analysis, I don't think the ordering matters. Either is fine. |
| wprzytula | thread | The direction is IMO good. Excess-connection logic is unfortunately rarely tested, so it will be great if you improve the coverage of it. |

### Runs that did not complete

None - every run in the matrix returned a report.

## Analysis

No hand-written analysis is attached to this cohort. `bench/analysis.md` describes only the immutable `legacy` results.
