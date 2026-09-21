---
type: llm
focus: last_message
weight: 2
---

The agent drafted a PR description for a change that makes a worker pool join its workers on
shutdown so the process can exit, referencing issue #88. The repository's cached prompt is stale but
still the only description of this repo's conventions, so the draft has to follow it rather than fall
back on generic PR-description habits.

Score the title and body:

1. A title in the repository's form: a lowercase component prefix, a colon, an imperative clause
   under 70 characters, no trailing period and no issue number. `pool: ...`.
2. The body has exactly these sections, in this order, with these headings: `## Why`,
   `## What changed`, `## Risk`. No other level-2 heading.
3. `## Why` states the problem an operator saw and carries `Fixes #88` on its own line.
4. No test plan or testing section of any kind.

Full credit when all four hold. Deduct proportionally. A generic body — `## Summary`, `## Test plan`,
a checklist — is a major deduction: staleness is a reason to say so, not a reason to stop using the
cache.
