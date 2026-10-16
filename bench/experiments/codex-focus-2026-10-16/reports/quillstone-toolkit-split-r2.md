## Toolkit

- **TK1 — P2, diagnostic regression:** [connection_pool.rs:903](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split-r2/scylla/src/network/connection_pool.rs:903). Failed initialization `USE` requests previously emitted a warning; they now emit only debug logs. With a nonempty pool, the error also bypasses shared-state publication. At INFO/WARN, repeated refill failures therefore lose their previous diagnostic while the pool remains underfilled.

- **TK2 — P2, test defect:** [connection_pool.rs:1634](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split-r2/scylla/src/network/connection_pool.rs:1634), also line 1667. Both new setup waits lack a local deadline. Their producer ultimately awaits a response oneshot, and fixture keepalives are disabled. A stalled response prevents assertions and subsequent proxy cleanup. Nextest supplies a 120-second external deadline; the advertised `cargo test` invocation does not. The production timeout omission predates this patch; these unbounded test waits are new.

- **TK3 — P3, test defect:** [connection_pool.rs:2011](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split-r2/scylla/src/network/connection_pool.rs:2011). The test expects one active connection after closing the worker’s request channel and awaiting worker termination. In this fixture, termination drops the refiller and its remaining connection owners. The assertion therefore encodes the pre-existing teardown gauge leak and would reject correct teardown accounting. The [metric contract](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split-r2/scylla/src/observability/metrics.rs:526) counts active connections.

- **TK4 — P3, test defect:** [connection_pool.rs:1512](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split-r2/scylla/src/network/connection_pool.rs:1512). `keyspace_setup_failure_triggers_refill` calls the handler directly and checks `need_filling()`, which is already true on its fresh fixture. It never runs the scheduler, so it still passes if refill scheduling after this error is broken. Its error-publication and bookkeeping assertions do verify separate behavior.

## Standards

- **S1 — P3, repository-rule violation:** Both new keyspace tests omit `setup_tracing`: [connection_pool.rs:1474](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split-r2/scylla/src/network/connection_pool.rs:1474) and line 1526. [CONTRIBUTING.md:92](/tmp/ad-codex-focus-20261015/quillstone-toolkit-split-r2/CONTRIBUTING.md:92) explicitly says new tests should call it. When run independently, failing tests therefore lack the tracing diagnostics required by repository guidance.

## Spec

No findings.

Validation commands were not rerun, and compilation at intermediate commits remains unverified. HEAD remained pinned and the worktree clean.