## Toolkit

- **T1 — P2: Keyspace setup failures lose warning visibility.** At [connection_pool.rs:903](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split/scylla/src/network/connection_pool.rs:903), failed background `USE` requests are logged at DEBUG; base logged them at WARN. With a nonempty pool, the error also bypasses shared-state publication. At INFO/WARN, repeated refill failures therefore become invisible while callers continue receiving surviving connections.

- **T2 — P2: New setup-result waits lack local deadlines.** The waits at [connection_pool.rs:1634](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split/scylla/src/network/connection_pool.rs:1634) and line 1667 depend on a request with no timeout and disabled keepalives. An unanswered request on an open connection stalls the test before proxy cleanup. Nextest provides a 120-second outer deadline; the PR’s direct `cargo test` command does not. The production timeout omission predates this PR; these test waits are new.

- **T3 — P3: The refill test does not exercise scheduling.** At [connection_pool.rs:1512](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split/scylla/src/network/connection_pool.rs:1512), `need_filling()` is already true on the fresh, empty fixture. The test calls the handler directly without running refill scheduling, so it still passes if error handling never schedules a replacement.

- **T4 — P3: Resharding coverage cannot detect a missing excess-count decrement.** The assertion at [connection_pool.rs:1936](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split/scylla/src/network/connection_pool.rs:1936) follows resharding with one active connection and zero excess connections. Decrementing only the active count would pass, leaving the newly added excess term unchecked. Other tests clear excess through different branches.

- **T5 — P3: The teardown assertion requires a stale connection gauge.** At [connection_pool.rs:2011](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split/scylla/src/network/connection_pool.rs:2011), the test expects one active connection after the worker exits and drops its connection collections. The gauge documents active connections, so this assertion accepts the existing teardown accounting leak and rejects correct zero accounting. The production leak is pre-existing; the assertion is new.

## Standards

- **S1 — P3: Both new keyspace tests omit required tracing setup.** The tests at [connection_pool.rs:1474](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split/scylla/src/network/connection_pool.rs:1474) and line 1526 omit `setup_tracing()`. [CONTRIBUTING.md](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split/CONTRIBUTING.md) says new tests should call it. Run independently, these tests lack the intended captured driver traces on failure.

## Spec

No additional findings. T2–T4 affect the stated regression coverage.

Linked issue #1682 and reported validation results could not be independently verified offline. No tests or builds were run. HEAD remained pinned and the worktree remained clean.