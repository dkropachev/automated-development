#!/usr/bin/env node
'use strict'
// Source inventory, not a bug classifier. Read only the frozen Git objects.
const path = require('node:path')
const { execFileSync } = require('node:child_process')

function git(repo, ...args) {
  return execFileSync('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000,
    // No command consumes stdin. Avoid Node's unused stdin pipe, which can fail
    // with EPERM under Codex's read-only sandbox despite Git exiting successfully.
    stdio: ['ignore', 'pipe', 'pipe'] })
}

function changedFiles(raw) {
  const fields = raw.split('\0')
  if (fields.at(-1) === '') fields.pop()
  const files = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]
    const oldPath = fields[i++]
    const renamed = /^[RC]/.test(status)
    const file = renamed ? fields[i++] : oldPath
    if (!/^[ACDMRTUXB][0-9]*$/.test(status) || file === undefined) {
      throw new Error('invalid NUL-delimited changed-file inventory')
    }
    files.push({ status, path: file, ...(renamed ? { oldPath } : {}) })
  }
  return files
}

function addedLines(diff) {
  const added = []
  let line = null
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) { line = null; continue }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (hunk) { line = Number(hunk[1]); continue }
    if (line === null) continue
    if (row.startsWith('+')) added.push({ line: line++, text: row.slice(1) })
    else if (row.startsWith(' ')) line += 1
  }
  return added
}

const isDoc = (file) => /\.(?:md|mdx|rst|adoc)$/i.test(file)
const isComment = (text) => /^(?:\/\/|\/\*|\*|#)/.test(text.trim()) || /\s\/\/|\s\/\*|\s#/.test(text)
const riskPattern = /\bauto\s*&|const_cast|\bfor\s*(?:\(|_\s+in)|\.back\(\)|\.front\(\)|\.hooks\b|\.wait\(|\bsleep\(|\byield_now\(|\b(?:warn|debug|error|info|trace)!|^(?:class|struct)\s+\w+|^(?:bool|std::atomic<bool>|atomic<bool>)\s+_\w+|\b(?:server|client)_factory\b/

function prepareReview({ repo = '.', base, head }) {
  for (const [name, oid] of Object.entries({ base, head })) {
    if (typeof oid !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(oid)) {
      throw new Error(`${name} must be a full commit object ID`)
    }
  }
  repo = path.resolve(repo)
  base = git(repo, 'rev-parse', '--verify', `${base}^{commit}`).trim()
  head = git(repo, 'rev-parse', '--verify', `${head}^{commit}`).trim()
  if (git(repo, 'rev-parse', 'HEAD').trim() !== head) throw new Error('checkout HEAD does not match the frozen head')
  const mergeBase = git(repo, 'merge-base', base, head).trim()
  const range = `${mergeBase}...${head}`
  const files = changedFiles(git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', '-z', range))
  const comments = [], nearby = [], risks = []
  for (const file of files) {
    if (file.status === 'D') continue
    // The old pathname may now be a directory containing unrelated new files.
    // Compare renamed blobs directly so its descendants cannot enter this diff.
    const scope = file.oldPath
      ? [`${mergeBase}:${file.oldPath}`, `${head}:${file.path}`]
      : [range, '--', file.path]
    const diff = git(repo, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color',
      '--find-renames', '--unified=0', ...scope)
    const added = addedLines(diff)
    if (!added.length) continue // Binary files, submodules and pure renames stay in the file list.
    const object = `${head}:${file.path}`
    if (git(repo, 'cat-file', '-t', object).trim() !== 'blob') continue
    const lines = git(repo, 'cat-file', 'blob', object).split('\n')
    const addedNumbers = new Set(added.map((row) => row.line))
    const nearbyNumbers = new Set()
    for (const row of added) {
      const text = row.text.trim()
      const entry = { path: file.path, line: row.line, text }
      if (text && (isDoc(file.path) || isComment(text))) comments.push(entry)
      if (isDoc(file.path)) continue
      if (riskPattern.test(text)) risks.push({ ...entry, kind: 'changed-construct' })
      if (/^func\s+\w*(?:MinSize|Size|Type|Kind|Classify|Metric)\w*\s*\(/.test(text)) {
        risks.push({ ...entry, kind: 'sizing-or-classification-helper' })
      }
      if (/^if\b/.test(text)) {
        const next = lines.slice(row.line, row.line + 12).findIndex((value) => value.trim() === text)
        if (next !== -1) risks.push({ ...entry, kind: 'repeated-condition', relatedLine: row.line + next + 1 })
      }
      for (let n = Math.max(1, row.line - 8); n <= Math.min(lines.length, row.line + 8); n += 1) {
        if (!addedNumbers.has(n) && !nearbyNumbers.has(n) && isComment(lines[n - 1])) {
          nearbyNumbers.add(n)
          nearby.push({ path: file.path, line: n, text: lines[n - 1].trim() })
        }
      }
    }
  }
  const commits = git(repo, 'rev-list', '--reverse', `${mergeBase}..${head}`).trim().split('\n').filter(Boolean).map((oid) => {
    const parent = git(repo, 'show', '-s', '--format=%P', oid).trim().split(' ')[0] || null
    const changed = parent
      ? git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', parent, oid)
      : git(repo, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', oid)
    return {
      oid, filesComparedWith: parent,
      message: git(repo, 'show', '-s', '--format=%B', oid).trimEnd(),
      files: changed.split('\0').filter(Boolean),
    }
  })
  return {
    schemaVersion: 1, base, head, mergeBase,
    workingTreeStatus: git(repo, 'status', '--porcelain=v1'),
    diffCommand: `git diff --no-ext-diff --no-textconv --find-renames ${range}`,
    files, commits, comments, nearby, risks,
  }
}

function renderInventory(data, limits = { comments: 120, nearby: 80, risks: 40 }) {
  const lines = [
    'Frozen source evidence, not findings. Check context before drawing conclusions.',
    `Base: ${data.base}`, `Head: ${data.head}`, `Merge-base: ${data.mergeBase}`, data.diffCommand,
    `Working-tree status: ${data.workingTreeStatus.trim() || 'clean'}`,
    'Changed files:', ...data.files.map((f) => `${f.status} ${JSON.stringify(f.path)}${f.oldPath ? ` (from ${JSON.stringify(f.oldPath)})` : ''}`),
    'Commit/file inventory (relative to each commit’s first parent):',
    ...data.commits.flatMap((c) => [`commit:${c.oid}`, c.message, ...c.files.map((f) => `  ${JSON.stringify(f)}`)]),
  ]
  const keys = data.commits.map((c) => `commit:${c.oid}`)
  for (const [key, label] of Object.entries({ comments: 'Added comment/documentation candidates',
    nearby: 'Nearby existing comment candidates', risks: 'Changed code constructs' })) {
    const shown = data[key].slice(0, limits[key])
    lines.push(`${label} (${shown.length}/${data[key].length}):`)
    for (const row of shown) {
      const location = `${row.path}:${row.line}`
      // Quoting paths prevents newline/tab filenames from fabricating inventory rows.
      lines.push(`${JSON.stringify(row.path)}:${row.line}: ${row.text}${row.relatedLine ? ` [same condition at line ${row.relatedLine}]` : ''}`)
      keys.push(location)
    }
    if (shown.length < data[key].length) {
      lines.push(`INCOMPLETE: ${data[key].length - shown.length} ${key} rows omitted; use --json for the full inventory or inspect the frozen diff. Do not mark omitted claims checked.`)
    }
  }
  lines.push(`Claim audit keys for displayed evidence: ${JSON.stringify([...new Set(keys)])}`)
  return lines.join('\n') + '\n'
}

if (require.main === module) {
  try {
    const options = {}
    let json = false
    const args = process.argv.slice(2)
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--json') { json = true; continue }
      if (!['--repo', '--base', '--head'].includes(args[i]) || !args[i + 1]) {
        throw new Error('usage: prepare-review.js --base FULL_OID --head FULL_OID [--repo DIR] [--json]')
      }
      options[args[i].slice(2)] = args[++i]
    }
    const data = prepareReview(options)
    process.stdout.write(json ? JSON.stringify(data, null, 2) + '\n' : renderInventory(data))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { addedLines, changedFiles, prepareReview, renderInventory }
