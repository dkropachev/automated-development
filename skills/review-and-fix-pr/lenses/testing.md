# Testing lens

Map meaningful changed behavior to tests. Check whether tests exercise the production path and
would fail if the behavior change were removed. Look for missing boundary/failure cases, assertions
that cannot detect the regression, mocks that bypass the changed code, and tests encoding an old
contract. A test gap is a finding only when you can name the behavior left unprotected.
Include client/server, close-order, exception-cleanup, supported-version, and alternate-integration
paths when relevant; do not require the missing behavior already to fail at runtime.
