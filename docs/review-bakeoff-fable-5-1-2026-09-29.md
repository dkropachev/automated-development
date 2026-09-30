# Review-tool bake-off: 7 review configurations, 3 real PRs

**Cohort:** `fable-5-1-2026-09-29`. **Requested model:** Claude Fable 5.1 (`claude-fable-5-1`). Claude Code: `2.1.284 (Claude Code)`.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=fable-5-1-2026-09-29`.
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

- Exact-model probe: $0.60.
- Reviews: 19 calls, 72,528,644 tokens, $119.78, 162.8 minutes wall time.
- Extraction: 19 calls, 187 raw claims, $2.62.
- Judging: 3 calls, 113 merged issues (75 real, 33 false-positive, 5 unproven), $7.86.
- Total known canonical spend: $130.85. Discarded attempts are not included in immutable stage artifacts.
- Final quota: current session 59%, all-model week 31%, Fable week 52% (recorded ceilings: 95% / 95% / 95%).

## Findings, by issue

One row per distinct defect the tools found between them, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | CR | CE | TB-D | TB-R | ANT | SP | MP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | **ironweave (C++)** | | | | |  |  |  |  |  |  |  |
| 1 | Docs claim throw during source read always closes it; unmarshall errors don't `include/seastar/rpc/rpc_types.hh:387` | real | in-scope | yes | medium |  |  |  |  | ✓ |  | ✓ |
| 2 | Stale plain-// comments left directly under the new doxygen blocks `include/seastar/rpc/rpc_types.hh:343` | real | in-scope | yes | nit |  |  |  |  | ✓ |  | ✓ |
| 3 | Doc overstates connection shuts down 'only' when both stream halves close `doc/rpc-streaming.md:115` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 4 | Non-empty-queue and failed-drain branches of stream_close() have no test `src/rpc/rpc.cc:562` | real | in-scope | yes | medium |  | ✓ |  |  | ✓ |  |  |
| 5 | Test's try/catch doesn't directly assert the send was refused `tests/unit/rpc_test.cc:2016` | real | in-scope | yes | low |  | ✓ |  |  | ✓ |  |  |
| 6 | yield()-loop timing to let the batch-flush poller run is not contractually guaranteed `tests/unit/rpc_test.cc:2022` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 7 | Comment misstates why _outgoing_queue_ready becomes exceptional `src/rpc/rpc.cc:566` | real | in-scope | yes | nit |  |  |  |  | ✓ |  |  |
| 8 | Comment claiming nothing else waits on _outgoing_queue_ready is imprecise `src/rpc/rpc.cc:559` | real | in-scope | yes | nit |  |  |  |  | ✓ |  |  |
| 9 | const_cast on this used instead of a mutable hooks member `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | nit |  |  | ✓ |  | ✓ | ✓ | ✓ |
| 10 | Commits and PR body carry Claude/Anthropic attribution, violating user's global rule  | real | in-scope | yes | medium |  |  | ✓ |  | ✓ | ✓ | ✓ |
| 11 | test_data_sink_impl is abstract and fails to compile below SEASTAR_API_LEVEL 9 `tests/unit/rpc_test.cc:1878` | real | in-scope | yes | high | ✓ |  |  |  |  | ✓ |  |
| 12 | Server drain loop claimed to be able to observe stream_closed instead of eof `tests/unit/rpc_test.cc:1988` | false-positive | out-of-scope | no | low |  | ✓ |  |  |  |  |  |
| 13 | Hook index (hooks.back()) claimed to depend on negotiation order `tests/unit/rpc_test.cc:2000` | false-positive | in-scope | yes | low |  | ✓ |  |  |  |  |  |
| 14 | No test for peer disconnect racing the new drain wait in stream_close() `src/rpc/rpc.cc:562` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |
| 15 | New test only covers the compressor's send_empty_frame hook, not other send() callers `tests/unit/rpc_test.cc` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |
| 16 | queue_drained wait in stream_close() has no timeout `src/rpc/rpc.cc:562` | false-positive | out-of-scope | no | low |  | ✓ |  |  |  |  |  |
| 17 | Out-of-tree compressors calling send_empty_frame during the closing window were not…  | unproven | out-of-scope | yes | low |  | ✓ |  |  |  |  |  |
| 18 | Unresolved _negotiated during stream_close() argued impossible but untested  | false-positive | out-of-scope | no | low |  | ✓ |  |  |  |  |  |
| 19 | Behavior of output_stream::write on an already-closed stream  | false-positive | out-of-scope | no | nit |  | ✓ |  |  |  |  |  |
| 20 | Claim that the new test fails without the fix, and passes with it, was unverified `tests/unit/rpc_test.cc:2033` | false-positive | in-scope | yes | low |  | ✓ |  |  |  |  | ✓ |
| 21 | Commits lack the DCO Signed-off-by trailer required by contributing.md  | real | in-scope | yes | medium |  |  |  |  |  |  | ✓ |
| 22 | static inline const sstring name declaration differs from neighbouring patterns `tests/unit/rpc_test.cc:1940` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 23 | then_wrapped/ignore_ready_future shape confirmed consistent with existing patterns `src/rpc/rpc.cc:562` | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 24 | _stream_closing field placement `include/seastar/rpc/rpc.hh:307` | false-positive | in-scope | yes | nit |  |  |  |  |  | ✓ | ✓ |
| 25 | test_socket_impl duplicates rpc_socket_impl's forwarding methods `tests/unit/rpc_test.cc:1922` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 26 | test_connected_socket_impl is a large pure forwarder (Middle Man smell) `tests/unit/rpc_test.cc:1900` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 27 | No Mysterious Names, Speculative Generality or Shotgun Surgery smells found  | false-positive | in-scope | no | nit |  |  |  |  |  |  | ✓ |
| 28 | send() confirmed to correctly return closed_error once _stream_closing is set `src/rpc/rpc.cc:293` | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 29 | _outgoing_queue_ready synchronization confirmed safe against races with stream_close() `src/rpc/rpc.cc` | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 30 | write_buf.close() call sites and reachability confirmed safe `src/rpc/rpc.cc:231` | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 31 | PR claim that setting _error instead is not an option confirmed to hold  | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 32 | client_factory.hooks.back() confirmed to correctly capture the stream connection's hook `tests/unit/rpc_test.cc` | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 33 | Docs on dropping an unclosed sink, and source lacking close(), confirmed accurate `include/seastar/rpc/rpc_impl.hh:935` | false-positive | in-scope | yes | nit |  |  | ✓ |  |  |  | ✓ |
| 34 | 'Refs #3653' reference could not be independently verified  | unproven | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 35 | Server-side stream_close() send-refusal window is untested `tests/unit/rpc_test.cc:1966` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 36 | Test claimed to hang or UAF if the hook throws a non-closed_error exception `tests/unit/rpc_test.cc:2015` | false-positive | in-scope | yes | low |  |  |  |  |  | ✓ | ✓ |
| 37 | Doc section is a scope expansion beyond the referenced issue  | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 38 | Commit subject prefixes confirmed to comply with repo convention  | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 39 | Code confirmed to comply with coding-style.md  | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 40 | New test is not shard-safe under --smp 2 (cross-shard write to server_factory.hooks) `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |
| 41 | then_wrapped lambda parameter f shadows the enclosing auto f `src/rpc/rpc.cc:565` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |
| 42 | Parent client's compressor hook behavior during client::stop() left unexamined  | unproven | out-of-scope | no | low |  |  |  |  |  | ✓ |  |
| 43 | Unclear whether external compressors handle closed_error from send_empty_frame  | unproven | out-of-scope | yes | low |  |  |  |  |  | ✓ |  |
| 44 | Pre-existing abort()/stream_close()/shutdown_output() ordering race not investigated  | unproven | out-of-scope | no | low |  |  |  |  |  | ✓ |  |
| 45 | doc/rpc-compression.md does not mention the new send_empty_frame failure mode `doc/rpc-compression.md` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |
| 46 | Layout change to rpc::connection in a public header `include/seastar/rpc/rpc.hh:307` | false-positive | out-of-scope | yes | nit |  |  |  |  |  | ✓ |  |
| 47 | send() gate verified to cover all callers including compressor hooks `src/rpc/rpc.cc:293` | false-positive | in-scope | yes | nit |  |  | ✓ |  |  |  |  |
| 48 | Queue drain via swapping _outgoing_queue_ready confirmed safe `src/rpc/rpc.cc:562` | false-positive | in-scope | yes | nit |  |  | ✓ |  |  |  |  |
| 49 | Race between stop_send_loop() and stream_close() produces the same outcome as before  | false-positive | out-of-scope | no | nit |  |  | ✓ |  |  |  |  |
| 50 | Test's lifetime safety for the wrapped data sink relies on sequencing, not ownership `tests/unit/rpc_test.cc:1849` | real | in-scope | yes | nit |  |  | ✓ |  |  |  |  |
| 51 | Comment claims the destructor assert is where the test fails without the fix; it… `tests/unit/rpc_test.cc:2033` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |
| | **quillstone (Rust)** | | | | |  |  |  |  |  |  |  |
| 52 | Persistent/stale USE-keyspace failures discard connections indefinitely, can drain pool… `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | medium |  |  | ✓ | ✓ | ✓ |  | ✓ |
| 53 | USE-keyspace failure log downgraded from warn! to debug!, hiding the exact failure the… `scylla/src/network/connection_pool.rs:903` | real | in-scope | yes | high |  |  |  | ✓ | ✓ | ✓ | ✓ |
| 54 | Reordering keyspace check ahead of resharding is sound but stalls sharder/shard-port… `scylla/src/network/connection_pool.rs:913` | real | in-scope | yes | low |  | ✓ | ✓ | ✓ |  |  |  |
| 55 | New ConnectionError::UseKeyspaceError variant's semantics/#[from] are debatable `scylla/src/errors.rs:600` | real | in-scope | yes | nit |  |  | ✓ | ✓ | ✓ |  | ✓ |
| 56 | No double-decrement of connection metrics across keyspace-failure/clear/reshard/remove… `scylla/src/network/connection_pool.rs:1232` | false-positive | in-scope | no | nit |  |  | ✓ | ✓ |  |  | ✓ |
| 57 | Excess shard-aware connection rejected in handle_ready_connection is dropped without… `scylla/src/network/connection_pool.rs:1006` | real | out-of-scope | no | medium |  | ✓ |  |  | ✓ |  |  |
| 58 | Connections held in conns/excess_connections at run() exit are dropped without… `scylla/src/network/connection_pool.rs:696` | real | out-of-scope | no | low |  | ✓ |  |  |  |  |  |
| 59 | use_keyspace future for new connections has no timeout, can stall refill scheduling `scylla/src/network/connection_pool.rs:1332` | real | out-of-scope | no | low |  | ✓ | ✓ |  |  |  |  |
| 60 | decrement_total_connections loops single decrements instead of one atomic bulk subtraction `scylla/src/network/connection_pool.rs:1360` | real | in-scope | yes | nit |  | ✓ |  |  | ✓ | ✓ | ✓ |
| 61 | Excess-connection decrement+clear logic duplicated across three sites instead of one… `scylla/src/network/connection_pool.rs:674` | real | in-scope | yes | nit |  |  |  |  | ✓ |  |  |
| 62 | Decrement sites lack comments explaining why they don't double-count with… `scylla/src/network/connection_pool.rs:674` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 63 | Reordered keyspace-setup block keeps its old comment and isn't explained as an… `scylla/src/network/connection_pool.rs:913` | real | in-scope | yes | low |  |  |  |  | ✓ |  | ✓ |
| 64 | PR description and commit messages omit the metrics-balancing commits and other…  | real | in-scope | yes | medium |  |  |  |  | ✓ | ✓ |  |
| 65 | PR's stated validation command never compiles or runs the three metrics-gated tests `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | medium |  |  |  |  | ✓ |  | ✓ |
| 66 | Unrelated metrics-balancing work bundled into this keyspace-failure PR `scylla/src/network/connection_pool.rs:674` | real | in-scope | yes | medium |  |  |  |  |  |  | ✓ |
| 67 | Fixes: #1682 does not resolve in this repository  | real | in-scope | yes | low |  |  |  |  |  | ✓ | ✓ |
| 68 | keyspace_setup_failure_triggers_refill asserts trivially-true conditions on a fresh… `scylla/src/network/connection_pool.rs:1511` | real | in-scope | yes | low |  |  |  |  | ✓ |  | ✓ |
| 69 | No test drives a keyspace failure through the actual run() loop or checks non-empty-pool… `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low |  | ✓ |  |  | ✓ |  |  |
| 70 | Excess-connections term in maybe_reshard's decrement is never exercised by any test `scylla/src/network/connection_pool.rs:1868` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 71 | New tests inconsistently discard vs. match on proxy.finish()'s result `scylla/src/network/connection_pool.rs:1939` | real | in-scope | yes | nit |  |  |  |  | ✓ |  | ✓ |
| 72 | Options/Startup proxy-rule-forging logic duplicated across three new tests `scylla/src/network/connection_pool.rs:1528` | real | in-scope | yes | low |  | ✓ |  |  |  |  | ✓ |
| 73 | New test uses ShardInfo::new(...) instead of the struct-literal style used everywhere else `scylla/src/network/connection_pool.rs:1617` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 74 | Hand-encoded RESULT/SET_KEYSPACE byte literal has no explanatory comment `scylla/src/network/connection_pool.rs:1537` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 75 | New keyspace-failure tests don't call setup_tracing() unlike sibling tests `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 76 | Commit subject 'avoid busy-waiting' is claimed to overstate a fix that still polls `scylla/src/network/connection_pool.rs:2003` | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 77 | All four PR commits have empty commit message bodies  | real | in-scope | yes | medium |  |  |  |  |  |  | ✓ |
| 78 | Timing-dependent metrics test polls with real sleeps instead of a deterministic signal `scylla/src/network/connection_pool.rs:2005` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |
| 79 | ConnectionSetupError lacks #[derive(Debug)] `scylla/src/network/connection_pool.rs:1418` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 80 | OpenedConnectionEvent's keyspace_name/result coupling is unenforced by the type system `scylla/src/network/connection_pool.rs:1414` | real | in-scope | yes | nit |  |  |  |  | ✓ |  |  |
| | **tidepool (Go)** | | | | |  |  |  |  |  |  |  |
| 81 | unmarshalVector panics on *any dest with nil SubType via VectorType.Zero() `marshal.go:1044` | real | in-scope | no | low |  | ✓ |  |  | ✓ |  |  |
| 82 | vectorElemMinSize panics recursing into a nested VectorType with nil inner SubType `marshal.go:1134` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 83 | Comment overstates protection: Dimensions>0 with nil SubType still panics (pre-existing) `marshal.go:996` | real | out-of-scope | no | low |  |  |  |  |  |  | ✓ |
| 84 | frame.go silently discards vector-dimension parse errors, yielding Dimensions=0 `frame.go:861` | real | out-of-scope | no | medium |  |  | ✓ |  | ✓ |  |  |
| 85 | PR description references nonexistent companion issues/PRs (#1085, #1086, #1091, #1093,…  | real | in-scope | yes | medium |  |  | ✓ |  | ✓ | ✓ |  |
| 86 | "Every new test fails against pristine code" claim in the PR description is overstated `marshal_vector_test.go` | real | in-scope | yes | medium |  |  | ✓ |  | ✓ | ✓ | ✓ |
| 87 | math.MaxInt32 saturation branch in vectorElemMinSize has no test coverage `marshal.go:1136` | real | in-scope | yes | low |  | ✓ |  |  | ✓ |  |  |
| 88 | No test for the described empty-payload boundary: vector<int,3> over exactly []byte{} `marshal_vector_test.go:587` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 89 | Stale fast-path comment: empty non-nil data with Dimensions>0 no longer falls through `marshal.go:1006` | real | in-scope | yes | low |  |  |  |  | ✓ |  | ✓ |
| 90 | Overstated comment: not every path below allocates (array destination doesn't) `marshal.go:986` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 91 | Misleading test comment: a zero-dimension inner vector does encode in zero bytes `marshal_vector_test.go:813` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 92 | Undocumented behaviour change: NULL vector with negative dimensions now errors `marshal.go:992` | real | in-scope | yes | low |  |  |  |  | ✓ |  | ✓ |
| 93 | getCassandraLongType still returns a nameless custom() from two other error branches `helpers.go:222` | real | in-scope | yes | low |  |  |  |  | ✓ |  |  |
| 94 | getCassandraLongType change alters String()/equality for all unknown custom types, not… `helpers.go:280` | real | in-scope | yes | low |  |  | ✓ |  |  |  | ✓ |
| 95 | New unmarshalVector error for nested-vector element types drops inner type/dimensions `marshal.go:1048` | real | in-scope | yes | low |  |  |  |  |  | ✓ | ✓ |
| 96 | Bound-check error message omits the per-element minimum size for nested element types `marshal.go:1000` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |
| 97 | Allocation-ceiling test may flake from process-wide MemStats measurement `marshal_vector_test.go:836` | real | in-scope | yes | nit |  | ✓ |  |  |  | ✓ |  |
| 98 | Allocation-reduction claim ("3.5 KB flat") is not pinned by a tight test assertion `marshal_vector_test.go:864` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 99 | New makeVectorType test helper duplicates existing vector-type test helpers `marshal_vector_test.go:557` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 100 | Claude/Anthropic attribution in commit trailers and PR description  | real | in-scope | yes | nit |  |  | ✓ |  | ✓ | ✓ | ✓ |
| 101 | Commits use lowercase conventional-commit subjects and lack the CONTRIBUTING.md "Patch…  | real | out-of-scope | no | nit |  |  |  |  |  |  | ✓ |
| 102 | Commit 0276a66's body undersells the fix as a flat one-byte floor  | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |
| 103 | Behaviour change (short/empty non-NULL vector now errors) isn't documented in godoc  | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 104 | Pre-existing: negative vint element length decodes an element from nil data with a nil… `marshal.go:1097` | real | out-of-scope | no | low |  | ✓ |  |  | ✓ |  |  |
| 105 | Test suite has pre-existing, environment-caused failures unrelated to this PR  | false-positive | out-of-scope | no | low |  | ✓ |  |  | ✓ |  |  |
| 106 | Reviewer self-verifications that the new bound-check arithmetic and placement are sound `marshal.go` | false-positive | in-scope | yes | low |  |  |  |  |  | ✓ | ✓ |
| 107 | Reviewer self-verifications: nil-Go-type guard is the sole dereference site; marshal… `marshal.go` | false-positive | in-scope | yes | low |  |  |  |  |  | ✓ |  |
| 108 | Reviewer self-verifications: getCassandraLongType change doesn't break any Custom()==""… `helpers.go` | false-positive | in-scope | yes | low |  |  | ✓ |  |  |  | ✓ |
| 109 | Reviewer self-verifications: spec's behavioural claims (NULL nil/nil, empty errors,…  | false-positive | in-scope | yes | low |  |  |  |  |  |  | ✓ |
| 110 | Pre-existing: dimension bound misclassifies a hypothetical zero-length fixed custom type `marshal.go:1130` | real | in-scope | yes | nit |  | ✓ |  |  |  |  |  |
| 111 | Recursion depth in new vector-type helpers bounded only by custom type-name string… `marshal.go:1134` | false-positive | out-of-scope | no | nit |  | ✓ |  |  |  |  |  |
| 112 | math.MaxInt32 saturation guard is defensible engineering, not speculative generality `marshal.go:1137` | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |
| 113 | ~400 lines of new tests for two guard conditions is a reasonable judgement call, not…  | false-positive | in-scope | yes | nit |  |  |  |  |  |  | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 92.6% of it is cache reads, which bill at a tenth of
input; cache creation, another 6.1%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 1.3% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(360,785 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Only this tool | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Claude Code /code-review | 3 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1,637,376 | $4.25 | 7.8 min | - |
| Compound Engineering ce-code-review | 3 | 25 | 16 | 8 | 1 | 12 | 5 | 4 | 18,098,335 | $40.85 | 70.5 min | - |
| Trail of Bits differential-review | 3 | 18 | 12 | 6 | 0 | 10 | 2 | 1 | 3,004,476 | $6.40 | 12.1 min | - |
| Trail of Bits rust-review | 1 | 5 | 4 | 1 | 0 | 4 | 0 | 0 | 5,199,654 | $9.06 | 12.0 min | - |
| Anthropic pr-review-toolkit | 3 | 41 | 40 | 1 | 0 | 37 | 4 | 14 | 30,714,065 | $34.03 | 25.5 min | - |
| Superpowers requesting-code-review | 3 | 27 | 19 | 5 | 3 | 19 | 0 | 7 | 3,424,150 | $9.89 | 19.5 min | - |
| Matt Pocock code-review | 3 | 57 | 35 | 21 | 1 | 33 | 2 | 15 | 10,450,588 | $15.30 | 15.5 min | - |

### Spend per run

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Claude Code /code-review | 754,592 tok / $1.72 / 3.4 min | 304,146 tok / $1.09 / 1.8 min | 578,638 tok / $1.45 / 2.7 min |
| Compound Engineering ce-code-review | 6,227,356 tok / $15.23 / 27.6 min | 5,783,045 tok / $10.84 / 18.2 min | 6,087,934 tok / $14.79 / 24.6 min |
| Trail of Bits differential-review | 988,640 tok / $2.17 / 3.5 min | 1,192,085 tok / $2.17 / 4.1 min | 823,751 tok / $2.06 / 4.5 min |
| Trail of Bits rust-review | - | 5,199,654 tok / $9.06 / 12.0 min | - |
| Anthropic pr-review-toolkit | 12,466,750 tok / $12.96 / 9.8 min | 9,802,337 tok / $11.33 / 7.8 min | 8,444,978 tok / $9.74 / 7.8 min |
| Superpowers requesting-code-review | 1,227,080 tok / $3.96 / 7.5 min | 1,290,940 tok / $2.93 / 5.7 min | 906,130 tok / $3.00 / 6.3 min |
| Matt Pocock code-review | 5,404,548 tok / $6.36 / 5.5 min | 3,810,179 tok / $5.38 / 4.9 min | 1,235,861 tok / $3.56 / 5.1 min |

**The 19 scored reviews' recorded attempts cost 72,528,644 tokens, $119.78.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

What each run said, before merging and verification - the gap between this and *Raised* above is
what the judge merged away as the same defect twice.

| Tool | ironweave | quillstone | tidepool |
|---|---:|---:|---:|
| Claude Code /code-review | 1 | 0 | 0 |
| Compound Engineering ce-code-review | 11 | 8 | 8 |
| Trail of Bits differential-review | 7 | 5 | 4 |
| Trail of Bits rust-review | - | 5 | - |
| Anthropic pr-review-toolkit | 10 | 16 | 16 |
| Superpowers requesting-code-review | 13 | 5 | 17 |
| Matt Pocock code-review | 24 | 18 | 19 |

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
