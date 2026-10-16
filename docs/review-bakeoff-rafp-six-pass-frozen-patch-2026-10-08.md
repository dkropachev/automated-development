# Review-tool bake-off: 1 review configuration, 1 real PR

**Cohort:** `rafp-six-pass-frozen-patch-2026-10-08`. **Skill platform:** Claude. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.292 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=rafp-six-pass-frozen-patch-2026-10-08`.
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

- Reviews: 1 calls, 3,085,611 tokens, $5.32, 11.9 minutes wall time.
- Extraction: 0 calls, 38 raw claims (13 confirmed, 25 suggestions), $0.00.
- Judging: 1 calls, 10 merged issues from 13 confirmed claims (10 real, 0 false-positive, 0 unproven), $1.20.
- Total known cohort spend: $6.52. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr |
|---|---|---|---|---|---|---|
| | **quillstone (Rust)** | | | | |  |
| 1 | Excess shard-aware connection is dropped without decrementing total_connections `scylla/src/network/connection_pool.rs:1006` | real | out-of-scope | no | medium | ✓ |
| 2 | Pool worker shutdown drops conns/excess_connections without decrementing total_connections `scylla/src/network/connection_pool.rs:696` | real | out-of-scope | no | medium | ✓ |
| 3 | keyspace_setup_failure_triggers_refill never exercises the actual refill-scheduling loop `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low | ✓ |
| 4 | New keyspace-failure tests skip the required setup_tracing() call `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | nit | ✓ |
| 5 | keyspace_setup_failure_preserves_pool_state can hang forever with no timeout `scylla/src/network/connection_pool.rs:1634` | real | in-scope | yes | low | ✓ |
| 6 | Commit messages are subject-only, contradicting the PR's own checklist claim `CONTRIBUTING.md:10` | real | in-scope | yes | nit | ✓ |
| 7 | Per-connection USE has no timeout, so a hang suppresses the promised keyspace-failure… `scylla/src/network/connection_pool.rs:1342` | real | in-scope | no | medium | ✓ |
| 8 | PR's own validation command never ran the new feature-gated metrics tests `scylla/src/network/connection_pool.rs:1868` | real | in-scope | yes | low | ✓ |
| 9 | PR description omits the metrics-balancing commit entirely `scylla/src/network/connection_pool.rs:1028` | real | in-scope | yes | nit | ✓ |
| 10 | Keyspace regression test's QUERY rule never checks the request was actually USE `scylla/src/network/connection_pool.rs:1543` | real | in-scope | yes | nit | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 84.7% of it is cache reads, which bill at a tenth of
input; cache creation, another 12.6%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 2.7% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(26,858 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr · Claude | 1 | 10 | 10 | 0 | 0 | 8 | 3 | 3,085,611 | $5.32 | 11.9 min | - |

### Spend per run

| Tool | quillstone |
|---|---:|
| Automated Development review-and-fix-pr · Claude | 3,085,611 tok / $5.32 / 11.9 min |

**The 1 scored reviews' recorded attempts cost 3,085,611 tokens, $5.32.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

Extracted claims include 25 suggestions. They remain visible for reviewer judgment but do not enter cohort judging. The 13 confirmed claims were merged and verified into 10 issues.

| Tool | quillstone |
|---|---:|
| Automated Development review-and-fix-pr · Claude | 38 (13 confirmed, 25 suggestions) |

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
