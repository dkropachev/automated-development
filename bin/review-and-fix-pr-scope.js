#!/usr/bin/env node
'use strict'

// Deterministic initial scope for review-and-fix-pr. The reviewing model may summarize these
// sources, but it cannot choose the exact GitHub commits or merge base used by coverage.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const MAX_ISSUES = 20
const MAX_ISSUE_BODY_CHARS = 100000
const MAX_INSTRUCTION_BYTES = 256 * 1024
const MAX_INSTRUCTION_TOTAL_BYTES = 1024 * 1024
function run(command, args, options = {}) {
  return execFileSync(command, args, Object.assign({
    encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'],
  }, options)).trim()
}
function git(root, ...args) { return run('git', ['-C', root, ...args]) }
function utf8(bytes, label) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(label + ' contains non-UTF-8 bytes')
  return text
}
function instructionApplies(file, changedPaths) {
  const directory = path.posix.dirname(file)
  const basename = path.posix.basename(file)
  const globalConvention = directory === '.github' &&
    /^(?:CONTRIBUTING(?:\.[^/]*)?|DEVELOPING(?:\.[^/]*)?|copilot-instructions\.md)$/i.test(basename)
  return directory === '.' || globalConvention || changedPaths.some(changed =>
    changed === file || changed.startsWith(directory + '/'))
}
function collectIssueReferences(body, repo) {
  const candidates = []
  const occupiedHashes = new Set()
  let ignoredCrossRepoIssueCount = 0
  for (const match of String(body || '').matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/g)) {
    const issueRepo = match[1], number = Number(match[2])
    if (issueRepo.toLowerCase() === repo.toLowerCase()) {
      candidates.push({ index: match.index || 0, repo, number })
    } else ignoredCrossRepoIssueCount++
    occupiedHashes.add((match.index || 0) + match[0].lastIndexOf('#'))
  }
  for (const match of String(body || '').matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\b/g)) {
    const issueRepo = match[1], number = Number(match[2])
    if (issueRepo.toLowerCase() === repo.toLowerCase()) {
      candidates.push({ index: match.index || 0, repo, number })
    } else ignoredCrossRepoIssueCount++
  }
  for (const match of String(body || '').matchAll(/#([1-9][0-9]*)\b/g)) {
    if (occupiedHashes.has(match.index || 0)) continue
    const previous = (match.index || 0) > 0 ? String(body)[(match.index || 0) - 1] : ''
    if (/[A-Za-z0-9_]/.test(previous)) continue
    const number = Number(match[1])
    candidates.push({ index: match.index || 0, repo, number })
  }
  const issueRefs = new Map()
  for (const candidate of candidates.sort((a, b) => a.index - b.index || a.number - b.number)) {
    issueRefs.set(repo.toLowerCase() + '#' + candidate.number,
      { repo: candidate.repo, number: candidate.number })
  }
  const all = [...issueRefs.values()]
  return {
    refs: all.slice(0, MAX_ISSUES),
    omittedIssueReferenceCount: Math.max(0, all.length - MAX_ISSUES),
    ignoredCrossRepoIssueCount,
  }
}

function main() {
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
  const changedPathBytes = execFileSync('git', ['-C', root, '-c', 'color.ui=false',
    '--literal-pathspecs', 'diff', '--name-only', '-z', '--no-renames', '--no-ext-diff',
    '--no-textconv', mergeBase + '...' + head], { maxBuffer: 1 << 28 })
  const changedPaths = utf8(changedPathBytes, 'changed path inventory').split('\0').filter(Boolean)

  const issueReferenceSummary = collectIssueReferences(pr.body, repo)
  const issues = []
  for (const ref of issueReferenceSummary.refs) {
    try {
      const issue = JSON.parse(run('gh', ['issue', 'view', String(ref.number), '--repo', ref.repo, '--json',
        'number,title,body,state,author'], { cwd: root }))
      if (String(issue.body || '').length > MAX_ISSUE_BODY_CHARS) {
        issue.body = String(issue.body).slice(0, MAX_ISSUE_BODY_CHARS)
        issue.bodyTruncated = true
      }
      issues.push(Object.assign({ repo: ref.repo }, issue))
    } catch {
      // Blinded benchmark PRs and repository migrations can preserve issue references without
      // republishing the linked issue. Retain a stable explicit absence in the frozen sources:
      // never invent issue text, and never hash transient API errors or request IDs.
      issues.push({
        repo: ref.repo, number: ref.number, title: '', body: '', state: 'unavailable',
        unavailable: true,
      })
    }
  }
  const instructionPattern = /^(?:AGENTS\.md|CLAUDE\.md|CONTRIBUTING(?:\.[^/]*)?|DEVELOPING(?:\.[^/]*)?|copilot-instructions\.md)$/i
  const instructionsByBlob = new Map()
  for (const [source, commit] of [['base', mergeBase], ['head', head]]) {
    const treeRows = execFileSync('git', ['-C', root, 'ls-tree', '-r', '-z', commit],
      { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean)
    for (const row of treeRows.sort()) {
      const tab = row.indexOf('\t')
      if (tab < 0) throw new Error('malformed git tree entry')
      const [mode, type, oid] = row.slice(0, tab).split(/\s+/)
      const file = row.slice(tab + 1)
      if (!instructionPattern.test(path.basename(file)) || !instructionApplies(file, changedPaths)) continue
      if (type !== 'blob' || !['100644', '100755'].includes(mode) || !/^[a-f0-9]{40}$/.test(oid)) {
        throw new Error(`instruction source is not a regular file in pinned PR ${source}: ${file}`)
      }
      const key = file + '\0' + oid
      const existing = instructionsByBlob.get(key)
      if (existing) {
        existing.sources.push(source)
      } else {
        instructionsByBlob.set(key, { path: file, oid, sources: [source] })
      }
    }
  }
  const instructionCandidates = [...instructionsByBlob.values()].sort((a, b) =>
    a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path) || a.oid.localeCompare(b.oid))
  const instructions = []
  const instructionOmissions = []
  let instructionBytes = 0
  for (const candidate of instructionCandidates) {
    const bytes = execFileSync('git', ['-C', root, 'cat-file', 'blob', candidate.oid], { maxBuffer: 1 << 26 })
    let content
    try { content = utf8(bytes, candidate.path) } catch {
      instructionOmissions.push({ ...candidate, bytes: bytes.length, reason: 'non-utf8' })
      continue
    }
    if (bytes.length > MAX_INSTRUCTION_BYTES) {
      instructionOmissions.push({ ...candidate, bytes: bytes.length, reason: 'per-file-limit' })
      continue
    }
    if (instructionBytes + bytes.length > MAX_INSTRUCTION_TOTAL_BYTES) {
      instructionOmissions.push({ ...candidate, bytes: bytes.length, reason: 'aggregate-limit' })
      continue
    }
    instructionBytes += bytes.length
    instructions.push({ ...candidate, content })
  }
  const startBranchRaw = git(root, 'rev-parse', '--abbrev-ref', 'HEAD')
  const startSha = git(root, 'rev-parse', '--verify', 'HEAD^{commit}')
  const clean = git(root, 'status', '--porcelain=v1', '-z') === ''
  process.stdout.write(JSON.stringify({ ok: true, repo, prNumber, baseRef: pr.baseRefName,
    baseSha: baseCommit, prHead: head, mergeBase,
    repoRoot: root, startBranch: startBranchRaw === 'HEAD' ? 'DETACHED' : startBranchRaw,
    startSha, treeClean: clean, pr, issues, changedPaths, instructions, instructionOmissions,
    issueCount: issues.length, unavailableIssueCount: issues.filter(issue => issue.unavailable).length,
    truncatedIssueCount: issues.filter(issue => issue.bodyTruncated).length,
    omittedIssueReferenceCount: issueReferenceSummary.omittedIssueReferenceCount,
    ignoredCrossRepoIssueCount: issueReferenceSummary.ignoredCrossRepoIssueCount,
    instructionCount: instructions.length, instructionOmissionCount: instructionOmissions.length,
    instructionBytes }, null, 2) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error.stderr || error.message || error).trim().slice(0, 1000) }, null, 2) + '\n')
  process.exitCode = 3
}
}

if (require.main === module) main()

module.exports = { collectIssueReferences, instructionApplies, main }
