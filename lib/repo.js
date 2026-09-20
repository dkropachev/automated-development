'use strict'
// Where one repository's cache lives and whether it is still good: origin-url parsing, the cache
// path, the hash of the files that outrank observed practice, and the staleness rule. All of it is
// per DOMAIN - a PR description and an issue have different caches and different authoritative
// files - and the domain's specifics come from lib/domains.js; a call without one means the PR.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { frontmatter, validUtcDate } = require('./prompt-gate')
const { domain } = require('./domains')

// Where one repo's cache lives, and whether it is still good. Resolved from the ORIGIN remote and
// never from `gh repo view`: in a fork clone that also has an `upstream` remote, gh answers with the
// upstream project and the wrong repo's conventions get learned under the wrong path.
function parseOrigin(url) {
  url = String(url || '').trim()
  let m
  if ((m = /^[\w.-]+@([\w.-]+):\/?(.+)$/.exec(url))) return finishOrigin(m[1], m[2])
  if ((m = /^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(url))) return finishOrigin(m[1], m[2])
  return null
}
function finishOrigin(host, rest) {
  const nwo = rest.replace(/\/+$/, '').replace(/\.git$/, '')
  if (!/^[\w.-]+$/.test(host) || !/^[\w.-]+\/[\w.-]+$/.test(nwo) || /(^|\/)\.\.(\/|$)/.test(nwo)) return null
  return { host, nwo }
}
const CACHE_ROOT = domain('pr').cacheRoot
function cachePathFor(host, nwo, cacheRoot) {
  return path.join(process.env.HOME || '.', cacheRoot || CACHE_ROOT, host, nwo + '.md')
}

// A fingerprint of the files that OUTRANK observed practice - for a PR the PR template, for an
// issue the issue templates and forms, and for both the contributing guide, CLAUDE.md and AGENTS.md.
// When any of them changes the cached prompt is wrong the same day, not in 90 days, so the hash is
// stamped into the cache at publish and compared at resolve. Every file in a template directory
// counts, whatever it is called: an issue form is `bug.yml`, and `config.yml` decides where
// questions go.
function sourceFiles(root, spec) {
  spec = spec || domain('pr').sources
  const out = []
  for (const d of spec.dirs) {
    const dir = path.join(root, d)
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    const templateDir = spec.templateDir.test(d)
    for (const n of names) {
      if (!templateDir && !spec.name.test(n)) continue
      const full = path.join(dir, n)
      try { if (fs.statSync(full).isFile()) out.push(path.join(d, n)) } catch {}
    }
  }
  return out.sort()
}
function sourcesHash(root, spec) {
  const files = sourceFiles(root, spec)
  if (!files.length) return 'none'
  const h = crypto.createHash('sha256')
  for (const f of files) {
    h.update(f); h.update('\0')
    try { h.update(fs.readFileSync(path.join(root, f))) } catch {}
    h.update('\0')
  }
  return h.digest('hex').slice(0, 12)
}

function utcDay(s) {
  if (!validUtcDate(s)) return NaN
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim())
  return Date.UTC(+m[1], +m[2] - 1, +m[3])
}

// Why a cache must be rebuilt, or '' when it is good. Read entirely off the file: no clock in the
// shell, no `date -d`, which does not exist on macOS and made every run there re-mine the repo.
function staleness(cachePath, currentHash, maxAgeDays, unverifiedMaxAgeDays) {
  const r = { exists: false, learnedAt: '', ageDays: -1, pattern: '', verified: '', unresolved: 0, sourcesHash: '', kinds: [], reason: '' }
  let text
  try { text = fs.readFileSync(cachePath, 'utf8') } catch { r.reason = 'missing'; return r }
  r.exists = true
  const fm = frontmatter(text)
  if (!fm) { r.reason = 'unreadable'; return r }
  r.learnedAt = fm.learned_at || ''
  r.pattern = fm.pattern || ''
  r.verified = fm.verified || ''
  r.unresolved = parseInt(fm.unresolved || '0', 10) || 0
  r.sourcesHash = fm.sources_hash || ''
  const km = /^\[(.*)\]$/.exec(String(fm.kinds || '').trim())
  r.kinds = km ? km[1].split(',').map(x => x.trim()).filter(x => /^[a-z][a-z0-9-]*$/.test(x)) : []
  const t = utcDay(r.learnedAt)
  if (isNaN(t)) { r.reason = 'bad-learned-at'; return r }
  r.ageDays = Math.floor((Date.now() - t) / 86400000)
  if (r.ageDays < 0) { r.reason = 'future-learned-at'; return r }
  if (r.ageDays > maxAgeDays) { r.reason = 'age'; return r }
  if (r.verified === 'false' && r.ageDays > unverifiedMaxAgeDays) { r.reason = 'unverified'; return r }
  if (r.sourcesHash && currentHash && r.sourcesHash !== currentHash) { r.reason = 'sources-changed'; return r }
  return r
}


module.exports = { parseOrigin, cachePathFor, sourceFiles, sourcesHash, utcDay, staleness, CACHE_ROOT }
