# Review-tool bake-off: 1 review configuration, 3 real PRs

**Cohort:** `rafp-native-claude-retest-2026-10-09`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.292 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=rafp-native-claude-retest-2026-10-09`.
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

- Reviews: 3 calls, 27,062,254 tokens, $24.69, 26.9 minutes wall time.
- Extraction: 3 calls, 58 raw claims, $0.67.
- Judging: 3 calls, 58 merged issues (40 real, 18 false-positive, 0 unproven), $7.11.
- Total known cohort spend: $32.48. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr |
|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |
| 1 | New test data-sink override breaks build at Seastar_API_LEVEL<9 `tests/unit/rpc_test.cc:1883` | real | in-scope | yes | high | ✓ |
| 2 | New regression test never exercises stream_close()'s queue-drain wait `src/rpc/rpc.cc:562` | real | in-scope | yes | medium | ✓ |
| 3 | New test tolerates both refusal and silent acceptance of the racy send `tests/unit/rpc_test.cc:2016` | real | in-scope | yes | medium | ✓ |
| 4 | Claim that the yield() loop doesn't drive the batch-flush poller `tests/unit/rpc_test.cc:2020` | false-positive | in-scope | yes | nit | ✓ |
| 5 | New test can hang or SIGABRT instead of failing cleanly on a regression `tests/unit/rpc_test.cc:2011` | real | in-scope | yes | medium | ✓ |
| 6 | Cross-shard data race on hook_capturing_compressor_factory::hooks vector `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | high | ✓ |
| 7 | New comment misstates when _outgoing_queue_ready becomes exceptional `src/rpc/rpc.cc:566` | real | in-scope | yes | low | ✓ |
| 8 | New rpc_types.hh doc overstates that an unmarshall exception always closes the source `include/seastar/rpc/rpc_types.hh:384` | real | in-scope | yes | medium | ✓ |
| 9 | New doc overstates that the stream connection shuts down 'only once' both halves close `doc/rpc-streaming.md:115` | real | in-scope | yes | low | ✓ |
| 10 | New doc understates dropping an unclosed sink as merely 'an error' `doc/rpc-streaming.md:109` | real | in-scope | yes | medium | ✓ |
| 11 | Claim that the new stream_close() wait is an unbounded regression `src/rpc/rpc.cc:562` | false-positive | in-scope | yes | nit | ✓ |
| 12 | Claim of a close-vs-shutdown race in the new stream_close() logic `src/rpc/rpc.cc:548` | false-positive | in-scope | yes | nit | ✓ |
| 13 | Claim that the parent client still has an unfixed write-after-close path  | false-positive | out-of-scope | no | nit | ✓ |
| 14 | Claim that error() callers can still reach send() on a closing stream connection `src/rpc/rpc.cc:293` | false-positive | in-scope | yes | nit | ✓ |
| 15 | Bare '#3663' issue reference flagged as a commit convention problem  | false-positive | out-of-scope | no | nit | ✓ |
| 16 | Missing DCO sign-off flagged as a commit convention problem  | false-positive | out-of-scope | no | nit | ✓ |
| 17 | Jira links in the PR body flagged as a convention problem  | false-positive | out-of-scope | no | nit | ✓ |
| 18 | 'rpc_test:' commit prefix flagged as a convention problem  | false-positive | out-of-scope | no | nit | ✓ |
| 19 | Comment placement flagged as a style convention problem  | false-positive | out-of-scope | no | nit | ✓ |
| 20 | Socket-wrapper boilerplate in the new test flagged as a style problem `tests/unit/rpc_test.cc:1875` | false-positive | in-scope | yes | nit | ✓ |
| 21 | Claude co-authorship trailers and PR footer flagged as a convention problem  | false-positive | out-of-scope | no | nit | ✓ |
| | **quillstone (Rust)** | | | | |  |
| 22 | Keyspace USE failure discards connection unconditionally, no permanent/transient split `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | medium | ✓ |
| 23 | Keyspace-change race: Err(Keyspace) arm never retries with the now-current keyspace `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | medium | ✓ |
| 24 | Failed per-connection USE keyspace log downgraded from warn! to debug! `scylla/src/network/connection_pool.rs:903` | real | in-scope | yes | low | ✓ |
| 25 | Excess shard-aware-port connection branch drops connection without decrementing metric `scylla/src/network/connection_pool.rs:994` | real | out-of-scope | no | medium | ✓ |
| 26 | keyspace_setup_failure_triggers_refill test exercises no real code path and uses an… `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | medium | ✓ |
| 27 | PR's stated validation command never runs the three new metrics-balance tests `scylla/Cargo.toml:35` | real | in-scope | yes | medium | ✓ |
| 28 | Commit 0d91aa54 fails -Dwarnings CI check on its own due to unused futures::FutureExt… `scylla/src/network/connection_pool.rs:1445` | real | in-scope | yes | medium | ✓ |
| 29 | Commit 617139df is a one-line fixup of 0d91aa54's busy-wait and should be squashed  | real | in-scope | yes | low | ✓ |
| 30 | Commit bodies are empty and PR body never mentions the metrics commits despite the…  | real | in-scope | yes | low | ✓ |
| 31 | Relocated comment still claims connection is 'finally put into the conns', no longer… `scylla/src/network/connection_pool.rs:918` | real | in-scope | yes | low | ✓ |
| 32 | New keyspace-failure tests skip the repo-conventional setup_tracing() call `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low | ✓ |
| 33 | Resharding metrics test never has excess connections, leaving that decrement term untested `scylla/src/network/connection_pool.rs:1115` | real | in-scope | yes | low | ✓ |
| 34 | Proxy test uses unbounded ready_connections.next().await `scylla/src/network/connection_pool.rs:1634` | false-positive | in-scope | yes | nit | ✓ |
| 35 | Keyspace check moved ahead of maybe_reshard, so missing USE timeout now also stalls… `scylla/src/network/connection_pool.rs:915` | real | in-scope | yes | medium | ✓ |
| 36 | New tests re-implement setup rather than reusing mock_pool_refiller/start_simulated_node `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | nit | ✓ |
| 37 | New private ConnectionSetupError is easily confused with public… `scylla/src/network/connection_pool.rs:1418` | real | in-scope | yes | nit | ✓ |
| 38 | decrement_total_connections decrements one-by-one in a loop instead of in bulk `scylla/src/network/connection_pool.rs:1360` | real | in-scope | yes | nit | ✓ |
| | **tidepool (Go)** | | | | |  |
| 39 | Vector element with no Go type was claimed to still panic via info.Zero() `helpers.go:283` | false-positive | out-of-scope | no | low | ✓ |
| 40 | vectorElemMinSize is quadratic in nesting depth via isVectorVariableLengthType's own… `marshal.go:1125` | real | in-scope | yes | low | ✓ |
| 41 | Zero-dimension inner vector's minimum size wrongly floored to 1 byte, rejecting valid… `marshal.go:1140` | real | in-scope | yes | medium | ✓ |
| 42 | New function-level comment overstates that every unmarshalVector path allocates `marshal.go:986` | real | in-scope | yes | nit | ✓ |
| 43 | Fast-path's nil/empty comment now precedes a duplicated Dimensions>0 && data!=nil guard `marshal.go:1004` | real | in-scope | yes | nit | ✓ |
| 44 | Float/double 'expected N bytes, got M' errors are now unreachable for too-short… `marshal.go:1012` | real | in-scope | yes | nit | ✓ |
| 45 | No-Go-type error for a nested vector element prints only 'custom(...VectorType)', losing… `marshal.go:1048` | real | in-scope | yes | low | ✓ |
| 46 | PR body's claim that every new test fails against pristine code is false `marshal_vector_test.go:695` | real | in-scope | yes | low | ✓ |
| 47 | Commit message's 'one byte per element' justification undersells the recursive minimum… `marshal.go:1125` | real | in-scope | yes | nit | ✓ |
| 48 | Commits omit Refs trailers even though the PR body cites issue #1091 and DRIVER-954  | real | in-scope | yes | nit | ✓ |
| 49 | New 'trailing byte' test locks in surplus-byte behaviour the PR explicitly defers to a… `marshal_vector_test.go:724` | real | in-scope | yes | low | ✓ |
| 50 | No test covers the headline case: an empty (non-NULL) payload with Dimensions > 0 `marshal_vector_test.go:587` | real | in-scope | yes | low | ✓ |
| 51 | No test reaches vectorElemMinSize's MaxInt32 saturation branch `marshal.go:1135` | real | in-scope | yes | low | ✓ |
| 52 | New test helper makeVectorType duplicates pre-existing… `marshal_vector_test.go:557` | real | in-scope | yes | nit | ✓ |
| 53 | Tests pair TypeText with the Java class name UTF8Type, though the real parser maps… `marshal_vector_test.go:811` | real | in-scope | yes | nit | ✓ |
| 54 | Pre-existing malformed-metadata branches still drop the type name, unlike the PR's new… `helpers.go:221` | real | in-scope | yes | nit | ✓ |
| 55 | Self-rejected: keeping the custom name on unknown types is not a user-visible break `helpers.go:280` | false-positive | in-scope | yes | low | ✓ |
| 56 | Self-rejected: the allocation-bound test is not likely to flake `marshal_vector_test.go:836` | false-positive | in-scope | yes | low | ✓ |
| 57 | Self-rejected: a nil SubType crashes on the same inputs on base as on head `marshal.go:1007` | false-positive | out-of-scope | no | low | ✓ |
| 58 | vectorElemMinSize's fixed-size-first check silently ignores a type that is both… `marshal.go:1125` | false-positive | in-scope | yes | nit | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 90.8% of it is cache reads, which bill at a tenth of
input; cache creation, another 7.6%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 1.6% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(225,677 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr | 3 | 58 | 40 | 18 | 0 | 39 | 1 | 27,062,254 | $24.69 | 26.9 min | - |

### Spend per run

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr | 8,805,418 tok / $8.68 / 10.6 min | 8,860,450 tok / $7.68 / 7.2 min | 9,396,386 tok / $8.33 / 9.2 min |

**The 3 scored reviews' recorded attempts cost 27,062,254 tokens, $24.69.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

What each run said before verification. Self-rejected claims are excluded, and the judge may merge several claims about one mechanism. The gap from *Raised* is not a miss count.

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr | 21 | 17 | 20 |

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
