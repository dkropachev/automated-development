## Toolkit

- **P2 · Diagnostic regression — keyspace failures lose WARN visibility.** [connection_pool.rs:903](/tmp/ad-codex-focus-20261015/quillstone-split-tests/scylla/src/network/connection_pool.rs:903) replaces the previous WARN with DEBUG. When an existing pool remains nonempty, the failure is also withheld from shared pool errors. With WARN logging enabled, failed replenishment therefore becomes silent; `Connection::use_keyspace` does not independently log ordinary server errors.

- **P2 · Test defect — teardown assertion requires a leaked connection count.** [connection_pool.rs:2011](/tmp/ad-codex-focus-20261015/quillstone-split-tests/scylla/src/network/connection_pool.rs:2011) expects one active connection after stopping and awaiting the worker. That worker owns the fixture’s connection collections and shared snapshot, which are dropped on exit. The new assertion codifies the pre-existing teardown accounting leak, contradicting the metric’s documented meaning and rejecting balanced teardown.

- **P2 · Test defect — new waits lack a local failure bound.** [connection_pool.rs:1634](/tmp/ad-codex-focus-20261015/quillstone-split-tests/scylla/src/network/connection_pool.rs:1634), repeated at line 1667, awaits keyspace setup without a timeout. Its producer awaits an unbounded request-response future; proxy shutdown occurs afterward. A stalled setup therefore prevents the test from reaching cleanup. Nextest supplies a 120-second external deadline, but the advertised `cargo test` command does not. This is a test failure-safety gap, not an introduced production hang.

## Standards

- **P3 · Repository-rule violation — both new keyspace tests omit tracing setup.** [connection_pool.rs:1474](/tmp/ad-codex-focus-20261015/quillstone-split-tests/scylla/src/network/connection_pool.rs:1474) and [line 1526](/tmp/ad-codex-focus-20261015/quillstone-split-tests/scylla/src/network/connection_pool.rs:1526) omit `setup_tracing()`, contrary to [CONTRIBUTING.md:92](/tmp/ad-codex-focus-20261015/quillstone-split-tests/CONTRIBUTING.md:92). When run independently, their failures lack the tracing subscriber and captured diagnostics required by that guidance.

## Spec

No findings.

Issue #1682’s contents were unavailable; specification review used the supplied PR description. Validation commands were not rerun. HEAD and the clean checkout remained unchanged.