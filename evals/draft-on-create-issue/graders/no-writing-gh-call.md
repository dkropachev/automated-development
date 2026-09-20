---
type: regex
target: trace
pattern: 'gh issue (edit|comment|close|reopen|transfer|pin|lock|delete)\b|gh label (create|edit|delete)\b'
match: not_contains
weight: 2
---
