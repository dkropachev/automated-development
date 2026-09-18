'use strict'
// The coverage gate for a LEARNED PROMPT: does the file exist, is its frontmatter well formed, and
// does some section claim every canonical field in schema.md. Pure functions over file contents;
// nothing here prints or nudges. Used by the driver's build machine and by `gate` and `publish`.
const fs = require('fs')

// The canonical fields, read from schema.md's tables: rows whose first cell is a backticked slug.
// This is the single source of truth for what a prompt must cover. Editing schema.md changes the
// gate, which is the point - the list must never be duplicated into this file.
//
// Two lists, split at the `## Repo-conditional fields` heading:
//
//   required     - every prompt must cover these, whatever the repo does
//   conditional  - covered ONLY when the repo itself writes about them. A prompt that omits one is
//                  correct; a prompt that invents one because it seems like good practice is not,
//                  and no gate can tell the difference, so the gate simply does not ask.
//
// `testing` lives in the second list. Plenty of repos never write a test-plan section, and a
// description that grows one is not in that repo's voice.
function canonicalFields(schemaPath) {
  let src
  try { src = fs.readFileSync(schemaPath, 'utf8') } catch { return { error: 'cannot read ' + schemaPath } }
  const split = src.search(/^##\s+Repo-conditional fields\s*$/m)
  const head = split === -1 ? src : src.slice(0, split)
  const tail = split === -1 ? '' : src.slice(split)
  const slugs = (text) => {
    const out = []
    const re = /^\|\s*`([a-z0-9][a-z0-9-]*)`\s*\|/gm
    let m
    while ((m = re.exec(text)) !== null) if (!out.includes(m[1])) out.push(m[1])
    return out
  }
  const required = slugs(head)
  const conditional = slugs(tail).filter(f => !required.includes(f))
  if (!required.length) return { error: 'no `field` rows found in ' + schemaPath }
  return { fields: required, conditional }
}

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) return null
  const fm = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim())
    if (kv) fm[kv[1]] = kv[2].trim()
  }
  return fm
}

// What the draft CLAIMS to cover: every `<!-- covers: a, b -->` comment in the body.
function claimedFields(text) {
  const out = []
  const re = /<!--\s*covers:\s*([^>]*?)-->/g
  let m
  while ((m = re.exec(text)) !== null) {
    for (const f of m[1].split(',').map(x => x.trim().replace(/^`|`$/g, '')).filter(Boolean)) {
      if (!out.includes(f)) out.push(f)
    }
  }
  return out
}

// The whole gate, as data. Callers decide what to print.
function inspect(draftPath, schemaPath) {
  const r = { ok: false, problems: [], missing: [], unknown: [], pattern: '', bytes: 0 }
  let text
  try { text = fs.readFileSync(draftPath, 'utf8') } catch {
    r.problems.push('The draft file does not exist on disk.')
    return r
  }
  r.bytes = Buffer.byteLength(text)
  const fm = frontmatter(text)
  if (!fm) {
    r.problems.push('The draft has no `---` frontmatter block at the very top of the file.')
    return r
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fm.learned_at || '')) {
    r.problems.push('Frontmatter `learned_at` is missing or is not a YYYY-MM-DD date.')
  }
  r.pattern = fm.pattern || ''
  if (!['derived', 'template', 'none'].includes(r.pattern)) {
    r.problems.push('Frontmatter `pattern` must be exactly one of: derived, template, none.')
  }
  if (!/^\[.*\]$/.test(fm.source_prs || '')) {
    r.problems.push('Frontmatter `source_prs` is missing or is not a [..] list - it may be empty ([]) only when pattern is none.')
  }
  if (fm.pattern !== 'none' && !/^\d{3,6}$/.test(fm.max_bytes || '')) {
    r.problems.push('Frontmatter `max_bytes` is missing or is not a plain integer. It is this repo\'s own ' +
                    'length ceiling, measured from the sampled bodies, and without it nothing stops a ' +
                    'description growing past anything these authors would merge.')
  }

  // pattern: none means there was not enough evidence and schema.md is used verbatim instead.
  // There is no prompt body to cover anything, so the coverage gate does not apply - but the
  // frontmatter still has to be well formed, or a later run cannot tell stale from absent.
  if (r.pattern === 'none') {
    r.ok = r.problems.length === 0
    return r
  }

  const body = text.slice(text.indexOf('\n---\n') + 5)
  if (Buffer.byteLength(body) < 400) {
    r.problems.push('The prompt body is under 400 bytes, which is too thin to be a usable generation prompt.')
  }
  if (!/^##\s*Title/mi.test(body)) r.problems.push('The prompt has no `## Title` section.')
  if (!/^##\s*Body/mi.test(body)) r.problems.push('The prompt has no `## Body` section.')
  if (!/^##\s*Style/mi.test(body)) {
    r.problems.push('The prompt has no `## Style` section. Every prompt must demand concise, direct, ' +
                    'filler-free prose - that rule is imposed on every repo, not derived from one.')
  }

  const canon = canonicalFields(schemaPath)
  if (canon.error) { r.problems.push('Cannot read the canonical field list: ' + canon.error); return r }
  const claimed = claimedFields(body)
  const known = canon.fields.concat(canon.conditional || [])
  r.missing = canon.fields.filter(f => !claimed.includes(f))
  r.unknown = claimed.filter(f => !known.includes(f))
  // An unknown name is a typo or a field that no longer exists, and either way the section it sits
  // on covers nothing. It was printed but not failed until now, which meant `covers: tesing` sailed
  // through: `testing` is conditional, so nothing was reported missing either.
  r.ok = r.problems.length === 0 && r.missing.length === 0 && r.unknown.length === 0
  return r
}



// Everything the orchestrator needs to know about a build, read off the driver's own state and the
// draft's frontmatter. The builder is asked for none of it, so none of it can be wrong in the ways an
// agent's report can be wrong.
function fmList(s) {
  const m = /^\[(.*)\]$/.exec(String(s || '').trim())
  if (!m) return []
  return m[1].split(',').map(x => x.trim().replace(/^["'`]|["'`]$/g, '')).filter(Boolean)
    .map(x => /^\d+$/.test(x) ? parseInt(x, 10) : x)
}

// Rewrite or add keys in the frontmatter block. Body untouched.
function stampFrontmatter(text, kv) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) return null
  let lines = m[1].split('\n')
  for (const [k, v] of Object.entries(kv)) {
    const i = lines.findIndex(l => new RegExp('^' + k + ':').test(l.trim()))
    const line = k + ': ' + v
    if (i === -1) lines.push(line); else lines[i] = line
  }
  return '---\n' + lines.join('\n') + '\n---\n' + text.slice(m[0].length)
}

// Gate once more, stamp what the orchestrator learned, rename into place. Refuses without a recorded
// verdict, because "nobody checked it" must never look like "it passed".

module.exports = { canonicalFields, frontmatter, claimedFields, inspect, fmList, stampFrontmatter }
