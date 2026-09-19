---
type: regex
target: trace
pattern: 'gh pr (create|edit|comment|merge|close)\b|git push'
match: not_contains
weight: 2
---
