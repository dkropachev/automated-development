# Review-tool bake-off: 1 review configuration, 1 real PR

**Cohort:** `rafp-frozen-patch-tokens-ironweave-2026-10-08`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.292 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=rafp-frozen-patch-tokens-ironweave-2026-10-08`.
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

- Reviews: 1 calls, 2,359,207 tokens, $4.70, 10.2 minutes wall time.
- Extraction: 0 calls, 29 raw claims (8 confirmed, 21 suggestions), $0.00.
- Judging: 1 calls, 8 merged issues from 8 confirmed claims (8 real, 0 false-positive, 0 unproven), $0.78.
- Total known cohort spend: $5.48. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr |
|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |
| 1 | Doc claims stream connection closes "only once both halves are closed", contradicted… `doc/rpc-streaming.md:115` | real | in-scope | yes | low | ✓ |
| 2 | stream_close() comment wrongly claims _error is only set by the trailing stop() `src/rpc/rpc.cc:553` | real | in-scope | yes | low | ✓ |
| 3 | New regression test never asserts the refused send actually throws closed_error `tests/unit/rpc_test.cc:2018` | real | in-scope | yes | low | ✓ |
| 4 | New test doesn't exercise stream_close()'s wait on the drained outgoing queue `src/rpc/rpc.cc:562` | real | in-scope | yes | medium | ✓ |
| 5 | New test's cleanup is not exception-safe on early assertion failure `tests/unit/rpc_test.cc:2000` | real | in-scope | yes | low | ✓ |
| 6 | test_data_sink_impl omits the pre-level-9 put() overload, breaking Seastar_API_LEVEL=7… `tests/unit/rpc_test.cc:1883` | real | in-scope | yes | medium | ✓ |
| 7 | Doc wrongly says a source is closed by reading until it "throws", not true for… `doc/rpc-streaming.md:111` | real | in-scope | yes | medium | ✓ |
| 8 | stream_close() now blocks on the outgoing queue with no timeout, risking an indefinite… `src/rpc/rpc.cc:562` | real | in-scope | yes | high | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 81.9% of it is cache reads, which bill at a tenth of
input; cache creation, another 14.9%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 3.2% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(25,434 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr | 1 | 8 | 8 | 0 | 0 | 8 | 0 | 2,359,207 | $4.70 | 10.2 min | - |

### Spend per run

| Tool | ironweave |
|---|---:|
| Automated Development review-and-fix-pr | 2,359,207 tok / $4.70 / 10.2 min |

**The 1 scored reviews' recorded attempts cost 2,359,207 tokens, $4.70.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

Extracted claims include 21 suggestions. They remain visible for reviewer judgment but do not enter cohort judging. The 8 confirmed claims were merged and verified into 8 issues.

| Tool | ironweave |
|---|---:|
| Automated Development review-and-fix-pr | 29 (8 confirmed, 21 suggestions) |

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
