#!/usr/bin/env node
'use strict'
// Builds the fixture in the current directory: a git repo whose origin names a repository that does
// not exist on GitHub, one change STAGED but not committed, and a cached commit-message prompt for
// that repository in this run's HOME so the skill drafts instead of learning. Nothing here needs gh.
// The fixture of draft-commit-from-cached-prompt with one addition; only the prompt differs, and
// the prompt is the whole case. The addition: an author identity in the repo's own config. The run
// is asked to commit, this HOME has no global gitconfig, and without a local one every git commit
// fails with "Author identity unknown" -- which would fail the case for the environment's reason
// rather than the model's. Unlike the create-a-PR and create-an-issue cases, the action here is
// local git and does succeed, so the message that lands is checkable.
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
git('config', 'user.email', 'eval@example.invalid')   // the run has to be able to commit
git('config', 'user.name', 'eval')
git('remote', 'add', 'origin', 'git@github.com:eval-org/widget-service.git')
write(path.join(cwd, 'widget', 'pool', 'manager.py'), before)
write(path.join(cwd, 'README.md'), '# widget-service\n')
git('add', '.'); git('commit', '-q', '-m', 'pool: add PoolManager with a plain stop-all shutdown')
git('branch', '-M', 'main')
git('checkout', '-q', '-b', 'fix/pool-shutdown-join')
write(path.join(cwd, 'widget', 'pool', 'manager.py'), after)
git('add', '.')                                   // staged, deliberately not committed

const home = process.env.HOME
const cache = path.join(home, '.claude', 'commit-style-cache', 'github.com', 'eval-org', 'widget-service.md')
write(cache, `---
learned_at: ${new Date().toISOString().slice(0, 10)}
source_commits: [3f1a9c2, 7be04d1, a91c3e8, c0ffee1, d1e2f3a]
contributors: [maria, tomasz]
pattern: derived
max_bytes: 700
title_max: 60
wrap_at: 72
verified: true
verify_verdict: sound
unresolved: 0
nwo: eval-org/widget-service
---

## Title
\`<component>: <imperative clause>\` - a lowercase component (\`pool\`, \`cli\`, \`api\`, \`docs\`), a colon,
then what the change does in the imperative, no capital, no trailing period, under 60 characters:
\`pool: join workers on shutdown\`, \`cli: drop the --legacy flag\`. No issue number in the subject.
No Conventional Commits types.  <!-- covers: summary -->

## Body
Every change except a typo or comment fix has a body: one or two short paragraphs, wrapped at 72,
opening with the problem as an operator met it, then what was done and - when something was tried
or considered and rejected - why not that. Plain prose, no bullets, no labels, no markdown. Two to
eight lines is typical.  <!-- covers: motivation -->
The issue as \`Fixes #N\` on its own line after the body, when one exists. Nothing when there is
none.  <!-- covers: references -->

## Style
The subject says what; the body says why. Never narrate the diff: no "changed X to Y", no "also
updated the tests", no file-by-file walk. \`path:line\` is fine when a location matters; no web
links, no markdown. No "this commit", no "in order to", no "it is worth noting". No sign-off line -
this repo has no DCO. No Co-authored-by.

## Notes
Reverts use git's own \`Revert "<subject>"\` form with the original SHA in the body. Squash-merge
subjects with a "(#N)" suffix are GitHub's artefact, not this repo's convention: do not add one.
`)
console.error(`scaffold: fixture ready in ${cwd}, staged change in widget/pool/manager.py, cache at ${cache}`)
console.error(`scaffold: HEAD is ${git('rev-parse', '--short', 'HEAD').toString().trim()}; the run is expected to add one commit`)
