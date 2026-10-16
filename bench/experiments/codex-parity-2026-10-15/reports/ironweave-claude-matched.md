## Toolkit

1. **Medium: the new test does not compile at `SEASTAR_API_LEVEL < 9`.** `tests/unit/rpc_test.cc:1883`
   - `test_data_sink_impl` overrides only `put(std::span<temporary_buffer<char>>)`. That virtual exists only under `#if SEASTAR_API_LEVEL >= 9` (`include/seastar/core/iostream.hh:110-128`). Below 9 the base has a pure `put(net::packet)` instead, so `override` fails to compile and the class would also be abstract.
   - The API level can be set through `CMakeLists.txt:72` and `configure.py:161,305`.
   - Other tests guard the same override with `#if SEASTAR_API_LEVEL >= 9`: `tests/unit/loopback_socket.hh:144` and `tests/unit/tls_test.cc:919,2281`.

2. **Low, plausible: the new queue wait can come before the socket shutdown that used to unblock a pending write.** `src/rpc/rpc.cc:562-570`
   - **Trigger:** a hook frame is accepted just before `_stream_closing` is set. Its write takes the direct `zero_copy_put()` → `_fd.put()` path (`iostream-impl.hh:133-138` / `446-451`), and that `put()` blocks because the peer is not reading.
   - **Old order:** `write_buf.close()` → flush with nothing buffered → `_fd.flush()` → `_fd.close()`. On posix that is `shutdown(SHUT_WR)` (`posix-stack.cc:895`), which fails the pending `put()`.
   - **New order:** `queue_drained` waits for that entry's `done` first. `stream_close()`'s own `stop()` is chained after the wait. The only remaining unblockers are the peer draining, the peer disconnecting, or the parent client stopping. A queued successor entry chains on the front entry's `done`, so it waits the same way.
   - **Consequence:** `sink::close()`, or the source read that closes the second half, can stay pending with no deadline.
   - **Scope:** the old code could already stall on a batch flush that was in flight. This specific schedule is newly delayed.

3. **Low: the new test's assertion and cleanup paths are weak.** `tests/unit/rpc_test.cc:2011-2035`
   - **Missing assertion:** the `try`/`catch (closed_error)` never checks that `closed_error` was thrown. A hook that succeeds without writing would also pass.
   - **Uncovered branches:** draining a queue that still holds an accepted entry, and an exceptional `_outgoing_queue_ready` (`then_wrapped` at `rpc.cc:565`).
   - **No deadlines:** `close_entered_cv.wait(...)`, `sink_closed.get()` and `server_done.get()` have none, so a regression hangs the test instead of failing it.
   - **Cleanup:** if `BOOST_REQUIRE_EQUAL(client_factory.hooks.size(), 2u)` fails, the unclosed sink is destroyed and `SEASTAR_ASSERT` in `~sink_impl` (`rpc_impl.hh:935`) aborts the binary. If any exception other than `closed_error` escapes, `release_close` is never set and the parked close is left pending.
   - **What the test does prove:** the refusal is observed while `_error` is still false, because `stop()` is chained after the parked close. So it exercises the new guard, not the old `_error` check.

4. **Low: the shutdown-contract docs contradict the code.**
   - **Hidden abort:** "Dropping an unclosed sink is an error" (`doc/rpc-streaming.md:109`) hides that the consequence is a process-terminating `SEASTAR_ASSERT` (`rpc_impl.hh:935`).
   - **"Only once both halves are closed" is false** (`doc/rpc-streaming.md:116`). The connection also shuts down on a peer eof or error, and when the parent client stops (`abort_all_streams`). The same section says so at L49-51.
   - **One-sided streams:** "Both halves" and "once the source … as well" (`rpc_types.hh:340-342`) are false for them. `_sink_closed` and `_source_closed` both start `true` (`rpc.hh:300-301`), so with only a sink or only a source, closing that one half runs `stream_close()`.
   - **Two sinks:** "close() must be called … before the last reference … goes away" (`rpc_types.hh:339`) can't be met for a second sink. `make_sink()` can be called twice (`rpc_impl.hh:999-1001`). After the first close, the second sink's `close()` fails with "double close" (`rpc_impl.hh:911`), and its destructor checks only the connection-wide flag, so dropping it unclosed doesn't assert.

   Lifecycle table (flags are connection-wide and both start true):

   | Shape | Constructor update | What runs `stream_close()` | Destructor check |
   |---|---|---|---|
   | Sink only | `_sink_closed` T→F | `sink.close()` alone | connection-wide `sink_closed()` |
   | Source only | `_source_closed` T→F | source read to eof or error alone | none |
   | Two sinks via `make_sink()` twice | both set the shared `_sink_closed`=F | first sink's close | second sink passes unclosed; its `close()` → `stream_closed` |

## Standards

1. **Medium: the test mutates shard-0 state from shard 1.** `tests/unit/rpc_test.cc:1957`, `1966-1970`
   - `server_factory` is a local on shard 0 that every shard's server shares. The loopback factory assigns connections round-robin (`loopback_socket.hh:308`). With test.py's default `--smp 2`, which is also the 2-shard run the PR claims, the stream connection negotiates on shard 1.
   - That negotiation runs `const_cast<...>(this)->hooks.push_back(...)` on shard 0's vector, allocating from shard 1. Shard 0 later frees that allocation and destroys a `std::function` capturing a shard-1 connection. This violates the per-shard memory ownership rule (`doc/tutorial.md:1652`).
   - `server_factory.hooks` is never read or asserted.

2. **Low: misleading test comments and names.**
   - **Not pass-through:** the "pass-through compressor" (`rpc_test.cc:1937`, and the 5e25ebdb commit body) delegates to `lz4_fragmented_compressor` and turns an empty buffer into a `temporary_buffer<char>()`.
   - **Present tense for a fixed bug:** the header comment (`rpc_test.cc:1852-1861`) says "connection::send() still accepts frames…" as if it were current, while `rpc.cc:293` now refuses those frames.
   - **Unexplained values:** `buffer_size()` returns a hard-coded `8192` (`:1895`), and `set_reuseaddr`/`get_reuseaddr` are stubbed out (`:1932-1933`), with no comment saying why.
   - **Unclear wrapper names:** `test_data_sink_impl`, `test_connected_socket_impl` and `test_socket_impl` don't say what they add, which is parking `close()` and recording a late `put()`.

3. **Low, plausible: the new anchor link may be dead in Doxygen output.** `doc/rpc-streaming.md:51`
   - `[Closing a stream](#closing-a-stream)` points into a Doxygen input (`doc/Doxyfile.in:764`).
   - The Doxyfile sets no `MARKDOWN_ID_STYLE`, and the heading has no explicit `{#closing-a-stream}` id, so Doxygen likely generates an `autotoc_mdN` id instead. GitHub resolves the link.

4. **Low: issue references point at the wrong repository.** Commit f545c28a's "Fixes #3663" and "Refs #3653", and the same lines in the PR body, resolve to this fork (`dkropachev/ironweave`, links repointed in 5cc62de6). History uses qualified upstream references (e.g. "Fixes scylladb/seastar#3411"), so on merge this would close the fork's #3663, not the upstream issue.

5. **Low, weak rule: no `Signed-off-by` trailer on any of the three commits.** `doc/contributing.md` asks for DCO sign-off, but only under its mailing-list patch section, and `CONTRIBUTING.md` does not repeat it for PRs.

**Audits:**
- **Numeric comments:** "The peer sends one message" (one `sink("seastar")`) and "Two client-side negotiations" (parent plus stream, matching `REQUIRE_EQUAL(..., 2u)`) are both correct. The 141-byte frame appears only in the PR body and the commit message, as field data, and can't be verified here.
- **Line lengths:** all new lines are within `coding-style.md`'s ~160-character rule.
- **Commits:** all three have bodies and `module:` subjects. Putting the fix and its test in separate commits matches the stated backport plan.

## Spec

1. **Low: the new completion dependency is not described.** `src/rpc/rpc.cc:562-570`
   - The PR body and commit message say the drain resolves once the last entry has been "written and flushed into the batch". They don't say that `sink::close()` and `stream_close()` now complete only after earlier accepted frames reach the peer's socket, and that `stop()` is deferred until then.
   - No test covers a non-empty queue or a pending `put()` at `stream_close()`. The trace is in Toolkit 2.

2. **Low: the docs commit and PR body describe the contract as absolute.** Toolkit 4 shows the counterexamples. The docs commit's "Close one half alone and nothing waits for the connection, and it is never shut down" is also false when the peer disconnects or the parent client stops.

Otherwise the code matches the PR description: `send()` refuses once `_stream_closing` is set (`rpc.cc:293`), and a failed queue entry still lets the write buffer close (`rpc.cc:565-569`). The PR does not claim to fix the unflushed frame on the parent client, and that is not a finding.

The reviewed checkout was unchanged: HEAD stayed at `69da8f5bb2f2a53a51946aa4b6ba2124be434cb0` and the working tree was clean before and after.
