#!/usr/bin/env node
'use strict'
// Builds the fixture in the current directory: a git repo whose origin names a repository that does
// not exist on GitHub, one committed change on a branch, and a cached prompt for that repository in
// this run's HOME so the skill drafts instead of learning. Identical to the fixture of
// draft-from-cached-prompt; only the prompt differs, and the prompt is the whole case. gh is not
// authenticated in an eval, so every gh call fails and the skill's git fallbacks carry the run --
// which also means the PR the prompt asks for cannot actually be opened, and the run has to say so.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const cwd = process.cwd()
const git = (...a) => execFileSync('git', ['-c', 'user.email=eval@example.invalid', '-c', 'user.name=eval', ...a], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }

const before = `class PoolManager:
    def __init__(self, size):
        self.size = size
        self.workers = []

    def shutdown(self):
        for w in self.workers:
            w.stop()
`
const after = `class PoolManager:
    def __init__(self, size):
        self.size = size
        self.workers = []

    def shutdown(self):
        # Workers still mid-handshake kept the process alive after shutdown returned; join them.
        for w in self.workers:
            w.stop()
        for w in self.workers:
            w.join(timeout=5)
        self.workers.clear()
`
git('init', '-q', '.')
git('remote', 'add', 'origin', 'git@github.com:eval-org/widget-service.git')
write(path.join(cwd, 'widget', 'pool', 'manager.py'), before)
write(path.join(cwd, 'README.md'), '# widget-service\n')
git('add', '.'); git('commit', '-q', '-m', 'Initial pool manager')
git('branch', '-M', 'main')
git('checkout', '-q', '-b', 'fix/pool-shutdown-join')
write(path.join(cwd, 'widget', 'pool', 'manager.py'), after)
git('add', '.'); git('commit', '-q', '-m', 'pool: join workers on shutdown so the process can exit', '-m', 'Fixes #88')

const home = process.env.HOME
const cache = path.join(home, '.claude', 'pr-style-cache', 'github.com', 'eval-org', 'widget-service.md')
write(cache, `---
learned_at: ${new Date().toISOString().slice(0, 10)}
source_prs: [71, 74, 80, 83, 85]
contributors: [maria, tomasz]
pattern: derived
max_bytes: 1400
verified: true
verify_verdict: sound
unresolved: 0
nwo: eval-org/widget-service
---

## Title
Lowercase component prefix, a colon, then an imperative clause under 70 characters:
\`pool: join workers on shutdown\`. No trailing period, no issue number in the title.

## Body
### \`## Why\`  <!-- covers: motivation -->
One short paragraph: the problem as a user or operator saw it, then \`Fixes #N\` on its own line
when an issue exists. Two to four sentences.

### \`## What changed\`  <!-- covers: summary-of-changes -->
Two to four bullets on the change, not a tour of the diff. Name the module, not every file.

### \`## Risk\`  <!-- covers: risk, breaking-changes -->
One or two lines: what could regress, and whether any public interface changed. Write "None." when
nothing did. This repo never writes a testing section in a PR description.

## Forbidden headings
- \`## Test plan\` — this repo does not write one; 2 of 20 sampled bodies had it
- \`## Testing\`
- \`## Summary\` — the title is the summary

## Style
Lead with the fact. No "in order to", no "it is worth noting", no "this PR". Median 700 characters,
middle half 450 to 1100. Code references are raw GitHub permalinks pinned to a full commit SHA on
their own line, never \`path:line\`.

## Notes
No sign-off line, no changelog entry, no checklist.
`)
console.error(`scaffold: fixture ready in ${cwd}, cache at ${cache}`)
