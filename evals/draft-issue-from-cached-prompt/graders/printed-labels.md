---
type: regex
pattern: '^Labels: (?:kind/bug, triage|triage, kind/bug)\s*$'
target: last_message
flags: m
match: contains
weight: 1
---
