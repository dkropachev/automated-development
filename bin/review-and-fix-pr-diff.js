'use strict'

// Deterministic byte-level diff inventory for the parent review session. Review agents reason
// about the change, while this helper supplies the exact changed paths, hunks, and non-text changes
// that the coverage audit must account for. Hunk digests are compact identifiers within this
// invocation, not persisted integrity or resume machinery.

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const MAX_BUFFER = 1 << 30
const DIFF_OPTIONS = [
  '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '--find-copies=50%',
  '--find-copies-harder',
  '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3',
  '--src-prefix=a/', '--dst-prefix=b/',
]

function git(root, ...args) {
  const bytes = execFileSync('git', ['-C', root, ...args], { maxBuffer: MAX_BUFFER })
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error('git diff output contains non-UTF-8 path or text bytes; refusing an ambiguous coverage inventory')
  }
  return text
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function splitHunks(text) {
  const marks = []
  const pattern = /^@@ /gm
  let match
  while ((match = pattern.exec(text)) !== null) marks.push(match.index)
  if (!marks.length) return { header: text, hunks: [] }
  return {
    header: text.slice(0, marks[0]),
    hunks: marks.map((start, index) => text.slice(start, index + 1 < marks.length ? marks[index + 1] : text.length)),
  }
}

function parseNameStatus(text) {
  const fields = text.split('\0')
  if (fields[fields.length - 1] === '') fields.pop()
  const entries = []
  for (let index = 0; index < fields.length; index++) {
    const rawStatus = fields[index]
    const renamed = /^[RC]/.test(rawStatus)
    if (index + 1 >= fields.length) throw new Error('malformed git --name-status output')
    const source = fields[++index]
    if (renamed && index + 1 >= fields.length) throw new Error('malformed git rename/copy output')
    const file = renamed ? fields[++index] : source
    entries.push({
      rawStatus,
      source,
      path: file,
      status: rawStatus.startsWith('R') ? 'renamed' : rawStatus.startsWith('C') ? 'copied' : rawStatus.startsWith('A') ? 'added' :
        rawStatus.startsWith('D') ? 'deleted' : 'modified',
    })
  }
  return entries
}

function changedEntries(root, base, head) {
  return parseNameStatus(git(root, '-c', 'color.ui=false', '-c', 'diff.renames=true',
    '-c', 'diff.algorithm=myers', '-c', 'diff.context=3', '-c', 'diff.indentHeuristic=false',
    'diff', ...DIFF_OPTIONS, '--name-status', '-z', base + '...' + head))
}

function wholeDiff(root, base, head) {
  return git(root, '-c', 'color.ui=false', '-c', 'diff.renames=true', '-c', 'diff.algorithm=myers',
    '-c', 'diff.context=3', '-c', 'diff.indentHeuristic=false',
    'diff', ...DIFF_OPTIONS, base + '...' + head)
}

function splitFileDiffs(text) {
  const marks = []
  const pattern = /^diff --git /gm
  let match
  while ((match = pattern.exec(text)) !== null) marks.push(match.index)
  if (!marks.length) {
    if (text.length) throw new Error('canonical diff has content without a file header')
    return []
  }
  if (text.slice(0, marks[0]).trim()) throw new Error('canonical diff has an unexpected preamble')
  return marks.map((start, index) => text.slice(start,
    index + 1 < marks.length ? marks[index + 1] : text.length))
}

function diffInventory(root, base, head) {
  const entries = changedEntries(root, base, head)
  const fileDiffs = splitFileDiffs(wholeDiff(root, base, head))
  if (fileDiffs.length !== entries.length) {
    throw new Error(`canonical diff file count ${fileDiffs.length} does not match name-status count ${entries.length}`)
  }
  const changedFiles = []
  const hunks = []
  const zeroHunkPaths = []
  const structuralUnits = []
  for (const [entryIndex, entry] of entries.entries()) {
    changedFiles.push({ path: entry.path, status: entry.status })
    const text = fileDiffs[entryIndex]
    const split = splitHunks(text)
    const structuralHash = sha256(text)
    const addStructural = (kind, summary) => structuralUnits.push({
      id: 'non-text:' + kind + ':' + entry.path + ':' + structuralHash,
      type: 'non-text', path: entry.path, symbol: 'file-level', hash: structuralHash, summary,
    })
    if (entry.rawStatus.startsWith('R')) addStructural('rename', 'renamed from ' + entry.source + ' to ' + entry.path)
    if (entry.rawStatus.startsWith('C')) addStructural('copy', 'copied from ' + entry.source + ' to ' + entry.path)
    if (entry.rawStatus.startsWith('D')) addStructural('delete', 'deleted path')
    if (/^(?:old mode|new mode) /m.test(text)) addStructural('mode', 'file mode or type changed')
    if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(text)) addStructural('binary', 'binary content changed')
    if (!split.hunks.length) {
      zeroHunkPaths.push(entry.path)
      if (!structuralUnits.some(unit => unit.path === entry.path)) {
        addStructural('zero-hunk', 'changed path has no textual diff hunk')
      }
      continue
    }
    for (const [index, body] of split.hunks.entries()) {
      const hash = sha256(body)
      hunks.push({ id: 'hunk:' + entry.path + ':' + (index + 1) + ':' + hash, path: entry.path, hash })
    }
  }
  return { changedFiles, hunks, hunkCount: hunks.length, zeroHunkPaths, structuralUnits }
}

function option(argv, name) {
  const index = argv.indexOf(name)
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) {
    throw new Error(name + ' requires a value')
  }
  return argv[index + 1]
}

function cli(argv = process.argv.slice(2)) {
  const known = new Set(['--root', '--base', '--head'])
  for (let index = 0; index < argv.length; index += 2) {
    if (!known.has(argv[index])) throw new Error('unknown option: ' + argv[index])
    if (argv[index + 1] === undefined) throw new Error(argv[index] + ' requires a value')
  }
  const root = fs.realpathSync(path.resolve(option(argv, '--root')))
  if (fs.realpathSync(git(root, 'rev-parse', '--show-toplevel').trim()) !== root) {
    throw new Error('--root must be the repository top level')
  }
  const resolveCommit = name => {
    const requested = option(argv, name)
    if (!/^[a-f0-9]{40}$/.test(requested)) throw new Error(name + ' must be a full lowercase commit SHA')
    const resolved = git(root, 'rev-parse', '--verify', requested + '^{commit}').trim()
    if (resolved !== requested) throw new Error(name + ' did not resolve to the requested commit')
    return resolved
  }
  const base = resolveCommit('--base')
  const head = resolveCommit('--head')
  const inventory = diffInventory(root, base, head)
  return Object.assign({ ok: true, base, head, count: inventory.changedFiles.length }, inventory)
}

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(cli(), null, 2) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(error.stderr || error.message || error).trim().slice(0, 1000) }, null, 2) + '\n')
    process.exitCode = 3
  }
}

module.exports = { changedEntries, cli, diffInventory, parseNameStatus, sha256, splitFileDiffs, splitHunks, wholeDiff }
