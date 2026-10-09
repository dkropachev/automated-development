# Review-tool bake-off: 1 review configuration, 1 real PR

**Cohort:** `rafp-six-pass-sonnet-2026-10-08`. **Requested model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`). Claude Code: `2.1.292 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=rafp-six-pass-sonnet-2026-10-08`.
This complete cohort contains 1 hash-pinned review cells.
Every run used its own headless `claude -p` process and
working directory so its token spend is attributable.

## What was reviewed

| Target | Language | Diff | Commits | PR under review | Upstream original |
|---|---|---:|---:|---|---|
| `ironweave` | C++ | 15,931 B | 3 commits | https://github.com/dkropachev/ironweave/pull/1 | https://github.com/scylladb/seastar/pull/3664 |

Each PR was replayed in its own fork with its commits under a neutral author. The preparer rewrote
repository references in review material and denied `WebSearch`/`WebFetch`. The benchmark freezes
the review inputs because access to upstream comments would bias discovery.

## Cohort accounting

- Reviews: 1 calls, 1,461,095 tokens, $1.80, 9.9 minutes wall time.
- Extraction: 0 calls, 34 raw claims (13 confirmed, 21 suggestions), $0.00.
- Judging: 1 calls, 8 merged issues from 13 confirmed claims (8 real, 0 false-positive, 0 unproven), $0.91.
- Total known cohort spend: $2.70. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr |
|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |
| 1 | Late-send test relies on silent catch, never asserts the send was actually refused `tests/unit/rpc_test.cc:2012` | real | in-scope | yes | low | ✓ |
| 2 | New regression test can deadlock on an early assertion failure instead of failing cleanly `tests/unit/rpc_test.cc:2011` | real | in-scope | yes | medium | ✓ |
| 3 | stream_close() comment overstates that nothing else waits on _outgoing_queue_ready `src/rpc/rpc.cc:558` | real | in-scope | yes | low | ✓ |
| 4 | No test exercises the queue-drain half of the fix (entry queued before _stream_closing) `tests/unit/rpc_test.cc:1989` | real | in-scope | yes | medium | ✓ |
| 5 | Commits carry Claude Co-Authored-By trailers, violating the user's no-attribution rule `src/rpc/rpc.cc:548` | real | in-scope | yes | nit | ✓ |
| 6 | Test header comment wrongly claims the compressor hook is the only unguarded send() caller `tests/unit/rpc_test.cc:1854` | real | in-scope | yes | low | ✓ |
| 7 | Doc's 'shut down only once both halves closed' ignores the client-abort path that skips… `doc/rpc-streaming.md:115` | real | in-scope | yes | low | ✓ |
| 8 | PR's commits lack the DCO Signed-off-by trailer required by the contributing guide `doc/contributing.md:10` | real | in-scope | yes | low | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 77.9% of it is cache reads, which bill at a tenth of
input; cache creation, another 18.9%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 3.2% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(8,542 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr | 1 | 8 | 8 | 0 | 0 | 8 | 0 | 1,461,095 | $1.80 | 9.9 min | - |

### Spend per run

| Tool | ironweave |
|---|---:|
| Automated Development review-and-fix-pr | 1,461,095 tok / $1.80 / 9.9 min |

**The 1 scored reviews' recorded attempts cost 1,461,095 tokens, $1.80.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

Extracted claims include 21 suggestions. They remain visible for reviewer judgment but do not enter cohort judging. The 13 confirmed claims were merged and verified into 8 issues.

| Tool | ironweave |
|---|---:|
| Automated Development review-and-fix-pr | 34 (13 confirmed, 21 suggestions) |

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

### Runs that did not complete

None - every run in the matrix returned a report.

## Analysis

No hand-written analysis is attached to this cohort. `bench/analysis.md` describes only the immutable `legacy` results.
