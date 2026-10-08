# Review-tool bake-off: 1 review configuration, 3 real PRs

**Cohort:** `rafp-baseline-2026-10-04`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.287 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=rafp-baseline-2026-10-04`.
This complete cohort contains 3 hash-pinned review cells.
Every run used its own headless `claude -p` process and
working directory so its token spend is attributable.

## What was reviewed

| Target | Language | Diff | Commits | PR under review | Upstream original |
|---|---|---:|---:|---|---|
| `ironweave` | C++ | 15,931 B | 3 commits | https://github.com/dkropachev/ironweave/pull/1 | https://github.com/scylladb/seastar/pull/3664 |
| `quillstone` | Rust | 26,179 B | 4 commits | https://github.com/dkropachev/quillstone/pull/1 | https://github.com/scylladb/scylla-rust-driver/pull/1801 |
| `tidepool` | Go | 18,335 B | 2 commits | https://github.com/dkropachev/tidepool/pull/1 | https://github.com/scylladb/gocql/pull/1094 |

Each PR was replayed in its own fork with its commits under a neutral author. The preparer rewrote
repository references in review material and denied `WebSearch`/`WebFetch`. The benchmark freezes
the review inputs because access to upstream comments would bias discovery.

## Cohort accounting

- Reviews: 3 calls, 33,281,648 tokens, $27.89, 42.8 minutes wall time.
- Extraction: 3 calls, 30 raw claims, $0.57.
- Judging: 3 calls, 29 merged issues (24 real, 4 false-positive, 1 unproven), $4.18.
- Total known cohort spend: $32.64. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr |
|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |
| 1 | New queue-drain wait in stream_close() is never exercised by any test `src/rpc/rpc.cc:562` | real | in-scope | yes | medium | ✓ |
| 2 | Doc says connection shuts down "only once both halves are closed", which is false `doc/rpc-streaming.md:115` | real | in-scope | yes | low | ✓ |
| 3 | Doc says reading-until-throws closes the source, false for deserialization errors `doc/rpc-streaming.md:111` | real | in-scope | yes | low | ✓ |
| 4 | Regression test swallows closed_error instead of asserting it was thrown `tests/unit/rpc_test.cc:2016` | real | in-scope | yes | low | ✓ |
| 5 | Test doesn't assert error() was still false when the hook fired `tests/unit/rpc_test.cc:2017` | unproven | in-scope | yes | low | ✓ |
| 6 | Pre-sink.close() assertion failure would abort the test binary, not fail cleanly `tests/unit/rpc_test.cc:2000` | real | in-scope | yes | low | ✓ |
| 7 | const_cast on this inside const negotiate() to mutate factory state `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | nit | ✓ |
| 8 | Comment claims queue_drained can be exceptional, but no code path makes it so `src/rpc/rpc.cc:566` | real | in-scope | yes | nit | ✓ |
| 9 | Commits lack DCO Signed-off-by trailer claimed to be required `doc/contributing.md:6` | false-positive | out-of-scope | no | nit | ✓ |
| | **quillstone (Rust)** | | | | |  |
| 10 | Keyspace USE failures are never classed transient vs permanent, pool can stay Broken… `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | high | ✓ |
| 11 | Keyspace-error branch skips the staleness check the success branch performs on… `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | low | ✓ |
| 12 | USE-keyspace failure log downgraded from warn! to debug!, hiding it at default log level `scylla/src/network/connection_pool.rs:903` | real | in-scope | yes | low | ✓ |
| 13 | Commit 0d91aa54 fails a no-default-features -D warnings build (unused FutureExt import) `scylla/src/network/connection_pool.rs:1462` | real | in-scope | yes | low | ✓ |
| 14 | Excess shard-aware connection retried via non-shard-aware port leaks a total_connections… `scylla/src/network/connection_pool.rs:994` | real | out-of-scope | no | low | ✓ |
| 15 | PR description omits the metrics-balancing half of the patch `scylla/src/network/connection_pool.rs` | real | in-scope | yes | low | ✓ |
| 16 | Resharding's excess-connections term in decrement_total_connections is untested `scylla/src/network/connection_pool.rs:1868` | real | in-scope | yes | low | ✓ |
| 17 | New keyspace-failure tests don't call setup_tracing() `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | nit | ✓ |
| 18 | Moved comment still claims the connection will 'finally be put into the conns' `scylla/src/network/connection_pool.rs:921` | real | in-scope | yes | nit | ✓ |
| 19 | Public #[from] UseKeyspaceError conversion on ConnectionError called unneeded API surface `scylla/src/errors.rs:601` | false-positive | in-scope | yes | low | ✓ |
| 20 | PR's stated validation omits clippy and the metrics feature even though CI runs both  | real | in-scope | yes | nit | ✓ |
| 21 | All four commit messages have no body explaining the change  | real | in-scope | yes | nit | ✓ |
| 22 | Commit 617139df is a one-line fixup of a test added two commits earlier  | real | in-scope | yes | nit | ✓ |
| 23 | New tests claimed to duplicate mock_pool_refiller and start_simulated_node `scylla/src/network/connection_pool.rs:1754` | false-positive | out-of-scope | no | low | ✓ |
| | **tidepool (Go)** | | | | |  |
| 24 | Float fast-path exact-length checks no longer exercised by any too-long-payload test `marshal.go:1012` | real | in-scope | yes | low | ✓ |
| 25 | Empty non-NULL payload with dimensions > 0 now errors, change is untested `marshal.go:998` | real | in-scope | yes | low | ✓ |
| 26 | vectorElemMinSize recomputes isVectorVariableLengthType at every recursion level,… `marshal.go:1125` | real | in-scope | yes | low | ✓ |
| 27 | New top-of-function comment wrongly claims every path allocates, but the array path does… `marshal.go:986` | real | in-scope | yes | nit | ✓ |
| 28 | Pre-existing comment about empty/dim=0 falling through to the generic path is now stale `marshal.go:1006` | real | in-scope | yes | nit | ✓ |
| 29 | Claimed contradiction between commit message wording and the recursive minimum-size logic  | false-positive | in-scope | yes | nit | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 91.7% of it is cache reads, which bill at a tenth of
input; cache creation, another 6.9%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 1.4% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(189,885 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr | 3 | 29 | 24 | 4 | 1 | 23 | 1 | 33,281,648 | $27.89 | 42.8 min | - |

### Spend per run

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr | 10,651,854 tok / $9.54 / 14.8 min | 13,415,478 tok / $10.30 / 16.7 min | 9,214,316 tok / $8.05 / 11.3 min |

**The 3 scored reviews' recorded attempts cost 33,281,648 tokens, $27.89.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

What each run said before verification. Self-rejected claims are excluded, and the judge may merge several claims about one mechanism. The gap from *Raised* is not a miss count.

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr | 9 | 15 | 6 |

## What the maintainers actually said

The upstream reviews, fetched at prepare time and never shown to any reviewer or to the judge.
Bot comments are dropped, and so are the PR author's own replies, which are answers rather than
findings.

Read these as context, not as a scoreboard. The PRs were reviewed at their pinned revisions,
after some upstream comments may already have been addressed. Not repeating a comment is not
automatically a miss; the useful question is whether a concern still applies to the pinned code.

**`ironweave`** - https://github.com/scylladb/seastar/pull/3664 - 9 inline review comments, 2 thread comments.

| Who | Where | What they said |
|---|---|---|
| michoecho | `src/rpc/rpc.cc:293` | It seems to me that it doesn't remove the race, only makes the race window more narrow. What if we pass through the `!_stream_closing` check and suspend at `_outgoing_queue_ready`, and `stream_close()` only runs at th... |
| michoecho | `tests/unit/rpc_test.cc:1867` | Nit: this remark is Scylla-specific. It's not appropriate here. |
| michoecho | `tests/unit/rpc_test.cc:2015` | Too Scylla-specific. |
| michoecho | `tests/unit/rpc_test.cc:1867` | Also applies to this. |
| gleb-cloudius | `doc/rpc-streaming.md:112` | Claude loves to push implementation details everywhere. Not sure such details are appropriate for this doc. |
| xemul | `src/rpc/rpc.cc:562` | Why is `drained` needed? It looks like `std::exchange(_outgoing_queue_ready, make_ready_future<>())` would work just as good |
| xemul | `include/seastar/rpc/rpc.hh:307` | It looks like `_stream_closing == _sink_closed \|\| _source_closed` , is one more boolean really needed? |
| xemul | `src/rpc/rpc.cc:562` | The _connection->write_buf.close() happens in this code after queue is drained and stop_send_loop does ``` return when_all(std::move(_outgoing_queue_ready), std::move(_sink_closed_future)).then([] { ... // calls _conn... |
| xemul | `include/seastar/rpc/rpc.hh:307` | :exploding_head: It looks like you're right |
| michoecho | thread | One more thing: That's also Scylla-specific. Unless it changed, the usual convention was to put such links on the Scylla PR which updates the Seastar submodule. |
| mykaul | thread | @bhalevy - https://github.com/scylladb/seastar/pull/3669 failed CI on test_stream_send_after_stream_close in tests/unit/rpc_test.cc . I think it has nothing to do with RPC, just exposes flakiness in the new test. |

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

**`tidepool`** - https://github.com/scylladb/gocql/pull/1094 - 0 inline review comments, 0 thread comments.

No human review comments upstream.

### Runs that did not complete

None - every run in the matrix returned a report.

## Analysis

No hand-written analysis is attached to this cohort. `bench/analysis.md` describes only the immutable `legacy` results.
