---
type: regex
target: trace
pattern: 'gh issue (create|edit|comment|close|reopen|transfer|pin|lock|delete)\b|gh label (create|edit|delete)\b|git push'
match: not_contains
weight: 2
---
