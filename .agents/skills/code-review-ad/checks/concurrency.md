# Applicable concurrency checks

Apply the checks below addressed to your assigned pass. They are direct review obligations, not instructions to delegate or spawn agents.

**For callbacks that mutate captured fixture or shared state, include this in Toolkit and Standards prompts:** Trace where the object is constructed, where each callback actually executes, and every scheduler, executor, thread, or shard hop between registration and invocation. Inspect a round-robin or load-balancing acceptor when it chooses the execution context. Compare the mutation with the repository's thread/shard ownership rules; absence of simultaneous access does not by itself make cross-shard mutation valid. Distinguish the callback's execution shard from a later handler's shard, and give a concrete configuration that exercises the hop or explain why none can.
