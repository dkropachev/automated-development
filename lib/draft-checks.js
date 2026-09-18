'use strict'
// The checks on a PR DESCRIPTION draft: sections against the cached prompt's vocabulary, files it
// names against the repo, permalinks, banners, filler, length. Pure functions plus the regexes they
// use, exported so they can be unit-tested without spawning the driver.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { frontmatter } = require('./prompt-gate')

// The sections a cached prompt declares, read off the same lines the coverage comments live on:
//   ### `## Testing`  — also `## Tests`, `## Test plan`  <!-- covers: testing -->
// Every backticked heading on that line is the SAME section under this repo's alternate names, so a
// draft satisfies it by using any one of them. Checking only the first would fire on a draft that
// legitimately picked the second, which is the kind of false alarm that teaches an agent to ignore
// the checks.
function promptSections(promptPath) {
  let src
  try { src = fs.readFileSync(promptPath, 'utf8') } catch { return { sections: [], allowed: [] } }
  const sections = []
  for (const line of src.split('\n')) {
    if (!/^###\s+`#/.test(line)) continue
    const names = (line.match(/`(#{1,4} [^`]+)`/g) || []).map(x => x.slice(1, -1))
    if (names.length) sections.push(names)
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
  return { sections, allowed: allowed.filter(h => !forbidden.includes(h)), forbidden }
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
  const untouched = cited.filter(c => !changed.some(f => f === c || f.endsWith('/' + c) || c.endsWith('/' + f)))
  // Naming a file this change does not touch is normal and often useful - "this mirrors the logic in
  // `pool.py`". What is never acceptable is naming one that does not exist at all. Split them, and
  // only fail on the second.
  const invented = [], referenced = []
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
      try { real = fs.existsSync(path.join(root, c)) } catch {}
      if (!real && tracked) real = tracked.some(f => f === c || f.endsWith('/' + c))
    }
    ;(real ? referenced : invented).push(c)
  }
  return { invented, referenced }
}

const PLACEHOLDER = /\b(TODO|FIXME|XXX|TBD)\b|<[a-z][a-z -]{2,}>|\.\.\.$/im

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
const BLOB_REF  = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/blob\/([^/\s]+)\//g
const WRAPPED   = /\[[^\]]*\]\(\s*https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/blob\/[^)]*\)/

function fillerFound(text) {
  const out = []
  for (const [re, label] of FILLER) if (re.test(text)) out.push(label)
  return out
}

const BANNER = /(🤖\s*)?generated with \[?claude|claude\.com\/claude-code|co-authored-by:\s*claude|\bgenerated by claude\b/i

// The whole draft check, as data.
function inspectDraft(draftPath, promptPath, filesPath, root, fallbackBudget) {
  const r = { ok: false, problems: [], missingHeadings: [], inventedHeadings: [], invented: [],
              filler: [], referenced: [], overBudget: null, longTitle: 0, bytes: 0, budget: 0,
              noFileList: false }
  let text
  try { text = fs.readFileSync(draftPath, 'utf8') } catch {
    r.problems.push('The draft file does not exist on disk.')
    return r
  }
  r.bytes = Buffer.byteLength(text)
  const body = prose(text)
  if (r.bytes < 120) r.problems.push('The draft is under 120 bytes, which is not a description.')
  const tm = /^\s*Title:\s*(\S.*)$/m.exec(text)
  if (!tm) r.problems.push('There is no non-empty `Title:` line.')
  // Soft, like the length guide, and for the same reason: no repo states a title limit, but every
  // convention any of them has lands well under this. Past it, a title is a sentence and GitHub
  // truncates it in every listing a reviewer will see it in.
  else if (tm[1].trim().length > 100) {
    r.longTitle = tm[1].trim().length
  }
  if (PLACEHOLDER.test(body)) {
    r.problems.push('The draft still contains a placeholder (TODO / FIXME / XXX / TBD / <something> / a trailing ...).')
  }
  if (BANNER.test(text)) {
    r.problems.push('The draft carries a Claude Code banner or a Co-Authored-By line. A PR description never has one - delete it, do not reword it.')
  }
  r.filler = fillerFound(body)

  const fl = FILE_LINE.exec(body)
  if (fl) {
    r.problems.push('The description references code as `' + fl[1] + ':' + fl[2] + '`. That is the terminal ' +
                    'convention; on GitHub it is a dead string. Use a raw permalink pinned to a commit ' +
                    'SHA, on its own line: https://github.com/<owner>/<repo>/blob/<full-sha>/' + fl[1] +
                    '#L' + fl[2])
  }
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
  const unpushed = unpushedShas(shas, root)
  if (unpushed.length) {
    r.problems.push('Permalinks pinned to commit(s) no remote branch contains yet (' +
                    unpushed.map(x => x.slice(0, 12)).join(', ') + '). The SHA is well formed and the ' +
                    'link still 404s for everyone but you. Push the branch, then use a SHA that is on ' +
                    'the remote.')
  }
  if (branchRefs.length) {
    r.problems.push('Code links pinned to a branch or tag rather than a commit SHA (' + branchRefs.join(', ') +
                    '). The lines move and the link then points at something else. `git rev-parse HEAD`, ' +
                    'and use the SHA the line actually exists at on the remote.')
  }
  if (WRAPPED.test(text)) {
    r.problems.push('A GitHub code link is wrapped in markdown link text. GitHub only expands a BARE url ' +
                    'on its own line into a code snippet - wrapping it throws the preview away.')
  }
  if (r.filler.length) {
    r.problems.push('The draft uses filler that carries no information. Each of these has a shorter form ' +
                    'that says the same thing: ' + r.filler.join('; ') + '.')
  }

  if (!fs.existsSync(promptPath)) {
    r.problems.push('The cached prompt is no longer readable at ' + promptPath + '. Everything this ' +
                    'check knows about the repo comes from it, so nothing below can be trusted.')
  }
  const { sections, allowed } = promptSections(promptPath)
  // A section is satisfied by ANY of its names.
  r.missingHeadings = sections.filter(names => !names.some(h => text.includes(h))).map(names => names[0])
  // Headings the draft invented. Compared on the heading text, so `## Foo` and `### Foo` are
  // different things - because in this prompt's own terms they are.
  const used = (body.match(/^#{1,4} .+$/gm) || []).map(x => x.trim())
  r.inventedHeadings = allowed.length ? used.filter(h => !allowed.includes(h)) : []

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

  const changed = changedFiles(filesPath)
  if (changed === null) {
    r.noFileList = true                       // no list to check against; say so rather than pass silently
  } else {
    const split = unknownPaths(citedPaths(text), changed, root)
    r.invented = split.invented
    r.referenced = split.referenced
  }
  r.ok = r.problems.length === 0 && r.missingHeadings.length === 0 && r.invented.length === 0 &&
         r.inventedHeadings.length === 0
  return r
}


module.exports = { promptSections, promptBudget, citedPaths, prose, unpushedShas, changedFiles, unknownPaths,
                   fillerFound, inspectDraft, PLACEHOLDER, FILLER, FILE_LINE, BLOB_REF, WRAPPED, BANNER }
