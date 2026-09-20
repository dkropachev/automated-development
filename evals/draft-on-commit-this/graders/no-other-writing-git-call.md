---
type: regex
target: trace
pattern: 'git push\b|git rebase\b|git reset --hard\b|git commit [^\n]*--amend\b'
match: not_contains
weight: 2
---
