## Toolkit

- **[P2] Diagnostic regression — [connection_pool.rs:903](/tmp/ad-codex-parity-20261015/quillstone-package-v5/scylla/src/network/connection_pool.rs:903).** Failed initialization `USE` requests previously emitted WARN; they now emit DEBUG. When a pool retains working connections, the error also leaves its published state `Ready`. With WARN enabled and DEBUG disabled, operators lose the previous explanation for repeated replacement-connection failures.

- **[P2] Test defect: unbounded setup-event waits — [connection_pool.rs:1634](/tmp/ad-codex-parity-20261015/quillstone-package-v5/scylla/src/network/connection_pool.rs:1634), also line 1667.** Both new waits await keyspace setup without a local deadline. The producer awaits a response with keepalives disabled; proxy termination occurs afterward. A stalled exchange prevents the test from failing locally. Nextest provides an external 120-second limit, but the advertised `cargo test` invocation does not. The production timeout omission predates this PR; these test waits are new.

- **[P3] Test defect: refill assertion does not observe a refill — [connection_pool.rs:1512](/tmp/ad-codex-parity-20261015/quillstone-package-v5/scylla/src/network/connection_pool.rs:1512).** `keyspace_setup_failure_triggers_refill` checks `need_filling()` on an empty fixture where that predicate already held before the injected failure. It never executes the scheduling loop or observes another connection attempt, so it would accept behavior that never schedules the promised refill. Its error-bookkeeping assertions remain meaningful.

## Standards

- **[P3] Repository-rule violation: missing tracing setup — [connection_pool.rs:1474](/tmp/ad-codex-parity-20261015/quillstone-package-v5/scylla/src/network/connection_pool.rs:1474), also line 1526.** Both new keyspace tests omit `setup_tracing()`, contrary to [CONTRIBUTING.md:92](/tmp/ad-codex-parity-20261015/quillstone-package-v5/CONTRIBUTING.md:92). A standalone failing run can therefore lack the captured tracing diagnostics required by that guidance. The three new metrics tests comply.

- **[P3] Repository-rule violation: production commit messages omit rationale.** [CONTRIBUTING.md:10](/tmp/ad-codex-parity-20261015/quillstone-package-v5/CONTRIBUTING.md:10) requires messages to explain what changes and why. Commits `de164845` and `7f48315` have empty bodies and subjects naming only the accounting and connection-discard actions. They do not explain the incorrect prior behavior motivating those changes. The PR’s checked commit-message criterion therefore overstates compliance.

## Spec

- **[P3] Repository-rule violation: PR description omits the separate metrics fix — [connection_pool.rs:674](/tmp/ad-codex-parity-20261015/quillstone-package-v5/scylla/src/network/connection_pool.rs:674).** The description covers keyspace rejection and setup ordering, while the series also changes gauge accounting for full-pool cleanup, excess-limit cleanup, and resharding, with three dedicated tests. Their purpose is absent despite the [PR template’s requirement to summarize changes and reasons](/tmp/ad-codex-parity-20261015/quillstone-package-v5/.github/pull_request_template.md:14).

Coverage limitations: linked issue contents and historical validation results were unavailable offline. The added tests do not demonstrate actual refill recovery or resharding with nonempty excess connections. No tests or builds were run. HEAD remained pinned and the worktree remained clean.