---
type: llm
focus: last_message
weight: 2
---

The response is a drafted PR title and description for a change that makes a worker pool join its
workers on shutdown so the process can exit, referencing issue #88.

Score it against the repository's cached conventions, which the agent was expected to follow:

1. The body has exactly these sections, in this order, with these headings: `## Why`,
   `## What changed`, `## Risk`. No other level-2 heading.
2. `## Why` states the problem an operator saw (the process did not exit after shutdown because
   workers mid-handshake were still alive) and carries `Fixes #88` on its own line.
3. `## What changed` is two to four bullets about the change, not a restatement of the diff line by
   line.
4. `## Risk` is one or two lines and says whether a public interface changed (it did not).
5. The prose is direct: no "in order to", "it is worth noting", "this PR", no filler.
6. No test plan or testing section of any kind, and no claim about tests having been run, since
   none were run and this repository does not write test plans.
7. No file is named that does not exist in the fixture. The only source file is
   `widget/pool/manager.py`.
8. After the draft, at most one closing line, and no offer to open or edit a PR.

Full credit when all eight hold. Deduct proportionally; an invented test section or a claim of tests
run is a major deduction.
