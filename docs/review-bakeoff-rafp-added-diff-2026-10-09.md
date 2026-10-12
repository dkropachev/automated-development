# Review-tool bake-off: 1 review configuration, 3 real PRs

**Cohort:** `rafp-added-diff-2026-10-09`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.292 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=rafp-added-diff-2026-10-09`.
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

- Reviews: 3 calls, 9,631,122 tokens, $14.49, 46.3 minutes wall time.
- Extraction: 0 calls, 110 raw claims (42 confirmed, 68 suggestions), $0.00.
- Judging: 3 calls, 33 merged issues from 42 confirmed claims (32 real, 1 false-positive, 0 unproven), $3.69.
- Total known cohort spend: $18.19. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr |
|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |
| 1 | Doc claims reading source to an exception always closes it; one path doesn't `doc/rpc-streaming.md:110` | real | in-scope | yes | low | ✓ |
| 2 | Doc/commit overstate that the stream connection only shuts down once both halves close `doc/rpc-streaming.md:115` | real | in-scope | yes | low | ✓ |
| 3 | stream_close() comment wrongly claims only the trailing stop() sets _error `src/rpc/rpc.cc:552` | real | in-scope | yes | low | ✓ |
| 4 | Regression test can hang: untimed cv wait and release only reached on success path `tests/unit/rpc_test.cc:2011` | real | in-scope | yes | low | ✓ |
| 5 | New regression test never exercises the outgoing-queue-drain half of the fix `tests/unit/rpc_test.cc:2013` | real | in-scope | yes | medium | ✓ |
| 6 | Test doesn't assert the stated closed_error contract, only the absence of a late write `tests/unit/rpc_test.cc:2016` | real | in-scope | yes | low | ✓ |
| 7 | PR's commits are missing the Signed-off-by trailer the contributing guide requires `doc/contributing.md:6` | real | in-scope | yes | nit | ✓ |
| 8 | stream_close() now waits unboundedly for the whole outgoing queue to drain `src/rpc/rpc.cc:565` | real | in-scope | yes | medium | ✓ |
| 9 | Test data_sink wrapper's put() override isn't API-level guarded like the base it copies `tests/unit/rpc_test.cc:1883` | real | in-scope | yes | medium | ✓ |
| | **quillstone (Rust)** | | | | |  |
| 10 | Claim that a bad keyspace permanently stops the pool from refilling is incorrect `scylla/src/network/connection_pool.rs:900` | false-positive | in-scope | no | low | ✓ |
| 11 | PoolRefiller drop never decrements total_connections for remaining conns `scylla/src/network/connection_pool.rs:498` | real | out-of-scope | no | low | ✓ |
| 12 | New keyspace test awaits ready_connections.next() with no timeout `scylla/src/network/connection_pool.rs:1634` | real | in-scope | yes | low | ✓ |
| 13 | keyspace_setup_failure_triggers_refill never proves a refill is scheduled `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low | ✓ |
| 14 | All four commits are title-only, violating CONTRIBUTING.md's commit-message rule `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | low | ✓ |
| 15 | New keyspace tests skip the repo's setup_tracing() convention `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | nit | ✓ |
| 16 | Comment claiming the connection will 'travel through this logic again' is now false `scylla/src/network/connection_pool.rs:920` | real | in-scope | yes | nit | ✓ |
| 17 | Shard-aware excess retry path drops a counted connection without decrementing metrics `scylla/src/network/connection_pool.rs:994` | real | out-of-scope | no | low | ✓ |
| 18 | PR's stated validation command excludes metrics feature, skipping metric assertions `scylla/src/network/connection_pool.rs:1521` | real | in-scope | yes | low | ✓ |
| 19 | PR description omits the metric-balancing change and its tests `scylla/src/network/connection_pool.rs:1114` | real | in-scope | yes | nit | ✓ |
| 20 | New UseKeyspaceError variant sits oddly against ConnectionError's doc comment `scylla/src/errors.rs:602` | real | in-scope | yes | low | ✓ |
| 21 | Reordering the keyspace check now also gates topology learning, still with no timeout `scylla/src/network/connection_pool.rs:913` | real | in-scope | yes | medium | ✓ |
| 22 | Keyspace-failure handler doesn't check if the failed USE is for a stale keyspace `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | medium | ✓ |
| | **tidepool (Go)** | | | | |  |
| 23 | Zero-dim VectorType with nil SubType still panics when unmarshaled into *any `marshal.go:1033` | real | in-scope | no | high | ✓ |
| 24 | getCassandraLongType's custom-name change silently alters TypeInfo for all unrecognized… `helpers.go:280` | real | in-scope | yes | medium | ✓ |
| 25 | PR body's 'every new test fails against pristine marshal.go/helpers.go' claim is false `marshal_vector_test.go:937` | real | in-scope | yes | low | ✓ |
| 26 | 32-bit wrap-test comment is false: the unit-tagged test package cannot compile on 32-bit `marshal_vector_test.go:585` | real | in-scope | yes | low | ✓ |
| 27 | vectorElemMinSize's int32-overflow saturation branch has no test `marshal.go:1137` | real | in-scope | yes | low | ✓ |
| 28 | No regression test for a zero-length non-NULL payload with Dimensions > 0 `marshal.go:998` | real | in-scope | yes | low | ✓ |
| 29 | New comment overstates that every path below unmarshalVector allocates `marshal.go:986` | real | in-scope | yes | nit | ✓ |
| 30 | Commit messages don't follow CONTRIBUTING.md's required format `CONTRIBUTING.md:28` | real | in-scope | yes | nit | ✓ |
| 31 | Behaviour changes ship without CHANGELOG/godoc documentation CONTRIBUTING.md requires `helpers.go:280` | real | in-scope | yes | low | ✓ |
| 32 | 'Payload with a trailing byte' test mislabels a malformed payload as well-formed `marshal_vector_test.go:724` | real | in-scope | yes | nit | ✓ |
| 33 | Allocation-regression test uses process-wide TotalAlloc, vulnerable to… `marshal_vector_test.go:836` | real | in-scope | yes | nit | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 87.3% of it is cache reads, which bill at a tenth of
input; cache creation, another 10.0%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 2.7% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(96,411 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr | 3 | 33 | 32 | 1 | 0 | 30 | 3 | 9,631,122 | $14.49 | 46.3 min | - |

### Spend per run

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr | 2,514,407 tok / $4.79 / 12.0 min | 3,360,210 tok / $4.67 / 12.6 min | 3,756,505 tok / $5.03 / 21.6 min |

**The 3 scored reviews' recorded attempts cost 9,631,122 tokens, $14.49.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

Extracted claims include 68 suggestions. They remain visible for reviewer judgment but do not enter cohort judging. The 42 confirmed claims were merged and verified into 33 issues.

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr | 31 (9 confirmed, 22 suggestions) | 36 (15 confirmed, 21 suggestions) | 43 (18 confirmed, 25 suggestions) |

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
