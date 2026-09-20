---
type: llm
focus: last_message
weight: 2
---

The agent was asked to create the PR for a change that makes a worker pool join its workers on
shutdown so the process can exit, referencing issue #88. `gh` is unauthenticated in this
environment, so `gh pr create` cannot succeed.

Score the title and body the agent settled on — whether it printed them as a draft, quoted them
back after a failed `gh pr create`, or both:

1. A title in the repository's form: a lowercase component prefix, a colon, an imperative clause
   under 70 characters, no trailing period and no issue number. `pool: ...`.
2. The body has exactly these sections, in this order, with these headings: `## Why`,
   `## What changed`, `## Risk`. No other level-2 heading.
3. `## Why` states the problem an operator saw (the process did not exit after shutdown because
   workers mid-handshake were still alive) and carries `Fixes #88` on its own line.
4. `## What changed` is two to four bullets about the change, not a restatement of the diff line by
   line.
5. `## Risk` is one or two lines and says whether a public interface changed (it did not).
6. No test plan or testing section of any kind, and no claim about tests having been run.
7. The agent says plainly that the PR was not opened, and why — `gh` is not authenticated — rather
   than reporting success or leaving it ambiguous.

Full credit when all seven hold. Deduct proportionally. A generic body — `## Summary`,
`## Test plan`, a checklist, anything the repository's cached conventions do not ask for — is a
major deduction, as is claiming the PR was created.
