Reviewed pinned head `69da8f5`; checkout unchanged. No tests or builds were run.

## Toolkit

- **[P1] Queue draining can prevent shutdown indefinitely** — [rpc.cc:565](/tmp/ad-codex-parity-20261015/ironweave-baseline/src/rpc/rpc.cc:565). An accepted compressor frame large enough to bypass local buffering can leave a socket `put()` blocked while the peer remains connected but stops reading. The new wait prevents reaching both buffer close and `stop()`, which could unblock that write. Previously, closing an empty local buffer could reach the sink’s `SHUT_WR` independently of the pending write. A queued successor inherits the same blockage. The regression test exercises an empty queue.

- **[P3] The compressor description is inaccurate** — [rpc_test.cc:1937](/tmp/ad-codex-parity-20261015/ironweave-baseline/tests/unit/rpc_test.cc:1937). The helper described as “pass-through” delegates to LZ4 compression, adding framing and changing transmitted bytes. The comment misstates the reproducer’s encoding.

## Standards

- **[P1] The new test wrapper breaks supported API-level builds** — [rpc_test.cc:1883](/tmp/ad-codex-parity-20261015/ironweave-baseline/tests/unit/rpc_test.cc:1883). The unconditional span-based `put()` override exists only at `SEASTAR_API_LEVEL >= 9`. Levels 7 and 8 require `put(net::packet)`, so this override is invalid, its forwarding call has no matching overload, and the wrapper remains abstract.

- **[P2] Compressor negotiation mutates fixture state across shards** — [rpc_test.cc:1957](/tmp/ad-codex-parity-20261015/ironweave-baseline/tests/unit/rpc_test.cc:1957). With two shards, the loopback acceptor places the parent connection on shard 0 and the stream connection on shard 1. Both servers share the factory constructed on shard 0, so stream negotiation modifies its `hooks` vector from shard 1. This violates the repository’s [shard ownership guidance](/tmp/ad-codex-parity-20261015/ironweave-baseline/doc/tutorial.md:2242); the later handler dispatch does not relocate negotiation.

## Spec

- **[P2] A source decoding exception does not close the source** — [rpc-streaming.md:111](/tmp/ad-codex-parity-20261015/ironweave-baseline/doc/rpc-streaming.md:111), also [rpc_types.hh:387](/tmp/ad-codex-parity-20261015/ironweave-baseline/include/seastar/rpc/rpc_types.hh:387). The new contract says reading until the source throws closes it. However, `unmarshall()` exceptions escape outside the receive-error continuation that calls `close_source()`. Following these instructions after a decoding failure leaves `_source_closed` false, so closing the sink does not trigger connection shutdown.