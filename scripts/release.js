#!/usr/bin/env node
'use strict'
// The manual release: bump the version everywhere, run the full suite at the new version, commit to
// main, tag vX.Y.Z, push both, publish a GitHub Release with generated notes.
//   node scripts/release.js patch|minor|major|X.Y.Z
// In Actions it runs on a checkout made with RELEASE_TOKEN (an admin's PAT), because the ruleset on
// main lets only repository admins past the required checks. Locally it uses your own credentials.
const { execFileSync } = require('child_process')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const sh = (cmd, args, opts) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim()
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' })

const bump = process.argv[2] || 'patch'
if (process.env.GITHUB_ACTIONS && !process.env.RELEASE_TOKEN) {
  console.error('::error::RELEASE_TOKEN is not set. main is protected by a ruleset that only repository admins bypass, and the ' +
                'default GITHUB_TOKEN is not one. Create a fine-grained PAT with Contents: read and write on this repository ' +
                'and add it as the RELEASE_TOKEN secret.')
  process.exit(1)
}
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') { console.error(`release: on ${branch}, not main`); process.exit(1) }
if (sh('git', ['status', '--porcelain'])) { console.error('release: working tree is not clean'); process.exit(1) }

const version = sh(process.execPath, [path.join(ROOT, 'scripts', 'bump-version.js'), bump])
const tag = 'v' + version
try { sh('git', ['rev-parse', '-q', '--verify', 'refs/tags/' + tag], { stdio: 'ignore' }); console.error(`release: tag ${tag} already exists`); process.exit(1) } catch { /* good: no such tag */ }
console.log('release: ' + version)

run('make', ['ci'])

if (process.env.GITHUB_ACTIONS) {
  run('git', ['config', 'user.name', 'github-actions[bot]'])
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
}
run('git', ['add', '.claude-plugin/plugin.json', 'package.json', 'package-lock.json'])
run('git', ['commit', '-m', 'Release ' + tag])
run('git', ['tag', '-a', tag, '-m', tag])
run('git', ['push', 'origin', 'HEAD:main', tag])
run('gh', ['release', 'create', tag, '--generate-notes', '--title', tag])
console.log('release: published ' + tag)
