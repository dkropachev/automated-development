---
type: regex
target: trace
pattern: 'gh pr (edit|comment|merge|close|ready|review)\b'
match: not_contains
weight: 2
---
