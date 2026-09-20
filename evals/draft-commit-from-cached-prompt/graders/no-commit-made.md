---
type: regex
target: trace
pattern: 'git commit\b|git push\b|git rebase\b|git reset\b'
match: not_contains
weight: 2
---
