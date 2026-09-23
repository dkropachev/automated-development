#!/usr/bin/env node
'use strict'
// `node --check` over every script, so a file the linter is configured to skip still has to parse.
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const ROOT = path.join(__dirname, '..')
let failed = 0
for (const dir of ['bin', 'lib', 'scripts', 'test', 'evals', 'workflows', 'bench']) {
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) { if (f.name !== 'results' && f.name !== 'node_modules') walk(p); continue }
      if (!f.name.endsWith('.js')) continue
      const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' })
      if (r.status !== 0) { failed++; process.stderr.write(r.stderr) }
    }
  }
  if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir))
}
if (failed) { console.error(`syntax-check: ${failed} file(s) failed`); process.exit(1) }
console.log('syntax-check: ok')
