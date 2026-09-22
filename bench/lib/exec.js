'use strict'
// Every external command the bench runs goes through here, so a failure names the command that
// failed instead of surfacing as an unexplained empty string somewhere downstream.
const { execFileSync, spawnSync } = require('node:child_process')

const BIG = 1 << 28

function run(cmd, args, opts) {
  opts = opts || {}
  const r = spawnSync(cmd, args, { maxBuffer: BIG, encoding: 'utf8', cwd: opts.cwd, env: opts.env || process.env, input: opts.input })
  if (r.error) throw new Error(`${cmd} ${args.join(' ')}: ${r.error.message}`)
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}\n${(r.stderr || '').slice(0, 4000)}`)
  }
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' }
}

const git = (cwd, ...args) => run('git', args, { cwd }).out.trim()
const gitTry = (cwd, ...args) => run('git', args, { cwd, allowFail: true })
const gh = (...args) => execFileSync('gh', args, { maxBuffer: BIG }).toString()
const ghJson = (...args) => JSON.parse(gh(...args))

module.exports = { run, git, gitTry, gh, ghJson }
