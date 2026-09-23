#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const DASHBOARD = path.join(ROOT, 'docs', 'index.html')

function chromeExecutable() {
  const candidates = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean)
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' })
    if (!result.error && result.status === 0) return candidate
  }
  throw new Error(`Chrome or Chromium is required; checked: ${candidates.join(', ')}`)
}

const chrome = chromeExecutable()
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'review-bench-browser-'))

function render(hash) {
  const url = `${pathToFileURL(DASHBOARD).href}#${hash}`
  const dom = execFileSync(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-crash-reporter', `--user-data-dir=${profile}`,
    '--virtual-time-budget=2500', '--dump-dom', url,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const start = dom.indexOf('<div id="app">')
  const end = dom.indexOf('<script id="dashboard-data"')
  assert.notEqual(start, -1, `#${hash} did not render #app`)
  assert.notEqual(end, -1, `#${hash} lost embedded data`)
  return { app: dom.slice(start, end), dom }
}

function count(text, pattern) { return [...text.matchAll(pattern)].length }

try {
  assert.ok(fs.existsSync(DASHBOARD), 'run make bench-dashboard before the browser check')

  const home = render('home')
  assert.match(home.app, /Find the code-review skill worth its price\./)
  assert.match(home.app, /Findings \/ price/)
  assert.match(home.app, /3\.02 \/ \$/)
  assert.match(home.app, /Completeness \/ price/)
  assert.match(home.app, /3\.12 pts \/ \$/)
  assert.match(home.app, /Best return for the money · All issues/)
  assert.equal(count(home.app, /id="completeness-scope"/g), 1)
  assert.ok(home.app.indexOf('id="completeness-scope"') < home.app.indexOf('class="landing-rank-grid leader-grid"'), 'the count picker must appear above the leader cards')
  const valueCards = home.app.match(/<div class="landing-rank-grid leader-grid">([\s\S]*?)<\/div><p class="method-note">/)
  assert.ok(valueCards, 'the price leaders must render as a ranked-card grid')
  assert.equal(count(valueCards[1], /<article class="rank-card">/g), 2)
  assert.doesNotMatch(valueCards[1], /value-leader-card|class="eyebrow"|See leaderboard/)
  assert.equal(count(home.app, /class="skill-summary-card"/g), 8)
  assert.match(home.app, /href="#skills\/superpowers-review"/)
  assert.doesNotMatch(home.app, /review-bakeoff\.md/)
  assert.match(home.app, /Best coverage · All issues/)
  assert.match(home.app, /Compound Engineering ce-code-review<\/a><\/h3><strong>56\.8%/)

  const majorHome = render('home?completeness=major')
  assert.match(majorHome.app, /Best return for the money · Major only/)
  assert.match(majorHome.app, /0\.45 \/ \$/)
  assert.match(majorHome.app, /5\.03 pts \/ \$/)
  assert.match(majorHome.app, /66\.7% of major verified findings/)
  assert.match(majorHome.app, /Best coverage · Major only/)
  assert.match(majorHome.app, /Compound Engineering ce-code-review<\/a><\/h3><strong>75\.0%/)
  const majorValueCards = majorHome.app.match(/<div class="landing-rank-grid leader-grid">([\s\S]*?)<\/div><p class="method-note">/)
  assert.ok(majorValueCards)
  assert.equal(count(majorValueCards[1], /<article class="rank-card">/g), 1, 'one skill leading both price measures must render once')
  assert.match(majorValueCards[1], /0\.45 \/ \$ · 5\.03 pts \/ \$/)

  const majorMinorHome = render('home?completeness=majorMinor')
  assert.match(majorMinorHome.app, /Best return for the money · Major \+ minor/)
  assert.match(majorMinorHome.app, /1\.21 \/ \$/)
  assert.match(majorMinorHome.app, /5\.25 pts \/ \$/)
  assert.match(majorMinorHome.app, /69\.6% of major \+ minor verified findings/)
  assert.match(majorMinorHome.app, /Best coverage · Major \+ minor/)
  assert.match(majorMinorHome.app, /Superpowers requesting-code-review<\/a><\/h3><strong>69\.6%/)
  const majorMinorValueCards = majorMinorHome.app.match(/<div class="landing-rank-grid leader-grid">([\s\S]*?)<\/div><p class="method-note">/)
  assert.ok(majorMinorValueCards)
  assert.equal(count(majorMinorValueCards[1], /<article class="rank-card">/g), 1, 'duplicate winners must stay deduplicated across scopes')

  const choose = render('choose')
  for (const label of ['Candidate', 'Cost', 'Real / run', 'High + med', 'Precision', 'Completeness', 'Cost / real', 'Success']) {
    assert.match(choose.app, new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?class="hint-mark"`, 's'), `${label} needs a rendered hint`)
  }
  assert.match(choose.app, /href="#runs\?runIds=[^"]+" class="runs-link">3 runs<\/a>/)
  assert.match(choose.app, /href="#skills\/superpowers-review" class="skill-info-link">Skill info<\/a>/)
  assert.match(choose.dom, /class="hint-tooltip" role="tooltip" hidden=""/)

  const runs = render('runs?runIds=ironweave%2Ftob-c-review')
  assert.match(runs.app, /Linked set · 1 run/)
  const runBody = runs.app.match(/<tbody>([\s\S]*?)<\/tbody>/)
  assert.ok(runBody, 'the exact run-set view must render a table body')
  assert.equal(count(runBody[1], /<tr>/g), 1, 'the exact run-set link must render one row')
  assert.match(runs.app, /href="#run\/ironweave\/tob-c-review" class="run-link">Trail of Bits c-review<\/a>/)
  assert.match(runs.app, /Read from the stored Claude Code transcript cost and usage records\./)

  const anthropicRun = render('runs?runIds=tidepool%2Fanthropic-pr-review')
  assert.match(anthropicRun.app, /<span class="subline">tidepool · <a href="#skills\/anthropic-pr-review" class="skill-info-link">anthropic-pr-review<\/a><\/span>/)
  assert.doesNotMatch(anthropicRun.app, /pr-review-toolkit@claude-plugins-official|>Skill info</)

  const pickedRuns = render('runs?pick=tidepool%2Fbuiltin-code-review%2Ctidepool%2Fsuperpowers-review')
  assert.match(pickedRuns.app, /href="#run\/tidepool\/builtin-code-review" class="run-link">Claude Code \/code-review<\/a> ↔/)
  assert.match(pickedRuns.app, /href="#run\/tidepool\/superpowers-review" class="run-link">Superpowers requesting-code-review<\/a>/)

  const run = render('run/ironweave/tob-c-review')
  for (const label of ['Input', 'Output', 'Cache read', 'Cache creation', 'Thinking (within output)', 'Field provenance']) {
    assert.match(run.app, new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?class="hint-mark"`, 's'), `${label} needs a rendered hint`)
  }
  assert.match(run.app, /source: <span class="hinted-label">transcript/)

  const insights = render('insights')
  assert.match(insights.app, /non-dominated frontier<span class="hint-mark"/)
  assert.match(insights.app, /Bubble size: <span class="hinted-label">False-positive rate/)
  assert.match(insights.app, /class="chart-link"[^>]*role="link"/)

  const skills = render('skills')
  assert.equal(count(skills.app, /class="skill-card"/g), 8)
  assert.equal(count(skills.app, />GitHub ↗<\/a>/g), 8)
  assert.equal(count(skills.app, />Skill page ↗<\/a>/g), 8)
  assert.match(skills.app, /The benchmark ran these as Claude Code plugins\./)

  const skillComparison = render('compare?compareSkills=builtin-code-review%2Csuperpowers-review')
  for (const label of ['Attempted cost', 'Distinct real', 'Only this skill', 'Shared', 'Completeness', 'Precision', 'Success']) {
    assert.match(skillComparison.app, new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?class="hint-mark"`, 's'), `${label} needs a rendered hint`)
  }
  assert.match(skillComparison.app, />6 attempted runs<\/a>/)
  assert.match(skillComparison.app, /href="#skills\/builtin-code-review" class="skill-info-link">Skill info<\/a>/)

  const comparison = render('compare/tidepool/builtin-code-review/tidepool/superpowers-review')
  assert.match(comparison.app, /href="#run\/tidepool\/builtin-code-review" class="run-link">tidepool\/builtin-code-review<\/a>/)
  assert.match(comparison.app, /href="#run\/tidepool\/superpowers-review" class="run-link">tidepool\/superpowers-review<\/a>/)
  assert.match(comparison.app, /Thinking<span class="hint-mark"/)

  process.stdout.write('dashboard-browser-check: all rendered routes passed\n')
} finally {
  fs.rmSync(profile, { recursive: true, force: true })
}
