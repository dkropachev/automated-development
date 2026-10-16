## Toolkit

- **[P2] Refill setup failures lose warning-level visibility** — [connection_pool.rs:903](/tmp/ad-codex-focus-20261015/quillstone-feature-scopes/scylla/src/network/connection_pool.rs:903). Base logged failed `USE` requests with `warn!`; head uses `debug!`. When an existing pool remains nonempty, shared state stays Ready and callers receive no setup error. At INFO/WARN filters, repeated refill failures therefore lose their previous diagnostic visibility.

- **[P3] New setup waits lack a local failure deadline** — [connection_pool.rs:1634](/tmp/ad-codex-focus-20261015/quillstone-feature-scopes/scylla/src/network/connection_pool.rs:1634), also line 1667. Both awaits rely on the setup operation completing, while its helper retains the missing-timeout TODO and the fixture disables keepalives. Nextest supplies an external 120-second deadline; the documented `cargo test` invocation supplies none. This is a test failure-safety gap, not a demonstrated production hang.

## Standards

- **[P3] Both new keyspace tests omit tracing initialization** — [connection_pool.rs:1474](/tmp/ad-codex-focus-20261015/quillstone-feature-scopes/scylla/src/network/connection_pool.rs:1474), also line 1526. Neither calls `setup_tracing()`, contrary to [CONTRIBUTING.md:92](/tmp/ad-codex-focus-20261015/quillstone-feature-scopes/CONTRIBUTING.md:92). Failures lack the prescribed captured tracing diagnostics.

- **[P3] The PR description omits the metrics change** — [connection_pool.rs:674](/tmp/ad-codex-focus-20261015/quillstone-feature-scopes/scylla/src/network/connection_pool.rs:674), also lines 1031 and 1114. The patch separately changes connection-gauge accounting during excess clearing and resharding, with three regression tests. The frozen description explains only keyspace setup handling, leaving this change’s motivation undocumented under [CONTRIBUTING.md:13](/tmp/ad-codex-focus-20261015/quillstone-feature-scopes/CONTRIBUTING.md:13).

- **[P3] Commit rationale is incomplete** — commit `7f48315d306b7657d34fa8c0ae20904b3a8e4e36`, including [connection_pool.rs:915](/tmp/ad-codex-focus-20261015/quillstone-feature-scopes/scylla/src/network/connection_pool.rs:915). Its subject describes discarding failed connections, but does not explain why setup moves before resharding to preserve the existing pool. The empty body supplies no further rationale, falling short of [CONTRIBUTING.md:10](/tmp/ad-codex-focus-20261015/quillstone-feature-scopes/CONTRIBUTING.md:10).

## Spec

No findings.

Validation limitation: the supplied commands omit `--features metrics`, excluding all three new metric tests and conditional gauge assertions. No tests or builds were run during review. HEAD remained pinned and the worktree remained clean.