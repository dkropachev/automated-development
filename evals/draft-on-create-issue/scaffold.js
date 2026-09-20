#!/usr/bin/env node
'use strict'
// Builds the fixture in the current directory: a git repo whose origin names a repository that does
// not exist on GitHub, two issue forms under .github/ISSUE_TEMPLATE, and a cached issue prompt for
// that repository in this run's HOME - with a bug kind and a feature kind - so the skill drafts
// instead of learning. Identical to the fixture of draft-issue-from-cached-prompt; only the prompt
// differs, and the prompt is the whole case. gh is not authenticated in an eval, so every gh call
// fails and the skill works from the conversation and the repository alone -- which also means the
// issue the prompt asks for cannot actually be filed, and the run has to say so.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const cwd = process.cwd()
const git = (...a) => execFileSync('git', ['-c', 'user.email=eval@example.invalid', '-c', 'user.name=eval', ...a], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }

write(path.join(cwd, 'widget', 'pool', 'manager.py'), `class Worker:
    def connect(self):
        pass

    def stop(self):
        pass


class PoolManager:
    def __init__(self, size):
        self.size = size
        self.workers = [Worker() for _ in range(size)]

    def start(self):
        for w in self.workers:
            w.connect()

    def shutdown(self):
        for w in self.workers:
            w.stop()
`)
write(path.join(cwd, 'README.md'), '# widget-service\n')
write(path.join(cwd, '.github', 'ISSUE_TEMPLATE', 'bug.yml'), `name: Bug report
description: Something that worked or should work does not
title: "[Bug]: "
labels: [bug]
body:
  - type: markdown
    attributes:
      value: Thanks for the report. Search existing issues first.
  - type: textarea
    id: what
    attributes:
      label: What happened?
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: What did you expect?
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
    validations:
      required: true
  - type: input
    id: version
    attributes:
      label: Version
    validations:
      required: true
`)
write(path.join(cwd, '.github', 'ISSUE_TEMPLATE', 'feature.yml'), `name: Feature request
description: Something widget-service does not do yet
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: Problem
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: Proposed solution
  - type: input
    id: version
    attributes:
      label: Version
`)
git('init', '-q', '.')
git('remote', 'add', 'origin', 'git@github.com:eval-org/widget-service.git')
git('add', '.'); git('commit', '-q', '-m', 'Initial pool manager')
git('branch', '-M', 'main')
git('tag', 'v2.3.1')

const home = process.env.HOME
const cache = path.join(home, '.claude', 'issue-style-cache', 'github.com', 'eval-org', 'widget-service.md')
write(cache, `---
learned_at: ${new Date().toISOString().slice(0, 10)}
source_issues: [71, 74, 80, 83, 85, 90]
contributors: [maria, tomasz]
pattern: template
max_bytes: 1800
kinds: [bug, feature]
verified: true
verify_verdict: sound
unresolved: 0
nwo: eval-org/widget-service
---

## Title
Bugs: the form's prefix \`[Bug]: \` then the symptom as a declarative clause under 80 characters,
naming the component: \`[Bug]: pool: shutdown() leaves the process alive\`. Features: imperative, no
prefix: \`Let shutdown() take a join timeout\`. No trailing period, no version in the title.

## Kinds
### \`bug\` — \`.github/ISSUE_TEMPLATE/bug.yml\`, title prefix \`[Bug]: \`, labels \`bug\`
Something that worked or should work does not: a crash, a hang, a wrong result, a regression.
### \`feature\` — \`.github/ISSUE_TEMPLATE/feature.yml\`, labels \`enhancement\`
Something widget-service does not do yet. A regression is a bug, not a feature.
Questions and support requests are not filed here; say so and draft nothing.

## Body
### \`### What happened?\`  <!-- kinds: bug --> <!-- covers: problem -->
Two to four sentences: the symptom as an operator meets it, then what the system was doing at the
time. Required. The cause you suspect, if any, is one sentence marked as a suspicion, at the end.

### \`### What did you expect?\`  <!-- kinds: bug --> <!-- covers: expected -->
One or two sentences of the correct behaviour. Required.

### \`### Steps to reproduce\`  <!-- kinds: bug --> <!-- covers: reproduction -->
A numbered list of the commands actually run, minimal, ending with the observed result. A fenced
block for a one-line command is fine. Required.

### \`### Version\`  <!-- covers: context -->
The released version as a number, then platform and Python version where they could matter:
\`2.3.1, Linux, Python 3.12\`. Never "latest". For a feature, the version the request is against.

### \`### Problem\`  <!-- kinds: feature --> <!-- covers: problem -->
What cannot be done today and who needs it, two to four sentences.

### \`### Proposed solution\`  <!-- kinds: feature --> <!-- covers: expected, proposal -->
The outcome wanted, as behaviour. A design sketch only if the author has one; otherwise one line.

## Forbidden headings
- \`### Proposed solution\` is a feature section; a bug report never carries one - 2 of 14 sampled bugs did
- \`## Summary\` — the title is the summary
- \`### Additional context\` — not in either form

## Style
Lead with the fact. No "Hi team", no "I noticed that", no "in order to", no "it is worth noting".
Speculation about the cause is labelled as such. Logs trimmed to the failing lines. Median 650
characters, middle half 400 to 1100. Code references are raw GitHub permalinks pinned to a full
commit SHA on their own line, never \`path:line\`.

## Notes
No sign-off line, no checklist, no "I have searched for duplicates" line - the form has none. Related
issues are referenced as \`#N\` in the sentence that needs them.
`)
console.error(`scaffold: fixture ready in ${cwd}, cache at ${cache}`)
