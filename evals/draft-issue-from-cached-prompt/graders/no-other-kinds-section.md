---
type: regex
target: last_message
pattern: '^#{2,3} (Proposed solution|Problem|Summary|Additional context)\s*$|<!--'
flags: m
match: not_contains
weight: 1
---
