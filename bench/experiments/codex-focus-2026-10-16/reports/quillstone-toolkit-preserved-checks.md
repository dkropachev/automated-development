## Toolkit

- **P2 — Diagnostic regression:** [connection_pool.rs:903](/tmp/ad-codex-focus-20261015/quillstone-toolkit-preserved-checks/scylla/src/network/connection_pool.rs:903) logs failed keyspace setup at DEBUG; base logged it at WARN. When an existing pool remains nonempty, the error is also withheld from shared pool state. At INFO/WARN settings, repeated setup failures therefore lose their previous diagnostic visibility.

- **P2 — Test defect:** The new waits at [connection_pool.rs:1634](/tmp/ad-codex-focus-20261015/quillstone-toolkit-preserved-checks/scylla/src/network/connection_pool.rs:1634) and line 1667 have no local deadline. Their producer awaits `USE` without a timeout, and `proxy.finish()` follows both waits. A pending setup can prevent assertions and cleanup from running. Nextest supplies an external 120-second deadline; the reported `cargo test` invocation does not.

- **P3 — Test defect:** [connection_pool.rs:1512](/tmp/ad-codex-focus-20261015/quillstone-toolkit-preserved-checks/scylla/src/network/connection_pool.rs:1512) asserts `need_filling()` in `keyspace_setup_failure_triggers_refill`, but that predicate was already true on the empty fixture. The test never runs the worker or observes another opening attempt. Its other assertions verify error handling, while a worker that never schedules another refill would still pass this claimed refill check.

## Standards

- **P3 — Repository-rule violation:** The new tests at [connection_pool.rs:1474](/tmp/ad-codex-focus-20261015/quillstone-toolkit-preserved-checks/scylla/src/network/connection_pool.rs:1474) and line 1526 omit `setup_tracing()`. [CONTRIBUTING.md:92](/tmp/ad-codex-focus-20261015/quillstone-toolkit-preserved-checks/CONTRIBUTING.md:92) explicitly says new tests should call it. Independent runs of these tests consequently lack the prescribed tracing diagnostics.

- **P3 — Repository-rule violation:** Commits `de164845`, `0d91aa54`, and `7f48315d` only name their changes and have empty bodies. They do not explain the incorrect metric accounting or why failed keyspace setup requires discarding the connection before resharding. [CONTRIBUTING.md:10](/tmp/ad-codex-focus-20261015/quillstone-toolkit-preserved-checks/CONTRIBUTING.md:10) requires commit messages to explain both what changes and why; the PR description does not satisfy that commit-specific requirement.

## Spec

- **P2 — Unmet explicit acceptance criterion:** The description promises that after failed setup “the pool schedules another refill.” The early return at [connection_pool.rs:915](/tmp/ad-codex-focus-20261015/quillstone-toolkit-preserved-checks/scylla/src/network/connection_pool.rs:915) preserves the previous sharder. In the new preservation test’s state—one retained connection filling the old nonsharded pool, with an incoming connection advertising two shards—failed `USE` leaves `is_full()` true and `need_filling()` false. The worker therefore schedules no refill. The test manually opens its subsequent successful connection, so it does not establish the promised retry. Preserving the existing pool succeeds; the unconditional refill promise remains unmet.

Review was read-only; HEAD and worktree remained unchanged. Tests and builds were not run. Issue #1682’s contents and the reported validation results were unavailable for verification.