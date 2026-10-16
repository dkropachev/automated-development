# Reliability lens

Inspect failure and lifecycle paths: returned or swallowed errors, retries, timeouts, cancellation,
cleanup, partial success, rollback, idempotency, async ordering, shared state, concurrency, and
background work. Check what happens when dependencies are slow, unavailable, duplicated, or stop
halfway. Prefer a specific reachable failure mode over a general resilience suggestion.
For each exception origin, identify who completes, unregisters, closes, rolls back, and destroys the
resource; cross-check client/server and every meaningful close-order permutation.
For a newly explicit wait, identify its completion source and bound. Check partial test failure and
peer stalls even if another base path could also stall; distinguish a new guarantee or diagnosis
burden from base parity before screening the lead.
