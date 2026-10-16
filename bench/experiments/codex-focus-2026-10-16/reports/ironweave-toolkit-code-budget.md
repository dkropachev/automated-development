## Toolkit

- **[P1] Runtime defect — queue draining can postpone the shutdown needed to unblock a write.** At [rpc.cc:565](/tmp/ad-codex-focus-20261015/ironweave-toolkit-code-budget/src/rpc/rpc.cc:565), close now waits for an accepted compressor frame’s pending socket write. For a direct write with an empty local buffer, base could reach the POSIX sink’s `SHUT_WR`, unblocking that write. Head waits before reaching that shutdown. A connected peer that stops reading can therefore retain the closing stream indefinitely. Independent abort or disconnect can still unblock it.

- **[P2] Test defect — successful hook completion passes the rejection check.** At [rpc_test.cc:2017](/tmp/ad-codex-focus-20261015/ironweave-toolkit-code-budget/tests/unit/rpc_test.cc:2017), the test catches `closed_error` without requiring it. An implementation that silently drops the frame and returns success passes every assertion, despite the promised error behavior.

- **[P2] Test defect — a failed prerequisite destroys an unclosed sink.** The fatal assertion at [rpc_test.cc:2000](/tmp/ad-codex-focus-20261015/ironweave-toolkit-code-budget/tests/unit/rpc_test.cc:2000) precedes sink cleanup. Failure unwinds the local sink before the enclosing client cleanup, triggering `sink_impl`’s destructor assertion and aborting the executable.

- **[P2] Test defect — the close-entry wait lacks a local failure bound.** At [rpc_test.cc:2011](/tmp/ad-codex-focus-20261015/ironweave-toolkit-code-budget/tests/unit/rpc_test.cc:2011), the test waits solely for the wrapped sink’s close notification. Failure to reach that transition leaves it waiting until the external harness deadline, normally 300 seconds.

## Standards

No findings.

Coverage gaps remain in direct-include and Doxygen-anchor checks.

## Spec

- **[P2] Factual documentation defect — a source-read exception does not necessarily close the source.** [rpc-streaming.md:111](/tmp/ad-codex-focus-20261015/ironweave-toolkit-code-budget/doc/rpc-streaming.md:111), repeated at [rpc_types.hh:387](/tmp/ad-codex-focus-20261015/ironweave-toolkit-code-budget/include/seastar/rpc/rpc_types.hh:387), says reading until the source throws closes it. Deserialization exceptions from `process_one_buffer()` bypass `close_source()`, leaving `_source_closed` false. Following this new contract can therefore leave the connection open after closing the sink. The implementation behavior predates this PR; the inaccurate contract is new.

Linked issue contents and reported execution results were not independently verified offline. Whether the test excludes the older `_error` guard remains unresolved. No tests were run or files changed; HEAD and worktree remained unchanged.