#!/usr/bin/env node
'use strict'
// Bump the plugin version in every file that carries it. Usage:
//   node scripts/bump-version.js patch|minor|major|X.Y.Z
// Prints the new version on stdout and nothing else, so a workflow can capture it.
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const FILES = ['.claude-plugin/plugin.json', 'package.json']

const dryRun = process.argv.includes('--dry-run')
const arg = process.argv.slice(2).find(x => x !== '--dry-run')
if (!arg) { console.error('usage: bump-version.js patch|minor|major|X.Y.Z'); process.exit(2) }
const cur = JSON.parse(fs.readFileSync(path.join(ROOT, FILES[0]), 'utf8')).version
let next
if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg
else {
  const [a, b, c] = cur.split('.').map(Number)
  next = arg === 'major' ? `${a + 1}.0.0` : arg === 'minor' ? `${a}.${b + 1}.0` : arg === 'patch' ? `${a}.${b}.${c + 1}` : null
  if (!next) { console.error('bump must be patch, minor, major or X.Y.Z'); process.exit(2) }
}
if (next === cur) { console.error('version is already ' + cur); process.exit(2) }
if (dryRun) { process.stdout.write(next + '\n'); process.exit(0) }
for (const f of FILES) {
  const p = path.join(ROOT, f)
  const o = JSON.parse(fs.readFileSync(p, 'utf8'))
  o.version = next
  fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n')
}
const lock = path.join(ROOT, 'package-lock.json')
if (fs.existsSync(lock)) {
  const o = JSON.parse(fs.readFileSync(lock, 'utf8'))
  o.version = next
  if (o.packages && o.packages['']) o.packages[''].version = next
  fs.writeFileSync(lock, JSON.stringify(o, null, 2) + '\n')
}
process.stdout.write(next + '\n')
