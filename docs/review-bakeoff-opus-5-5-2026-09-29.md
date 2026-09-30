# Review-tool bake-off: 7 review configurations, 3 real PRs

**Cohort:** `opus-5-5-2026-09-29`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.284 (Claude Code)`.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=opus-5-5-2026-09-29`.
This complete cohort contains 19 hash-pinned review cells.
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

- Reviews: 19 calls, 27,223,505 tokens, $21.36, 68.1 minutes wall time.
- Extraction: 19 calls, 119 raw claims, $2.23.
- Judging: 3 calls, 73 merged issues (55 real, 17 false-positive, 1 unproven), $4.80.
- Total known canonical spend: $28.40. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct defect the tools found between them, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | CR | CE | TB-D | TB-R | ANT | SP | MP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |  |  |  |  |  |  |
| 1 | Test never asserts send() actually throws closed_error after stream_close() `tests/unit/rpc_test.cc:2017` | real | in-scope | yes | medium |  |  |  |  | ✓ | ✓ | ✓ |
| 2 | New regression test never exercises the server-side stream hook path `tests/unit/rpc_test.cc:1965` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 3 | New test's put(std::span<...>) override lacks the SEASTAR_API_LEVEL >= 9 guard used… `tests/unit/rpc_test.cc:1881` | real | out-of-scope | yes | nit |  |  |  |  | ✓ |  |  |
| 4 | New doc sentence "shut down only once both halves are closed" contradicts the rest of… `doc/rpc-streaming.md:115` | real | in-scope | yes | low |  |  |  |  | ✓ | ✓ | ✓ |
| 5 | doc/rpc-streaming.md and sink doxygen wrongly claim reading a source until it throws… `doc/rpc-streaming.md:110` | real | in-scope | yes | medium |  |  | ✓ |  |  | ✓ |  |
| 6 | Comment claiming "nothing else waits for _outgoing_queue_ready" is imprecise and… `src/rpc/rpc.cc:559` | real | in-scope | yes | low |  |  |  |  | ✓ |  | ✓ |
| 7 | Test compressor factory mutates hooks via const_cast instead of a mutable member `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | nit |  |  |  |  | ✓ | ✓ | ✓ |
| 8 | PR description ends with a Claude Code attribution line  | real | in-scope | yes | low |  |  |  |  | ✓ | ✓ |  |
| 9 | "Fixes #3663" / "Refs #3653" resolve against the fork repo, not upstream Seastar  | real | in-scope | yes | low |  |  |  |  | ✓ | ✓ | ✓ |
| 10 | PR description links internal Jira tickets  | false-positive | out-of-scope | yes | nit |  |  |  |  | ✓ |  |  |
| 11 | stream_close() draining the old _outgoing_queue_ready could miss in-flight frames `src/rpc/rpc.cc:562` | false-positive | in-scope | yes | low | ✓ |  |  |  |  |  |  |
| 12 | Possible hang if stream_close() runs before negotiation finishes `src/rpc/rpc.cc:548` | false-positive | in-scope | yes | low | ✓ |  |  |  |  |  |  |
| 13 | Back-pressure from a non-reading peer can stall the drain in stream_close() `src/rpc/rpc.cc:566` | false-positive | out-of-scope | no | low | ✓ |  |  |  |  |  |  |
| 14 | stop() now explicitly blocks on outgoing-queue drain before closing, undocumented `src/rpc/rpc.cc:562` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 15 | New _stream_closing flag is a second lifecycle flag send() must check alongside _error `include/seastar/rpc/rpc.hh:305` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 16 | New test's pass-through socket/sink wrapper classes duplicate patterns already in… `tests/unit/rpc_test.cc:1877` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 17 | New \brief doxygen blocks left alongside the old single-line comments they duplicate `include/seastar/rpc/rpc_types.hh:337` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 18 | Doc understates that dropping an unclosed sink is a hard SEASTAR_ASSERT crash `doc/rpc-streaming.md:109` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 19 | New sentence appended to an already-overlong doc line `doc/rpc-streaming.md:49` | real | out-of-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 20 | Test helper class/type names don't convey their close-parking/late-put-recording behavior `tests/unit/rpc_test.cc:1870` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 21 | Reference into client_factory.hooks vector could dangle if the vector ever reallocates… `tests/unit/rpc_test.cc:2001` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 22 | hooks.size() == 2 assertion assumes stream negotiation ordering that reviewers flagged… `tests/unit/rpc_test.cc:2000` | false-positive | in-scope | yes | low | ✓ | ✓ |  |  |  |  |  |
| 23 | New flag could theoretically be set multiple times or on non-stream connections `src/rpc/rpc.cc:552` | false-positive | in-scope | yes | low | ✓ |  |  |  |  |  |  |
| 24 | Wait on close_entered_cv is unbounded and a mid-test assertion failure would abort… `tests/unit/rpc_test.cc:2011` | real | in-scope | yes | medium |  | ✓ |  |  |  | ✓ | ✓ |
| 25 | server_done.get() could intermittently rethrow stream_closed `tests/unit/rpc_test.cc:2028` | false-positive | in-scope | yes | low |  | ✓ |  |  |  |  |  |
| 26 | New regression test doesn't actually exercise the queue-drain half of the fix `tests/unit/rpc_test.cc:1965` | real | in-scope | yes | medium |  |  | ✓ |  |  |  |  |
| 27 | PR description doesn't explain whether the parent client's own unflushed frame is…  | unproven | in-scope | no | medium |  |  |  |  |  |  | ✓ |
| | **quillstone (Rust)** | | | | |  |  |  |  |  |  |  |
| 28 | Failed/dropped USE KEYSPACE discards new connections and can permanently break the pool `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | high | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 29 | Failed USE for a stale keyspace is discarded instead of retried with the current keyspace `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | low |  | ✓ | ✓ |  |  | ✓ |  |
| 30 | Keyspace setup failure logging downgraded from warn! to debug! `scylla/src/network/connection_pool.rs:903` | real | in-scope | yes | low |  | ✓ |  |  | ✓ | ✓ | ✓ |
| 31 | Excess shard-aware-port connection is dropped without decrementing total_connections `scylla/src/network/connection_pool.rs:994` | real | out-of-scope | no | medium | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| 32 | keyspace_setup_failure_triggers_refill test never drives run(), so it doesn't prove a… `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low |  |  |  |  | ✓ | ✓ |  |
| 33 | New keyspace tests skip setup_tracing(), unlike other new tests in the file `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 34 | Metrics-balancing fix commit (de164845) ships with no test until the following commit `scylla/src/network/connection_pool.rs:1360` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 35 | keyspace_setup_failure_triggers_refill hand-builds a PoolRefiller instead of reusing… `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 36 | Proxy OPTIONS/STARTUP rules re-implemented in new tests instead of reusing… `scylla/src/network/connection_pool.rs:1529` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 37 | New UseKeyspaceError variant's message breaks the file's existing message pattern for… `scylla/src/errors.rs:600` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 38 | Commit message "avoid busy-waiting" claim disputed as not matching the change `scylla/src/network/connection_pool.rs:2001` | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 39 | Commit 7f48315d bundles the keyspace fix, a new error variant, and an undocumented… `scylla/src/network/connection_pool.rs:913` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 40 | Reordering the keyspace check ahead of maybe_reshard skips sharder/shard-aware-port… `scylla/src/network/connection_pool.rs:913` | real | in-scope | yes | low |  | ✓ |  |  |  |  | ✓ |
| 41 | A hung USE KEYSPACE request is never timed out, stalling refills indefinitely `scylla/src/network/connection_pool.rs:1336` | real | out-of-scope | no | medium |  |  |  |  |  |  | ✓ |
| 42 | Metrics-balancing commits are bundled into this PR without being mentioned in its…  | real | in-scope | yes | low |  | ✓ |  |  |  | ✓ | ✓ |
| 43 | PR's listed validation command omits --features metrics, skipping the metrics assertions…  | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |
| 44 | PR checklist claim that commit messages explain what/why is inaccurate  | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |
| 45 | New ConnectionError::UseKeyspaceError variant conflates a CQL/keyspace-name error with a… `scylla/src/errors.rs:600` | real | in-scope | yes | low |  |  | ✓ |  |  |  |  |
| 46 | New ConnectionError variant is API-compatible because ConnectionError is #[non_exhaustive] `scylla/src/errors.rs:600` | false-positive | in-scope | no | low |  | ✓ |  |  |  |  |  |
| 47 | No double or missed metrics decrement across maybe_reshard/remove_connection interaction `scylla/src/network/connection_pool.rs:1098` | false-positive | in-scope | no | low |  | ✓ |  |  |  |  |  |
| 48 | New/existing tests pass reliably; many_connections failure is a pre-existing,… `scylla/src/network/connection_pool.rs` | false-positive | out-of-scope | no | low |  | ✓ |  |  |  | ✓ |  |
| 49 | decrement_total_connections/metrics test use a single-decrement loop and a polling sleep… `scylla/src/network/connection_pool.rs:1360` | real | in-scope | yes | nit |  |  |  |  | ✓ | ✓ |  |
| | **tidepool (Go)** | | | | |  |  |  |  |  |  |  |
| 50 | PR description links five issues (#1085,#1086,#1091,#1093,#1106) that don't exist  | real | in-scope | yes | medium |  |  |  |  | ✓ |  |  |
| 51 | Comment says empty non-nil payloads fall through, but the new bound rejects them first `marshal.go:1006` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 52 | Test comment claims 32-bit coverage the package cannot currently be built to exercise `marshal_vector_test.go:585` | real | in-scope | yes | nit |  |  |  |  | ✓ |  |  |
| 53 | PR body ends with a forbidden '🤖 Generated with Claude Code' attribution line  | real | in-scope | yes | nit |  |  |  |  | ✓ |  |  |
| 54 | Dimensions*8/*4 overflow claimed possible in unmarshalVector's fast paths `marshal.go:998` | false-positive | in-scope | yes | medium | ✓ |  |  |  |  |  |  |
| 55 | vectorElemMinSize claimed to risk returning 0 or overflowing, breaking the division `marshal.go:1125` | false-positive | in-scope | yes | low | ✓ |  | ✓ |  |  |  |  |
| 56 | Zero()-returns-nil crash on nested vector / unknown element type — confirmed fixed `marshal.go:1045` | false-positive | in-scope | yes | high | ✓ |  | ✓ |  |  |  |  |
| 57 | getCassandraLongType's newly-named custom type claimed to affect other NativeType.custom… `helpers.go:280` | false-positive | in-scope | yes | low | ✓ |  | ✓ |  |  |  | ✓ |
| 58 | Surplus trailing bytes after the last vector element are never rejected `marshal.go:1090` | real | out-of-scope | no | medium | ✓ |  |  |  |  |  |  |
| 59 | A variable-length element's vint length can narrow to negative and silently decode as… `marshal.go:1097` | real | out-of-scope | no | high | ✓ |  |  |  |  |  |  |
| 60 | frame.go silently treats an unparseable vector dimension as 0 `frame.go:861` | real | out-of-scope | no | medium | ✓ |  |  |  |  |  |  |
| 61 | A caller-built VectorType with Dimensions>0 and a nil SubType still panics `marshal.go:1008` | real | out-of-scope | no | low | ✓ |  | ✓ |  |  |  |  |
| 62 | Map-arity parse failure still returns an unnamed TypeCustom instead of the server's type… `helpers.go:222` | real | out-of-scope | no | low |  | ✓ |  |  |  |  |  |
| 63 | Vector-dimension parse failure still returns an unnamed TypeCustom instead of the… `helpers.go:267` | real | out-of-scope | no | low |  | ✓ |  |  |  |  |  |
| 64 | TestUnmarshalVectorRejectsNestedCountBeforeAllocating measures process-wide allocation,… `marshal_vector_test.go:852` | real | in-scope | yes | low |  | ✓ | ✓ |  |  | ✓ |  |
| 65 | No CHANGELOG.md entry for the described behaviour change `CONTRIBUTING.md:24` | real | out-of-scope | no | nit |  |  |  |  |  |  | ✓ |
| 66 | Commit messages omit CONTRIBUTING.md's 'Patch by...; reviewed by... for #####' trailer `CONTRIBUTING.md:30` | real | out-of-scope | no | nit |  |  |  |  |  |  | ✓ |
| 67 | Two adjacent blocks repeat the identical 'info.Dimensions > 0 && data != nil' guard `marshal.go:995` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 68 | vectorElemMinSize adds a third place that must know how to classify a vector element type `marshal.go:1125` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 69 | New makeVectorType test helper repeats the struct literal already in two existing helpers `marshal_vector_test.go:557` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 70 | PR description's 'every new test fails against pristine code' overstates the actual set  | real | in-scope | yes | low |  |  |  |  |  | ✓ | ✓ |
| 71 | New bound check reorders validation, changing the error for a short payload into a… `marshal.go:998` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |
| 72 | New size check claimed to prevent overflow and match unmarshalList's pattern `marshal.go:998` | false-positive | in-scope | yes | low |  |  | ✓ |  |  |  |  |
| 73 | marshalVectorFloat32/64 allocations claimed to be server-controlled `marshal.go:961` | false-positive | out-of-scope | no | low |  |  | ✓ |  |  |  |  |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 93.0% of it is cache reads, which bill at a tenth of
input; cache creation, another 6.1%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 0.9% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(134,375 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Only this tool | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Claude Code /code-review | 3 | 15 | 6 | 9 | 0 | 1 | 5 | 3 | 1,557,924 | $1.55 | 5.9 min | - |
| Compound Engineering ce-code-review | 3 | 15 | 10 | 5 | 0 | 7 | 3 | 2 | 5,400,430 | $4.28 | 24.1 min | - |
| Trail of Bits differential-review | 3 | 13 | 8 | 5 | 0 | 6 | 2 | 2 | 1,607,254 | $2.03 | 5.6 min | - |
| Trail of Bits rust-review | 1 | 2 | 2 | 0 | 0 | 1 | 1 | 0 | 464,268 | $0.78 | 1.4 min | - |
| Anthropic pr-review-toolkit | 3 | 18 | 17 | 1 | 0 | 15 | 1 | 6 | 2,020,007 | $2.33 | 7.7 min | - |
| Superpowers requesting-code-review | 3 | 20 | 19 | 1 | 0 | 18 | 1 | 3 | 6,343,858 | $4.32 | 12.9 min | - |
| Matt Pocock code-review | 3 | 34 | 31 | 2 | 1 | 27 | 3 | 20 | 9,829,764 | $6.07 | 10.5 min | - |

### Spend per run

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Claude Code /code-review | 420,034 tok / $0.53 / 1.9 min | 505,406 tok / $0.45 / 1.6 min | 632,484 tok / $0.57 / 2.3 min |
| Compound Engineering ce-code-review | 1,768,091 tok / $1.31 / 6.7 min | 1,499,281 tok / $1.54 / 5.0 min | 2,133,058 tok / $1.43 / 12.4 min |
| Trail of Bits differential-review | 530,448 tok / $0.70 / 2.0 min | 356,626 tok / $0.60 / 1.4 min | 720,180 tok / $0.74 / 2.2 min |
| Trail of Bits rust-review | - | 464,268 tok / $0.78 / 1.4 min | - |
| Anthropic pr-review-toolkit | 766,619 tok / $0.75 / 2.5 min | 520,013 tok / $0.78 / 2.0 min | 733,375 tok / $0.80 / 3.1 min |
| Superpowers requesting-code-review | 3,838,672 tok / $1.89 / 3.5 min | 1,181,892 tok / $1.22 / 4.3 min | 1,323,294 tok / $1.21 / 5.1 min |
| Matt Pocock code-review | 2,512,768 tok / $1.86 / 4.3 min | 983,640 tok / $1.49 / 2.9 min | 6,333,356 tok / $2.72 / 3.4 min |

**The 19 scored reviews' recorded attempts cost 27,223,505 tokens, $21.36.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

What each run said, before merging and verification - the gap between this and *Raised* above is
what the judge merged away as the same defect twice.

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Claude Code /code-review | 5 | 2 | 8 |
| Compound Engineering ce-code-review | 3 | 9 | 3 |
| Trail of Bits differential-review | 2 | 4 | 7 |
| Trail of Bits rust-review | - | 2 | - |
| Anthropic pr-review-toolkit | 9 | 5 | 4 |
| Superpowers requesting-code-review | 7 | 11 | 3 |
| Matt Pocock code-review | 15 | 13 | 7 |

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
