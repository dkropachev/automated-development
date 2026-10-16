## Toolkit

- **P2 · Diagnostic regression — keyspace failures lose WARN visibility.** [connection_pool.rs:903](/tmp/ad-codex-focus-20261015/quillstone-focused-three-r2/scylla/src/network/connection_pool.rs:903) logs setup failures at DEBUG, replacing the base’s WARN. When usable connections remain, the pool also suppresses error publication. Repeated failed `USE` requests therefore become silent at INFO/WARN filters.

- **P2 · Test defect — teardown assertion preserves an incorrect gauge.** [connection_pool.rs:2011](/tmp/ad-codex-focus-20261015/quillstone-focused-three-r2/scylla/src/network/connection_pool.rs:2011) expects one active connection after closing the request channel and awaiting the worker that owns the pool. This assertion codifies the pre-existing teardown overcount and rejects accounting consistent with the metric’s active-connection contract.

## Standards

- **P3 · Repository-rule violation — new keyspace tests omit tracing setup.** The tests at [connection_pool.rs:1474](/tmp/ad-codex-focus-20261015/quillstone-focused-three-r2/scylla/src/network/connection_pool.rs:1474) and [1526](/tmp/ad-codex-focus-20261015/quillstone-focused-three-r2/scylla/src/network/connection_pool.rs:1526) omit `setup_tracing()`, required for new tests by [CONTRIBUTING.md:92](/tmp/ad-codex-focus-20261015/quillstone-focused-three-r2/CONTRIBUTING.md:92). Failures lack the prescribed captured tracing diagnostics.

## Spec

No findings.

Tests and builds were not run; historical validation claims remain unverified. HEAD and worktree remained unchanged.