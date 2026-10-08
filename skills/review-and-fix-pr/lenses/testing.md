# Testing lens

Map meaningful changed behavior to tests. Check whether tests exercise the production path and
would fail if the behavior change were removed. Look for missing boundary/failure cases, assertions
that cannot detect the regression, mocks that bypass the changed code, and tests encoding an old
contract. A test gap is a finding only when you can name the behavior left unprotected.
Include client/server, close-order, exception-cleanup, supported-version, and alternate-integration
paths when relevant; do not require the missing behavior already to fail at runtime.
When client and server share a method, still check whether their hook setup, negotiation, and
fixture entry points differ; one side's test may never drive the other's path. Check the actual
public callback source, not only the shared callee.
Inspect test quality separately from coverage: assertions that pass for the wrong reason, fragile
fixture references or negotiation order, unbounded waits that hide failures, and claims in test
names/comments that exceed what the assertion proves. Give the specific future regression each
issue could miss. Check relevant integration paths as well as the new unit fixture.
