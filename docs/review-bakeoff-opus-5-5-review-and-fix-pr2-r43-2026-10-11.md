# Review-tool bake-off: 1 review configuration, 3 real PRs

**Cohort:** `opus-5-5-review-and-fix-pr2-r43-2026-10-11`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.296 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr2` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=opus-5-5-review-and-fix-pr2-r43-2026-10-11`.
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

- Reviews: 3 calls, 3,908,047 tokens, $6.26, 9.7 minutes wall time.
- Extraction: 3 calls, 76 raw claims, $0.92.
- Judging: 3 calls, 75 merged issues (69 real, 6 false-positive, 0 unproven), $5.51.
- Total known cohort spend: $12.68. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr2 |
|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |
| 1 | Test comment wrongly says the no-fix failure manifests as the ~output_stream() assert `tests/unit/rpc_test.cc:2031` | real | in-scope | yes | low | ✓ |
| 2 | New doc text understates that dropping an unclosed sink aborts the process `doc/rpc-streaming.md:109` | real | in-scope | yes | medium | ✓ |
| 3 | New doc text wrongly claims connection shuts down only once both stream halves close `doc/rpc-streaming.md:115` | real | in-scope | yes | medium | ✓ |
| 4 | New comment overstates that nothing else waits on _outgoing_queue_ready `src/rpc/rpc.cc:559` | real | in-scope | yes | nit | ✓ |
| 5 | New test's condition-variable wait has no timeout and can stall to the harness limit `tests/unit/rpc_test.cc:2011` | real | in-scope | yes | low | ✓ |
| 6 | Any early failure in the new test aborts the whole test process via the unclosed sink's… `tests/unit/rpc_test.cc:2000` | real | in-scope | yes | medium | ✓ |
| 7 | Test never directly asserts the refused frame throws closed_error `tests/unit/rpc_test.cc:2016` | real | in-scope | yes | low | ✓ |
| 8 | New test never exercises the queue-drain wait branch or the server-side stream hook `src/rpc/rpc.cc:562` | real | in-scope | yes | low | ✓ |
| 9 | New source doc comment overstates that there is no other way to release a source `include/seastar/rpc/rpc_types.hh:386` | real | in-scope | yes | low | ✓ |
| 10 | Pre-existing _sink_closed_future comment is now less precise given the new queue-drain… `include/seastar/rpc/rpc.hh:302` | real | in-scope | yes | nit | ✓ |
| 11 | PR body and all three commits carry Claude/Anthropic attribution the user's global rules…  | real | in-scope | yes | medium | ✓ |
| 12 | Commits lack the Signed-off-by trailer doc/contributing.md requires `doc/contributing.md:6` | real | in-scope | yes | low | ✓ |
| 13 | Commit/PR text references issue numbers that don't resolve in this checkout's remote  | false-positive | out-of-scope | yes | low | ✓ |
| 14 | Fix commit lands before its regression test, in a separate commit  | false-positive | out-of-scope | no | nit | ✓ |
| 15 | Fix commit subject omits that stream_close() was also reordered `src/rpc/rpc.cc:557` | real | in-scope | yes | nit | ✓ |
| 16 | _stream_closing is only consulted by send(), not by error()/sink_closed() `include/seastar/rpc/rpc.hh:307` | real | in-scope | yes | nit | ✓ |
| 17 | New test wrapper classes have generic names that don't convey their close-parking… `tests/unit/rpc_test.cc:1877` | false-positive | in-scope | yes | nit | ✓ |
| 18 | Test wrapper's buffer_size() returns a hard-coded constant instead of forwarding to the… `tests/unit/rpc_test.cc:1895` | real | in-scope | yes | nit | ✓ |
| 19 | const_cast used to mutate state inside a const negotiate() override `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | nit | ✓ |
| 20 | is_server parameter of negotiate() is unused `tests/unit/rpc_test.cc:1953` | real | in-scope | yes | nit | ✓ |
| 21 | server_factory's captured hooks are dead fixture state, never invoked or asserted `tests/unit/rpc_test.cc:1966` | real | in-scope | yes | nit | ✓ |
| 22 | Reference into client_factory.hooks taken via back() could be invalidated by a later… `tests/unit/rpc_test.cc:2001` | real | in-scope | yes | nit | ✓ |
| 23 | Fixed 10-iteration yield() loop is a magic-count poll rather than a real completion signal `tests/unit/rpc_test.cc:2022` | real | in-scope | yes | nit | ✓ |
| 24 | New doc comment blocks are split from their declarations by older inline comments `include/seastar/rpc/rpc_types.hh:337` | real | in-scope | yes | nit | ✓ |
| 25 | Stream shutdown contract is now documented in three places that could drift apart `include/seastar/rpc/rpc_types.hh:337` | real | in-scope | yes | nit | ✓ |
| | **quillstone (Rust)** | | | | |  |
| 26 | Persistent keyspace USE failure retries forever, leaving pool permanently Broken `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | high | ✓ |
| 27 | Keyspace USE failures downgraded from warn! to debug!, silent at default log level `scylla/src/network/connection_pool.rs:903` | real | in-scope | yes | medium | ✓ |
| 28 | Missing timeout on per-connection USE means a hung request delays the new Broken report… `scylla/src/network/connection_pool.rs:908` | real | in-scope | yes | medium | ✓ |
| 29 | Test injects UseKeyspaceError::RequestTimeout, a variant the per-connection USE path… `scylla/src/network/connection_pool.rs:1500` | real | in-scope | yes | low | ✓ |
| 30 | keyspace_setup_failure_triggers_refill never exercises run(), and metrics assertions… `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low | ✓ |
| 31 | Comment claims a connection always ends up in conns, but a failed USE now discards it `scylla/src/network/connection_pool.rs:918` | real | in-scope | yes | low | ✓ |
| 32 | New metrics test skips cleanup (sender drop, worker.await, proxy.finish) if it times out… `scylla/src/network/connection_pool.rs:2001` | real | in-scope | yes | low | ✓ |
| 33 | Wrong-shard-aware-port connection is dropped without decrementing total-connections metric `scylla/src/network/connection_pool.rs:994` | real | out-of-scope | no | low | ✓ |
| 34 | decrement_total_connections loops fetch_sub(1) per connection instead of a single… `scylla/src/network/connection_pool.rs:1359` | false-positive | in-scope | yes | nit | ✓ |
| 35 | Commit 7f48315d's message omits the new error variant, log downgrade, and reordering it… `scylla/src/errors.rs:600` | real | in-scope | yes | low | ✓ |
| 36 | Metric-balancing fix shipped without tests, tests and a busy-wait fixup trail in two… `scylla/src/network/connection_pool.rs:2003` | real | in-scope | yes | nit | ✓ |
| 37 | PR's 'Fixes: #1682' references a nonexistent issue  | real | in-scope | yes | low | ✓ |
| 38 | Report notes no Claude/Anthropic attribution was found  | false-positive | out-of-scope | no | nit | ✓ |
| 39 | New UseKeyspaceError wrapper variant uses a fourth, inconsistent error message format `scylla/src/errors.rs:601` | real | in-scope | yes | nit | ✓ |
| 40 | New keyspace-failure tests omit the setup_tracing() call every neighboring test makes `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low | ✓ |
| 41 | New tests hand-roll PoolRefiller/rule setup and near-duplicate an existing helper… `scylla/src/network/connection_pool.rs:1489` | real | in-scope | yes | nit | ✓ |
| 42 | "Busy-wait" fixup commit still polls on a sleep instead of awaiting a Notify `scylla/src/network/connection_pool.rs:2003` | real | in-scope | yes | nit | ✓ |
| 43 | Metric-decrement-on-clear bookkeeping is duplicated across several call sites `scylla/src/network/connection_pool.rs:674` | real | in-scope | yes | nit | ✓ |
| 44 | PR description frames the failure path as recovering via refill without disclosing it… `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | high | ✓ |
| 45 | Keyspace-mismatch check now runs before resharding/shard-aware-port update, undocumented… `scylla/src/network/connection_pool.rs:913` | real | in-scope | yes | medium | ✓ |
| 46 | PR body omits the metric-balancing commits, new error variant, and log-level change  | real | in-scope | yes | low | ✓ |
| | **tidepool (Go)** | | | | |  |
| 47 | serialization/varint integer constants overflow int on GOARCH=386 `serialization/varint/marshal_ints.go:123` | real | out-of-scope | no | medium | ✓ |
| 48 | Fast-path comment says empty payload falls through, but the new bound now rejects it first `marshal.go:1006` | real | in-scope | yes | nit | ✓ |
| 49 | Bound comment overstates that every path below it allocates `marshal.go:986` | real | in-scope | yes | nit | ✓ |
| 50 | Bound comment omits that it also stops short payloads decoding to silent zeroes `marshal.go:986` | real | in-scope | yes | low | ✓ |
| 51 | Comment overstates that unmarshalList bounds the same way `marshal.go:986` | real | in-scope | yes | nit | ✓ |
| 52 | Test doc's 32-bit wraparound coverage claim can never run since the package won't build… `marshal_vector_test.go:586` | real | in-scope | yes | low | ✓ |
| 53 | Claim that the dim=0 comment overstates nil-SubType safety `marshal.go:995` | false-positive | out-of-scope | yes | nit | ✓ |
| 54 | vectorElemMinSize's MaxInt32 saturation branch has no test `marshal.go:1134` | real | in-scope | yes | low | ✓ |
| 55 | No direct test for a non-NULL empty []byte{} payload with dim>0 now erroring `marshal_vector_test.go` | real | in-scope | yes | low | ✓ |
| 56 | Flat variable-length vector over a short payload is only tested nested `marshal_vector_test.go` | real | in-scope | yes | low | ✓ |
| 57 | getCassandraLongType's name-preserving fix also changes String()/Custom() output, beyond… `helpers.go:280` | real | in-scope | yes | low | ✓ |
| 58 | New bound block and the pre-existing fast-path block repeat the same guard condition `marshal.go:998` | real | in-scope | yes | nit | ✓ |
| 59 | New generic makeVectorType duplicates the pre-existing… `marshal_vector_test.go:35` | real | in-scope | yes | nit | ✓ |
| 60 | PR body and both commits carry Claude/Anthropic attribution  | real | in-scope | yes | low | ✓ |
| 61 | PR body references issue/PR numbers that don't exist in this repo  | real | in-scope | yes | low | ✓ |
| 62 | PR body lists #1106 as outstanding deferred work, but it was already closed as completed…  | real | in-scope | yes | low | ✓ |
| 63 | PR body's '#1093 rejects dim < 1' companion claim does not apply to this repository `frame.go:861` | real | in-scope | yes | low | ✓ |
| 64 | Commit 0276a66's body never states the short/empty-payload-now-errors behavior change  | real | in-scope | yes | low | ✓ |
| 65 | Commit 78891dd's subject doesn't mention the getCassandraLongType naming change  | real | in-scope | yes | nit | ✓ |
| 66 | Commits/changes don't follow CONTRIBUTING.md's commit-trailer and godoc-update guidance `CONTRIBUTING.md` | real | in-scope | yes | low | ✓ |
| 67 | vectorElemMinSize, vectorFixedElemSize and isVectorVariableLengthType can silently diverge `marshal.go:1125` | real | in-scope | yes | nit | ✓ |
| 68 | New test-only vector-type builders duplicate an existing one in vector_bench_test.go `marshal_vector_test.go:557` | real | in-scope | yes | nit | ✓ |
| 69 | wireVectorType is a generic custom-type-string parser, not vector-specific as its name… `marshal_vector_test.go:860` | real | in-scope | yes | nit | ✓ |
| 70 | The 'nothing recovers on Scan's goroutine' rationale is repeated across comments, commit… `marshal.go:986` | real | in-scope | yes | nit | ✓ |
| 71 | New tests mix in t.Parallel() and an inline-slice table inconsistent with the file's… `marshal_vector_test.go:937` | real | in-scope | yes | nit | ✓ |
| 72 | PR body's claim that every new test fails against pristine code is not accurate  | real | in-scope | yes | low | ✓ |
| 73 | The NULL-with-negative-dimensions case fails on base in a way the PR body's four failure…  | real | in-scope | yes | low | ✓ |
| 74 | Undocumented behaviour change: a NULL value with negative dimensions now errors instead… `marshal.go:992` | real | in-scope | yes | low | ✓ |
| 75 | Undocumented change: a short payload to an unsupported destination now gets the bound's… `marshal.go:998` | real | in-scope | yes | low | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 82.1% of it is cache reads, which bill at a tenth of
input; cache creation, another 15.1%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 2.8% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(42,965 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr2 | 3 | 75 | 69 | 6 | 0 | 67 | 2 | 3,908,047 | $6.26 | 9.7 min | - |

### Spend per run

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr2 | 1,283,576 tok / $2.00 / 3.0 min | 1,224,758 tok / $1.91 / 2.9 min | 1,399,713 tok / $2.36 / 3.8 min |

**The 3 scored reviews' recorded attempts cost 3,908,047 tokens, $6.26.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

What each run said before verification. Self-rejected claims are excluded, and the judge may merge several claims about one mechanism. The gap from *Raised* is not a miss count.

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr2 | 26 | 21 | 29 |

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
