'use strict'
// The checks on a PR DESCRIPTION draft: sections against the cached prompt's vocabulary, files it
// names against the repo, permalinks, banners, filler, length. Pure functions plus the regexes they
// use, exported so they can be unit-tested without spawning the driver.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { frontmatter, slugList, canonicalFields } = require('./prompt-gate')

const FALLBACK_HEADINGS = {
  motivation: ['## Motivation', '## Why'],
  'summary-of-changes': ['## Summary of changes', '## What changed'],
  risk: ['## Risk'],
  'breaking-changes': ['## Breaking changes'],
  problem: ['## Problem'],
  expected: ['## Expected behavior', '## Expected behaviour'],
  context: ['## Context'],
}

// The sections a cached prompt declares, read off the same lines the coverage comments live on:
//   ### `## Testing`  — also `## Tests`, `## Test plan`  <!-- covers: testing -->
// Every backticked heading on that line is the SAME section under this repo's alternate names, so a
// draft satisfies it by using any one of them. Checking only the first would fire on a draft that
// legitimately picked the second, which is the kind of false alarm that teaches an agent to ignore
// the checks.
//
// A line may also carry `<!-- kinds: bug, feature -->`: the section belongs to those kinds of issue
// only. A line without one belongs to every kind. `kinds` is the frontmatter's list, empty when the
// prompt does not distinguish any.
//
// With `opts.labels`, a section may also be a `Label:` at the start of a line rather than a markdown
// heading - `### \`Problem:\`` - which is how commit bodies are shaped in the repos that shape them.
function promptSections(promptPath, opts) {
  opts = opts || {}
  let src
  try { src = fs.readFileSync(promptPath, 'utf8') } catch { return { sections: [], allowed: [], forbidden: [], kinds: [], error: 'unreadable' } }
  const fm = frontmatter(src)
  if (!fm) {
    const canon = canonicalFields(promptPath)
    if (!canon.error) {
      const sections = canon.fields.map(f => ({ names: FALLBACK_HEADINGS[f] || ['## ' + f.replace(/(^|-)([a-z])/g, (_m, _d, c) => (_d ? ' ' : '') + c.toUpperCase())], kinds: null }))
      return { sections, allowed: sections.flatMap(s => s.names), forbidden: [], kinds: [], fallback: true }
    }
  }
  const kinds = fm ? slugList(fm.kinds) : []
  const sections = []
  const nameRe = opts.labels ? /`(#{1,4} [^`]+|[A-Z][\w -]{0,40}:)`/g : /`(#{1,4} [^`]+)`/g
  const startRe = opts.labels ? /^###\s+`(#|[A-Z][\w -]{0,40}:`)/ : /^###\s+`#/
  for (const line of src.split('\n')) {
    if (!startRe.test(line)) continue
    const names = (line.match(nameRe) || []).map(x => x.slice(1, -1))
    const km = /<!--\s*kinds:\s*([^>]*?)-->/.exec(line)
    if (names.length) sections.push({ names, kinds: km ? slugList(km[1]) : null })
  }
  // Anything the prompt names in backticks ANYWHERE is a heading this repo is known to use - the
  // alternates, the checklist, the ones only discussed in prose. A draft heading outside that set
  // was invented.
  //
  // With one exception, and it is the whole reason this block is not three lines long: a prompt that
  // PROHIBITS a heading has to name it to prohibit it, and naming it in backticks would silently
  // turn the prohibition into permission. A `## Forbidden headings` section is subtracted from the
  // allowed set, so a prompt can say "never write `## Testing`" in the obvious way and have it mean
  // what it says. Without this, the only way to forbid a heading is to avoid backticking it - which
  // is invisible, unenforced, and one careless edit away from reversing itself.
  const allowed = []
  const re = /`(#{1,4} [^`]+)`/g
  let m
  while ((m = re.exec(src)) !== null) if (!allowed.includes(m[1])) allowed.push(m[1])

  // Sliced rather than matched with a lookahead: JavaScript has no \Z, and `(?=^##\s|\Z)` quietly
  // becomes "a following ## heading, or a literal Z" - which skips the section whenever it is the
  // last one in the file, exactly where it is most likely to be.
  const forbidden = []
  const lines = src.split('\n')
  let fi = lines.findIndex(l => /^##\s+Forbidden headings\s*$/.test(l))
  if (fi !== -1) {
    let end = lines.length
    for (let i = fi + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { end = i; break }
    }
    const fre = /`(#{1,4} [^`]+)`/g
    let x
    const block = lines.slice(fi + 1, end).join('\n')
    while ((x = fre.exec(block)) !== null) if (!forbidden.includes(x[1])) forbidden.push(x[1])
  }
  const declared = new Set(sections.flatMap(s => s.names))
  return { sections, allowed: allowed.filter(h => !forbidden.includes(h) || declared.has(h)), forbidden, kinds, fallback: false }
}

// A section is present when its heading appears anywhere, or its `Label:` starts a line.
function hasSection(text, name) {
  if (name.startsWith('#')) return text.includes(name)
  return new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)', 'm').test(text)
}

// The trailers a prompt requires, from a `## Trailers` section:
//   - `Signed-off-by:` required - DCO; git commit -s adds it
//   - `Fixes:` optional - when an issue exists
// Only the required ones are checked; the rest is prose for the writer.
function promptTrailers(promptPath) {
  let src
  try { src = fs.readFileSync(promptPath, 'utf8') } catch { return [] }
  const lines = src.split('\n')
  const ti = lines.findIndex(l => /^##\s+Trailers\s*$/.test(l))
  if (ti === -1) return []
  const out = []
  for (let i = ti + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const m = /^\s*-\s+`([A-Z][\w-]*):`\s+required\b/i.exec(lines[i])
    if (m && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

// Two more numbers a prompt may record in its frontmatter. `wrap_at` is the column this repo wraps
// bodies at; `title_max` the subject length past which its authors do not go. Both optional; the
// domain's defaults apply otherwise.
function promptNumber(promptPath, key) {
  try {
    const fm = frontmatter(fs.readFileSync(promptPath, 'utf8'))
    if (!fm || !/^\d+$/.test(fm[key] || '')) return 0
    return parseInt(fm[key], 10)
  } catch { return 0 }
}

// The sections and headings that apply to ONE kind. A section restricted to other kinds is not
// required of this one, and a heading that appears only on such sections is not in this kind's
// vocabulary either: a bug report carrying the feature template's "Proposed solution" imported it
// from the wrong form. Headings the prompt names anywhere else - in prose, in a checklist - stay
// allowed for every kind, exactly as before.
function sectionsForKind(ps, kind) {
  const applies = (s) => !s.kinds || !kind || s.kinds.includes(kind)
  const sections = ps.sections.filter(applies)
  const onSection = new Map()                   // heading -> does any section naming it apply?
  for (const s of ps.sections) for (const h of s.names) onSection.set(h, (onSection.get(h) || false) || applies(s))
  const allowed = ps.allowed.filter(h => !onSection.has(h) || onSection.get(h))
  return { sections, allowed }
}

// The repo's own length, recorded by the builder as `max_bytes` in the prompt's frontmatter. A
// description is not better for being longer, and every other check in this file asks whether
// something is MISSING - without a ceiling the only gradient the revise loop creates points at
// "add more", and six honest passes will happily triple the thing.
function promptBudget(promptPath) {
  try {
    const fm = frontmatter(fs.readFileSync(promptPath, 'utf8'))
    if (!fm || !/^\d+$/.test(fm.max_bytes || '')) return 0
    return parseInt(fm.max_bytes, 10)
  } catch { return 0 }
}

// The labels a kind's `## Kinds` line applies, off the line that declares it:
//   ### `bug` - `.github/ISSUE_TEMPLATE/bug.yml`, title prefix `[Bug]: `, labels `kind/bug`, `triage`
//
// The list is read as a run of consecutive backticked items starting at the word `labels`, rather
// than as every backticked token after it. The rest of the line is prose that carries backticks of
// its own - the template filename, a title prefix - and a label is not distinguishable from either
// by its shape: `kind/bug` looks like a path and `[Bug]: ` looks like a label. Only position tells
// them apart, so only position is used. Anything between two items that is not a separator ends the
// run, and the word has to be followed by a backtick to be the list's own. The FIRST such word on
// the line is the declaration - a second one is the line's prose talking about labels, not another
// list ("triagers later add labels `needs-info`"), and the run ends before it.
function promptLabels(promptPath, kind) {
  if (!kind) return []
  try {
    const src = fs.readFileSync(promptPath, 'utf8')
    const line = src.split('\n').find(l => new RegExp('^###\\s+`' + kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`(?:\\s|$)').test(l)) || ''
    const a = /\blabels?\s+(?=`)/i.exec(line)
    if (!a) return []
    const start = a.index + a[0].length
    const out = []
    const item = /`([^`]+)`/g
    item.lastIndex = start
    let m, prev = start
    while ((m = item.exec(line)) !== null) {
      if (!/^[\s,]*(?:and[\s,]+)?$/.test(line.slice(prev, m.index))) break
      if (!out.includes(m[1])) out.push(m[1])
      prev = item.lastIndex
    }
    return out
  } catch { return [] }
}

// Backticked tokens that look like file paths: something with an extension and no spaces. An
// identifier like `Session::new` or a flag like `--limit` does not match, which is the point -
// false positives here would train the agent to ignore the check.
function citedPaths(text) {
  const out = []
  const re = /`([^`\s]+\.[A-Za-z0-9_]+)`/g
  let m
  while ((m = re.exec(text)) !== null) {
    const t = m[1]
    if (/^[\w./@-]+$/.test(t) && !/^v?\d+(\.\d+)+$/.test(t) && !out.includes(t)) out.push(t)   // 1.2, v1.2.3: versions, not files
  }
  const withoutUrls = text.replace(/https?:\/\/\S+/g, '')
  // An UNBACKTICKED path has to end in a real extension - a dot followed by a letter - or it is not
  // recognised. Without that, every `a/b` in ordinary prose is a cited path: "and/or",
  // "client/server", "read/write", "Linux/6.1". Each one is then looked up in the repository, found
  // missing and reported as a file the draft invented, which is a hard failure the writer can only
  // clear by rewording plain English. Issue bodies are prose end to end, so they meet it constantly.
  // The cost is an extensionless `docs/README` written without backticks, which now goes unchecked -
  // the backticked branch above has always required an extension, and a missed invention is worth
  // less than a rejected sentence.
  const plain = /(?:^|[\s(])((?:[\w.@-]+\/)+[\w@-]+(?:\.[\w@-]+)*\.[A-Za-z][A-Za-z0-9_-]*)(?=[\s,.;:)]|$)/gm
  while ((m = plain.exec(withoutUrls)) !== null) {
    // `x` is a letter, so a version written with a slash - Node/20.x, scylla/6.0.x, driver/3.29.x -
    // otherwise clears the extension test and is reported as a file the draft invented.
    if (/^v?\d+(?:\.(?:\d+|[Xx]))*$/.test(m[1].slice(m[1].lastIndexOf('/') + 1))) continue
    if (!out.includes(m[1])) out.push(m[1])
  }
  const special = /`?((?:Makefile|GNUmakefile|Dockerfile|Gemfile|Procfile|Justfile))`?/g
  while ((m = special.exec(withoutUrls)) !== null) if (!out.includes(m[1])) out.push(m[1])
  return out
}

// Everything below reads the draft as PROSE. A fenced block is quoted material - a command, a log
// line, a snippet of the diff - and its contents are not the author writing. Without this, a `#`
// comment in a shell example is read as a markdown heading and reported as invented, which fires on
// exactly the repos whose descriptions quote commands.
function prose(text) {
  return text.replace(/^```[\s\S]*?^```\s*$/gm, '')
             .replace(/^~~~[\s\S]*?^~~~\s*$/gm, '')
}

// A 40-hex SHA is well formed and still 404s if the commit was never pushed - `git rev-parse HEAD`
// on an unpushed branch gives exactly that. Only SHAs this clone actually HAS are checked: one it
// does not have belongs to some other repository the description is citing, and is none of our
// business.
function unpushedShas(shas, root) {
  if (!root || !shas.length) return []
  const out = []
  for (const sha of shas) {
    try { execFileSync('git', ['-C', root, 'cat-file', '-e', sha + '^{commit}'], { stdio: 'ignore' }) }
    catch { continue }                       // not ours to judge
    try {
      const refs = execFileSync('git', ['-C', root, 'branch', '-r', '--contains', sha],
                                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (!refs) out.push(sha)
    } catch { /* detached or no remotes - say nothing rather than guess */ }
  }
  return out
}

function changedFiles(listPath) {
  try {
    return fs.readFileSync(listPath, 'utf8').split('\n').map(x => x.trim()).filter(Boolean)
  } catch { return null }
}

// A cited path counts as real if the PR touches a file with that exact path, or one that ends in it
// - a description saying `foo_test.rs` about `tests/integration/foo_test.rs` is being helpful, not
// wrong.
function unknownPaths(cited, changed, root) {
  const unsafe = cited.filter(c => path.isAbsolute(c) || c.split('/').includes('..'))
  const safe = cited.filter(c => !unsafe.includes(c))
  const untouched = safe.filter(c => !changed.some(f => f === c || f.endsWith('/' + c)))
  // Naming a file this change does not touch is normal and often useful - "this mirrors the logic in
  // `pool.py`". What is never acceptable is naming one that does not exist at all. Split them, and
  // only fail on the second.
  const invented = unsafe.slice(), referenced = []
  if (!untouched.length) return { invented, referenced }

  // Tracked files, for the bare-basename case: a description saying `pool.py` about
  // `cassandra/pool.py` is normal phrasing, and calling it invented would be a lie. Falls back to a
  // plain existsSync when git is unavailable - in that case only a path given in full is recognised.
  let tracked = null
  if (root) {
    try {
      tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 1 << 26 })
        .split('\n').filter(Boolean)
    } catch { tracked = null }
  }
  for (const c of untouched) {
    let real = false
    if (root) {
      try { real = fs.statSync(path.join(root, c)).isFile() } catch {}
      if (!real && tracked) real = tracked.some(f => f === c || f.endsWith('/' + c))
    }
    ;(real ? referenced : invented).push(c)
  }
  return { invented, referenced }
}

const PLACEHOLDER = /\b(TODO|FIXME|XXX|TBD)\b|<(?!\/?(?:details|summary)\b)[a-z][a-z -]{2,}>|\.\.\.$/im

// A PR description never carries a tooling banner. It is the author's description of their own
// change, and a generated-by line turns it into an advert reviewers learn to skip. Checked
// mechanically because an instruction not to add one is exactly the kind that loses to habit.
// Filler that is always removable without losing information. Deliberately short and conservative:
// a check that fires on ordinary writing teaches the agent to stop reading these messages. Each of
// these has a shorter form that says the same thing, so there is never a reason to keep one.
// Spaces are \s+ throughout: a description is wrapped text, and a phrase broken across a line is
// the same phrase.
const FILLER = [
  [/\bin\s+order\s+to\b/i, 'in order to  ->  to'],
  [/\bdue\s+to\s+the\s+fact\s+that\b/i, 'due to the fact that  ->  because'],
  [/\bit\s+(is|should\s+be)\s+worth\s+(noting|mentioning)\s+that\b/i, 'it is worth noting that  ->  delete, keep the fact'],
  [/\bit\s+should\s+be\s+noted\s+that\b/i, 'it should be noted that  ->  delete, keep the fact'],
  [/\bas\s+(mentioned|noted|stated)\s+(above|below|previously|earlier)\b/i, 'as mentioned above  ->  delete'],
  [/\bneedless\s+to\s+say\b/i, 'needless to say  ->  delete'],
  [/\bplease\s+note\s+that\b/i, 'please note that  ->  delete'],
  [/\bat\s+the\s+end\s+of\s+the\s+day\b/i, 'at the end of the day  ->  delete'],
  [/\bfor\s+all\s+intents\s+and\s+purposes\b/i, 'for all intents and purposes  ->  delete'],
  [/\bthe\s+fact\s+of\s+the\s+matter\s+is\b/i, 'the fact of the matter is  ->  delete'],
]

// Code references in a PR description are raw GitHub permalinks pinned to a commit SHA, never
// `path:line` and never a branch ref. Three ways to get it wrong, all of them mechanical:
//
//   · `cassandra/cluster.py:42`   - a terminal convention, useless to a reviewer in a browser
//   · .../blob/main/foo.py#L42    - a branch ref, which rots the moment the line moves
//   · [text](https://github.com/...) or the URL inside a fence - GitHub only expands a BARE url on
//     its own line, so wrapping it is what turns a code preview back into a link
const FILE_LINE = /(?:^|[\s(`])([\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,6}):(\d+)(?:-\d+)?(?=[\s,.);`]|$)/m
const BLOB_REF  = /https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/blob\/([^/\s]+)\//g
const BLOB_URL  = /https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/blob\/[^\s)]+/g
const WRAPPED   = /\[[^\]]*\]\(\s*https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/blob\/[^)]*\)/

function fillerFound(text) {
  const out = []
  for (const [re, label] of FILLER) if (re.test(text)) out.push(label)
  return out
}

const BANNER = /(🤖\s*)?generated with \[?claude|claude\.com\/claude-code|co-authored-by:\s*claude|\bgenerated by claude\b/i

// A template's instructions to its author, left in the draft. Every issue template and most PR
// templates carry them, and a draft that still has one was filled in around the template rather
// than written. Fenced blocks are already gone from `body` by the time this runs, so a comment
// quoted in a code sample is not caught.
const HTML_COMMENT = /<!--[\s\S]*?-->/

// The whole draft check, as data. `opts.kind` selects one kind's sections when the prompt declares
// kinds; `opts.noDiff` says the draft describes no change - an issue - so no changed-file list is
// expected and every cited path is judged on whether it exists; `opts.web` (default true) says the
// draft is read in a browser, so code references must be permalinks; `opts.titleMax`, `opts.minBytes`
// and `opts.labels` are the domain's knobs, overridable by the prompt's own frontmatter.
function inspectDraft(draftPath, promptPath, filesPath, root, fallbackBudget, opts) {
  opts = opts || {}
  const web = opts.web !== false
  const minBytes = opts.minBytes || 120
  const r = { ok: false, problems: [], missingHeadings: [], inventedHeadings: [], invented: [],
              filler: [], referenced: [], overBudget: null, longTitle: 0, titleBudget: 0, bytes: 0, budget: 0,
              noFileList: false, labels: '', longLines: [], missingTrailers: [] }
  let text
  try { text = fs.readFileSync(draftPath, 'utf8') } catch {
    r.problems.push('The draft file does not exist on disk.')
    return r
  }
  r.bytes = Buffer.byteLength(text)
  const body = prose(text)
  if (r.bytes < minBytes) r.problems.push('The draft is under ' + minBytes + ' bytes, which is not a ' + (opts.noDiff ? 'report' : web ? 'description' : 'message') + '.')
  const lines = text.split('\n')
  const tm = /^Title:\s*(\S.*)$/.exec(lines[0] || '')
  if (!tm) r.problems.push('There is no non-empty `Title:` line.')
  // Soft, like the length guide, and for the same reason: no repo states a title limit, but every
  // convention any of them has lands well under this. Past it, a title is a sentence and GitHub
  // truncates it in every listing a reviewer will see it in. The prompt's own `title_max` wins.
  r.titleBudget = promptNumber(promptPath, 'title_max') || opts.titleMax || 100
  if (tm && tm[1].trim().length > r.titleBudget) {
    r.longTitle = tm[1].trim().length
  }
  // Optional, and only meaningful for an issue: the labels the repo's template or kind applies.
  const lm = /^Labels:\s*(.*)$/.exec(lines[1] || '')
  if (lm) {
    r.labels = lm[1].trim()
    if (!r.labels) r.problems.push('The `Labels:` line is empty. Name the labels or drop the line.')
    if (!opts.noDiff) r.problems.push('A PR description must not contain a `Labels:` metadata line.')
  }
  const expectedLabels = promptLabels(promptPath, opts.kind || '')
  if (expectedLabels.length) {
    const actual = r.labels.split(',').map(x => x.trim()).filter(Boolean).sort()
    const expected = expectedLabels.slice().sort()
    if (!lm) r.problems.push('This issue kind requires a `Labels:` line with: ' + expectedLabels.join(', ') + '.')
    else if (actual.join('\0') !== expected.join('\0')) r.problems.push('The `Labels:` line must be exactly: ' + expectedLabels.join(', ') + '.')
  }
  const metadataLines = lm ? 2 : 1
  if (lines[metadataLines] !== '') r.problems.push('Title' + (lm ? ' and labels must be followed' : ' must be followed') + ' by a blank line before the body.')
  if (PLACEHOLDER.test(body)) {
    r.problems.push('The draft still contains a placeholder (TODO / FIXME / XXX / TBD / <something> / a trailing ...).')
  }
  if (HTML_COMMENT.test(body)) {
    r.problems.push('The draft still contains an HTML comment (<!-- ... -->). Those are the template\'s ' +
                    'instructions to the author, not content - delete every one, along with any placeholder ' +
                    'line the template shipped with.')
  }
  if (BANNER.test(text)) {
    r.problems.push('The draft carries a Claude Code banner or a Co-Authored-By line. ' +
                    (opts.noDiff ? 'An issue' : 'A PR description') + ' never has one - delete it, do not reword it.')
  }
  r.filler = fillerFound(body)

  const fl = web ? FILE_LINE.exec(body) : null
  if (fl) {
    r.problems.push('The draft references code as `' + fl[1] + ':' + fl[2] + '`. That is the terminal ' +
                    'convention; on GitHub it is a dead string. Use a raw permalink pinned to a commit ' +
                    'SHA, on its own line: https://github.com/<owner>/<repo>/blob/<full-sha>/' + fl[1] +
                    '#L' + fl[2])
  }
  const fencedBlob = /^(?:```|~~~)[\s\S]*?https?:\/\/[^\s]+\/blob\/[^\s]+[\s\S]*?^(?:```|~~~)\s*$/gm.test(text)
  if (fencedBlob) r.problems.push('A GitHub code link is inside a fenced block. Put the bare URL on its own line so GitHub expands it.')
  BLOB_REF.lastIndex = 0
  let bm, branchRefs = []
  while ((bm = BLOB_REF.exec(body)) !== null) {
    if (!/^[0-9a-f]{40}$/.test(bm[1]) && !branchRefs.includes(bm[1])) branchRefs.push(bm[1])
  }
  BLOB_REF.lastIndex = 0
  const shas = []
  let sm
  while ((sm = BLOB_REF.exec(body)) !== null) {
    if (/^[0-9a-f]{40}$/.test(sm[1]) && !shas.includes(sm[1])) shas.push(sm[1])
  }
  const unpushed = web ? unpushedShas(shas, root) : []
  if (unpushed.length) {
    r.problems.push('Permalinks pinned to commit(s) no remote branch contains yet (' +
                    unpushed.map(x => x.slice(0, 12)).join(', ') + '). The SHA is well formed and the ' +
                    'link still 404s for everyone but you. Push the branch, then use a SHA that is on ' +
                    'the remote.')
  }
  if (web && branchRefs.length) {
    r.problems.push('Code links pinned to a branch or tag rather than a commit SHA (' + branchRefs.join(', ') +
                    '). The lines move and the link then points at something else. `git rev-parse HEAD`, ' +
                    'and use the SHA the line actually exists at on the remote.')
  }
  if (web && WRAPPED.test(text)) {
    r.problems.push('A GitHub code link is wrapped in markdown link text. GitHub only expands a BARE url ' +
                    'on its own line into a code snippet - wrapping it throws the preview away.')
  }
  BLOB_URL.lastIndex = 0
  let um
  while ((um = BLOB_URL.exec(body)) !== null) {
    const line = body.slice(body.lastIndexOf('\n', um.index) + 1, body.indexOf('\n', um.index) === -1 ? body.length : body.indexOf('\n', um.index)).trim()
    if (line !== um[0]) {
      r.problems.push('A GitHub code link is not a bare URL on its own line. Move it to its own line so GitHub expands it.')
      break
    }
  }
  if (r.filler.length) {
    r.problems.push('The draft uses filler that carries no information. Each of these has a shorter form ' +
                    'that says the same thing: ' + r.filler.join('; ') + '.')
  }

  let promptReadable
  try { promptReadable = fs.statSync(promptPath).isFile(); if (promptReadable) fs.accessSync(promptPath, fs.constants.R_OK) } catch { promptReadable = false }
  if (!promptReadable) {
    r.problems.push('The cached prompt is no longer readable at ' + promptPath + '. Everything this ' +
                    'check knows about the repo comes from it, so nothing below can be trusted.')
  }
  const parsedPrompt = promptSections(promptPath, { labels: opts.labels })
  if (parsedPrompt.error) r.problems.push('The cached prompt could not be parsed as a learned prompt or canonical schema.')
  const { sections, allowed } = sectionsForKind(parsedPrompt, opts.kind || '')
  const used = (body.match(/^#{1,6} .+$/gm) || []).map(x => x.trim())
  // A section is satisfied by ANY of its names. A markdown heading counts only as a heading line -
  // mentioning `### What happened?` in prose is not a section. A label (`Problem:`) must start a line.
  r.missingHeadings = sections.filter(s => !s.names.some(h => h.startsWith('#') ? used.includes(h) : hasSection(text, h))).map(s => s.names[0])
  // Headings the draft invented. Compared on the heading text, so `## Foo` and `### Foo` are
  // different things - because in this prompt's own terms they are.
  r.inventedHeadings = allowed.length ? used.filter(h => !allowed.includes(h)) : []
  // A commit message is not markdown. Where the prompt declares no headings at all, a line starting
  // with # is one git will strip as a comment the moment the message is opened in an editor.
  if (!web && !allowed.length && used.length) {
    r.problems.push('Lines beginning with # (' + used.slice(0, 3).join(' | ') + '). git treats them as comments ' +
                    'when the message is edited, and this repo\'s commits carry no markdown headings. Plain text.')
  }

  // Trailers the prompt requires - `Signed-off-by:`, a required `Fixes:` - must each start a line.
  r.missingTrailers = promptTrailers(promptPath).filter(k => !new RegExp('^' + k + ':', 'm').test(text))
  if (r.missingTrailers.length) {
    r.problems.push('Trailers this repo requires that are not in the draft: ' + r.missingTrailers.map(k => k + ':').join(', ') +
                    '. Each goes on its own line at the very end, spelled exactly so.')
  }

  // The wrap column, where the prompt records one. Only the body is measured - not the Title line,
  // not a line carrying a URL, not quoted output in a fence - because those cannot be rewrapped.
  const wrap = promptNumber(promptPath, 'wrap_at')
  if (wrap) {
    body.split('\n').forEach((line, i) => {
      if (/^\s*(Title|Labels):/.test(line) || /:\/\//.test(line)) return
      if (line.length > wrap) r.longLines.push({ line: i + 1, length: line.length })
    })
    if (r.longLines.length) {
      const f = r.longLines[0]
      r.problems.push(r.longLines.length + ' line(s) run past the ' + wrap + '-column wrap this repo uses (first: line ' +
                      f.line + ', ' + f.length + ' characters). Rewrap the prose; leave URLs and quoted output alone.')
    }
  }

  // A `pattern: none` prompt is schema.md itself: no frontmatter, so no repo-measured ceiling. That
  // is exactly the case with the least to hold a description in shape - no observed vocabulary, no
  // observed length - so it gets the fallback rather than nothing.
  const budget = promptBudget(promptPath) || fallbackBudget || 0
  r.budget = budget
  // SOFT. Length is the one measurement here that cannot be judged mechanically without reading the
  // change: a genuinely large PR sometimes needs a long description, and a hard gate would make the
  // agent hit the number by deleting whichever section it could afford to lose - which is exactly
  // the information a reviewer wanted. So being over budget prompts a trim rather than failing the
  // draft, and a draft that is still over after trimming is allowed through with it said out loud.
  if (budget && r.bytes > budget) {
    r.overBudget = { bytes: r.bytes, budget, pct: Math.round((r.bytes / budget) * 100) }
  }

  // An issue describes no change, so there is no changed-file list and nothing is "untouched":
  // every path it names is judged on whether it exists in the repository, and that is all.
  const changed = opts.noDiff ? [] : changedFiles(filesPath)
  if (changed === null) {
    r.noFileList = true
  }
  const split = unknownPaths(citedPaths(body), changed || [], root)
  r.invented = split.invented
  r.referenced = split.referenced
  r.ok = r.problems.length === 0 && r.missingHeadings.length === 0 && r.invented.length === 0 &&
         r.inventedHeadings.length === 0
  return r
}


module.exports = { promptSections, sectionsForKind, hasSection, promptTrailers, promptNumber, promptBudget, promptLabels, citedPaths,
                   prose, unpushedShas, changedFiles, unknownPaths, fillerFound, inspectDraft, PLACEHOLDER, FILLER,
                   FILE_LINE, BLOB_REF, WRAPPED, BANNER, HTML_COMMENT }
