---
type: regex
target: last_message
pattern: '^## (Test plan|Testing|Summary)\s*$'
flags: m
match: not_contains
weight: 1
---
