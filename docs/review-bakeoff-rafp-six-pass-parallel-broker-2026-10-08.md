# Review-tool bake-off: 1 review configuration, 3 real PRs

**Cohort:** `rafp-six-pass-parallel-broker-2026-10-08`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.292 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr` is experimental and self-authored. Its confirmed claims are mapped in the sealed model-comparison-2026-10-08 gold snapshot; suggestions are excluded from confirmed credit. The cohort-local judgements below remain separate.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=rafp-six-pass-parallel-broker-2026-10-08`.
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

- Reviews: 3 calls, 12,695,932 tokens, $16.42, 45.6 minutes wall time.
- Extraction: 0 calls, 121 raw claims (47 confirmed, 74 suggestions), $0.00.
- Judging: 3 calls, 36 merged issues from 47 confirmed claims (32 real, 4 false-positive, 0 unproven), $4.50.
- Total known cohort spend: $20.92. Discarded attempts are not included in immutable stage artifacts.

## Compare with other models on canonical gold

All rows use the same 3 pinned PRs and 113 reviewed real gold issues. The older model rows use 17 matched tool cells; the indented review-and-fix-pr line uses 3 cells under the same Opus 5.5 model. It is a protocol detail, not another model in the ranking. Tool sets differ, and suggestions are excluded from confirmed gold credit.

| Model / protocol | Evidence | Gold issues found | Claude tokens | Claude review cost | Summed review time |
|---|---|---:|---:|---:|---:|
| Claude Opus 5 | 17 matched tool cells | 75 / 113 | 153,643,618 | $160.60 | 242.5 min |
| Claude Fable 5.1 | 17 matched tool cells | 61 / 113 | 53,834,538 | $91.59 | 125.4 min |
| Claude Opus 5.5 | 17 matched tool cells | 42 / 113 | 24,688,795 | $19.30 | 58.8 min |
| ↳ review-and-fix-pr (same Claude Opus 5.5) | 3 review-and-fix-pr cells | 35 / 113 | 12,695,932 | $16.42 | 45.6 min |

This cohort additionally used 498,302 Codex tokens for adjudication; its receipts do not provide a USD cost. The 74 suggestions remain visible in the structured review receipts and are not counted above.
Canonical gold credits 35 real issues from this cohort; the cohort-local judge reports 32. These are separate adjudications over the same pinned PRs.
The sealed comparison is [model-comparison-2026-10-08](./index.html#choose?tab=models&scope=supplemental-rafp-six-pass-parallel-broker-2026-10-08); the earlier [matched-model scope](./index.html#choose?tab=models&scope=all-models) remains separately available.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr |
|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |
| 1 | New stream-close test doesn't assert the hook actually throws closed_error `tests/unit/rpc_test.cc:2016` | real | in-scope | yes | medium | ✓ |
| 2 | New test can hang forever on any unexpected exception or unbounded wait `tests/unit/rpc_test.cc:2011` | real | in-scope | yes | medium | ✓ |
| 3 | New doc overstates that the stream connection only shuts down once both halves close `doc/rpc-streaming.md:115` | real | in-scope | yes | low | ✓ |
| 4 | stream_close() comment wrongly claims nothing else waits on _outgoing_queue_ready `src/rpc/rpc.cc:559` | real | in-scope | yes | low | ✓ |
| 5 | New test's header comment describes the pre-fix bug in present tense `tests/unit/rpc_test.cc:1852` | real | in-scope | yes | nit | ✓ |
| 6 | No test exercises the queue-drain half of the fix (entry queued before _stream_closing) `tests/unit/rpc_test.cc:2017` | real | in-scope | yes | medium | ✓ |
| 7 | New source doc claims any read exception closes the source; deserialization errors don't `doc/rpc-streaming.md:110` | real | in-scope | yes | medium | ✓ |
| 8 | New comment wrongly says _outgoing_queue_ready is exceptional 'if an entry failed' `src/rpc/rpc.cc:566` | real | in-scope | yes | nit | ✓ |
| 9 | New comment wrongly says _error is only set by the stop() that follows `src/rpc/rpc.cc:552` | real | in-scope | yes | low | ✓ |
| 10 | stream_close()'s new queue-drain wait can block indefinitely under peer backpressure `src/rpc/rpc.cc:562` | real | in-scope | yes | medium | ✓ |
| 11 | Compressor factory doc doesn't mention send_empty_frame can now fail with closed_error… `include/seastar/rpc/rpc_types.hh:318` | real | in-scope | yes | nit | ✓ |
| 12 | PR's stated validation doesn't meet contributing.md's test.py requirement `doc/contributing.md:25` | real | in-scope | yes | low | ✓ |
| | **quillstone (Rust)** | | | | |  |
| 13 | Keyspace-set failures now discard the connection instead of keeping it silently wrong `scylla/src/network/connection_pool.rs:900` | false-positive | in-scope | yes | medium | ✓ |
| 14 | Keyspace-failure handler doesn't check the failure is still for the current keyspace `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | low | ✓ |
| 15 | Excess shard-aware connection dropped on fallback retry without dec_total_connections `scylla/src/network/connection_pool.rs:1006` | real | out-of-scope | no | low | ✓ |
| 16 | Stale ready_connections/keyspace comments no longer match the new failure path `scylla/src/network/connection_pool.rs:531` | real | in-scope | yes | nit | ✓ |
| 17 | start_setting_keyspace_for_connection's doc comment no longer reflects that it can now… `scylla/src/network/connection_pool.rs:1329` | real | in-scope | yes | nit | ✓ |
| 18 | New keyspace tests skip the required setup_tracing() call `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | nit | ✓ |
| 19 | keyspace_setup_failure_preserves_pool_state finishes the proxy before dropping the… `scylla/src/network/connection_pool.rs:1689` | real | in-scope | yes | nit | ✓ |
| 20 | Unconditional `futures::FutureExt` import is not actually unused without the metrics… `scylla/src/network/connection_pool.rs:1462` | false-positive | in-scope | yes | nit | ✓ |
| 21 | PR's stated validation command never runs the metrics-gated tests or enables the metrics… `scylla/src/network/connection_pool.rs:1521` | real | in-scope | yes | low | ✓ |
| 22 | PR description omits the three metrics-balancing commits it also contains `scylla/src/network/connection_pool.rs:1114` | real | in-scope | yes | nit | ✓ |
| | **tidepool (Go)** | | | | |  |
| 23 | Nested-vector "no Go type" error blames the wrong cause `marshal.go:1048` | real | out-of-scope | yes | medium | ✓ |
| 24 | VectorType has no String(), so vector errors render uninformatively `marshal.go:1048` | real | in-scope | yes | low | ✓ |
| 25 | Function comment overclaims that every unmarshalVector path allocates `marshal.go:986` | real | in-scope | yes | low | ✓ |
| 26 | Commit messages don't match CONTRIBUTING.md's documented format `CONTRIBUTING.md:30` | false-positive | out-of-scope | no | nit | ✓ |
| 27 | No CHANGELOG/godoc entry for the new vector Scan error behavior `marshal.go:992` | false-positive | out-of-scope | no | low | ✓ |
| 28 | vectorElemMinSize floors a 0-dim fixed-type nested vector at 1, not 0 `marshal.go:1140` | real | in-scope | yes | medium | ✓ |
| 29 | 32-bit-targeting test comment is moot: package can't build for GOARCH=386 `marshal_vector_test.go:584` | real | in-scope | yes | low | ✓ |
| 30 | PR description overclaims every new test fails against pristine code `marshal_vector_test.go:701` | real | in-scope | yes | low | ✓ |
| 31 | Negative-dimension check runs before NULL check, splitting *[]T vs **[]T `marshal.go:992` | real | in-scope | yes | low | ✓ |
| 32 | getCassandraLongType's custom-name change isn't scoped to vectors only `helpers.go:280` | real | in-scope | yes | low | ✓ |
| 33 | vectorElemMinSize panics recursing into a nested vector's nil SubType `marshal.go:1135` | real | in-scope | yes | medium | ✓ |
| 34 | Stale fast-path comment no longer matches code reachable after new bound `marshal.go:1006` | real | in-scope | yes | nit | ✓ |
| 35 | Zero-dim vector with nil SubType still panics scanning into *any `marshal.go:1044` | real | in-scope | no | high | ✓ |
| 36 | Commits and PR body carry Claude/Anthropic attribution trailers `marshal.go:986` | real | in-scope | yes | nit | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 89.8% of it is cache reads, which bill at a tenth of
input; cache creation, another 7.8%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 2.5% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(113,650 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr | 3 | 36 | 32 | 4 | 0 | 30 | 2 | 12,695,932 | $16.42 | 45.6 min | - |

### Spend per run

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr | 3,530,403 tok / $5.35 / 17.8 min | 4,474,105 tok / $5.67 / 12.6 min | 4,691,424 tok / $5.39 / 15.3 min |

**The 3 scored reviews' recorded attempts cost 12,695,932 tokens, $16.42.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

Extracted claims include 74 suggestions. They remain visible for reviewer judgment but do not enter cohort judging. The 47 confirmed claims were merged and verified into 36 issues.

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Automated Development review-and-fix-pr | 53 (19 confirmed, 34 suggestions) | 33 (10 confirmed, 23 suggestions) | 35 (18 confirmed, 17 suggestions) |

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
