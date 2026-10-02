'use strict'

// Shared byte-level diff inventory. The chunker and the trusted state helper must hash the exact
// same hunk bodies; keeping parsing here prevents a harmless-looking change in one process from
// making the coverage cross-check either reject every run or, worse, bless an incomplete relay.

const { execFileSync } = require('child_process')
const crypto = require('crypto')

const MAX_BUFFER = 1 << 30

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER })
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
      status: renamed ? 'renamed' : rawStatus.startsWith('A') ? 'added' :
        rawStatus.startsWith('D') ? 'deleted' : 'modified',
    })
  }
  return entries
}

function changedEntries(root, base, head) {
  return parseNameStatus(git(root, 'diff', '--name-status', '-z', base + '...' + head))
}

function fileDiff(root, base, head, file, source = file) {
  const paths = source && source !== file ? [source, file] : [file]
  return git(root, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', base + '...' + head, '--', ...paths)
}

function diffInventory(root, base, head) {
  const entries = changedEntries(root, base, head)
  const changedFiles = []
  const hunks = []
  const zeroHunkPaths = []
  const structuralUnits = []
  for (const entry of entries) {
    changedFiles.push({ path: entry.path, status: entry.status })
    const text = fileDiff(root, base, head, entry.path, entry.source)
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
    for (const body of split.hunks) hunks.push({ path: entry.path, hash: sha256(body) })
  }
  return { changedFiles, hunks, hunkCount: hunks.length, zeroHunkPaths, structuralUnits }
}

module.exports = { changedEntries, diffInventory, fileDiff, parseNameStatus, sha256, splitHunks }
