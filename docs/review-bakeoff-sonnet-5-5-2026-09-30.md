# Review-tool bake-off: 7 review configurations, 3 real PRs

**Cohort:** `sonnet-5-5-2026-09-30`. **Requested model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`). Claude Code: `2.1.285 (Claude Code)`.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=sonnet-5-5-2026-09-30`.
This complete cohort contains 19 hash-pinned review cells.
Every run used its own headless `claude -p` process and
working directory so its token spend is attributable.

## What was reviewed

| Target | Language | Diff | Commits | PR under review | Upstream original |
|---|---|---:|---:|---|---|
| `ironweave` | C++ | 15,931 B | 3 commits | https://github.com/dkropachev/ironweave/pull/1 | https://github.com/scylladb/seastar/pull/3664 |
| `quillstone` | Rust | 26,179 B | 4 commits | https://github.com/dkropachev/quillstone/pull/1 | https://github.com/scylladb/scylla-rust-driver/pull/1801 |
| `tidepool` | Go | 18,335 B | 2 commits | https://github.com/dkropachev/tidepool/pull/1 | https://github.com/scylladb/gocql/pull/1094 |

Each PR was republished into a private repository of its own: full upstream history, the PR's own
commits replayed under a neutral author, every `owner/repo` link repointed at the copy, and
`WebSearch`/`WebFetch` denied to every run. A reviewer that could reach the original PR could read
the maintainers' review instead of doing its own.

## Cohort accounting

- Reviews: 19 calls, 6,156,251 tokens, $5.34, 20.6 minutes wall time.
- Extraction: 19 calls, 105 raw claims, $2.97.
- Judging: 3 calls, 59 merged issues (42 real, 16 false-positive, 1 unproven), $4.62.
- Total known canonical spend: $12.92. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct defect the tools found between them, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | CR | CE | TB-D | TB-R | ANT | SP | MP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |  |  |  |  |  |  |
| 1 | Comment in stream_close() wrongly claims nothing else waits on the queue future `src/rpc/rpc.cc:559` | real | in-scope | yes | low |  | ✓ |  |  |  |  | ✓ |
| 2 | Claim: write_buf.close() can race a still in-flight front-entry send_entry() `src/rpc/rpc.cc:562` | false-positive | out-of-scope | no | medium |  |  | ✓ |  |  |  |  |
| 3 | stream_close() has no guard against being invoked a second time concurrently `src/rpc/rpc.cc:554` | real | out-of-scope | no | low |  |  | ✓ |  |  |  |  |
| 4 | New regression test never asserts closed_error was actually thrown `tests/unit/rpc_test.cc:2017` | real | in-scope | yes | low | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| 5 | Test captures the server-side compressor hook but never exercises or checks it `tests/unit/rpc_test.cc:1966` | real | in-scope | yes | low |  | ✓ |  |  | ✓ |  |  |
| 6 | compress() override has an unexplained empty-data special case `tests/unit/rpc_test.cc:1945` | real | in-scope | yes | nit |  | ✓ | ✓ |  | ✓ | ✓ |  |
| 7 | Unused is_server parameter in hook_capturing_compressor_factory::negotiate() `tests/unit/rpc_test.cc:1953` | real | in-scope | yes | nit |  | ✓ |  |  | ✓ | ✓ | ✓ |
| 8 | negotiate() mutates hooks via const_cast inside a const method `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | nit |  | ✓ |  |  | ✓ |  | ✓ |
| 9 | Test scaffolding (~130 lines) called needlessly heavy for one regression test `tests/unit/rpc_test.cc:1870` | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 10 | PR description carries a 'Generated with Claude Code' attribution trailer  | real | in-scope | yes | nit |  |  | ✓ |  | ✓ | ✓ | ✓ |
| 11 | PR description links internal ScyllaDB Jira tickets in a public repo  | real | in-scope | yes | nit |  |  | ✓ |  |  |  | ✓ |
| 12 | New doxygen blocks sit above stale one-line comments on sink and source `include/seastar/rpc/rpc_types.hh:337` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 13 | Doc says connection shuts down only when both stream halves close, omitting errors `doc/rpc-streaming.md:115` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |
| 14 | Doc doesn't say dropping an unclosed sink triggers a process-aborting assertion `doc/rpc-streaming.md:109` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 15 | New _stream_closing guard checked only in send(), not in enqueue_zero_frame() `src/rpc/rpc.cc:866` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 16 | Test picks the stream's compressor hook via hooks.back() without enforcing order `tests/unit/rpc_test.cc:2001` | real | in-scope | yes | nit |  |  | ✓ |  |  |  |  |
| 17 | No test exercises the new outgoing-queue drain step before the buffer is closed `tests/unit/rpc_test.cc:2009` | real | in-scope | yes | low |  |  | ✓ |  |  |  |  |
| 18 | eof marker send is fully awaited before close_sink() runs, not lost `include/seastar/rpc/rpc_impl.hh:924` | false-positive | out-of-scope | no | nit | ✓ | ✓ |  |  |  |  |  |
| 19 | stop() racing stream_close() is correctly serialized via _sink_closed_future `src/rpc/rpc.cc:225` | false-positive | out-of-scope | no | low | ✓ |  |  |  |  |  |  |
| 20 | Ignoring an exceptional drained-queue future before closing the buffer is intentional `src/rpc/rpc.cc:565` | false-positive | out-of-scope | no | low | ✓ | ✓ |  |  |  |  | ✓ |
| 21 | Compressor hook now receiving closed_error mid-window is the intended fix `src/rpc/rpc.cc:293` | false-positive | out-of-scope | no | nit | ✓ |  |  |  |  |  |  |
| 22 | _stream_closing is correctly set before the write buffer is touched `src/rpc/rpc.cc:554` | false-positive | out-of-scope | no | nit | ✓ | ✓ |  |  |  |  |  |
| 23 | _error is intentionally left untouched by stream_close(), matching PR intent `src/rpc/rpc.cc:572` | false-positive | out-of-scope | no | nit |  | ✓ |  |  |  |  |  |
| 24 | Doc and header comments accurately describe close_source()'s sole caller `include/seastar/rpc/rpc_types.hh:384` | false-positive | out-of-scope | no | nit |  | ✓ | ✓ |  |  |  |  |
| | **quillstone (Rust)** | | | | |  |  |  |  |  |  |  |
| 25 | Keyspace-failure branch skips the immediate non-shard-aware fallback/retry `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | low |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 26 | USE-keyspace failure log level downgraded from warn! to debug! `scylla/src/network/connection_pool.rs:903` | real | in-scope | yes | low | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| 27 | Shard-aware "missed target shard" branch drops connection without decrementing… `scylla/src/network/connection_pool.rs:994` | real | out-of-scope | no | low | ✓ |  |  |  |  | ✓ |  |
| 28 | No bound or transient/permanent distinction on repeated USE (keyspace) failures `scylla/src/network/connection_pool.rs:908` | real | in-scope | yes | low |  | ✓ |  |  |  |  | ✓ |
| 29 | PR description omits the bundled metrics-balancing changes and tests  | real | in-scope | yes | low |  | ✓ | ✓ |  | ✓ |  | ✓ |
| 30 | Log/decrement/clear sequence duplicated at three call sites instead of a shared helper `scylla/src/network/connection_pool.rs:674` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 31 | ConnectionSetupError name is easily confused with… `scylla/src/network/connection_pool.rs:1418` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 32 | keyspace_setup_failure_preserves_pool_state bundles three scenarios into one long,… `scylla/src/network/connection_pool.rs:1526` | real | in-scope | yes | nit |  |  |  |  |  | ✓ | ✓ |
| 33 | keyspace_setup_failure_triggers_refill doesn't actually run the refill loop `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 34 | Test's proxy.finish() match tolerates DriverDisconnected `scylla/src/network/connection_pool.rs:1689` | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 35 | keyspace_setup_failure_preserves_pool_state's ready_connections.next().await calls have… `scylla/src/network/connection_pool.rs:1634` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 36 | full_pool_clears_excess_connections_and_balances_metrics still polls in a sleep loop `scylla/src/network/connection_pool.rs:2002` | real | in-scope | yes | nit |  | ✓ |  |  |  |  |  |
| 37 | New public UseKeyspaceError-wrapping variant claimed to lack changelog entry `scylla/src/errors.rs:601` | false-positive | in-scope | yes | nit |  |  |  |  |  | ✓ | ✓ |
| 38 | Keyspace check now runs before resharding, delaying shard-info learning on persistent… `scylla/src/network/connection_pool.rs:915` | real | in-scope | yes | low |  |  |  | ✓ |  |  | ✓ |
| 39 | "Failed USE now marks node Broken instead of keeping the connection" framed as a… `scylla/src/network/connection_pool.rs:900` | false-positive | in-scope | yes | low |  |  | ✓ |  |  |  |  |
| 40 | many_connections test fails with ConnectTimeout opening 400 connections `scylla/src/network/connection_pool.rs:1720` | real | out-of-scope | no | low |  |  |  | ✓ |  |  |  |
| 41 | Metric decrement/removal logic verified to avoid double-decrement `scylla/src/network/connection_pool.rs:1216` | false-positive | in-scope | yes | low |  |  |  | ✓ |  |  |  |
| 42 | PoolRefiller teardown never decrements total_connections for still-live connections `scylla/src/network/connection_pool.rs:498` | real | out-of-scope | no | low |  |  |  |  |  | ✓ |  |
| 43 | Possible unused-import warnings under --no-default-features `scylla/src/network/connection_pool.rs` | false-positive | in-scope | no | nit |  |  |  |  |  | ✓ |  |
| | **tidepool (Go)** | | | | |  |  |  |  |  |  |  |
| 44 | PR description ends with a Claude Code attribution line  | real | in-scope | yes | nit |  | ✓ | ✓ |  | ✓ | ✓ | ✓ |
| 45 | getCassandraLongType now names every unknown basic type, widely untested `helpers.go:280` | real | in-scope | yes | low |  | ✓ |  |  | ✓ | ✓ | ✓ |
| 46 | vectorElemMinSize returns 1 (not 0) for a zero-dimension fixed-size inner vector `marshal.go:1142` | real | in-scope | yes | low | ✓ |  |  |  |  | ✓ | ✓ |
| 47 | TestVectorElemMinSize's zero-dim row has a comment that misstates the true minimum `marshal_vector_test.go:813` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |
| 48 | math.MaxInt32 saturation branch in vectorElemMinSize is untested `marshal.go:1136` | real | in-scope | yes | nit |  |  |  |  | ✓ |  |  |
| 49 | vectorElemMinSize recursion nil-derefs on a nested VectorType with nil SubType `marshal.go:1135` | real | out-of-scope | no | low |  |  | ✓ |  | ✓ | ✓ |  |
| 50 | unmarshalVector's top-level bound check nil-derefs when SubType is nil and Dimensions>0 `marshal.go:999` | real | out-of-scope | no | low |  |  |  |  |  | ✓ |  |
| 51 | Negative vint length narrowing can still reach element unmarshal, deferred to #1106 `marshal.go:1097` | real | out-of-scope | no | low |  |  |  |  |  |  | ✓ |
| 52 | Map/vector parse-error fallbacks still return nameless custom() unlike the new… `helpers.go:222` | real | in-scope | yes | low |  |  | ✓ |  |  |  |  |
| 53 | New makeVectorType test helper duplicates existing makeFloat32/DoubleVectorType `marshal_vector_test.go:556` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 54 | Doc comment for TestUnmarshalVectorZeroDimensionsDoesNotTouchSubType breaks naming… `marshal_vector_test.go:933` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 55 | TestUnmarshalVectorRejectsNestedCountBeforeAllocating asserts on process-wide TotalAlloc `marshal_vector_test.go:836` | real | in-scope | yes | nit |  |  |  |  | ✓ | ✓ |  |
| 56 | New vector tests are gated behind the 'unit' build tag `marshal_vector_test.go:1` | false-positive | out-of-scope | no | nit |  |  |  |  |  | ✓ |  |
| 57 | TestShardAwarePortMocked*/with_TLS tests fail with a cert parsing error  | unproven | out-of-scope | no | low |  |  |  |  |  | ✓ |  |
| 58 | NULL vector value with negative Dimensions metadata now errors instead of decoding to zero `marshal.go:992` | real | in-scope | yes | low |  |  | ✓ |  |  |  |  |
| 59 | Empty non-nil payload with Dimensions>0 now errors -- intended, documented behavior `marshal.go:998` | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 83.4% of it is cache reads, which bill at a tenth of
input; cache creation, another 15.0%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 1.6% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(52,843 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Only this tool | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Claude Code /code-review | 3 | 9 | 4 | 5 | 0 | 3 | 1 | 0 | 929,220 | $0.59 | 3.2 min | - |
| Compound Engineering ce-code-review | 3 | 17 | 12 | 5 | 0 | 12 | 0 | 1 | 914,621 | $0.81 | 2.6 min | - |
| Trail of Bits differential-review | 3 | 17 | 14 | 3 | 0 | 12 | 2 | 5 | 827,617 | $0.79 | 2.4 min | - |
| Trail of Bits rust-review | 1 | 5 | 4 | 1 | 0 | 3 | 1 | 1 | 460,488 | $0.39 | 2.1 min | - |
| Anthropic pr-review-toolkit | 3 | 15 | 15 | 0 | 0 | 14 | 1 | 2 | 775,450 | $0.72 | 3.0 min | - |
| Superpowers requesting-code-review | 3 | 20 | 16 | 3 | 1 | 12 | 4 | 4 | 1,204,445 | $1.18 | 4.3 min | - |
| Matt Pocock code-review | 3 | 28 | 23 | 5 | 0 | 22 | 1 | 9 | 1,044,410 | $0.86 | 2.8 min | - |

### Spend per run

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Claude Code /code-review | 266,129 tok / $0.18 / 1.1 min | 184,513 tok / $0.15 / 0.6 min | 478,578 tok / $0.26 / 1.5 min |
| Compound Engineering ce-code-review | 330,221 tok / $0.27 / 0.8 min | 293,272 tok / $0.28 / 0.8 min | 291,128 tok / $0.27 / 1.0 min |
| Trail of Bits differential-review | 301,468 tok / $0.25 / 0.7 min | 245,748 tok / $0.28 / 0.9 min | 280,401 tok / $0.26 / 0.8 min |
| Trail of Bits rust-review | - | 460,488 tok / $0.39 / 2.1 min | - |
| Anthropic pr-review-toolkit | 174,873 tok / $0.22 / 0.8 min | 278,600 tok / $0.25 / 1.3 min | 321,977 tok / $0.25 / 0.9 min |
| Superpowers requesting-code-review | 305,275 tok / $0.34 / 1.1 min | 485,044 tok / $0.46 / 1.6 min | 414,126 tok / $0.39 / 1.6 min |
| Matt Pocock code-review | 475,355 tok / $0.34 / 1.1 min | 283,812 tok / $0.27 / 0.9 min | 285,243 tok / $0.26 / 0.8 min |

**The 19 scored reviews' recorded attempts cost 6,156,251 tokens, $5.34.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

What each run said, before merging and verification - the gap between this and *Raised* above is
what the judge merged away as the same defect twice.

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Claude Code /code-review | 5 | 2 | 1 |
| Compound Engineering ce-code-review | 10 | 4 | 2 |
| Trail of Bits differential-review | 8 | 4 | 4 |
| Trail of Bits rust-review | - | 6 | - |
| Anthropic pr-review-toolkit | 4 | 4 | 6 |
| Superpowers requesting-code-review | 4 | 8 | 8 |
| Matt Pocock code-review | 7 | 11 | 7 |

## What the maintainers actually said

The upstream reviews, fetched at prepare time and never shown to any reviewer or to the judge.
Bot comments are dropped, and so are the PR author's own replies, which are answers rather than
findings.

Read these as context, not as a scoreboard. Every PR here was replayed at the revision that was
merged, which is the revision *after* its review: the defects the maintainers caught were already
fixed in the code the tools were given, so not reporting one is not a miss. What the list is good
for is the other direction - whether a tool raises the kind of thing these maintainers raise, and
whether anything they flagged survived into the merged code.

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

**`quillstone`** - https://github.com/scylladb/scylla-rust-driver/pull/1801 - 8 inline review comments, 1 thread comments.

| Who | Where | What they said |
|---|---|---|
| Copilot | `scylla/src/network/connection_pool.rs:902` | When keyspace setup fails for the first connection, this branch leaves `shared_conns` as `Initializing` and never notifies `pool_updated_notify`. Consequently, `wait_until_all_pools_are_initialized()` can block foreve... |
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
