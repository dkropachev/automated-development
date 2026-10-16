## Toolkit

- **[P2] Diagnostic regression — [connection_pool.rs:903](/tmp/ad-codex-focus-20261015/quillstone-split-tests-output/scylla/src/network/connection_pool.rs:903).** Failed background `USE` requests previously logged at WARN; head logs them only at DEBUG. When usable connections remain, the error also stays out of shared pool state. At WARN logging, applications lose visibility into failures preventing the pool from refilling.

- **[P2] Test defect — [connection_pool.rs:2011](/tmp/ad-codex-focus-20261015/quillstone-split-tests-output/scylla/src/network/connection_pool.rs:2011).** The test expects one active connection after closing the request channel and awaiting the owning pool worker’s termination. No connection owner remains, so balanced teardown would yield zero. This new assertion accepts the pre-existing teardown accounting leak and would reject correct accounting.

- **[P3] Test defect — [connection_pool.rs:1512](/tmp/ad-codex-focus-20261015/quillstone-split-tests-output/scylla/src/network/connection_pool.rs:1512).** `keyspace_setup_failure_triggers_refill` asserts `need_filling()`, but that predicate was already true on the fresh, empty fixture. The test never runs the scheduler or observes another connection attempt, so it passes even if the failure leaves the pool Broken without scheduling a retry. Its error-bookkeeping assertions remain meaningful.

## Standards

- **[P3] Repository-rule violation — [connection_pool.rs:1474](/tmp/ad-codex-focus-20261015/quillstone-split-tests-output/scylla/src/network/connection_pool.rs:1474), also line 1526.** Both new keyspace tests omit `setup_tracing()`. [CONTRIBUTING.md:92](/tmp/ad-codex-focus-20261015/quillstone-split-tests-output/CONTRIBUTING.md:92) says “any new tests should too.” Neither test initializes tracing through a helper, leaving independently run failures without the prescribed captured diagnostics.

## Spec

No findings.

Validation was source-only; tests and builds were not run. Complete proxy shutdown safety remains unverified. HEAD and the clean worktree remained unchanged.