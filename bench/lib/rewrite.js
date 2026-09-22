'use strict'
// Repointing every link from the upstream project at the blinded copy. The point is not tidiness:
// a reviewer that can read `github.com/scylladb/seastar` out of a README can fetch the real PR and
// the review humans already left on it, and then it is quoting that review back at us instead of
// finding anything itself.
//
// The same map is applied to three things - the checked-out tree, every patch replayed on top of it
// and the PR body - because a patch whose context lines still say `scylladb/...` no longer applies
// to a tree where that string has been rewritten.
const fs = require('node:fs')
const path = require('node:path')

// `scylladb/seastar` -> `dkropachev/ironweave`, longest key first so a longer key that contains a
// shorter one (`github.com/gocql/gocql` vs `gocql/gocql`) is never half-replaced by the short one.
function buildMap(target) {
  const map = { [target.upstream]: target.fork, ...(target.extraReplacements || {}) }
  return Object.entries(map).sort((a, b) => b[0].length - a[0].length)
}

function rewriteText(text, pairs) {
  let out = text
  for (const [from, to] of pairs) out = out.split(from).join(to)
  return out
}

// Binary files are left alone: a replacement inside one corrupts it, and no link a reviewer can
// read lives in one. Detection is the same heuristic git uses - a NUL byte in the first 8000 bytes.
function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0)
}

function rewriteTree(root, pairs, opts) {
  opts = opts || {}
  const changed = []
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git') continue
      const p = path.join(dir, ent.name)
      if (ent.isSymbolicLink()) continue
      if (ent.isDirectory()) { walk(p); continue }
      if (!ent.isFile()) continue
      const buf = fs.readFileSync(p)
      if (isBinary(buf)) continue
      const before = buf.toString('utf8')
      const after = rewriteText(before, pairs)
      if (after !== before) {
        if (!opts.dryRun) fs.writeFileSync(p, after)
        changed.push(path.relative(root, p))
      }
    }
  }
  walk(root)
  return changed
}

// What still points at the upstream project after a rewrite - reported, never silently accepted,
// because each hit is a way for a reviewer to find the original PR.
function residualLeaks(root, needles) {
  const hits = []
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git') continue
      const p = path.join(dir, ent.name)
      if (ent.isSymbolicLink()) continue
      if (ent.isDirectory()) { walk(p); continue }
      if (!ent.isFile()) continue
      const buf = fs.readFileSync(p)
      if (isBinary(buf)) continue
      const text = buf.toString('utf8')
      for (const n of needles) {
        const c = text.split(n).length - 1
        if (c) hits.push({ file: path.relative(root, p), needle: n, count: c })
      }
    }
  }
  walk(root)
  return hits
}

module.exports = { buildMap, rewriteText, rewriteTree, residualLeaks, isBinary }
