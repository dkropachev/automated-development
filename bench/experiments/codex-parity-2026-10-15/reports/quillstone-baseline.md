## Toolkit

- **[P2] A rejected keyspace selection prevents subsequent reconnection** — [connection_pool.rs:1341](/tmp/ad-codex-parity-20261015/quillstone-baseline/scylla/src/network/connection_pool.rs:1341). A failed `Session::use_keyspace("missing", false)` leaves that name stored in `current_keyspace`. Every replacement connection now repeats the rejected `USE` and is discarded. When existing connections disappear, the pool remains Broken—even for fully qualified queries—until another keyspace selection or server-side change. Previously, these replacements were admitted.

- **[P2] Persistent setup failures lose their warning-level diagnostic** — [connection_pool.rs:903](/tmp/ad-codex-parity-20261015/quillstone-baseline/scylla/src/network/connection_pool.rs:903). This path replaces the previous `warn!` with `debug!`. While existing connections remain, it also publishes no error to callers. At INFO/WARN verbosity, repeated replacement failures therefore remain invisible while the pool loses capacity.

## Standards

- **[P3] Both new keyspace tests omit required tracing setup** — [connection_pool.rs:1474](/tmp/ad-codex-parity-20261015/quillstone-baseline/scylla/src/network/connection_pool.rs:1474) and [connection_pool.rs:1526](/tmp/ad-codex-parity-20261015/quillstone-baseline/scylla/src/network/connection_pool.rs:1526). Neither calls `setup_tracing()`, contrary to [CONTRIBUTING.md:92](/tmp/ad-codex-parity-20261015/quillstone-baseline/CONTRIBUTING.md:92). Independently executed failures lack the intended connection and pool traces.

## Spec

The retry and diagnostic regressions are reported under Toolkit. No additional findings.

Review remained read-only; HEAD stayed pinned and the checkout clean. No tests, builds, linters, or formatters were executed.