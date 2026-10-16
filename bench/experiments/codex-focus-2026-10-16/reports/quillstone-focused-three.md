## Toolkit

- **[P2] Keyspace failures lose warning-level visibility** — [connection_pool.rs:903](/tmp/ad-codex-focus-20261015/quillstone-focused-three/scylla/src/network/connection_pool.rs:903). The base logged failed `USE` requests with `warn!`; the new handler uses `debug!`. When the pool retains a usable connection, it also suppresses shared error publication. INFO/WARN subscribers therefore lose the failure signal, and callers continue seeing `Ready`.

- **[P2] Refill regression test never observes a refill** — [connection_pool.rs:1512](/tmp/ad-codex-focus-20261015/quillstone-focused-three/scylla/src/network/connection_pool.rs:1512). `keyspace_setup_failure_triggers_refill` invokes the event handler directly and asserts `need_filling()`, which was already true on its empty fixture. It never runs the scheduling loop or observes a replacement attempt, so it accepts a worker that stops scheduling refills after setup failure.

- **[P2] New setup waits lack local failure deadlines** — [connection_pool.rs:1634](/tmp/ad-codex-focus-20261015/quillstone-focused-three/scylla/src/network/connection_pool.rs:1634), also line 1667. Both waits depend on keyspace setup completing without a local timeout. Nextest supplies a 120-second external deadline; the documented `cargo test` invocation has no equivalent harness deadline. This is missing test-failure protection, not evidence of a production hang.

- **[P3] Final metric assertion expects a closed connection to remain counted** — [connection_pool.rs:2011](/tmp/ad-codex-focus-20261015/quillstone-focused-three/scylla/src/network/connection_pool.rs:2011). After `worker.await`, the consuming refiller task has returned and dropped its remaining connection owners, but the test still requires the active-connection gauge to equal one. That contradicts the metric’s documented meaning and encodes the pre-existing teardown-accounting omission in a new assertion.

## Standards

- **[P3] New keyspace tests omit required tracing setup** — [connection_pool.rs:1474](/tmp/ad-codex-focus-20261015/quillstone-focused-three/scylla/src/network/connection_pool.rs:1474), also line 1526. Neither test calls `setup_tracing()`, contrary to `CONTRIBUTING.md:92`. Their focused invocation therefore lacks the subscriber needed to capture connection and pool diagnostics.

- **[P3] Commit messages omit the required rationale** — commit series, anchored at [connection_pool.rs:674](/tmp/ad-codex-focus-20261015/quillstone-focused-three/scylla/src/network/connection_pool.rs:674). `CONTRIBUTING.md:10` and the PR template require messages explaining what changes and why. The four commits have action-only subjects and empty bodies; they do not explain the underlying accounting and connection-admission problems. The PR claims compliance and provides no exception.

## Spec

No findings.

The checkout remained clean at the pinned head. No tests, builds, or formatting checks were run; supplied validation results remain unverified. Full router teardown and every external error consumer were not exhaustively reviewed.