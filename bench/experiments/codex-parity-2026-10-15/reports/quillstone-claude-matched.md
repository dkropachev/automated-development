# Code review: PR #1 — connection: discard connections after keyspace setup failure

This review was pinned to head `617139dfa6e0d3653cc77ee54d24d112ebf8bce0`, with base and merge-base `ec5003868283c23a1cecb7c8070c72870315502c`. The checkout was unchanged after the review (HEAD matches and `git status` is clean). The three passes ran as independent Opus agents; I then re-checked the key claims against the source.

The main problem is that a keyspace the server rejects now gradually takes the node out of service. Before this PR, the pool kept such a connection and logged a warning.

## Toolkit

1. **High: a keyspace the server rejects permanently blocks new connections and gradually removes the node from service.** See `scylla/src/network/connection_pool.rs:900-911`, `:1287` and `scylla/src/client/session.rs:2009`.
   - **How it gets stuck:** `PoolRefiller::use_keyspace` sets `current_keyspace` before any `USE` result is known, and nothing ever clears it. `Session::use_keyspace` also stores the name before checking it. So a keyspace that was dropped, or a `use_keyspace` call naming one that doesn't exist, leaves `current_keyspace` pointing at a keyspace the server rejects.
   - **What happens next:** every new connection now hits the new `Keyspace` branch and is discarded. The refill retries with the same stored state, so no retry can succeed without some outside change. As existing connections expire they are not replaced. The pool ends up `Broken(UseKeyspaceError)`, and queries with fully qualified table names to that node fail too.
   - **Before this PR:** the base kept the connection and logged a `warn!` (base `connection_pool.rs:1324`). The PR turns a soft failure into losing the node, and scheduling another refill is not recovery.
2. **High: the failure is now invisible at default log levels.** See `connection_pool.rs:903`.
   - The log for this failure was downgraded from `warn!` to `debug!`.
   - While the pool still has connections, `shared_conns` stays Ready and only `had_error_since_last_refill` changes, so callers see nothing.
   - Combined with finding 1, a node can quietly drain its pool and operators get no signal until it reports Broken.
3. **Medium: the new variant files server-side rejections under connection faults.** See `scylla/src/errors.rs:600-602`.
   - `ConnectionError` is documented as meaning the connection "can no longer be used and should be dropped".
   - `UseKeyspaceError` also covers cases where the transport is healthy: a server error response, `KeyspaceNameMismatch`, and `RequestTimeout`.
   - Users receive these as `ConnectionPoolError::Broken { last_connection_error }`, which reads as a network outage when the real cause is the keyspace.
   - `#[from]` also adds a permanent public `From<UseKeyspaceError> for ConnectionError`.
4. **Medium: `keyspace_setup_failure_triggers_refill` doesn't show that a refill happens.** See `connection_pool.rs:1474`.
   - It calls `handle_ready_connection` directly and never runs `run()`, so neither the refill nor the backoff is exercised.
   - `need_filling()`, `is_empty()` and the empty `ready_connections` are already true on the fresh fixture, so those assertions pass before the action.
   - The metric is incremented by hand with `inc_total_connections()`, not through the real `count_in_metrics` path.
   - The event uses `keyspace_name: None`, while real events on this path always carry `Some`.
   - Only an empty pool with `requested_shard: Some(..)` is covered. A non-empty pool with `Some(..)` and the loss notification are untested.
5. **Low: test robustness gaps in `keyspace_setup_failure_preserves_pool_state`.** See `connection_pool.rs:1526`.
   - `open_connection(..).await` and `ready_connections.next().await` have no deadline.
   - The proxy is not shut down if an assertion panics.
   - Only a server-error rejection is exercised; transport failure and timeout are not.
   - In the failure case it doesn't check `had_error_since_last_refill` or that no notification fired.
6. **Low: a metric test asserts an unbalanced gauge after teardown, and another misses half the formula it targets.**
   - `full_pool_clears_excess_connections_and_balances_metrics` asserts `get_total_connections() == 1` after the worker has exited (`connection_pool.rs:2010-2012`). This locks in the existing teardown leak (`run` returns without decrementing for `conns`, `excess_connections` or in-flight connections) despite the "balance" claim.
   - In `resharding_discards_old_connections_and_balances_metrics` (`:1868`), `excess_connections` is empty, so only the `active_connection_count()` part of the reshard decrement at `:1114-1117` is covered, not the `excess_connections.len()` part.
   - All metric tests set up the gauge with direct `inc_total_connections()` calls rather than the real connection-opening path.

Numeric-comment audit: no added comment states a number.

## Standards

1. **Medium: commit messages don't explain what or why, contradicting the PR checklist.** All four commits have a subject line only. CONTRIBUTING.md requires messages to "clearly explain what is being changed … and what is the reason", yet the PR ticks that box.
   - 7f48315d does several things its subject doesn't mention: it adds a public `ConnectionError` variant, moves keyspace setup ahead of resharding and the shard-aware port update (`connection_pool.rs:912-929`), adds a metric decrement, and downgrades the log level.
2. **Medium: the PR description covers only one of the four commits.** It doesn't mention the metric-balance commits (de164845, 0d91aa54, 617139df) or the log-level downgrade. CONTRIBUTING.md and the PR template ask the description to sum up the changes and their reasons.
3. **Low: commit structure goes against the one-change-per-commit rule.**
   - The fix in de164845 is separated from its tests in 0d91aa54.
   - 617139df is a one-line fixup to a test added in 0d91aa54.
   - That fixup still polls `get_total_connections()` with `sleep(1ms)` inside a 5 s timeout, rather than waiting on a notification.
4. **Low: the stated validation doesn't run any metric code.** The `metrics` feature is off by default (`scylla/Cargo.toml:35` has `default = []`; the feature is defined at `:65`). The stated command doesn't enable it, so every `#[cfg(feature = "metrics")]` assertion and all three new metric tests are skipped. The `keyspace_setup_failure` filter does match exactly two tests.
5. **Low: the new tests skip `setup_tracing()`.** CONTRIBUTING.md says new tests should call it, and every other test in the module does. The two keyspace tests (`connection_pool.rs:1474`, `:1526`) don't.
6. **Low: the new tests duplicate existing helpers.**
   - `:1475-1495` builds a `PoolRefiller` by hand instead of using `mock_pool_refiller()`.
   - `:1526-1591` sets up its own proxy with OPTIONS/STARTUP rules instead of using `start_simulated_node`.
   - It hand-encodes the SetKeyspace result body; the encoding is correct.
7. **Low: the new error text breaks the existing pattern.** Every other wrapper of `UseKeyspaceError` displays `"'USE KEYSPACE <>' request failed: {0}"` (`errors.rs:80`, `:142`, `:172`). The new variant at `:601` uses different wording.
8. **Low: the new private enum breaks neighbouring conventions.** `ConnectionSetupError` (`connection_pool.rs:1418`) has no `Debug`, so the test has to match on it and panic by hand. Its name is also easy to confuse with the public `ConnectionError::ConnectionSetupRequestError`.

## Spec

1. **The PR body leaves out the permanent-failure mode in Toolkit finding 1.**
   - The body says the pool "schedules another refill", but it doesn't say that a keyspace the server rejects causes endless retries and, eventually, a Broken node where the base kept working.
   - No test covers recovery from Broken back to Ready on this path, or a keyspace change while a `USE` is in flight.
2. **Validation and scope mismatch:** see Standards findings 2 and 4. The body's claim that "the failure path preserves the current pool" does hold: the test uses a non-empty pool and would fail on the base, which reshards before `USE`.

The cause of finding 1 isn't new: `PoolRefiller::use_keyspace` set `current_keyspace` before any `USE` result in the base too. What this PR changes is the consequence: a failed `USE` used to leave the connection in the pool, and now it is discarded.
