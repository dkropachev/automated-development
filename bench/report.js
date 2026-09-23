'use strict'
// Render the bake-off. Everything here is mechanical: the numbers come from bench/results (what each
// run spent), bench/findings (what each run claimed) and bench/judgement (what survived checking).
// The prose that interprets them lives in the report's own Analysis section, written by hand.
//
//   node bench/report.js > docs/review-bakeoff.md
const fs = require('node:fs')
const path = require('node:path')
const { totalsForCwd } = require('./lib/usage')

const ROOT = __dirname
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8'))
const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.json'), 'utf8')).tools
const SHORT = {
  'builtin-code-review': 'CR', 'ce-code-review': 'CE', 'tob-diff-review': 'TB-D',
  'tob-rust-review': 'TB-R', 'tob-c-review': 'TB-C', 'anthropic-pr-review': 'ANT',
  'superpowers-review': 'SP', 'mattpocock-review': 'MP',
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const exists = (p) => fs.existsSync(p)
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'))
const money = (n) => (n == null ? '-' : '$' + Number(n).toFixed(2))
const mins = (ms) => (ms == null ? '-' : (ms / 60000).toFixed(1))

const targets = Object.values(state.targets)
const results = {}
for (const t of targets) {
  results[t.id] = {}
  const dir = path.join(ROOT, 'results', t.id)
  if (!exists(dir)) continue
  // `.lock` files sit next to the results; only the results are results.
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const rec = read(path.join(dir, f))
    // Usage is recomputed here rather than trusted from the run record: the accounting was fixed
    // after the first runs were already on disk, and the transcripts outlive the record.
    // `usageCwd` is set when a run's tool was renamed after it ran: the transcripts stay filed
    // under the directory it actually used.
    const cwd = rec.usageCwd || path.join(ROOT, 'work', t.id, 'runs', rec.tool, 'repo')
    rec.cell = totalsForCwd(cwd)
    // What the REPORT cost is the attempt that produced it, not everything ever run in that
    // directory: a pair the usage limit cut off was retried from scratch, and those dead attempts
    // are filed under the same directory. They are counted too, as `wasted`, because somebody paid
    // for them - just not as the price of a review.
    // `attemptSince` is set by hand for the runs that were salvaged from their transcripts and so
    // have no wall time of their own; otherwise the window is the recorded wall time, widened by
    // two minutes for process startup.
    const start = rec.attemptSince || (rec.finishedAt && rec.wallMs ? Date.parse(rec.finishedAt) - rec.wallMs - 120000 : 0)
    rec.usage = start ? totalsForCwd(cwd, { since: start }) : rec.cell
    // A run that never produced a report bought nothing with any of it, last attempt included.
    if (rec.dnf) rec.usage = totalsForCwd(cwd, { since: Date.now() })
    rec.wastedUsd = Math.max(0, (rec.cell.costUsd || 0) - (rec.usage.costUsd || 0))
    rec.wastedTok = Math.max(0, (rec.cell.total || 0) - (rec.usage.total || 0))
    results[t.id][rec.tool] = rec
  }
}
const findings = {}
for (const t of targets) {
  findings[t.id] = {}
  const dir = path.join(ROOT, 'findings', t.id)
  if (!exists(dir)) continue
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const rec = read(path.join(dir, f))
    findings[t.id][rec.tool] = rec.findings || []
  }
}
const judged = {}
for (const t of targets) {
  const p = path.join(ROOT, 'judgement', `${t.id}.json`)
  if (exists(p)) judged[t.id] = read(p).issues || []
}

const groundtruth = {}
for (const t of targets) {
  const p = path.join(ROOT, 'groundtruth', t.id + '.json')
  if (exists(p)) groundtruth[t.id] = read(p)
}
// A review comment as one table cell: quoted replies stripped, newlines and pipes flattened.
function oneline(body) {
  const s = String(body || '').split('\n').filter(l => !l.startsWith('>')).join(' ')
  const t = s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
  return t.length > 220 ? t.slice(0, 217) + '...' : t
}

// What the token column is actually made of. Four classes priced an order of magnitude apart get
// summed into one number, so the number needs its composition printed next to it.
const tokenMix = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 }
for (const t of targets) for (const rec of Object.values(results[t.id] || {})) {
  for (const k of Object.keys(tokenMix)) tokenMix[k] += rec.usage[k] || 0
}
// Thinking is a subset of output, so it is left out of the denominator.
const mixTotal = tokenMix.input + tokenMix.output + tokenMix.cacheRead + tokenMix.cacheCreation
const pctOfTotal = (k) => (mixTotal ? (100 * tokenMix[k] / mixTotal).toFixed(1) : '0') + '%'

const used = tools.filter(tl => targets.some(t => results[t.id] && results[t.id][tl.id]))
const out = []
const P = (s) => out.push(s)

P(`# Review-tool bake-off: ${used.length} review configurations, three real PRs\n`)
P('Every number below is produced by `bench/` in this repository and can be regenerated with')
P('`make bench-report`. General-purpose tools reviewed all three pull requests; language-specific')
P('tools ran only on matching targets. Every run used its own headless `claude -p` process and')
P('working directory so its token spend is attributable.\n')

P('## What was reviewed\n')
P('| Target | Language | Diff | Files | PR under review | Upstream original |')
P('|---|---|---:|---:|---|---|')
for (const t of targets) {
  P(`| \`${t.id}\` | ${t.language} | ${fmt(t.localDiffBytes)} B | ${t.commits} commits | ${t.forkPrUrl} | ${t.upstreamPrUrl} |`)
}
P('')
P('Each PR was republished into a private repository of its own: full upstream history, the PR\'s own')
P('commits replayed under a neutral author, every `owner/repo` link repointed at the copy, and')
P('`WebSearch`/`WebFetch` denied to every run. A reviewer that could reach the original PR could read')
P('the maintainers\' review instead of doing its own.\n')

P('## Findings, by issue\n')
P('One row per distinct defect the tools found between them, merged across tools by a judge that had')
P('the code in front of it. `✓` = that tool reported it.\n')
const cols = used.map(tl => SHORT[tl.id] || tl.id)
P(`| # | Issue | Verdict | Scope | New? | Sev | ${cols.join(' | ')} |`)
P(`|---|---|---|---|---|---|${cols.map(() => '---').join('|')}|`)
let n = 0
for (const t of targets) {
  const issues = judged[t.id]
  if (!issues) continue
  P(`| | **${t.id} (${t.language})** | | | | | ${cols.map(() => '').join(' | ')} |`)
  for (const i of issues) {
    n += 1
    const by = new Set(i.reportedBy || [])
    const marks = used.map(tl => (by.has(tl.id) ? '✓' : ''))
    const where = i.file ? `\`${i.file}${i.line ? ':' + i.line : ''}\`` : ''
    P(`| ${n} | ${i.title} ${where} | ${i.verdict} | ${i.scope} | ${i.introducedByPr ? 'yes' : 'no'} | ${i.severity} | ${marks.join(' | ')} |`)
  }
}
P('')

P('## Per tool\n')
P('*Tokens* and *Cost* are the attempt that produced the report being scored. *Lost to limits* is what')
P('the same cell spent on earlier attempts that the account\'s usage limit cut off mid-review: they')
P('produced nothing and were retried from scratch. Both columns are real money; only the first is the')
P('price of a review.\n')
P('**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are')
P(`priced an order of magnitude apart, and ${pctOfTotal('cacheRead')} of it is cache reads, which bill at a tenth of`)
P(`input; cache creation, another ${pctOfTotal('cacheCreation')}, bills at 1.25x. Output - the tokens a reviewer`)
P(`actually wrote - is ${pctOfTotal('output')} of the total. A tool that re-reads a large tree under a warm cache`)
P('therefore looks enormous and costs little. The cost column is not computed from these counts: it is')
P('the per-session figure Claude Code itself bills, already priced per class. Thinking tokens')
P(`(${fmt(tokenMix.thinking)} across the matrix) are counted in the cost and reported by the model as part of`)
P('its output, so they are deliberately not added on top of it here.\n')
P('| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Only this tool | Tokens | Cost | Wall | Lost to limits |')
P('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const tl of used) {
  let raised = 0, real = 0, fp = 0, unproven = 0, inScope = 0, pre = 0, uniq = 0, tok = 0, cost = 0, wall = 0, runs = 0, wasted = 0
  for (const t of targets) {
    const rec = results[t.id] && results[t.id][tl.id]
    if (rec) { runs += 1; tok += rec.usage.total || 0; cost += rec.usage.costUsd || 0; wall += rec.wallMs || 0; wasted += rec.wastedUsd || 0 }
    for (const i of judged[t.id] || []) {
      if (!(i.reportedBy || []).includes(tl.id)) continue
      raised += 1
      if (i.verdict === 'real') real += 1
      else if (i.verdict === 'false-positive') fp += 1
      else unproven += 1
      if (i.verdict === 'real' && i.scope === 'in-scope') inScope += 1
      if (i.verdict === 'real' && !i.introducedByPr) pre += 1
      if ((i.reportedBy || []).length === 1 && i.verdict === 'real') uniq += 1
    }
  }
  P(`| ${tl.label} | ${runs} | ${raised} | ${real} | ${fp} | ${unproven} | ${inScope} | ${pre} | ${uniq} | ${fmt(tok)} | ${money(cost)} | ${mins(wall)} min | ${wasted > 0.005 ? money(wasted) : '-'} |`)
}
P('')

P('### Spend per run\n')
P(`| Tool | ${targets.map(t => t.id).join(' | ')} |`)
P(`|---|${targets.map(() => '---:').join('|')}|`)
for (const tl of used) {
  const cells = targets.map(t => {
    const rec = results[t.id] && results[t.id][tl.id]
    if (!rec) return '-'
    return `${fmt(rec.usage.total)} tok / ${money(rec.usage.costUsd)} / ${mins(rec.wallMs)} min`
  })
  P(`| ${tl.label} | ${cells.join(' | ')} |`)
}
P('')
const sumOver = (f) => targets.reduce((a, t) => a + Object.values(results[t.id] || {}).reduce((b, r) => b + (f(r) || 0), 0), 0)
const totalCost = sumOver(r => r.usage.costUsd)
const totalTok = sumOver(r => r.usage.total)
const wastedCost = sumOver(r => r.wastedUsd)
const wastedTok = sumOver(r => r.wastedTok)
const runCount = sumOver(() => 1)
P(`**The ${runCount} scored reviews cost ${fmt(totalTok)} tokens, ${money(totalCost)}.** A further`)
P(`**${fmt(wastedTok)} tokens, ${money(wastedCost)}** went on attempts the usage limit killed before they`)
P(`reported, for a bill of ${money(totalCost + wastedCost)} across the matrix. Judging and extraction are`)
P('counted separately.\n')

P('### Raw claims before judging\n')
P('What each run said, before merging and verification - the gap between this and *Raised* above is')
P('what the judge merged away as the same defect twice.\n')
P(`| Tool | ${targets.map(t => t.id).join(' | ')} |`)
P(`|---|${targets.map(() => '---:').join('|')}|`)
for (const tl of used) {
  P(`| ${tl.label} | ${targets.map(t => ((findings[t.id] || {})[tl.id] || []).length || (results[t.id] && results[t.id][tl.id] ? '0' : '-')).join(' | ')} |`)
}
P('')

P('## What the maintainers actually said\n')
P('The upstream reviews, fetched at prepare time and never shown to any reviewer or to the judge.')
P('Bot comments are dropped, and so are the PR author\'s own replies, which are answers rather than')
P('findings.\n')
P('Read these as context, not as a scoreboard. Every PR here was replayed at the revision that was')
P('merged, which is the revision *after* its review: the defects the maintainers caught were already')
P('fixed in the code the tools were given, so not reporting one is not a miss. What the list is good')
P('for is the other direction - whether a tool raises the kind of thing these maintainers raise, and')
P('whether anything they flagged survived into the merged code.\n')
for (const t of targets) {
  const g = groundtruth[t.id]
  if (!g) continue
  const author = String(g.author || '').toLowerCase()
  const human = (c) => !/\[bot\]$/.test(c.user || '') && String(c.user || '').toLowerCase() !== author
  const inline = ((g.review || {}).inline || []).filter(human)
  const issue = ((g.review || {}).issue || []).filter(human)
  P(`**\`${t.id}\`** - ${g.url} - ${inline.length} inline review comments, ${issue.length} thread comments.\n`)
  if (!inline.length && !issue.length) { P('No human review comments upstream.\n'); continue }
  P('| Who | Where | What they said |')
  P('|---|---|---|')
  for (const c of inline) P(`| ${c.user} | \`${c.path}${c.line ? ':' + c.line : ''}\` | ${oneline(c.body)} |`)
  for (const c of issue) P(`| ${c.user} | thread | ${oneline(c.body)} |`)
  P('')
}

P('### Runs that did not complete\n')
const bad = []
for (const t of targets) for (const [id, rec] of Object.entries(results[t.id] || {})) {
  if (rec.exitCode === 0 && !rec.isError && rec.result) continue
  const how = `exit ${rec.exitCode}${rec.signal ? ' ' + rec.signal : ''}${rec.apiErrorStatus ? ' api ' + rec.apiErrorStatus : ''}`
  const spent = `${fmt(rec.cell.total)} tokens and ${money(rec.cell.costUsd)} spent across ${rec.cell.sessions} sessions`
  bad.push(`- \`${t.id}/${id}\` - ${how}, ${spent}.${rec.dnfReason ? ' ' + rec.dnfReason : ''}`)
}
P(bad.length ? bad.join('\n') : 'None - every run in the matrix returned a report.')
P('')
// The analysis is written by hand and lives in bench/analysis.md, so regenerating the report does
// not erase it.
const analysisPath = path.join(ROOT, 'analysis.md')
if (exists(analysisPath)) P(fs.readFileSync(analysisPath, 'utf8').trim() + '\n')
console.log(out.join('\n'))
