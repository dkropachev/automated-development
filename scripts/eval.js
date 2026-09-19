#!/usr/bin/env node
'use strict'
// Runs the eval suite with real model calls. Refuses to run without credentials, with a notice
// rather than an error, so a fork or a fresh clone is never red for this.
const { spawnSync } = require('child_process')
const path = require('path')
const argv = process.argv.slice(2)
const opt = (f, d) => { const i = argv.indexOf('--' + f); return i === -1 || !argv[i + 1] ? d : argv[i + 1] }
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.log('::notice::CLAUDE_CODE_OAUTH_TOKEN is not set; the eval suite was not run. Create one with ' +
              "'claude setup-token' and add it as a repository secret.")
  process.exit(0)
}
const r = spawnSync(process.env.CLAUDE || 'claude', [
  'plugin', 'eval', '.', '--trust-plugin', '--scaffold', '--no-publish', '--ablation', 'none',
  '--allow-tools', 'Bash', 'Read', 'Write', 'Edit', 'Skill',
  '--case', opt('case', '*'), '--threshold', opt('threshold', '0.8'),
  '--max-cost-usd', opt('max-cost-usd', '5'), '--report', 'eval-report.html', '--json', 'eval-result.json',
], { stdio: 'inherit', cwd: path.join(__dirname, '..') })
process.exit(r.status === null ? 1 : r.status)
