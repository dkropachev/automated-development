#!/usr/bin/env node
'use strict'
// The draft-from-cached-prompt fixture with the cache aged past 90 days and a failed learn stamped
// an hour ago, so `resolve` prints STALE=1 with LEARN_NOW=0. That pair is the back-off branch: the
// skill must not rebuild, must draft from the stale cache it has, and must say in its closing line
// why the rebuild was skipped. gh is not authenticated in an eval, so every gh call fails and the
// skill's git fallbacks carry the run.
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
const stale = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10)
write(cache, `---
learned_at: ${stale}
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
// The stamp `abandon` and a refused `publish` write. An hour old, well inside the 24-hour back-off,
// so `resolve` reports the cache stale and still says not to learn.
write(cache + '.attempt', JSON.stringify({
  at: new Date(Date.now() - 3600000).toISOString(),
  reason: 'gh is not authenticated; the builder could not sample any merged PR',
  batch: 'pr-gp-eval0000',
}))
console.error(`scaffold: fixture ready in ${cwd}, stale cache at ${cache}`)
