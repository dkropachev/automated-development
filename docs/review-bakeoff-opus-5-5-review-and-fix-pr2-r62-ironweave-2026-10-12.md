# Review-tool bake-off: 1 review configuration, 1 real PR

**Cohort:** `opus-5-5-review-and-fix-pr2-r62-ironweave-2026-10-12`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.296 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr2` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=opus-5-5-review-and-fix-pr2-r62-ironweave-2026-10-12`.
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

- Reviews: 1 calls, 1,348,399 tokens, $2.53, 4.1 minutes wall time.
- Extraction: 1 calls, 35 raw claims, $0.30.
- Judging: 1 calls, 35 merged issues (20 real, 14 false-positive, 1 unproven), $4.86.
- Total known cohort spend: $7.69. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr2 |
|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |
| 1 | Empty catch(closed_error) means detection relies only on put_after_close flag `tests/unit/rpc_test.cc:2016` | real | in-scope | yes | medium | ✓ |
| 2 | New regression test's waits (condition_variable, two futures) have no deadline `tests/unit/rpc_test.cc:2000` | real | in-scope | yes | medium | ✓ |
| 3 | Failed BOOST_REQUIRE_EQUAL aborts the whole process via sink_impl's destructor assert `tests/unit/rpc_test.cc:2000` | real | in-scope | yes | medium | ✓ |
| 4 | A hook throwing a non-closed_error exception may leave the test parked with no deadline `tests/unit/rpc_test.cc:2016` | unproven | in-scope | yes | low | ✓ |
| 5 | New stream_close() queue-drain branches (pending entry, exceptional drain, mid-entry… `src/rpc/rpc.cc:562` | real | in-scope | yes | medium | ✓ |
| 6 | New comment misstates when _outgoing_queue_ready becomes exceptional `src/rpc/rpc.cc:566` | real | in-scope | yes | low | ✓ |
| 7 | Sink-only stream (no source ever built) still trivially satisfies the doc's 'both… `doc/rpc-streaming.md:115` | false-positive | in-scope | yes | nit | ✓ |
| 8 | Source-only stream (no sink ever built) still trivially satisfies the doc's 'both… `doc/rpc-streaming.md:115` | false-positive | in-scope | yes | nit | ✓ |
| 9 | No guard against a second make_sink() call lets an unclosed sink silently bypass the 'is… `doc/rpc-streaming.md:108` | real | in-scope | yes | low | ✓ |
| 10 | Peer EOF/error tears the socket down without the app closing both halves, contradicting… `doc/rpc-streaming.md:115` | real | in-scope | yes | low | ✓ |
| 11 | Test's 'pass-through' compressor actually compresses via lz4 `tests/unit/rpc_test.cc:1937` | real | in-scope | yes | nit | ✓ |
| 12 | server_factory.hooks is collected but never invoked or asserted, leaving the server-side… `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | low | ✓ |
| 13 | const_cast push_back on hook_capturing_compressor_factory::hooks races across shards… `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | medium | ✓ |
| 14 | 10-iteration yield() loop looks redundant next to the latched close_entered flag `tests/unit/rpc_test.cc:2022` | false-positive | in-scope | yes | nit | ✓ |
| 15 | Commits and PR body carry Claude attribution, violating the user's own CLAUDE.md policy  | real | in-scope | yes | low | ✓ |
| 16 | None of the three commits carry a DCO sign-off required by CONTRIBUTING `doc/contributing.md:10` | real | in-scope | yes | low | ✓ |
| 17 | PR body's 'Fixes'/'Refs' issue numbers don't resolve in this repo, and it links internal…  | real | in-scope | yes | low | ✓ |
| 18 | Fix commit ships without its regression test in a separate commit  | false-positive | in-scope | yes | nit | ✓ |
| 19 | #closing-a-stream anchor breaks under Doxygen, which is this doc file's actual renderer `doc/rpc-streaming.md:51` | real | in-scope | yes | low | ✓ |
| 20 | New sentence makes an already very long pre-existing line longer `doc/rpc-streaming.md:51` | false-positive | out-of-scope | no | nit | ✓ |
| 21 | _stream_closing is only consulted in send(), not via a shared can_send() predicate `include/seastar/rpc/rpc.hh:307` | false-positive | in-scope | yes | nit | ✓ |
| 22 | Synchronous ordering of the three new stream_close() statements is undocumented `src/rpc/rpc.cc:551` | false-positive | in-scope | yes | nit | ✓ |
| 23 | 'Nothing else waits for _outgoing_queue_ready' comment is only true in effect, not… `src/rpc/rpc.cc:559` | false-positive | in-scope | yes | nit | ✓ |
| 24 | Lambda parameter f shadows the enclosing local future f `src/rpc/rpc.cc:565` | real | in-scope | yes | nit | ✓ |
| 25 | New /// doc blocks on sink/source sit above old redundant one-line comments `include/seastar/rpc/rpc_types.hh:337` | real | in-scope | yes | nit | ✓ |
| 26 | auto& reference into client_factory.hooks.back() could dangle if the vector reallocates… `tests/unit/rpc_test.cc:2001` | false-positive | in-scope | yes | nit | ✓ |
| 27 | test_sink_state is lambda-local while connection wrappers hold a reference to it `tests/unit/rpc_test.cc:1977` | false-positive | in-scope | yes | nit | ✓ |
| 28 | const_cast in negotiate() departs from the file's existing mutable-member idiom `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | nit | ✓ |
| 29 | Wrapper names don't convey close-parking behavior, and buffer_size() is hardcoded… `tests/unit/rpc_test.cc:1870` | real | in-scope | yes | nit | ✓ |
| 30 | New comments use two spaces after a sentence-ending period `src/rpc/rpc.cc:551` | real | in-scope | yes | nit | ✓ |
| 31 | Stream sends still have no per-entry timeout, so a wedged peer can stall the front queue… `src/rpc/rpc.cc:562` | false-positive | out-of-scope | no | nit | ✓ |
| 32 | PR doesn't document the new write round-trip added by waiting for queued frames in… `src/rpc/rpc.cc:562` | false-positive | in-scope | yes | nit | ✓ |
| 33 | An exceptional queue drain is swallowed when closing the write buffer `src/rpc/rpc.cc:568` | false-positive | in-scope | yes | low | ✓ |
| 34 | PR body overstates the new test's determinism and loosely describes the queue-drain…  | real | in-scope | yes | low | ✓ |
| 35 | Doc's description of client::stop aborting open streams is accurate `doc/rpc-streaming.md:49` | false-positive | in-scope | yes | nit | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 79.6% of it is cache reads, which bill at a tenth of
input; cache creation, another 16.8%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 3.6% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(20,333 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr2 | 1 | 35 | 20 | 14 | 1 | 20 | 0 | 1,348,399 | $2.53 | 4.1 min | - |

### Spend per run

| Tool | ironweave |
|---|---:|
| Automated Development review-and-fix-pr2 | 1,348,399 tok / $2.53 / 4.1 min |

**The 1 scored reviews' recorded attempts cost 1,348,399 tokens, $2.53.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

What each run said before verification. Self-rejected claims are excluded, and the judge may merge several claims about one mechanism. The gap from *Raised* is not a miss count.

| Tool | ironweave |
|---|---:|
| Automated Development review-and-fix-pr2 | 35 |

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
