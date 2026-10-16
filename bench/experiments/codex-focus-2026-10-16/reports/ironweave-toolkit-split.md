## Toolkit

- **[P2] Queue draining can delay the shutdown needed to unblock a send** — [rpc.cc:562](/tmp/ad-codex-focus-20261015/ironweave-toolkit-split/src/rpc/rpc.cc:562). A compressor frame accepted immediately before closing can have a large socket write pending while the peer stops reading. The new wait delays both buffer closure and `stop()` until that write finishes. Previously, closing an empty local output buffer could reach the socket’s `SHUT_WR` independently of the pending write. Without peer progress, disconnection, or an independent abort, close can now remain pending. Active sends have no remaining timer or cancellation protection.

- **[P2] Successful submission passes the rejection check** — [rpc_test.cc:2017](/tmp/ad-codex-focus-20261015/ironweave-toolkit-split/tests/unit/rpc_test.cc:2017). The test accepts both normal completion and `closed_error`. An implementation that silently drops the frame and returns success would pass, despite violating the promised rejection behavior.

- **[P2] The reproducer can pass through the old error guard** — [rpc_test.cc:2013](/tmp/ad-codex-focus-20261015/ironweave-toolkit-split/tests/unit/rpc_test.cc:2013). Parking client output closure does not prevent the server from consuming EOF, closing its connection, and causing the client receive loop to set `_error`. The hook can then receive `closed_error` even without the new guard, so the claimed deterministic distinction is not established.

- **[P2] The close-entry wait has no local failure bound** — [rpc_test.cc:2011](/tmp/ad-codex-focus-20261015/ironweave-toolkit-split/tests/unit/rpc_test.cc:2011). The wait neither times out nor observes failure of `sink_closed`. If shutdown fails to reach the wrapped close, the test cannot reach its assertions or release action. The runner’s default 300-second executable timeout supplies only external protection.

- **[P2] A fatal assertion bypasses required sink cleanup** — [rpc_test.cc:2000](/tmp/ad-codex-focus-20261015/ironweave-toolkit-split/tests/unit/rpc_test.cc:2000). Failure of the hook-count assertion unwinds past the live, unclosed sink. Its destructor then asserts `sink_closed()`, before the enclosing fixture’s deferred cleanup runs.

The independent Toolkit code pass was incomplete after failed and truncated reads; Spec and parent verification supplied the lifecycle analysis above. Tests were not run.

## Standards

- **[P2] The new factory mutates shared state across server shards** — [rpc_test.cc:1957](/tmp/ad-codex-focus-20261015/ironweave-toolkit-split/tests/unit/rpc_test.cc:1957). The test constructs one `server_factory` and passes its address to every server shard. With two shards, round-robin connection placement invokes negotiations on different shards, each mutating the same `hooks` vector. This violates the documented shard-ownership requirement in `doc/tutorial.md:2229`; the finding does not require simultaneous accesses.

- **[P3] The compressor is inaccurately described as “pass-through”** — [rpc_test.cc:1937](/tmp/ad-codex-focus-20261015/ironweave-toolkit-split/tests/unit/rpc_test.cc:1937). It delegates to LZ4, which adds headers and changes the encoded bytes. It also substitutes the empty-buffer representation. The added description is factually incorrect.

## Spec

- **[P2] A source exception does not necessarily close its connection half** — [rpc_types.hh:387](/tmp/ad-codex-focus-20261015/ironweave-toolkit-split/include/seastar/rpc/rpc_types.hh:387), also stated in [rpc-streaming.md:111](/tmp/ad-codex-focus-20261015/ironweave-toolkit-split/doc/rpc-streaming.md:111). `source_impl::operator()` calls `unmarshall()` without closing the source when deserialization throws. Following the new instruction to stop reading after that exception therefore leaves `_source_closed` false and can prevent stream shutdown. This is an introduced documentation defect describing pre-existing implementation behavior.

HEAD remained pinned and the working tree clean.