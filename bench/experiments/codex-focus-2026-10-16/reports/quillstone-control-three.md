## Toolkit

- **P2 — Diagnostic regression — [connection_pool.rs:903](/tmp/ad-codex-focus-20261015/quillstone-control-three/scylla/src/network/connection_pool.rs:903).** Failed background `USE` requests previously logged at WARN; they now log at DEBUG. When usable connections remain, the error is also withheld from shared pool state. At INFO/WARN, repeated setup failures can therefore prevent replenishment without the previous diagnostic. Empty-pool error publication does not cover this case.

- **P2 — Test defect — [connection_pool.rs:1634](/tmp/ad-codex-focus-20261015/quillstone-control-three/scylla/src/network/connection_pool.rs:1634), also line 1667.** Both new setup-event waits lack local deadlines. Their producer awaits a network request without a configured request timeout, and the fixture disables keepalive timeouts. A pending setup prevents assertions and explicit teardown from running. Nextest provides an external 120-second deadline; the advertised `cargo test` invocation does not. This is missing test failure protection, not a newly introduced production hang.

- **P3 — Test defect — [connection_pool.rs:1936](/tmp/ad-codex-focus-20261015/quillstone-control-three/scylla/src/network/connection_pool.rs:1936).** The resharding metric test starts with one active connection and zero excess connections. Its assertions still pass if resharding omits the newly added excess-connection decrement. The other clearing tests exercise different branches, so they do not distinguish this incorrect resharding behavior.

## Standards

- **P3 — Repository-rule violation — [connection_pool.rs:1474](/tmp/ad-codex-focus-20261015/quillstone-control-three/scylla/src/network/connection_pool.rs:1474), also line 1526.** Both new keyspace tests omit `setup_tracing()`. [CONTRIBUTING.md:92](/tmp/ad-codex-focus-20261015/quillstone-control-three/CONTRIBUTING.md:92) explicitly requires new tests to call it. Unlike the added metric tests, these tests lack the tracing subscriber needed to capture diagnostic output.

- **P3 — Repository-rule violation — commit messages `de164845` and `7f48315d`.** These fix commits contain only subjects describing their actions; they do not explain the underlying incorrect behavior or motivation. [CONTRIBUTING.md:10](/tmp/ad-codex-focus-20261015/quillstone-control-three/CONTRIBUTING.md:10) requires commit messages to explain both what changes and why. The PR description supplies context, but no exception to the commit-message requirement.

## Spec

- **P2 — Test defect — [connection_pool.rs:1512](/tmp/ad-codex-focus-20261015/quillstone-control-three/scylla/src/network/connection_pool.rs:1512).** `keyspace_setup_failure_triggers_refill` never stimulates refill scheduling. It injects an error directly into the handler and asserts `need_filling()`, which is already true for the fresh empty fixture. It never runs the scheduler or observes another connection attempt. Production behavior that publishes the error but fails to schedule a refill would still pass, despite the test’s claimed transition. Its separate error-state assertions remain meaningful.

Coverage limitations: nonempty shard-aware setup failure, Broken-to-Ready recovery, and last-connection-loss notification lack new regression coverage. Validation commands were not rerun under the review-only instructions. HEAD remains pinned and the worktree is clean.