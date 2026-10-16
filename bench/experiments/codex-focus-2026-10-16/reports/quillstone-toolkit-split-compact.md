## Toolkit

- **P2 — Diagnostic regression:** [connection_pool.rs:903](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split-compact/scylla/src/network/connection_pool.rs:903) logs failed keyspace setup at DEBUG; base logged the same failure at WARN. When existing connections survive, the pool remains Ready and does not expose the error to callers. At WARN-enabled, DEBUG-disabled settings, repeated failed refills therefore lose their previous diagnostic.

- **P2 — Test defect:** [connection_pool.rs:1634](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split-compact/scylla/src/network/connection_pool.rs:1634), also line 1667, awaits setup completion without a local deadline. The underlying `USE` request has no configured timeout, and `proxy.finish()` follows these waits. A stalled setup leaves the new test waiting indefinitely under the documented `cargo test` command. Nextest’s external deadline does not apply to that command.

- **P3 — Test defect:** [connection_pool.rs:1512](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split-compact/scylla/src/network/connection_pool.rs:1512) asserts `need_filling()` in `keyspace_setup_failure_triggers_refill`, but that predicate already holds on the fresh fixture. The test never executes refill scheduling or observes another connection attempt. Its bookkeeping assertions are meaningful, but it would still pass if scheduling the replacement attempt stopped working.

## Standards

- **P3 — Repository-rule violation:** The new keyspace tests at [connection_pool.rs:1474](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split-compact/scylla/src/network/connection_pool.rs:1474) and line 1526 omit `setup_tracing()`. [CONTRIBUTING.md:92](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split-compact/CONTRIBUTING.md:92) explicitly says new tests should call it. The focused invocation therefore lacks the prescribed tracing initialization for failure diagnostics.

## Spec

No findings. The inspected paths discard failed setup connections, preserve the existing pool on failure, and complete successful keyspace setup before resharding.

Review was static; validation commands were not rerun. HEAD and worktree remained unchanged.