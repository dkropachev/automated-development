# Review-tool bake-off: 1 review configurations, 3 real PRs

**Cohort:** `rafp-coverage-2026-10-04`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.287 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=rafp-coverage-2026-10-04`.
This complete cohort contains 3 hash-pinned review cells.
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

- Reviews: 3 calls, 34,968,504 tokens, $30.96, 48.7 minutes wall time.
- Extraction: 3 calls, 41 raw claims, $0.64.
- Judging: 3 calls, 41 merged issues (33 real, 7 false-positive, 1 unproven), $3.70.
- Total known cohort spend: $35.30. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct defect the tools found between them, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr |
|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |
| 1 | No test covers draining a frame queued just before _stream_closing is set `src/rpc/rpc.cc:562` | real | in-scope | yes | medium | ✓ |
| 2 | Regression test doesn't assert the refused send actually throws closed_error `tests/unit/rpc_test.cc:2016` | real | in-scope | yes | low | ✓ |
| 3 | New docs overstate that reading-until-throw always closes the source `doc/rpc-streaming.md:110` | real | in-scope | yes | low | ✓ |
| 4 | New docs overstate that the stream connection shuts down only once both halves close `doc/rpc-streaming.md:115` | real | in-scope | yes | low | ✓ |
| 5 | Test header comment states the pre-fix bug mechanism in present tense `tests/unit/rpc_test.cc:1854` | real | in-scope | yes | low | ✓ |
| 6 | put(std::span) test sink override lacks SEASTAR_API_LEVEL guard `tests/unit/rpc_test.cc:1883` | real | in-scope | yes | low | ✓ |
| 7 | New comment misdescribes when _outgoing_queue_ready becomes exceptional `src/rpc/rpc.cc:566` | real | in-scope | yes | nit | ✓ |
| 8 | Comment overstates that yield() itself runs the batch flush poller `tests/unit/rpc_test.cc:2021` | real | in-scope | yes | nit | ✓ |
| 9 | New compressor factory uses const_cast instead of file's mutable-member convention `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | nit | ✓ |
| 10 | Comment describing what still waits on _outgoing_queue_ready `src/rpc/rpc.cc:559` | false-positive | in-scope | yes | low | ✓ |
| 11 | _stream_closing alleged to duplicate state already tracked by _error `src/rpc/rpc.cc` | false-positive | in-scope | yes | low | ✓ |
| 12 | close_entered_cv wait in test has no timeout `tests/unit/rpc_test.cc:2011` | false-positive | in-scope | yes | low | ✓ |
| 13 | Claude Co-Authored-By trailers flagged as an issue  | false-positive | out-of-scope | no | nit | ✓ |
| | **quillstone (Rust)** | | | | |  |
| 14 | Persistent USE KEYSPACE failure drains pool and marks node permanently Down `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | medium | ✓ |
| 15 | Refill loop keeps reopening and discarding connections while USE keeps failing `scylla/src/network/connection_pool.rs:902` | real | in-scope | yes | low | ✓ |
| 16 | Stale failed USE attempt isn't re-checked against the current keyspace before being… `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | low | ✓ |
| 17 | Keyspace-setup failure now logs at debug! instead of the prior warn! `scylla/src/network/connection_pool.rs:903` | real | in-scope | yes | low | ✓ |
| 18 | PR description doesn't mention the metrics-accounting commits  | real | in-scope | yes | low | ✓ |
| 19 | Commit 0d91aa54 fails clippy on its own under default features `scylla/src/network/connection_pool.rs:1462` | real | in-scope | yes | low | ✓ |
| 20 | No test drives the full failed-USE-then-refill cycle via the real event loop `scylla/src/network/connection_pool.rs:1526` | real | in-scope | yes | low | ✓ |
| 21 | Reshard metrics test can't detect a dropped excess_connections term in the decrement `scylla/src/network/connection_pool.rs:1868` | real | in-scope | yes | low | ✓ |
| 22 | The !is_filling() guard on keyspace-failure pool reporting is untested `scylla/src/network/connection_pool.rs:908` | real | in-scope | yes | low | ✓ |
| 23 | Decrement-then-clear pattern is duplicated at each call site rather than centralized `scylla/src/network/connection_pool.rs:674` | real | in-scope | yes | low | ✓ |
| 24 | New ConnectionError::UseKeyspaceError text breaks the established wrapper wording… `scylla/src/errors.rs:602` | real | in-scope | yes | nit | ✓ |
| 25 | Moved comment still claims the connection will be put into conns, ignoring the failure… `scylla/src/network/connection_pool.rs:921` | real | in-scope | yes | nit | ✓ |
| 26 | New keyspace-failure tests skip the required setup_tracing() call `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | nit | ✓ |
| 27 | All four PR commit messages have empty bodies, omitting the required motivation  | real | in-scope | yes | nit | ✓ |
| 28 | Stated PR validation never runs under --features metrics or clippy  | real | in-scope | yes | nit | ✓ |
| 29 | Commit 617139df flagged as an unsquashed fixup commit  | false-positive | in-scope | yes | nit | ✓ |
| 30 | New unrequested_connection_event helper duplicates shard_aware_attempt_result `scylla/src/network/connection_pool.rs:1855` | real | in-scope | yes | nit | ✓ |
| 31 | Linked issue #1682 is inaccessible, so the fix can't be checked against the original…  | unproven | in-scope | no | nit | ✓ |
| | **tidepool (Go)** | | | | |  |
| 32 | vectorElemMinSize recursion is quadratic in vector nesting depth `marshal.go:1125` | real | in-scope | yes | low | ✓ |
| 33 | MaxInt32 saturation branch in dimension-bound math is untested `marshal.go:1136` | real | in-scope | yes | low | ✓ |
| 34 | Float fast-path length-mismatch check is no longer independently tested `marshal_vector_test.go:371` | real | in-scope | yes | low | ✓ |
| 35 | PR body claims every new test fails on pristine code; several already pass  | real | in-scope | yes | nit | ✓ |
| 36 | Bound's comment wrongly claims every path allocates `marshal.go:986` | real | in-scope | yes | nit | ✓ |
| 37 | Test comment misstates per-element byte size of nested text vector `marshal_vector_test.go:772` | real | in-scope | yes | nit | ✓ |
| 38 | Test comment's 'N bytes' rationale doesn't name the real per-type bound `marshal_vector_test.go:692` | real | in-scope | yes | nit | ✓ |
| 39 | makeVectorType duplicates makeFloat32VectorType/makeDoubleVectorType `marshal_vector_test.go:557` | real | in-scope | yes | nit | ✓ |
| 40 | Commit message not naming vectorElemMinSize is not a defect  | false-positive | in-scope | yes | nit | ✓ |
| 41 | AI attribution trailer claimed missing but is present in commit/PR body  | false-positive | in-scope | yes | nit | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 91.5% of it is cache reads, which bill at a tenth of
input; cache creation, another 6.9%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 1.6% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(213,214 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Only this tool | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr | 3 | 41 | 33 | 7 | 1 | 33 | 0 | 33 | 34,968,504 | $30.96 | 48.7 min | - |

### Spend per run

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr | 10,462,166 tok / $10.41 / 16.0 min | 14,283,793 tok / $11.00 / 17.6 min | 10,222,545 tok / $9.55 / 15.1 min |

**The 3 scored reviews' recorded attempts cost 34,968,504 tokens, $30.96.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

What each run said, before merging and verification - the gap between this and *Raised* above is
what the judge merged away as the same defect twice.

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr | 13 | 18 | 10 |

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
