---
type: regex
target: trace
pattern: 'promptgen-driver\.js"? start [^\n]*--learn'
match: not_contains
weight: 3
---
