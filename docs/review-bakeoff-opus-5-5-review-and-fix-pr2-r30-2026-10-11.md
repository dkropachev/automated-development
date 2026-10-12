# Review-tool bake-off: 1 review configuration, 3 real PRs

**Cohort:** `opus-5-5-review-and-fix-pr2-r30-2026-10-11`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.296 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr2` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=opus-5-5-review-and-fix-pr2-r30-2026-10-11`.
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

- Reviews: 3 calls, 3,747,390 tokens, $6.23, 10.0 minutes wall time.
- Extraction: 3 calls, 87 raw claims, $1.01.
- Judging: 3 calls, 86 merged issues (73 real, 12 false-positive, 1 unproven), $4.99.
- Total known cohort spend: $12.23. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr2 |
|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |
| 1 | Test swallows send()'s closed_error without asserting it was thrown `tests/unit/rpc_test.cc:2016` | real | in-scope | yes | low | ✓ |
| 2 | Mid-test assertion/exception failure leaves the parked sink unclosed and aborts `tests/unit/rpc_test.cc:2000` | real | in-scope | yes | medium | ✓ |
| 3 | close_entered_cv.wait() has no timeout, so a regression hangs the suite `tests/unit/rpc_test.cc:2011` | real | in-scope | yes | low | ✓ |
| 4 | New drain in stream_close() is untested for the race it exists to fix `src/rpc/rpc.cc:562` | real | in-scope | yes | medium | ✓ |
| 5 | Doc says dropping an unclosed sink 'is an error', understating it aborts the process `doc/rpc-streaming.md:109` | real | in-scope | yes | low | ✓ |
| 6 | Doc overstates that reading to eof or throw is the only way the source closes `doc/rpc-streaming.md:110` | real | in-scope | yes | low | ✓ |
| 7 | Doc overstates that stream shutdown happens only once both halves are closed `doc/rpc-streaming.md:115` | real | in-scope | yes | nit | ✓ |
| 8 | Comment imprecisely implies nothing ever waits on _outgoing_queue_ready again `src/rpc/rpc.cc:559` | real | in-scope | yes | nit | ✓ |
| 9 | ignore_ready_future() drops a failed queue-drain without logging `src/rpc/rpc.cc:566` | false-positive | out-of-scope | no | nit | ✓ |
| 10 | PR body doesn't explain the same unflushed frame it says it saw on the parent client  | real | in-scope | yes | low | ✓ |
| 11 | Test hard-codes buffer_size() to 8192 instead of forwarding to the inner sink `tests/unit/rpc_test.cc:1895` | real | in-scope | yes | nit | ✓ |
| 12 | test_socket_impl::set_reuseaddr/get_reuseaddr are a no-op instead of forwarding `tests/unit/rpc_test.cc:1932` | real | in-scope | yes | nit | ✓ |
| 13 | Old one-line comments left redundant alongside new Doxygen blocks `include/seastar/rpc/rpc_types.hh:343` | real | in-scope | yes | nit | ✓ |
| 14 | PR body ends with a Claude Code attribution line  | real | in-scope | yes | nit | ✓ |
| 15 | Commits carry Co-Authored-By: Claude trailers  | real | in-scope | yes | nit | ✓ |
| 16 | Fixes #3663 / Refs #3653 do not resolve against this repository  | real | in-scope | yes | low | ✓ |
| 17 | Fix and its regression test are split across separate commits  | false-positive | out-of-scope | yes | nit | ✓ |
| 18 | PR body's debug-build validation claims aren't backed by a CI link or log  | unproven | in-scope | yes | low | ✓ |
| 19 | Generic test_ names don't signal these fixtures exist to park close() `tests/unit/rpc_test.cc:1870` | real | in-scope | yes | nit | ✓ |
| 20 | test_connected_socket_impl hand-forwards ~16 methods, prone to drift `tests/unit/rpc_test.cc:1900` | real | in-scope | yes | nit | ✓ |
| 21 | const_cast used in a const negotiate() instead of a mutable member `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | nit | ✓ |
| 22 | Unused server_factory captured hooks have no explanatory comment `tests/unit/rpc_test.cc:1966` | real | in-scope | yes | nit | ✓ |
| 23 | Reference into hooks vector could dangle if a later push_back reallocates `tests/unit/rpc_test.cc:2000` | real | in-scope | yes | nit | ✓ |
| 24 | Fixed 10-yield polling loop is an arbitrary, non-deterministic bound `tests/unit/rpc_test.cc:2022` | real | in-scope | yes | nit | ✓ |
| 25 | Pass-through compressor claimed to duplicate an existing one in the file `tests/unit/rpc_test.cc:1939` | false-positive | out-of-scope | yes | nit | ✓ |
| 26 | PR body overstates that the drain's wait mirrors send()'s error handling  | real | in-scope | yes | nit | ✓ |
| | **quillstone (Rust)** | | | | |  |
| 27 | Persistent USE keyspace failures can drain a reachable node's pool to Broken `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | medium | ✓ |
| 28 | Keyspace-setup failure log downgraded from warn! to debug! `scylla/src/network/connection_pool.rs:903` | real | in-scope | yes | low | ✓ |
| 29 | Keyspace-failure log uses {} while sibling arms use {:?} `scylla/src/network/connection_pool.rs:903` | real | in-scope | yes | nit | ✓ |
| 30 | Comment claims a connection re-enters pool logic to finally be stored, but failures now… `scylla/src/network/connection_pool.rs:918` | real | in-scope | yes | nit | ✓ |
| 31 | Pre-existing missing-timeout TODO on per-connection USE now also blocks the empty-pool… `scylla/src/network/connection_pool.rs:1336` | real | in-scope | no | low | ✓ |
| 32 | New error variant text said to overstate when the keyspace failure occurs `scylla/src/errors.rs:600` | false-positive | in-scope | yes | nit | ✓ |
| 33 | #[from] on ConnectionError::UseKeyspaceError enables silent ? conversion `scylla/src/errors.rs:600` | real | in-scope | yes | nit | ✓ |
| 34 | keyspace_setup_failure_triggers_refill never calls run(), doesn't prove a refill is… `scylla/src/network/connection_pool.rs:1473` | real | in-scope | yes | low | ✓ |
| 35 | Test uses UseKeyspaceError::RequestTimeout, a variant this code path cannot produce `scylla/src/network/connection_pool.rs:1473` | real | in-scope | yes | low | ✓ |
| 36 | No test for keyspace failure while pool is empty with other attempts in flight `scylla/src/network/connection_pool.rs` | real | in-scope | yes | low | ✓ |
| 37 | No test asserts the Lost connectivity event actually fires on keyspace failure `scylla/src/network/connection_pool.rs` | real | in-scope | yes | low | ✓ |
| 38 | No test for resharding while excess_connections is non-empty `scylla/src/network/connection_pool.rs` | real | in-scope | yes | low | ✓ |
| 39 | Metrics test uses a 1ms polling loop instead of a deterministic notification `scylla/src/network/connection_pool.rs:2001` | real | in-scope | yes | nit | ✓ |
| 40 | Redundant assert after worker.await repeats the polling loop's exit condition `scylla/src/network/connection_pool.rs:2001` | real | in-scope | yes | nit | ✓ |
| 41 | PR body's 'Fixes: #1682' points to a nonexistent issue  | real | in-scope | yes | medium | ✓ |
| 42 | Cited validation run omits --features metrics, leaving the metrics-balancing tests and… `scylla/Cargo.toml:35` | real | in-scope | yes | medium | ✓ |
| 43 | Metric-balancing fix (de164845) lands with no test; test arrives in a separate commit  | real | in-scope | yes | low | ✓ |
| 44 | Fixup commit 617139df should be squashed into the commit that added the test `scylla/src/network/connection_pool.rs:2003` | real | in-scope | yes | nit | ✓ |
| 45 | All four commits are subject-only, with no body explaining why  | real | in-scope | yes | low | ✓ |
| 46 | New UseKeyspaceError message breaks the wording pattern of the other three variants `scylla/src/errors.rs:601` | real | in-scope | yes | nit | ✓ |
| 47 | New keyspace tests skip setup_tracing() used by every nearby test `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | nit | ✓ |
| 48 | New keyspace tests build PoolRefiller by hand instead of reusing mock_pool_refiller() `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | nit | ✓ |
| 49 | keyspace_setup_failure_preserves_pool_state re-implements OPTIONS/STARTUP rules already… `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | nit | ✓ |
| 50 | decrement_total_connections loops one atomic op per connection instead of batching `scylla/src/network/connection_pool.rs:1360` | real | in-scope | yes | nit | ✓ |
| 51 | Self-rejected: per-connection counter-increment test loops are fine as written `scylla/src/network/connection_pool.rs:1957` | false-positive | out-of-scope | no | nit | ✓ |
| 52 | Empty-pool report condition duplicated between the two handle_ready_connection error arms `scylla/src/network/connection_pool.rs:908` | real | in-scope | yes | nit | ✓ |
| 53 | Keyspace failure represented by two parallel error enums that must be kept in sync  | real | in-scope | yes | nit | ✓ |
| 54 | unrequested_connection_event nearly duplicates shard_aware_attempt_result `scylla/src/network/connection_pool.rs:1855` | real | in-scope | yes | nit | ✓ |
| 55 | PR description doesn't disclose that the pool can now permanently drain under persistent…  | real | in-scope | yes | medium | ✓ |
| 56 | PR description covers only one of the four commits' changes `scylla/src/network/connection_pool.rs:674` | real | in-scope | yes | medium | ✓ |
| 57 | Keyspace check moved ahead of sharder/shard-aware-port update, so stale values persist… `scylla/src/network/connection_pool.rs` | real | in-scope | yes | low | ✓ |
| 58 | Self-rejected: no new waits/timeouts/cancellation points added on public calls  | false-positive | out-of-scope | no | low | ✓ |
| 59 | Self-rejected: validation filter accurately matches the two cited passing tests `scylla/src/network/connection_pool.rs:1474` | false-positive | out-of-scope | no | low | ✓ |
| | **tidepool (Go)** | | | | |  |
| 60 | Negative-dimensions test allegedly expects the wrong error message `marshal_vector_test.go:598` | false-positive | out-of-scope | no | nit | ✓ |
| 61 | Test comment's 32-bit wrap claim is never exercised because 386 fails to build `marshal_vector_test.go:586` | real | in-scope | yes | low | ✓ |
| 62 | NULL scanned into *any with an unrepresentable element type now errors instead of… `marshal.go:1044` | real | in-scope | yes | low | ✓ |
| 63 | Nested-vector "no Go type" error doesn't name the inner element type or dimension `marshal.go:1048` | real | in-scope | yes | low | ✓ |
| 64 | Saturation branch in vectorElemMinSize is untested `marshal.go:1133` | real | in-scope | yes | low | ✓ |
| 65 | getCassandraLongType's unknown-type-name behavior has no direct unit test `helpers.go:280` | real | in-scope | yes | low | ✓ |
| 66 | unmarshalVector repeats the same guard condition in two adjacent blocks `marshal.go:998` | real | in-scope | yes | nit | ✓ |
| 67 | PR commits and body carry Claude/Anthropic attribution against the user's standing…  | real | in-scope | yes | nit | ✓ |
| 68 | Behavior change isn't recorded in CHANGELOG.md or mentioned in Unmarshal/VectorType godoc `marshal.go:260` | real | in-scope | yes | low | ✓ |
| 69 | Commits don't use CONTRIBUTING.md's "Patch by ...; reviewed by ... for #####" format `CONTRIBUTING.md:37` | real | in-scope | yes | nit | ✓ |
| 70 | Stale "nil/empty and dim=0 fall through" comment no longer fully describes the fast-path… `marshal.go:1006` | real | in-scope | yes | nit | ✓ |
| 71 | "// basic type" comment in helpers.go now also covers the new custom-type branch `helpers.go:279` | real | in-scope | yes | nit | ✓ |
| 72 | vectorElemMinSize, vectorFixedElemSize and isVectorVariableLengthType must be kept in… `marshal.go:1125` | real | in-scope | yes | nit | ✓ |
| 73 | New makeVectorType test helper takes a redundant elem/elemName pair that could disagree `marshal_vector_test.go:557` | real | in-scope | yes | nit | ✓ |
| 74 | wireVectorType's name doesn't convey that it parses through readTypeInfo `marshal_vector_test.go:860` | real | in-scope | yes | nit | ✓ |
| 75 | The wrap-overflow rationale is restated nearly verbatim in code, test comments, and the… `marshal.go:986` | real | in-scope | yes | nit | ✓ |
| 76 | vectorElemMinSize godoc explains rationale against a hypothetical rather than describing… `marshal.go:1121` | real | in-scope | yes | nit | ✓ |
| 77 | TotalAlloc-based allocation test is theoretically sensitive to leaked goroutines from… `marshal_vector_test.go:836` | real | in-scope | yes | low | ✓ |
| 78 | PR body overclaims that every new test fails against pristine code with specific panic…  | real | in-scope | yes | low | ✓ |
| 79 | PR body misdescribes how short-payload cases actually fail on base (silent zero values,…  | real | in-scope | yes | low | ✓ |
| 80 | PR body's linked issue numbers don't resolve on this repository  | real | in-scope | yes | low | ✓ |
| 81 | PR body's "Behaviour change" section omits that NULL with negative dimensions now also… `marshal.go:992` | real | in-scope | yes | low | ✓ |
| 82 | PR body's "keeps that name" claim for unknown types only holds on the basic-type… `helpers.go:222` | real | in-scope | yes | nit | ✓ |
| 83 | Claim "no new blocking or cancellation paths" is a correctness confirmation, not a defect  | false-positive | out-of-scope | no | nit | ✓ |
| 84 | Claim "dimension bound prevents overflow" describes the fix working as intended, not a… `marshal.go:992` | false-positive | out-of-scope | no | nit | ✓ |
| 85 | Claim "nested vector into interface{} now errors instead of crashing" describes the… `marshal.go:1044` | false-positive | out-of-scope | no | nit | ✓ |
| 86 | Claim "error message names the unknown type" describes correct behavior for that one… `helpers.go:280` | false-positive | out-of-scope | no | nit | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 80.7% of it is cache reads, which bill at a tenth of
input; cache creation, another 16.3%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 2.9% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(45,582 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr2 | 3 | 86 | 73 | 12 | 1 | 73 | 1 | 3,747,390 | $6.23 | 10.0 min | - |

### Spend per run

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr2 | 1,256,835 tok / $2.06 / 3.2 min | 1,165,932 tok / $2.06 / 3.3 min | 1,324,623 tok / $2.11 / 3.6 min |

**The 3 scored reviews' recorded attempts cost 3,747,390 tokens, $6.23.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

What each run said before verification. Self-rejected claims are excluded, and the judge may merge several claims about one mechanism. The gap from *Raised* is not a miss count.

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr2 | 27 | 33 | 27 |

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
