# Review-tool bake-off: 1 review configuration, 3 real PRs

**Cohort:** `rafp-six-pass-batched-2026-10-08`. **Skill platform:** Claude. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.292 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=rafp-six-pass-batched-2026-10-08`.
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

- Reviews: 3 calls, 14,549,023 tokens, $18.07, 40.8 minutes wall time.
- Extraction: 0 calls, 113 raw claims (42 confirmed, 71 suggestions), $0.00.
- Judging: 3 calls, 35 merged issues from 42 confirmed claims (33 real, 2 false-positive, 0 unproven), $4.75.
- Total known cohort spend: $22.82. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr |
|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |
| 1 | Claim that the test's loopback sink can't batch flushes is factually wrong `tests/unit/rpc_test.cc:1847` | false-positive | in-scope | yes | low | ✓ |
| 2 | Claim that test comments describe a batch-flush path that never happens is wrong `tests/unit/rpc_test.cc:2021` | false-positive | in-scope | yes | low | ✓ |
| 3 | Test doesn't assert send_empty_frame hook was refused; relies only on a side effect `tests/unit/rpc_test.cc:2016` | real | in-scope | yes | low | ✓ |
| 4 | No test covers stream_close() draining pre-existing queued entries `src/rpc/rpc.cc:562` | real | in-scope | yes | medium | ✓ |
| 5 | Doc overstates that any exception while reading a source closes it `doc/rpc-streaming.md:111` | real | in-scope | yes | medium | ✓ |
| 6 | Doc claim that a stream connection shuts down 'only once both halves are closed' is… `doc/rpc-streaming.md:115` | real | in-scope | yes | low | ✓ |
| 7 | stream_close() comment wrongly claims nothing else waits for _outgoing_queue_ready `src/rpc/rpc.cc:559` | real | in-scope | yes | nit | ✓ |
| 8 | test_data_sink_impl::put override is not guarded by SEASTAR_API_LEVEL, unlike the repo's… `tests/unit/rpc_test.cc:1883` | real | in-scope | yes | medium | ✓ |
| 9 | stream_close() comment wrongly implies failed sends make _outgoing_queue_ready exceptional `src/rpc/rpc.cc:566` | real | in-scope | yes | low | ✓ |
| 10 | Commits and PR description carry forbidden Claude/Anthropic attribution `src/rpc/rpc.cc:551` | real | in-scope | yes | low | ✓ |
| 11 | stream_close() comment wrongly claims _error is only set by the stop() that follows `src/rpc/rpc.cc:552` | real | in-scope | yes | low | ✓ |
| | **quillstone (Rust)** | | | | |  |
| 12 | Rejected shard-aware excess connection dropped without decrementing total_connections `scylla/src/network/connection_pool.rs:1006` | real | out-of-scope | no | low | ✓ |
| 13 | Pool worker teardown drops all connections without decrementing total_connections `scylla/src/network/connection_pool.rs:696` | real | out-of-scope | no | low | ✓ |
| 14 | Per-connection USE keyspace future has no timeout; reordering now gates resharding on it `scylla/src/network/connection_pool.rs:1330` | real | in-scope | yes | medium | ✓ |
| 15 | keyspace_setup_failure_triggers_refill feeds an impossible event and never checks a… `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low | ✓ |
| 16 | keyspace_setup_failure_preserves_pool_state awaits ready_connections with no timeout `scylla/src/network/connection_pool.rs:1634` | real | in-scope | yes | low | ✓ |
| 17 | New keyspace tests omit the setup_tracing() call other new tests in this PR use `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | nit | ✓ |
| 18 | All four PR commits have subject-only messages with no explanatory body `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | nit | ✓ |
| 19 | PR description covers only the keyspace-setup commit, omits the metrics-balancing work `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | nit | ✓ |
| 20 | Inconsistent proxy-shutdown assertions across the PR's new tests `scylla/src/network/connection_pool.rs:1689` | real | in-scope | yes | nit | ✓ |
| 21 | Keyspace setup failure on an empty pool is reported as lost host connectivity `scylla/src/network/connection_pool.rs:908` | real | in-scope | yes | medium | ✓ |
| 22 | Broken connection during USE is misclassified as a keyspace setup failure `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | low | ✓ |
| | **tidepool (Go)** | | | | |  |
| 23 | vectorElemMinSize floors a zero-dim nested vector at 1 byte, rejecting valid payloads `marshal.go:1141` | real | in-scope | yes | low | ✓ |
| 24 | unmarshalVector head comment wrongly says every path allocates `marshal.go:986` | real | in-scope | yes | nit | ✓ |
| 25 | Fast-path comment is stale: new bound intercepts non-nil empty payloads first `marshal.go:1006` | real | in-scope | yes | nit | ✓ |
| 26 | Commit messages don't follow CONTRIBUTING.md's subject/trailer format `CONTRIBUTING.md:28` | real | out-of-scope | no | nit | ✓ |
| 27 | No CHANGELOG.md entry for two bugfixes, though CONTRIBUTING.md requires one `CONTRIBUTING.md:24` | real | out-of-scope | no | nit | ✓ |
| 28 | Test doc's "on or above the boundary" claim doesn't fit the null-value subtest `marshal_vector_test.go:691` | real | in-scope | yes | nit | ✓ |
| 29 | Test comment wrongly claims the wrap case also lands on a 32-bit target `marshal_vector_test.go:585` | real | in-scope | yes | nit | ✓ |
| 30 | PR claim "every new test fails against pristine marshal.go" overstates it `marshal_vector_test.go:695` | real | in-scope | yes | nit | ✓ |
| 31 | Commit message's "one byte per element" claim misdescribes the per-type bound `marshal.go:999` | real | in-scope | yes | nit | ✓ |
| 32 | Nested-vector "no Go type" error drops the inner element type and dimensions `marshal.go:1048` | real | in-scope | yes | low | ✓ |
| 33 | Commits and PR body carry forbidden Claude/Anthropic attribution `marshal.go:985` | real | in-scope | yes | nit | ✓ |
| 34 | PR body omits the new NULL-with-negative-dimensions behavior change `marshal.go:993` | real | in-scope | yes | nit | ✓ |
| 35 | Nested vector with nonpositive inner dimension defeats the new allocation bound `marshal.go:1141` | real | in-scope | yes | high | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 90.2% of it is cache reads, which bill at a tenth of
input; cache creation, another 7.4%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 2.3% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(124,058 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr · Claude | 3 | 35 | 33 | 2 | 0 | 29 | 4 | 14,549,023 | $18.07 | 40.8 min | - |

### Spend per run

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr · Claude | 4,374,623 tok / $5.63 / 11.4 min | 4,611,957 tok / $6.26 / 14.8 min | 5,562,443 tok / $6.18 / 14.6 min |

**The 3 scored reviews' recorded attempts cost 14,549,023 tokens, $18.07.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

Extracted claims include 71 suggestions. They remain visible for reviewer judgment but do not enter cohort judging. The 42 confirmed claims were merged and verified into 35 issues.

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr · Claude | 39 (14 confirmed, 25 suggestions) | 40 (15 confirmed, 25 suggestions) | 34 (13 confirmed, 21 suggestions) |

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
