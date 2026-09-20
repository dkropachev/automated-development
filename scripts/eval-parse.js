#!/usr/bin/env node
'use strict'
// Loads the eval suite with a case filter that matches nothing. The runner still parses and
// validates every case file, so a schema error in evals/ fails CI without spending a token. The
// runner exits 0 on a load failure, so the output is what decides.
const { spawnSync } = require('child_process')
const r = spawnSync(process.env.CLAUDE || 'claude',
  ['plugin', 'eval', '.', '--trust-plugin', '--no-publish', '--ablation', 'none', '--case', 'zz-none-*'],
  { encoding: 'utf8', cwd: require('path').join(__dirname, '..'), timeout: 180000 })
const out = (r.stdout || '') + (r.stderr || '')
process.stdout.write(out)
if (r.error) { console.error('eval-parse: could not run claude: ' + r.error.message); process.exit(1) }
// The filter matching nothing is the one nonzero exit that means the suite loaded; any other is a
// runner that did not get as far as reading the cases.
if (r.status !== 0 && !/No eval cases found matching/.test(out)) { console.error('eval-parse: claude exited ' + String(r.status)); process.exit(1) }
if (/failed to load|unknown frontmatter key|frontmatter must include|frontmatter missing|invalid/i.test(out)) {
  console.error('eval-parse: a case file did not load'); process.exit(1)
}
console.log('eval-parse: ok')
