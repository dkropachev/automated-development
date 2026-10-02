#!/usr/bin/env node
'use strict'

// Deterministic scope identity for review-and-fix-pr. The reviewing model may summarize these
// sources, but it cannot choose their hash or the Git merge base used by coverage.

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
function run(command, args, options = {}) {
  return execFileSync(command, args, Object.assign({ encoding: 'utf8', maxBuffer: 1 << 26 }, options)).trim()
}
function git(root, ...args) { return run('git', ['-C', root, ...args]) }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') }

try {
  const rootIndex = argv.indexOf('--root')
  const requestedRoot = rootIndex >= 0 && argv[rootIndex + 1] && !argv[rootIndex + 1].startsWith('--')
    ? argv[rootIndex + 1] : process.cwd()
  const root = fs.realpathSync(path.resolve(requestedRoot))
  if (fs.realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== root) throw new Error('--root must be the repository top level')
  if (argv.includes('--root-only')) {
    process.stdout.write(JSON.stringify({ ok: true, repoRoot: root }, null, 2) + '\n')
    process.exit(0)
  }
  const prIndex = argv.indexOf('--pr')
  const requestedPr = prIndex >= 0 && argv[prIndex + 1] && !argv[prIndex + 1].startsWith('--')
    ? Number(argv[prIndex + 1]) : null
  if (requestedPr !== null && (!Number.isSafeInteger(requestedPr) || requestedPr < 1)) {
    throw new Error('--pr must be a positive integer')
  }
  const repoIndex = argv.indexOf('--repo')
  const repo = repoIndex >= 0 && argv[repoIndex + 1] && !argv[repoIndex + 1].startsWith('--')
    ? argv[repoIndex + 1]
    : JSON.parse(run('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd: root })).nameWithOwner
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('--repo is not owner/name')
  const prArgs = ['pr', 'view']
  if (requestedPr !== null) prArgs.push(String(requestedPr))
  prArgs.push('--repo', repo, '--json',
    'number,title,body,url,baseRefName,baseRefOid,headRefOid,commits,files,author')
  const pr = JSON.parse(run('gh', prArgs, { cwd: root }))
  const prNumber = pr.number
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 ||
      (requestedPr !== null && pr.number !== requestedPr) || !/^[a-f0-9]{40}$/.test(pr.headRefOid || '') ||
      !/^[a-f0-9]{40}$/.test(pr.baseRefOid || '')) throw new Error('GitHub returned an invalid PR identity')
  run('git', ['-C', root, 'fetch', '--no-tags', '--quiet', '--', 'https://github.com/' + repo + '.git',
    'refs/heads/' + pr.baseRefName, 'refs/pull/' + prNumber + '/head'])
  const head = git(root, 'rev-parse', '--verify', pr.headRefOid + '^{commit}')
  if (head !== pr.headRefOid) throw new Error('PR head is not available as the exact local commit')
  const baseCommit = git(root, 'rev-parse', '--verify', pr.baseRefOid + '^{commit}')
  if (baseCommit !== pr.baseRefOid) throw new Error('GitHub base commit is not available locally')
  const mergeBase = git(root, 'merge-base', baseCommit, head)
  if (!/^[a-f0-9]{40}$/.test(mergeBase)) throw new Error('git merge-base returned no full SHA')

  const body = String(pr.body || '')
  const issueRefs = new Map()
  const occupiedHashes = new Set()
  for (const match of body.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/g)) {
    const issueRepo = match[1], number = Number(match[2])
    issueRefs.set(issueRepo.toLowerCase() + '#' + number, { repo: issueRepo, number })
    occupiedHashes.add((match.index || 0) + match[0].lastIndexOf('#'))
  }
  for (const match of body.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\b/g)) {
    const issueRepo = match[1], number = Number(match[2])
    issueRefs.set(issueRepo.toLowerCase() + '#' + number, { repo: issueRepo, number })
  }
  for (const match of body.matchAll(/#([1-9][0-9]*)\b/g)) {
    if (occupiedHashes.has(match.index || 0)) continue
    const previous = (match.index || 0) > 0 ? body[(match.index || 0) - 1] : ''
    if (/[A-Za-z0-9_]/.test(previous)) continue
    const number = Number(match[1])
    issueRefs.set(repo.toLowerCase() + '#' + number, { repo, number })
  }
  const issues = []
  for (const ref of [...issueRefs.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number)) {
    try {
      const issue = JSON.parse(run('gh', ['issue', 'view', String(ref.number), '--repo', ref.repo, '--json',
        'number,title,body,state'], { cwd: root }))
      issues.push(Object.assign({ repo: ref.repo }, issue))
    } catch (error) {
      throw new Error('linked issue ' + ref.repo + '#' + ref.number + ' could not be read: ' +
        String(error.stderr || error.message || error),
        { cause: error })
    }
  }
  const treeRows = execFileSync('git', ['-C', root, 'ls-tree', '-r', '-z', head],
    { encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0').filter(Boolean)
  const instructionPattern = /^(?:AGENTS\.md|CLAUDE\.md|CONTRIBUTING(?:\.[^/]*)?|DEVELOPING(?:\.[^/]*)?|copilot-instructions\.md)$/i
  const instructions = []
  for (const row of treeRows.sort()) {
    const tab = row.indexOf('\t')
    if (tab < 0) throw new Error('malformed git tree entry')
    const [mode, type, oid] = row.slice(0, tab).split(/\s+/)
    const file = row.slice(tab + 1)
    if (!instructionPattern.test(path.basename(file))) continue
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || !/^[a-f0-9]{40}$/.test(oid)) {
      throw new Error('instruction source is not a regular file in pinned PR head: ' + file)
    }
    const bytes = execFileSync('git', ['-C', root, 'cat-file', 'blob', oid], { maxBuffer: 1 << 26 })
    instructions.push({ path: file, sha256: sha256(bytes), content: bytes.toString('utf8') })
  }
  const sources = { repo, pr, issues, instructions }
  const deferralIndex = argv.indexOf('--deferrals-base64')
  let requestedDeferrals = []
  if (deferralIndex >= 0) {
    try { requestedDeferrals = JSON.parse(Buffer.from(argv[deferralIndex + 1] || '', 'base64').toString('utf8')) } catch (error) {
      throw new Error('--deferrals-base64 is invalid', { cause: error })
    }
    if (!Array.isArray(requestedDeferrals) || requestedDeferrals.some(value => typeof value !== 'string' || !value)) {
      throw new Error('--deferrals-base64 must encode nonempty strings')
    }
  }
  const authorText = [pr.title || '', pr.body || '', JSON.stringify(pr.commits || []),
    ...issues.flatMap(issue => [issue.title || '', issue.body || ''])].join('\n')
  const unverifiedDeferrals = requestedDeferrals.filter(quote => !authorText.includes(quote))
  if (unverifiedDeferrals.length) throw new Error('scope contains deferral text not found verbatim in authoritative sources')
  const startBranchRaw = git(root, 'rev-parse', '--abbrev-ref', 'HEAD')
  const startSha = git(root, 'rev-parse', '--verify', 'HEAD^{commit}')
  const clean = git(root, 'status', '--porcelain=v1', '-z') === ''
  let ghUser = 'unknown'
  try { ghUser = run('gh', ['api', 'user', '--jq', '.login'], { cwd: root }) || 'unknown' } catch {}
  const sourceJson = JSON.stringify({ repo, pr, issues, instructions, repoRoot: root,
    startBranch: startBranchRaw === 'HEAD' ? 'DETACHED' : startBranchRaw, startSha, treeClean: clean,
    mergeBase, ghUser })
  process.stdout.write(JSON.stringify({ ok: true, repo, prNumber, baseRef: pr.baseRefName,
    prHead: head, mergeBase, scopeFingerprint: sha256(Buffer.from(canonical(sources))),
    issueCount: issues.length, instructionCount: instructions.length,
    verifiedDeferrals: requestedDeferrals, sourceJson }, null, 2) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error.stderr || error.message || error).trim().slice(0, 1000) }, null, 2) + '\n')
  process.exitCode = 3
}
