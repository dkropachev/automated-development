## Toolkit

- **[P2] Runtime defect: queue draining can block its own unblocker.** At [rpc.cc:565](/tmp/ad-codex-focus-20261015/ironweave-split-tests/src/rpc/rpc.cc:565), closing now waits for accepted sends before closing the socket. A compressor control frame can be blocked in a direct socket write while the output stream’s local buffers are empty. If the peer stops reading but keeps TCP open, this wait prevents the socket shutdown that would release the write. Base could close the empty stream and reach `shutdown(SHUT_WR)` in this state.

- **[P2] Test defect: the old error guard can satisfy the regression check.** At [rpc_test.cc:2017](/tmp/ad-codex-focus-20261015/ironweave-split-tests/tests/unit/rpc_test.cc:2017), the hook is invoked after observing socket-close entry, which does not establish that `_error` remains false. The server can consume the client’s EOF and close its transport first; the client receive loop then sets `_error`, and `stop_send_loop()` can enter the same parked close. The old guard rejects the hook with `closed_error`, allowing the final assertion to pass without the fix.

- **[P2] Test defect: a failed precondition aborts the executable.** If the assertion at [rpc_test.cc:2000](/tmp/ad-codex-focus-20261015/ironweave-split-tests/tests/unit/rpc_test.cc:2000) fails, unwinding destroys the client sink before `sink.close()` runs. `sink_impl::~sink_impl()` asserts that the sink is closed (`rpc_impl.hh:935`). The fixture’s deferred client shutdown runs after callback-local destruction, so it cannot prevent this process abort.

- **[P3] Factual comment defect: the compressor is not pass-through.** [rpc_test.cc:1937](/tmp/ad-codex-focus-20261015/ironweave-split-tests/tests/unit/rpc_test.cc:1937) describes a pass-through compressor, but its implementation delegates to `lz4_fragmented_compressor`, which changes the encoding and adds chunk headers. The test commit body repeats this description.

## Standards

No findings.

## Spec

- **[P2] Factual documentation defect: a source exception does not always close it.** [rpc_types.hh:386](/tmp/ad-codex-focus-20261015/ironweave-split-tests/include/seastar/rpc/rpc_types.hh:386) and [rpc-streaming.md:110](/tmp/ad-codex-focus-20261015/ironweave-split-tests/doc/rpc-streaming.md:110) say reading until an exception closes/releases the source. A serializer exception propagates through `unmarshall()` and `process_one_buffer()` without calling `close_source()` (`rpc_impl.hh:435–437,942–980`). An application following this guidance can stop reading and close its sink while `_source_closed` remains false, preventing `stream_close()`. Receive failures do close the source; decoding failures are the counterexample.

Review was read-only; HEAD and worktree remained unchanged. No tests or builds ran. Native/custom transport behavior, complete wrapper compatibility across API configurations, and all exceptional teardown paths remain unverified.