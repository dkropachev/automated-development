---
type: regex
target: last_message
pattern: 'Generated with|Co-Authored-By|claude\.com/claude-code|🤖'
flags: i
match: not_contains
weight: 1
---
