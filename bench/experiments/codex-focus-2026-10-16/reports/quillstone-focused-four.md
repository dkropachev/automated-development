## Toolkit

- **[P2] Keyspace setup failures lose visibility at INFO/WARN** — [connection_pool.rs:903](/tmp/ad-codex-focus-20261015/quillstone-focused-four/scylla/src/network/connection_pool.rs:903). Failed initialization `USE` requests previously logged at WARN; they now log at DEBUG. When existing connections remain, the error is also withheld from shared pool state. Repeated replacement failures therefore become invisible at INFO/WARN while callers continue receiving the retained connections. Empty pools still expose the error.

- **[P2] New setup waits lack a local failure deadline** — [connection_pool.rs:1634](/tmp/ad-codex-focus-20261015/quillstone-focused-four/scylla/src/network/connection_pool.rs:1634), repeated at line 1667. Both waits depend on a raw `USE` request without a request timeout; this fixture also disables keepalives. If setup stops completing, the test cannot reach its assertions or cleanup. Nextest imposes an external 120-second deadline, but the PR’s documented `cargo test` invocation does not.

- **[P3] Refill regression assertion accepts missing refill scheduling** — [connection_pool.rs:1512](/tmp/ad-codex-focus-20261015/quillstone-focused-four/scylla/src/network/connection_pool.rs:1512). `keyspace_setup_failure_triggers_refill` asserts `need_filling()` on an empty fixture where that predicate was already true. It never exercises the scheduling branch or observes another connection attempt, so it still passes if scheduling after failure is broken. Its other assertions meaningfully verify error handling.

## Standards

- **[P3] New keyspace tests omit prescribed tracing setup** — [connection_pool.rs:1474](/tmp/ad-codex-focus-20261015/quillstone-focused-four/scylla/src/network/connection_pool.rs:1474) and line 1526. [CONTRIBUTING.md:92](/tmp/ad-codex-focus-20261015/quillstone-focused-four/CONTRIBUTING.md:92) says new tests should call `setup_tracing`; neither does. When run individually, these tests lack the prescribed captured tracing diagnostics. No exception appears in the PR description.

## Spec

No findings.

The linked issue’s contents were unavailable, and validation commands were not rerun. HEAD remained pinned and the checkout remained clean.