# Review-tool bake-off: 8 review configurations, three real PRs

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report`. General-purpose tools reviewed all three pull requests; language-specific
tools ran only on matching targets. Every run used its own headless `claude -p` process and
working directory so its token spend is attributable.

## What was reviewed

| Target | Language | Diff | Files | PR under review | Upstream original |
|---|---|---:|---:|---|---|
| `tidepool` | Go | 18,335 B | 2 commits | https://github.com/dkropachev/tidepool/pull/1 | https://github.com/scylladb/gocql/pull/1094 |
| `quillstone` | Rust | 26,179 B | 4 commits | https://github.com/dkropachev/quillstone/pull/1 | https://github.com/scylladb/scylla-rust-driver/pull/1801 |
| `ironweave` | C++ | 15,931 B | 3 commits | https://github.com/dkropachev/ironweave/pull/1 | https://github.com/scylladb/seastar/pull/3664 |

Each PR was republished into a private repository of its own: full upstream history, the PR's own
commits replayed under a neutral author, every `owner/repo` link repointed at the copy, and
`WebSearch`/`WebFetch` denied to every run. A reviewer that could reach the original PR could read
the maintainers' review instead of doing its own.

## Findings, by issue

One row per distinct defect the tools found between them, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | CR | CE | TB-D | TB-R | TB-C | ANT | SP | MP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | **tidepool (Go)** | | | | |  |  |  |  |  |  |  |  |
| 1 | Zero/negative inner-vector dimension floors elemMin at 1, leaving 24x amplification `marshal.go:1134` | real | in-scope | no | high |  | ✓ |  |  |  | ✓ |  | ✓ |
| 2 | Bound counts wire bytes but allocation is Go-sized, so 16x amplification survives `marshal.go:999` | real | in-scope | no | high |  | ✓ |  |  |  |  | ✓ |  |
| 3 | Zero VectorType into an empty-interface destination still nil-derefs in VectorType.Zero() `marshal.go:1044` | real | in-scope | no | high | ✓ |  |  |  |  | ✓ |  |  |
| 4 | vectorElemMinSize(nil) panics when Dimensions > 0 despite the guard's nil-SubType claim `marshal.go:999` | real | in-scope | no | low |  | ✓ | ✓ |  |  |  | ✓ |  |
| 5 | Nested vector inner type keeps the bare VectorType prefix, so the new error names nothing `helpers.go:271` | real | in-scope | no | medium | ✓ | ✓ | ✓ |  |  | ✓ | ✓ | ✓ |
| 6 | Saturation branch `return math.MaxInt32` in vectorElemMinSize has zero test coverage `marshal.go:1137` | real | in-scope | yes | medium |  | ✓ | ✓ |  |  | ✓ | ✓ |  |
| 7 | Zero-length variable-length elements still decode to garbage with a nil error `marshal.go:1125` | real | out-of-scope | no | medium |  | ✓ |  |  |  | ✓ |  |  |
| 8 | VectorType.Zero() discards NewWithError's error, so the new message cannot name the cause `marshal.go:2047` | real | in-scope | yes | low | ✓ |  |  |  |  | ✓ |  |  |
| 9 | Identical `info.Dimensions > 0 && data != nil` guard appears twice back to back `marshal.go:998` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  | ✓ |
| 10 | Commits and PR body carry Claude attribution, forbidden by the user's global instructions  | real | in-scope | yes | medium |  |  |  |  |  | ✓ |  | ✓ |
| 11 | PR body's claim that every new test fails against pristine code is false for three of six  | real | in-scope | yes | low |  | ✓ |  |  |  |  |  | ✓ |
| 12 | getCassandraLongType indexes split results unguarded, panicking on a malformed type name `helpers.go:264` | real | out-of-scope | no | high |  | ✓ |  |  |  | ✓ | ✓ |  |
| 13 | readTypeInfo slices the vector custom name unchecked, panicking on the frame goroutine `frame.go:856` | real | out-of-scope | no | high |  | ✓ |  |  |  |  | ✓ |  |
| 14 | getCassandraLongType parse cost is super-linear in nested type-name length (52s at 37 KB) `helpers.go:206` | real | out-of-scope | no | medium |  |  | ✓ |  |  |  |  |  |
| 15 | frame.go discards strconv.Atoi's error for the vector dimension `frame.go:861` | real | out-of-scope | no | low |  |  |  |  |  | ✓ |  |  |
| 16 | Other getCassandraLongType degrade paths still return a nameless custom type `helpers.go:224` | real | in-scope | no | low |  |  |  |  |  | ✓ |  |  |
| 17 | Zero-dimension inner vector now errors on a payload that decoded on base `marshal.go:1141` | real | in-scope | yes | low |  |  |  |  |  | ✓ | ✓ |  |
| 18 | Negative dimensions on a NULL payload now error instead of returning nil, undocumented `marshal.go:992` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |  |
| 19 | Non-NULL zero-length payloads now error, breaking driver-produced round-trips `marshal.go:1000` | real | in-scope | yes | low | ✓ | ✓ |  |  |  |  |  |  |
| 20 | marshalVector emits a wire-invalid value when an element under-marshals `marshal.go:920` | real | out-of-scope | no | low |  | ✓ |  |  |  |  |  |  |
| 21 | Allocation test asserts on process-global TotalAlloc with a payload-relative budget `marshal_vector_test.go:852` | real | in-scope | yes | low |  |  |  |  |  | ✓ | ✓ |  |
| 22 | Allocation-bound test covers only the nested fixed-size shape, not variable-length `marshal_vector_test.go:838` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 23 | No dimension-bound test goes through the public Unmarshal or Scan with a wire-parsed type `marshal_vector_test.go:587` | real | in-scope | yes | low |  | ✓ |  |  |  | ✓ |  |  |
| 24 | Guard comment claims every path below allocates, which is false for the array destination `marshal.go:986` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |  |
| 25 | Test comment reads as if each inner vector costs eight bytes when it costs four `marshal_vector_test.go:773` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |  |
| 26 | Dimension-bound error message names neither the element type nor the per-element minimum `marshal.go:1001` | real | in-scope | yes | nit |  | ✓ |  |  |  | ✓ |  |  |
| 27 | VectorType.Zero() yields []*T while goType() yields []T, so Scan(&any) and MapScan differ `marshal.go:2050` | real | in-scope | no | low |  |  | ✓ |  |  |  | ✓ |  |
| 28 | Basic-type fallback change also widens Custom()/String() for list, map, tuple and UDT `helpers.go:280` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  | ✓ |
| 29 | Test helper builds a TypeText descriptor for UTF8Type, which the parser maps to varchar `marshal_vector_test.go:557` | real | in-scope | yes | nit |  | ✓ |  |  |  |  |  |  |
| 30 | vectorElemMinSize is a third function branching on vector element type `marshal.go:1125` | real | in-scope | yes | nit |  |  |  |  |  |  |  | ✓ |
| 31 | math.MaxInt32 saturation sentinel is returned as a plain int size `marshal.go:1137` | real | in-scope | yes | nit |  |  |  |  |  |  |  | ✓ |
| 32 | vectorElemMinSize is recomputed for every value with cost quadratic in nesting depth `marshal.go:999` | real | in-scope | yes | nit |  | ✓ | ✓ |  |  |  |  |  |
| 33 | Deferred #1106: oversized vint element length narrows to -1, decoding empty with nil error `marshal.go:1097` | real | out-of-scope | no | medium |  | ✓ |  |  |  | ✓ | ✓ |  |
| 34 | Deferred #1086: surplus trailing bytes dropped on the generic path, rejected on fast paths `marshal.go:1095` | real | out-of-scope | no | low |  | ✓ |  |  |  | ✓ | ✓ |  |
| 35 | Peer-controlled type descriptor text reaches error messages verbatim `marshal.go:1048` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 36 | No test pins the headline change: an empty non-NULL payload for vector<int,3> `marshal_vector_test.go:641` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 37 | No test covers a variable-length element whose real minimum exceeds the 1-byte floor `marshal_vector_test.go:693` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 38 | No test asserts the float fast-path message survives for longer-than-minimum payloads `marshal_vector_test.go:693` | real | in-scope | yes | nit |  | ✓ |  |  |  |  |  |  |
| 39 | No-Go-type test asserts only a message prefix, not the rendered type identifier `marshal_vector_test.go:891` | real | in-scope | yes | nit |  | ✓ |  |  |  |  |  | ✓ |
| 40 | No benchmark covers nested or variable-length vectors that now run the recursive prologue `vector_bench_test.go:1` | real | in-scope | yes | nit |  | ✓ |  |  |  |  |  |  |
| 41 | No test drives the bound through three or more levels of vector nesting `marshal_vector_test.go:818` | real | in-scope | yes | nit |  | ✓ |  |  |  |  |  |  |
| 42 | Unmarshal's doc comment still has no vector row despite two new error conditions `marshal.go:260` | real | in-scope | no | nit |  | ✓ |  |  |  |  |  |  |
| 43 | getCassandraLongType's standing TODO for unit tests remains unaddressed `helpers.go:204` | real | in-scope | no | nit |  | ✓ |  |  |  |  |  |  |
| 44 | The "not parallel" comment's rationale is correct, not a misstatement of Go's scheduling `marshal_vector_test.go:835` | false-positive | in-scope | yes | nit |  |  |  |  |  | ✓ |  |  |
| 45 | The info.Dimensions < 0 check is covered by the PR's declared scope `marshal.go:992` | false-positive | in-scope | yes | nit |  |  |  |  |  |  |  | ✓ |
| 46 | CHANGELOG.md not updated, but the file does not exist in this fork  | false-positive | out-of-scope | no | nit |  | ✓ |  |  |  |  |  | ✓ |
| 47 | Commit subjects do not follow CONTRIBUTING.md's capitalized-subject + trailer format  | false-positive | out-of-scope | no | nit |  |  |  |  |  |  |  | ✓ |
| | **quillstone (Rust)** | | | | |  |  |  |  |  |  |  |  |
| 48 | Pool-level USE failure leaves pooled connections on the old keyspace while pool believes otherwise `scylla/src/network/connection_pool.rs:1287` | real | out-of-scope | no | high |  |  | ✓ |  |  |  |  |  |
| 49 | Permanently failing USE now drains every pool to Broken with no recovery path `scylla/src/network/connection_pool.rs:900` | real | in-scope | yes | high |  | ✓ | ✓ |  |  | ✓ | ✓ | ✓ |
| 50 | Untimed use_keyspace await in start_setting_keyspace_for_connection can wedge the refiller forever `scylla/src/network/connection_pool.rs:1341` | real | out-of-scope | no | high |  | ✓ |  | ✓ |  |  | ✓ |  |
| 51 | Shard-aware-miss discard drops a counted connection without decrementing total_connections `scylla/src/network/connection_pool.rs:994` | real | in-scope | no | medium | ✓ | ✓ | ✓ | ✓ |  |  | ✓ | ✓ |
| 52 | PoolRefiller has no Drop impl, so pool teardown leaks the whole total_connections count `scylla/src/network/connection_pool.rs:697` | real | out-of-scope | no | medium | ✓ |  | ✓ | ✓ |  | ✓ | ✓ |  |
| 53 | Keyspace-setup failure log downgraded from warn! to debug! as it became consequential `scylla/src/network/connection_pool.rs:903` | real | in-scope | yes | medium |  |  |  |  |  | ✓ | ✓ | ✓ |
| 54 | Hoisting the keyspace check above maybe_reshard defers sharder and shard-aware-port discovery `scylla/src/network/connection_pool.rs:911` | real | in-scope | yes | low |  | ✓ |  | ✓ |  | ✓ | ✓ | ✓ |
| 55 | decrement_total_connections does N fetch_sub(1) calls instead of one bulk Metrics helper `scylla/src/network/connection_pool.rs:1360` | real | in-scope | yes | nit | ✓ | ✓ |  | ✓ |  | ✓ |  | ✓ |
| 56 | dec_total_connections wraps rather than saturating, so a future off-by-one underflows the gauge `scylla/src/observability/metrics.rs:342` | real | out-of-scope | no | nit |  | ✓ |  |  |  |  | ✓ |  |
| 57 | 'decrement then clear excess' pattern duplicated across three call sites, one of them drifted `scylla/src/network/connection_pool.rs:674` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  | ✓ |
| 58 | Private ConnectionSetupError overlaps the public ConnectionError::UseKeyspaceError added in the same PR `scylla/src/network/connection_pool.rs:1418` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 59 | ConnectionSetupError is undocumented and name-collides with the public ConnectionSetupRequestError `scylla/src/network/connection_pool.rs:1418` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ | ✓ |
| 60 | UseKeyspaceError under ConnectionError contradicts that type's 'connection must be dropped' doc contract `scylla/src/errors.rs:599` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 61 | Two new keyspace tests omit setup_tracing(), which CONTRIBUTING.md requires `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low |  |  |  | ✓ |  | ✓ | ✓ | ✓ |
| 62 | keyspace_setup_failure_triggers_refill asserts need_filling(), which was already true before the event `scylla/src/network/connection_pool.rs:1494` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 63 | Hand-forged SET_KEYSPACE frame bytes in test are undocumented and can silently desync from the parser `scylla/src/network/connection_pool.rs:1534` | real | in-scope | yes | nit |  | ✓ |  |  |  | ✓ |  |  |
| 64 | make_rules re-implements start_simulated_node's OPTIONS/STARTUP rules instead of parameterizing it `scylla/src/network/connection_pool.rs:1527` | real | in-scope | yes | nit |  |  |  |  |  | ✓ | ✓ |  |
| 65 | initial_shard_info passed to start_simulated_node in the resharding test is dead `scylla/src/network/connection_pool.rs:1868` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |  |
| 66 | unrequested_connection_event duplicates shard_aware_attempt_result apart from requested_shard `scylla/src/network/connection_pool.rs:1855` | real | in-scope | yes | nit |  | ✓ |  |  |  |  |  |  |
| 67 | full_pool metrics test still wall-clock busy-polls despite the 'avoid busy-waiting' commit `scylla/src/network/connection_pool.rs:2000` | real | in-scope | yes | low |  |  |  |  |  | ✓ | ✓ | ✓ |
| 68 | maybe_reshard's excess_connections decrement term is never exercised with a non-empty excess pool `scylla/src/network/connection_pool.rs:1113` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 69 | No test covers a pool going Broken(UseKeyspaceError) and recovering to Ready `scylla/src/network/connection_pool.rs:1526` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 70 | No test covers keyspace failure emptying the pool and firing ConnectivityChangeEvent::Lost `scylla/src/network/connection_pool.rs:1157` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 71 | No test confirms refill backoff grows across repeated keyspace failures, or covers a USE that never answers `scylla/src/network/connection_pool.rs:1474` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 72 | No test drives the increment half of the total_connections invariant end to end `scylla/src/network/connection_pool.rs:1868` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 73 | PR description covers only one of four commits, omitting all the total_connections metric-balancing work  | real | in-scope | yes | low |  | ✓ |  |  |  |  |  | ✓ |
| 74 | Stated validation commands never compile or run the three new metrics-gated tests `scylla/Cargo.toml:34` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |  |
| 75 | PR description's 'Fixes: #1682' points at an issue that does not exist in this repository  | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 76 | All four commit messages are subject-only, against CONTRIBUTING.md's what-and-why requirement  | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |  |
| 77 | Commit 617139df is an unsquashed fixup of 0d91aa54  | real | in-scope | yes | low |  |  |  |  |  |  | ✓ | ✓ |
| 78 | Inline dec_total_connections at the keyspace arm is inconsistent with the new helper and proxy.finish() handling `scylla/src/network/connection_pool.rs:901` | false-positive | in-scope | yes | nit |  |  |  |  |  |  |  | ✓ |
| 79 | Keyspace arm sets had_error_since_last_refill even for shard-aware attempts, unlike the Connection arm `scylla/src/network/connection_pool.rs:901` | false-positive | in-scope | yes | low |  | ✓ |  |  |  |  |  | ✓ |
| 80 | New public ConnectionError variant added with no changelog entry `scylla/src/errors.rs:599` | false-positive | in-scope | yes | nit |  |  |  |  |  |  |  | ✓ |
| 81 | Pool-full excess clear in the run loop has no test `scylla/src/network/connection_pool.rs:673` | false-positive | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 82 | New total_connections tests unnecessarily gated behind the metrics feature `scylla/src/network/connection_pool.rs:1867` | false-positive | in-scope | yes | nit |  | ✓ |  |  |  |  |  |  |
| 83 | connection_pool.rs is already large and grows another ~415 lines without being split `scylla/src/network/connection_pool.rs:1443` | real | out-of-scope | yes | nit |  | ✓ |  |  |  |  |  |  |
| 84 | Pointer logging via {:p} flagged as a security issue `scylla/src/network/connection_pool.rs:683` | false-positive | out-of-scope | no | nit |  |  |  | ✓ |  |  |  |  |
| 85 | tests::many_connections fails in this environment `scylla/src/network/connection_pool.rs:1720` | false-positive | out-of-scope | no | nit | ✓ |  |  |  |  |  | ✓ | ✓ |
| 86 | Double-decrement of total_connections between the new bulk-clear sites and remove_connection `scylla/src/network/connection_pool.rs:1230` | false-positive | in-scope | yes | low | ✓ | ✓ |  |  |  |  | ✓ | ✓ |
| 87 | New ConnectionError::UseKeyspaceError variant is a semver break or breaks exhaustive matches `scylla/src/errors.rs:599` | false-positive | in-scope | yes | nit | ✓ |  |  | ✓ |  |  | ✓ | ✓ |
| | **ironweave (C++)** | | | | |  |  |  |  |  |  |  |  |
| 88 | New regression test is flaky: rpc::stream_closed escapes the test body at smp>1 `tests/unit/rpc_test.cc:2028` | real | in-scope | yes | high |  | ✓ |  |  |  |  |  |  |
| 89 | stream_close() now gates write_buf.close()/stop()/abort() behind an unbounded queue drain `src/rpc/rpc.cc:562` | real | in-scope | yes | high | ✓ | ✓ |  |  |  | ✓ | ✓ | ✓ |
| 90 | Unguarded put(std::span) override breaks the build at SEASTAR_API_LEVEL 7 and 8 `tests/unit/rpc_test.cc:1883` | real | in-scope | yes | medium | ✓ | ✓ | ✓ |  |  | ✓ | ✓ |  |
| 91 | Regression test never asserts the send was refused; closed_error is swallowed `tests/unit/rpc_test.cc:2016` | real | in-scope | yes | medium |  | ✓ | ✓ |  |  | ✓ | ✓ | ✓ |
| 92 | Queue-drain half of the fix has no test coverage at all `src/rpc/rpc.cc:562` | real | in-scope | yes | medium |  | ✓ | ✓ |  |  | ✓ |  |  |
| 93 | Server compressor factory's hooks vector is mutated cross-shard by negotiate() `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | medium |  |  |  |  |  |  | ✓ |  |
| 94 | Comment claims nothing else waits on _outgoing_queue_ready, but stop_send_loop() does `src/rpc/rpc.cc:559` | real | in-scope | yes | low |  |  | ✓ |  |  | ✓ |  | ✓ |
| 95 | Comment names the wrong cause for an exceptional _outgoing_queue_ready `src/rpc/rpc.cc:566` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 96 | Lambda parameter f shadows the function-scope f it is being assigned to `src/rpc/rpc.cc:565` | real | in-scope | yes | nit |  |  |  |  |  | ✓ | ✓ | ✓ |
| 97 | Docs overstate that both halves of a stream must always be closed `doc/rpc-streaming.md:106` | real | in-scope | yes | low |  |  |  |  |  | ✓ | ✓ |  |
| 98 | "Shut down only once both halves are closed" ignores error and peer-driven teardown `doc/rpc-streaming.md:115` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |  |
| 99 | #closing-a-stream anchor does not resolve in the doxygen build `doc/rpc-streaming.md:51` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 100 | send_empty_frame's contract comment not updated for the widened closed_error window `include/seastar/rpc/rpc_types.hh:318` | real | in-scope | yes | low |  |  |  |  |  | ✓ | ✓ |  |
| 101 | New doxygen blocks stacked on top of retained legacy one-line comments `include/seastar/rpc/rpc_types.hh:337` | real | in-scope | yes | nit |  | ✓ |  |  |  | ✓ |  | ✓ |
| 102 | \ref source in sink's doxygen is ambiguous with connected_socket_impl::source() `include/seastar/rpc/rpc_types.hh:341` | unproven | in-scope | yes | nit |  |  |  |  |  | ✓ |  |  |
| 103 | Class-level doxygen states the close contract but sink::close() itself still lacks it `include/seastar/rpc/rpc_types.hh:337` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 104 | Parked data_sink::close() is released on the happy path only, with no scope guard `tests/unit/rpc_test.cc:2026` | real | in-scope | yes | low |  | ✓ |  |  |  | ✓ |  |  |
| 105 | close_entered_cv.wait() has no timeout, so a regression hangs rather than fails `tests/unit/rpc_test.cc:2011` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 106 | Test cannot distinguish a refusal caused by _stream_closing from one caused by _error `tests/unit/rpc_test.cc:2013` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 107 | server_factory is wired up but never read; the server side of the fix is untested `tests/unit/rpc_test.cc:1966` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  | ✓ |
| 108 | server_done initialised to make_ready_future<>() makes its check vacuous `tests/unit/rpc_test.cc:1978` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 109 | test_sink_state is declared inside the lambda body but outlived by the rpc connection `tests/unit/rpc_test.cc:1977` | real | in-scope | yes | low |  | ✓ |  |  |  | ✓ |  |  |
| 110 | Hardcoded hooks.size()==2u plus hooks.back() pins the fixture's connection count and order `tests/unit/rpc_test.cc:2000` | real | in-scope | yes | low |  |  | ✓ |  |  | ✓ | ✓ |  |
| 111 | buffer_size() hardcodes 8192 instead of forwarding to _inner `tests/unit/rpc_test.cc:1895` | real | in-scope | yes | nit |  |  | ✓ |  |  | ✓ | ✓ | ✓ |
| 112 | const_cast used to record hooks instead of a mutable member or a tracker reference `tests/unit/rpc_test.cc:1957` | real | in-scope | yes | nit |  |  | ✓ |  |  | ✓ |  | ✓ |
| 113 | negotiate(feature, is_server) calls abort(), killing the binary with no Boost.Test diagnostic `tests/unit/rpc_test.cc:1960` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 114 | 10-iteration yield loop uses an unexplained magic count and its comment misstates what it does `tests/unit/rpc_test.cc:2022` | real | in-scope | yes | nit |  |  |  |  |  | ✓ | ✓ | ✓ |
| 115 | Test's header comment describes the already-fixed bug in the present tense `tests/unit/rpc_test.cc:1852` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |  |
| 116 | "A pass-through compressor" is inaccurate and the empty-snd_buf swap is uncommented `tests/unit/rpc_test.cc:1937` | real | in-scope | yes | nit |  |  |  |  |  | ✓ | ✓ |  |
| 117 | All three commits and the PR body carry Claude/Anthropic attribution  | real | in-scope | yes | medium |  |  |  |  |  | ✓ | ✓ | ✓ |
| 118 | No DCO Signed-off-by trailer on any of the three commits `doc/contributing.md:6` | real | in-scope | yes | low |  |  |  |  |  |  |  | ✓ |
| 119 | Fixes #3663 / Refs #3653 resolve to nonexistent issues in this repository  | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 120 | _outgoing_queue_ready is left ready while the tail-entry invariant can still be re-established `src/rpc/rpc.cc:562` | real | in-scope | yes | low | ✓ |  |  |  |  |  |  | ✓ |
| 121 | Safety of the stream_close()/stop_send_loop() interleaving rests on an unrecorded ordering assumption `src/rpc/rpc.cc:562` | real | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 122 | sink::close() can now fail where it previously succeeded, undocumented `src/rpc/rpc.cc:569` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 123 | Re-entry into stream_close() is still guarded only by error(), not by the new _stream_closing flag `src/rpc/rpc.cc:550` | real | in-scope | yes | low |  |  |  |  |  |  | ✓ |  |
| 124 | _stream_closing's header comment omits that it is stream-only and never cleared `include/seastar/rpc/rpc.hh:305` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  | ✓ |
| 125 | "Dropping an unclosed sink is an error" understates an unconditional abort `doc/rpc-streaming.md:109` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 126 | shared_promise used without including <seastar/core/shared_future.hh> `tests/unit/rpc_test.cc:1874` | real | in-scope | yes | nit |  |  |  |  |  |  |  | ✓ |
| 127 | New comments use two spaces after a full stop, unlike every other comment in these files `src/rpc/rpc.cc:551` | real | in-scope | yes | nit |  |  |  |  |  |  | ✓ |  |
| 128 | doc/rpc-streaming.md line runs to 213 characters, inconsistent with its own paragraph `doc/rpc-streaming.md:51` | real | in-scope | yes | nit |  |  |  |  |  |  |  | ✓ |
| 129 | set_reuseaddr/get_reuseaddr silently dropped rather than forwarded to the inner socket `tests/unit/rpc_test.cc:1932` | real | in-scope | yes | nit |  |  |  |  |  | ✓ |  |  |
| 130 | test_connected_socket_impl is a 16-of-17-method delegating wrapper that belongs in loopback_socket.hh `tests/unit/rpc_test.cc:1900` | real | in-scope | yes | nit |  |  |  |  |  |  |  | ✓ |
| 131 | test_sink_state reads as rpc::sink state in a file where sink means rpc::sink `tests/unit/rpc_test.cc:1870` | real | in-scope | yes | nit |  |  |  |  |  |  |  | ✓ |
| 132 | Whether in-the-field compressors tolerate send_empty_frame failing with closed_error is unverified `include/seastar/rpc/rpc_types.hh:321` | unproven | in-scope | yes | low |  | ✓ |  |  |  |  |  |  |
| 133 | Unguarded _connected dereference in the new continuation is asymmetric with stop_send_loop() `src/rpc/rpc.cc:569` | false-positive | out-of-scope | no | low |  | ✓ |  |  |  |  |  | ✓ |
| 134 | Trailing comment about where ~output_stream() asserts is claimed inaccurate `tests/unit/rpc_test.cc:2031` | false-positive | in-scope | yes | nit |  |  |  |  |  | ✓ |  |  |
| 135 | Drain logic would read better as a coroutine `src/rpc/rpc.cc:548` | real | in-scope | yes | low |  |  |  |  |  | ✓ |  |  |
| 136 | Documentation commit is scope creep beyond the issue the PR fixes `doc/rpc-streaming.md:104` | false-positive | in-scope | yes | nit |  |  |  |  |  |  |  | ✓ |
| 137 | Claim that the drain incidentally fixes a second unclaimed bug `src/rpc/rpc.cc:565` | false-positive | out-of-scope | no | nit |  |  |  |  |  |  | ✓ |  |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored. *Lost to limits* is what
the same cell spent on earlier attempts that the account's usage limit cut off mid-review: they
produced nothing and were retried from scratch. Both columns are real money; only the first is the
price of a review.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 93.4% of it is cache reads, which bill at a tenth of
input; cache creation, another 5.0%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 1.6% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(1,155,568 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Only this tool | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Claude Code /code-review | 3 | 13 | 10 | 3 | 0 | 9 | 4 | 0 | 7,114,203 | $8.61 | 32.5 min | $2.91 |
| Compound Engineering ce-code-review | 3 | 60 | 53 | 6 | 1 | 44 | 15 | 21 | 58,704,783 | $53.88 | 107.7 min | $54.12 |
| Trail of Bits differential-review | 3 | 17 | 17 | 0 | 0 | 14 | 7 | 2 | 8,956,747 | $11.49 | 38.2 min | $3.49 |
| Trail of Bits rust-review | 1 | 8 | 6 | 2 | 0 | 4 | 3 | 0 | 10,549,216 | $9.24 | 18.2 min | $13.63 |
| Trail of Bits c-review | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | $0.00 | 19.3 min | $186.41 |
| Anthropic pr-review-toolkit | 3 | 69 | 66 | 2 | 1 | 60 | 10 | 22 | 22,551,362 | $27.88 | 39.1 min | - |
| Superpowers requesting-code-review | 3 | 44 | 40 | 4 | 0 | 33 | 12 | 6 | 8,464,338 | $10.87 | 37.5 min | $2.38 |
| Matt Pocock code-review | 3 | 48 | 37 | 11 | 0 | 37 | 3 | 7 | 8,161,714 | $11.37 | 19.3 min | $4.23 |

### Spend per run

| Tool | tidepool | quillstone | ironweave |
|---|---:|---:|---:|
| Claude Code /code-review | 2,054,916 tok / $2.64 / 9.9 min | 1,626,764 tok / $2.12 / 9.2 min | 3,432,523 tok / $3.85 / 13.3 min |
| Compound Engineering ce-code-review | 26,900,442 tok / $23.06 / 39.0 min | 16,134,498 tok / $14.83 / 32.9 min | 15,669,843 tok / $16.00 / 35.8 min |
| Trail of Bits differential-review | 3,286,181 tok / $4.15 / 16.1 min | 2,575,341 tok / $3.39 / 9.7 min | 3,095,225 tok / $3.95 / 12.3 min |
| Trail of Bits rust-review | - | 10,549,216 tok / $9.24 / 18.2 min | - |
| Trail of Bits c-review | - | - | 0 tok / $0.00 / 19.3 min |
| Anthropic pr-review-toolkit | 11,078,707 tok / $12.57 / 17.1 min | 2,082,090 tok / $2.59 / 7.8 min | 9,390,565 tok / $12.73 / 14.2 min |
| Superpowers requesting-code-review | 2,005,282 tok / $2.86 / 9.8 min | 3,056,275 tok / $3.62 / 13.4 min | 3,402,781 tok / $4.39 / 14.2 min |
| Matt Pocock code-review | 3,220,002 tok / $4.11 / 6.6 min | 1,874,365 tok / $3.11 / 7.1 min | 3,067,347 tok / $4.15 / 5.6 min |

**The 20 scored reviews cost 124,502,363 tokens, $133.34.** A further
**267,736,734 tokens, $267.17** went on attempts the usage limit killed before they
reported, for a bill of $400.51 across the matrix. Judging and extraction are
counted separately.

### Raw claims before judging

What each run said, before merging and verification - the gap between this and *Raised* above is
what the judge merged away as the same defect twice.

| Tool | tidepool | quillstone | ironweave |
|---|---:|---:|---:|
| Claude Code /code-review | 4 | 11 | 3 |
| Compound Engineering ce-code-review | 33 | 19 | 16 |
| Trail of Bits differential-review | 5 | 3 | 7 |
| Trail of Bits rust-review | - | 8 | - |
| Trail of Bits c-review | - | - | 0 |
| Anthropic pr-review-toolkit | 19 | 15 | 38 |
| Superpowers requesting-code-review | 18 | 22 | 15 |
| Matt Pocock code-review | 15 | 18 | 19 |

## What the maintainers actually said

The upstream reviews, fetched at prepare time and never shown to any reviewer or to the judge.
Bot comments are dropped, and so are the PR author's own replies, which are answers rather than
findings.

Read these as context, not as a scoreboard. Every PR here was replayed at the revision that was
merged, which is the revision *after* its review: the defects the maintainers caught were already
fixed in the code the tools were given, so not reporting one is not a miss. What the list is good
for is the other direction - whether a tool raises the kind of thing these maintainers raise, and
whether anything they flagged survived into the merged code.

**`tidepool`** - https://github.com/scylladb/gocql/pull/1094 - 0 inline review comments, 0 thread comments.

No human review comments upstream.

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

- `ironweave/tob-c-review` - exit 143, 184,884,302 tokens and $186.41 spent across 30 sessions. Abandoned after 28 attempts. The c-review skill runs a fan-out Workflow whose subagents together need more tokens than one usage window holds, so every attempt was cut mid-workflow by the usage limit and none ever reached a report; the 28th was killed deliberately to stop the spend. Nothing in this cell bought a review.

## Analysis

### Nobody agrees with anybody

137 distinct issues came out of 20 reviews, and **71 of them were raised by exactly one tool** — 58
of those 71 survived verification. Only 31 issues were raised by three or more tools. Two reviewers
picked at random will mostly hand you disjoint lists, so "run one good reviewer" and "run several
and take the union" are genuinely different products, and the union costs what the sum of its parts
costs.

Consensus is also not a truth signal. Of the 31 issues with three or more reporters, 3 are false
positives, and the worst of them had **four tools agreeing on a double-decrement of
`total_connections` that does not happen**. The most-reported issue in the matrix (6 of 8 tools) is
real, but a claim's weight comes from reading the code, which is what the judge did and what a
reviewer downstream of these tools has to do too.

### The yield is overwhelmingly cosmetic

Of 118 verified-real issues: 10 high, 14 medium, 58 low, 36 nit. Only **three** high-severity
defects in the whole matrix were introduced by the PR under review, and no tool found more than
three of them — the column that would justify the spend is the emptiest one in the report. What the
tools are reliably good at is the layer above the bug: missing test coverage for a branch the PR
added, a comment that no longer matches the code, an error message that names the wrong type. That
is worth something, and it is not what "found a bug" means.

The clearest example is the C++ PR. Five tools independently said `stream_close()` now parks
`write_buf.close()`, `stop()` and `abort()` behind an unbounded queue drain, which is the real
remaining risk in that change and is graded high. Five said the new regression test never asserts
that the send was actually refused — also true, also the kind of thing a human reviewer says. But
the two things the upstream maintainers caught on the first revision, that the barrier promise was
unnecessary and that `_stream_closing` was redundant with the two flags already there, were caught
by nobody, in any of the 7 reviews of that PR.

### Price

The 20 scored reviews cost $133.34. Getting them cost $400.51, because every attempt the account's
usage limit cut off mid-review was thrown away and retried from scratch. The landing page counts
that lost spend in its price ratios; the detailed table splits successful and interrupted attempts.

Two fan-out tools dominate the bill. `ce-code-review` spent $53.88 on completed reviews and lost
$54.12 to interrupted attempts. `c-review` spent $186.41 without producing a report. Against that,
`pr-review-toolkit` raised 69 issues, 66 of them real, for $27.88 and no losses at all, and it is the
only tool in the matrix whose false-positive rate rounds to 3%. `requesting-code-review` found 40
real issues for $13.26 including interrupted spend, the best findings-per-dollar result.

`c-review` never finished. Its Workflow needs more tokens than one usage window holds, so all 28
attempts were cut off mid-fan-out, $186.41 went into that one cell, and no report ever came out of
it. It is parked in `tools.json` rather than deleted: the number is the finding.

### False positives cluster in the confident tools

`mattpocock-review` (23%), `builtin-code-review` (23%) and `tob-rust-review` (25%) are the three
most likely to be wrong, and they are wrong in the same way: a plausible mechanism asserted without
checking the call sites that would have to exist for it to fire. `tob-diff-review` made 17 claims
and none of them were false — the only clean sheet in the matrix — but it also made the fewest
claims per dollar of any non-trivial tool.

### What the harness got wrong, and what it cost

- **Blinding is not airtight.** Every `owner/repo` reference was rewritten and `WebSearch`/`WebFetch`
  were denied, so no run could reach the upstream PR. Product names survive in the source itself
  ("seastar", "gocql", "scylla") and cannot be scrubbed without changing the code under review, so a
  determined reviewer could have guessed the project. Nothing in the transcripts suggests one did.
- **The replayed PR bodies and commits kept the upstream authors' Claude attribution trailers**, and
  several tools dutifully reported them as a policy violation (two separate issues in the table).
  They are real findings about the input and tell you nothing about the reviewer, so read those two
  rows as harness noise.
- **A workflow-based skill ends its headless turn while its own Workflow is still running**, and
  returns a stub. This affected an early `c-review` attempt before it was caught; every tool prompt
  now carries an instruction to keep the turn alive until the workflow result lands. Anything that
  shells out to a fan-out workflow needs that instruction or the measurement is a stub.
- **Two runs were recovered from their transcripts** after a `pkill` pattern matched the runner
  itself. They have no recorded wall time, so their attempt windows were reconstructed by hand from
  session start times and marked `wallMsDerived`.
- **The judge is lenient.** "Real" means the code does what the finding says and that is a defect —
  it does not mean anybody would fix it. 36 of the 118 real issues are nits. The verdict to trust in
  the table is `false-positive`, which required the judge to show the code contradicting the claim.

### If you keep one

`requesting-code-review` gives the most verified findings per attempted dollar. `pr-review-toolkit`
gives the broadest completeness and the lowest false-positive rate, with 22 issues nobody else
found. Add `tob-diff-review` when the diff is what matters and a wrong claim is expensive. Add
`ce-code-review` only when major-issue coverage matters enough to justify the higher and less
predictable spend.

