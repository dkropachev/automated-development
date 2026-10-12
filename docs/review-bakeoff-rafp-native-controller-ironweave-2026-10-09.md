# Review-tool bake-off: 1 review configuration, 1 real PR

**Cohort:** `rafp-native-controller-ironweave-2026-10-09`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.292 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=rafp-native-controller-ironweave-2026-10-09`.
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

- Reviews: 1 calls, 11,713,104 tokens, $10.01, 12.4 minutes wall time.
- Extraction: 1 calls, 20 raw claims, $0.28.
- Judging: 1 calls, 20 merged issues (13 real, 6 false-positive, 1 unproven), $3.56.
- Total known cohort spend: $13.85. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr |
|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |
| 1 | New regression test never exercises the _outgoing_queue_ready drain path `tests/unit/rpc_test.cc:1965` | real | in-scope | yes | low | ✓ |
| 2 | Claimed risk that base-case test aborts instead of cleanly failing `tests/unit/rpc_test.cc:2014` | false-positive | in-scope | yes | low | ✓ |
| 3 | Claimed non-determinism of the test's forced race window `tests/unit/rpc_test.cc:1965` | false-positive | in-scope | yes | low | ✓ |
| 4 | Docs: reading a source until it throws is not always enough to close it `doc/rpc-streaming.md:110` | real | in-scope | yes | medium | ✓ |
| 5 | Docs overstate that the connection only shuts down once both halves close `doc/rpc-streaming.md:115` | real | in-scope | yes | low | ✓ |
| 6 | Comment misattributes cause of an exceptional _outgoing_queue_ready `src/rpc/rpc.cc:566` | real | in-scope | yes | low | ✓ |
| 7 | Comment overstates that nothing else waits on _outgoing_queue_ready `src/rpc/rpc.cc:557` | real | in-scope | yes | low | ✓ |
| 8 | Comment overclaims only the trailing stop() can set _error during stream_close() `src/rpc/rpc.cc:551` | real | in-scope | yes | low | ✓ |
| 9 | Test's put(std::span) override lacks the SEASTAR_API_LEVEL guard, breaks API 7/8 builds `tests/unit/rpc_test.cc:1883` | real | in-scope | yes | low | ✓ |
| 10 | close_entered_cv.wait() has no timeout, a stuck regression hangs the test `tests/unit/rpc_test.cc:2011` | real | in-scope | yes | low | ✓ |
| 11 | An early assertion failure in the new test would abort rather than report cleanly `tests/unit/rpc_test.cc:1998` | real | in-scope | yes | low | ✓ |
| 12 | const_cast used instead of a mutable member, inconsistent with existing file style `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | low | ✓ |
| 13 | New test's put(std::span) dependency limits clean backport to pre-2025-10 branches `tests/unit/rpc_test.cc:1883` | real | out-of-scope | no | nit | ✓ |
| 14 | PR commits lack a DCO Signed-off-by trailer  | real | out-of-scope | no | nit | ✓ |
| 15 | Commits carry Claude/Anthropic co-author trailers  | real | out-of-scope | no | nit | ✓ |
| 16 | Fixes/Refs issue numbers may resolve against the wrong repo  | unproven | in-scope | yes | low | ✓ |
| 17 | Self-rejected: _stream_closing claimed as a hazard with enqueue_zero_frame `src/rpc/rpc.cc:307` | false-positive | in-scope | yes | low | ✓ |
| 18 | Self-rejected: size/complexity of the test's socket wrapper classes `tests/unit/rpc_test.cc:1875` | false-positive | in-scope | yes | low | ✓ |
| 19 | Self-rejected: parent-client connection claimed to share the same send race window `src/rpc/rpc.cc:198` | false-positive | out-of-scope | no | low | ✓ |
| 20 | Self-rejected: claimed use-after-free on test_sink_state st `tests/unit/rpc_test.cc:1868` | false-positive | in-scope | yes | low | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 91.5% of it is cache reads, which bill at a tenth of
input; cache creation, another 7.0%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 1.5% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(96,160 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr | 1 | 20 | 13 | 6 | 1 | 10 | 3 | 11,713,104 | $10.01 | 12.4 min | - |

### Spend per run

| Tool | ironweave |
|---|---:|
| Automated Development review-and-fix-pr | 11,713,104 tok / $10.01 / 12.4 min |

**The 1 scored reviews' recorded attempts cost 11,713,104 tokens, $10.01.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

What each run said before verification. Self-rejected claims are excluded, and the judge may merge several claims about one mechanism. The gap from *Raised* is not a miss count.

| Tool | ironweave |
|---|---:|
| Automated Development review-and-fix-pr | 20 |

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
