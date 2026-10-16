## Toolkit

- **P2 — Keyspace failures lose warning visibility.** At [connection_pool.rs:903](/tmp/ad-codex-focus-20261015/quillstone-toolkit-code-budget/scylla/src/network/connection_pool.rs:903), failed initialization `USE` requests now log at DEBUG instead of WARN. When an existing pool remains usable, shared state stays Ready and callers receive no error. At INFO/WARN thresholds, repeated setup failures therefore lose their previous diagnostic.

- **P2 — New test waits lack a local failure deadline.** The waits at [connection_pool.rs:1634](/tmp/ad-codex-focus-20261015/quillstone-toolkit-code-budget/scylla/src/network/connection_pool.rs:1634) and line 1667 await setup requests without a timeout. Their producer waits on a response oneshot; keepalive is disabled, and proxy shutdown occurs afterward. A stalled request leaves the test pending. Nextest supplies a 120-second external deadline, but the advertised `cargo test` invocation has no equivalent configured bound.

- **P2 — The final metric assertion endorses a teardown leak.** At [connection_pool.rs:2011](/tmp/ad-codex-focus-20261015/quillstone-toolkit-code-budget/scylla/src/network/connection_pool.rs:2011), the new test expects one active connection after awaiting worker termination. The worker owns the refiller and its remaining connections, so teardown leaves zero. This assertion accepts the pre-existing accounting leak and would reject correct teardown accounting.

## Standards

- **P3 — Both new keyspace tests omit required tracing setup.** The tests at [connection_pool.rs:1474](/tmp/ad-codex-focus-20261015/quillstone-toolkit-code-budget/scylla/src/network/connection_pool.rs:1474) and line 1526 never call `setup_tracing()`. [CONTRIBUTING.md:92](/tmp/ad-codex-focus-20261015/quillstone-toolkit-code-budget/CONTRIBUTING.md:92) explicitly requires this for new tests so failure traces are available. The new metrics tests comply; these two do not.

- **P3 — Fix commit messages omit the required rationale.** The metric fix (`de164845`) and keyspace fix (`7f48315d`, including [connection_pool.rs:900](/tmp/ad-codex-focus-20261015/quillstone-toolkit-code-budget/scylla/src/network/connection_pool.rs:900)) have subject-only messages stating their intended changes without explaining the faulty prior behavior. [CONTRIBUTING.md:10](/tmp/ad-codex-focus-20261015/quillstone-toolkit-code-budget/CONTRIBUTING.md:10) requires messages to explain both what changes and why.

## Spec

- **P2 — The refill regression test never exercises refill scheduling.** At [connection_pool.rs:1512](/tmp/ad-codex-focus-20261015/quillstone-toolkit-code-budget/scylla/src/network/connection_pool.rs:1512), `keyspace_setup_failure_triggers_refill` asserts `need_filling()` on a fresh fixture where that predicate was already true. It never starts the run loop or observes another connection attempt. Its bookkeeping assertions are meaningful, but it would still pass if scheduling after setup failure stopped working.

Coverage limitations: the new tests do not exercise Broken-to-Ready recovery, nonempty shard-aware setup failure, or resharding with existing excess connections. Tests and builds were not run. HEAD remained pinned and the worktree clean.