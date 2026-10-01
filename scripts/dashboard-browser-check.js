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
const DASHBOARD_SOURCE = fs.readFileSync(DASHBOARD, 'utf8')
const DASHBOARD_DATA = JSON.parse(DASHBOARD_SOURCE.match(/<script id="dashboard-data" type="application\/json">([\s\S]*?)<\/script>/)[1])

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

function rankingCards(text, gridClass) {
  const match = text.match(new RegExp(`<div class="landing-rank-grid ${gridClass}">([\\s\\S]*?)<\\/div><\\/div>`))
  assert.ok(match, `${gridClass} must render as a ranked-card grid`)
  return match[1]
}

function assertTopThree(cards) {
  assert.equal(count(cards, /<article class="rank-card">/g), 3)
  for (const rank of [1, 2, 3]) assert.match(cards, new RegExp(`<div class="rank-number">#${rank}<\\/div>`))
}

function modelCompletenessDenominators(text) {
  const table = text.match(/<table class="model-comparison-table">([\s\S]*?)<\/table>/)
  assert.ok(table, 'the model comparison must render its metrics table')
  return [...table[1].matchAll(/<span class="subline">[0-9]+ \/ ([0-9]+)<\/span>/g)].map((match) => Number(match[1]))
}

function modelRows(text) {
  const table = text.match(/<table class="model-comparison-table">[\s\S]*?<tbody>([\s\S]*?)<\/tbody><\/table>/)
  assert.ok(table, 'the model comparison must render model rows')
  return [...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => ({
    html: match[1],
    name: (match[1].match(/<strong>([^<]+)<\/strong>/) || [])[1],
  }))
}

function completedCohortRows(text) {
  const section = text.match(/<section class="panel completed-cohort-panel"[\s\S]*?<tbody>([\s\S]*?)<\/tbody><\/table>[\s\S]*?<\/section>/)
  assert.ok(section, 'the Models tab must render completed cohorts')
  return [...section[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => match[1])
}

function leaderboardRows(text) {
  const table = text.match(/<h2>Decision leaderboard<\/h2>[\s\S]*?<table>[\s\S]*?<tbody>([\s\S]*?)<\/tbody><\/table>/)
  assert.ok(table, 'the decision leaderboard must render candidate rows')
  return [...table[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => {
    const name = match[1].match(/<strong>[0-9]+\. <a[^>]*>([^<]+)<\/a><\/strong>/)
    assert.ok(name, 'each decision leaderboard row must name its candidate')
    return name[1]
  })
}

function linkedEvidenceCounts(text) {
  return modelRows(text).map((row) => Number((row.html.match(/aria-label="View exact contributing runs: ([0-9]+)"/) || [])[1]))
}

try {
  assert.ok(fs.existsSync(DASHBOARD), 'run make bench-dashboard before the browser check')

  const defaultHome = render('home')
  assert.match(defaultHome.app, /<option value="claude-opus-5-5" selected="">Claude Opus 5\.5<\/option>/)
  if (/No benchmark runs recorded for Claude Opus 5\.5 yet/.test(defaultHome.app)) {
    assert.match(defaultHome.app, /<strong>0<\/strong><span>review runs<\/span>/)
  } else {
    assert.match(defaultHome.app, /<strong>[1-9][0-9]*<\/strong><span>review runs<\/span>/)
  }

  const fableHome = render('home?model=claude-fable-5-1')
  assert.match(fableHome.app, /<option value="claude-fable-5-1" selected="">Claude Fable 5\.1<\/option>/)
  if (/No benchmark runs recorded for Claude Fable 5\.1 yet/.test(fableHome.app)) {
    assert.match(fableHome.app, /<strong>0<\/strong><span>review runs<\/span>/)
  } else {
    assert.match(fableHome.app, /<strong>[1-9][0-9]*<\/strong><span>review runs<\/span>/)
  }

  const sonnetHome = render('home?model=claude-sonnet-5-5')
  assert.match(sonnetHome.app, /<option value="claude-sonnet-5-5" selected="">Claude Sonnet 5\.5<\/option>/)
  assert.match(sonnetHome.app, /<strong>19<\/strong><span>review runs<\/span>/)

  // Pin historical assertions to legacy Opus. `model=all` intentionally changes whenever a new
  // completed cohort lands, while this slice remains stable before and after that event.
  const home = render('home?model=claude-opus-5')
  assert.match(home.app, /Find the code-review skill worth its price\./)
  assert.match(home.app, /cohort-adjudicated real findings/)
  assert.doesNotMatch(home.app, /verified findings|verified issues|verified real/)
  assert.match(home.app, /<h2 id="leaders-title">Leaders<\/h2>/)
  assert.doesNotMatch(home.app, /Completeness leaders/)
  assert.match(home.app, /Best return for the money · All issues/)
  assert.match(home.app, /3\.02 findings \/ \$/)
  assert.equal(count(home.app, /id="completeness-scope"/g), 1)
  assert.equal(count(home.app, /id="language-scope"/g), 1)
  assert.match(home.app, /class="leader-pickers"[\s\S]*id="completeness-scope"[\s\S]*id="language-scope"/)
  assert.ok(home.app.indexOf('id="completeness-scope"') < home.app.indexOf('class="landing-rank-grid leader-grid"'), 'the count picker must appear above the leader cards')
  const valueCards = rankingCards(home.app, 'leader-grid')
  assertTopThree(valueCards)
  assert.doesNotMatch(valueCards, /value-leader-card|class="eyebrow"|See leaderboard/)
  assert.equal(count(home.app, /class="skill-summary-card"/g), 8)
  assert.match(home.app, /href="#skills\/superpowers-review\?model=claude-opus-5"/)
  assert.doesNotMatch(home.app, /review-bakeoff\.md/)
  assert.match(home.app, /Best coverage · All issues/)
  assert.match(home.app, /Compound Engineering ce-code-review<\/a><\/h3><strong>56\.8%/)
  const coverageCards = rankingCards(home.app, 'completeness-grid')
  assertTopThree(coverageCards)
  assert.match(home.app, /Fastest useful review · All issues/)
  assertTopThree(rankingCards(home.app, 'fastest-grid'))
  assert.match(home.app, /Most unique discoveries · All issues/)
  assertTopThree(rankingCards(home.app, 'unique-grid'))
  assert.equal(count(home.app, /class="leader-section"/g), 4)

  const majorHome = render('home?model=claude-opus-5&completeness=major')
  assert.match(majorHome.app, /Best return for the money · Major only/)
  assert.match(majorHome.app, /0\.45 findings \/ \$/)
  assert.match(majorHome.app, /Best coverage · Major only/)
  assert.match(majorHome.app, /Compound Engineering ce-code-review<\/a><\/h3><strong>75\.0%/)
  assertTopThree(rankingCards(majorHome.app, 'leader-grid'))

  const majorMinorHome = render('home?model=claude-opus-5&completeness=majorMinor')
  assert.match(majorMinorHome.app, /Best return for the money · Major \+ minor/)
  assert.match(majorMinorHome.app, /1\.21 findings \/ \$/)
  assert.match(majorMinorHome.app, /Best coverage · Major \+ minor/)
  assert.match(majorMinorHome.app, /Superpowers requesting-code-review<\/a><\/h3><strong>69\.6%/)
  assertTopThree(rankingCards(majorMinorHome.app, 'leader-grid'))

  const goHome = render('home?model=claude-opus-5&language=Go')
  assert.match(goHome.app, /Best return for the money · All issues · Go/)
  assert.match(goHome.app, /Best coverage · All issues · Go/)
  assert.match(goHome.app, /Fastest useful review · All issues · Go/)
  assert.match(goHome.app, /Most unique discoveries · All issues · Go/)
  assert.match(goHome.app, /<option value="Go" selected="">Go<\/option>/)
  assertTopThree(rankingCards(goHome.app, 'completeness-grid'))
  assert.doesNotMatch(rankingCards(goHome.app, 'completeness-grid'), /[23] targets/)

  const rustMajorHome = render('home?model=claude-opus-5&completeness=major&language=Rust')
  assert.match(rustMajorHome.app, /Fastest useful review · Major only · Rust/)
  assert.match(rustMajorHome.app, /Most unique discoveries · Major only · Rust/)

  const choose = render('choose?model=claude-opus-5')
  assert.match(choose.app, /class="choose-tabs" aria-label="Leaderboard views"/)
  assert.match(choose.app, /aria-current="page" class="active">Skills<\/a>/)
  assert.doesNotMatch(choose.app, /<option value="model">Model under test<\/option>/)
  for (const label of ['Candidate', 'Cost', 'Real / run', 'High + med', 'Precision', 'Completeness', 'Cost / real', 'Success']) {
    assert.match(choose.app, new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?class="hint-mark"`, 's'), `${label} needs a rendered hint`)
    assert.match(choose.app, new RegExp(`aria-label="Sort leaderboard by ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, (?:ascending|descending)"`), `${label} must be sortable`)
  }
  assert.equal(count(choose.app, /aria-sort="none"/g), 8, 'the hidden best-value preset must not mark a visible column as sorted')
  assert.match(choose.app, /href="#runs\?runIds=[^"]+" class="runs-link">3 runs<\/a>/)
  assert.match(choose.app, /href="#skills\/superpowers-review\?model=claude-opus-5" class="skill-info-link">Skill info<\/a>/)
  assert.match(choose.dom, /class="hint-tooltip" role="tooltip" hidden=""/)

  const candidateAscending = render('choose?model=claude-opus-5&decision=candidate')
  const ascendingNames = leaderboardRows(candidateAscending.app)
  assert.deepEqual(ascendingNames, [...ascendingNames].sort((a, b) => a.localeCompare(b)))
  assert.equal(count(candidateAscending.app, /aria-sort="ascending"/g), 1)
  assert.equal(count(candidateAscending.app, /aria-sort="none"/g), 7)
  assert.match(candidateAscending.app, /<option value="candidate" selected="">Candidate<\/option>/)

  const candidateDescending = render('choose?model=claude-opus-5&decision=candidate&decisionDir=desc')
  assert.deepEqual(leaderboardRows(candidateDescending.app), [...ascendingNames].reverse())
  assert.equal(count(candidateDescending.app, /aria-sort="descending"/g), 1)

  const costDescending = render('choose?model=claude-opus-5&decision=cost&decisionDir=desc')
  assert.equal(leaderboardRows(costDescending.app)[0], 'Trail of Bits c-review')
  assert.match(costDescending.app, /<option value="cost" selected="">Cost<\/option>/)

  const models = render('choose?tab=models')
  assert.match(models.app, /Compare models against the canonical gold standard\./)
  assert.match(models.app, /aria-current="page" class="active">Models<\/a>/)
  assert.doesNotMatch(models.app, /id="model-filter"/)
  assert.match(models.app, /id="model-scope"/)
  assert.match(models.app, /All models · 17 matched cells/)
  for (const label of ['Best value', 'Most complete', 'Lowest median cost', 'Fastest median runtime']) assert.match(models.app, new RegExp(`>${label}<`))
  for (const label of ['Real / $', 'Recorded total', 'Median cost', 'Canonical real', 'High + med', 'Precision', 'Completeness', 'Cost / real', 'Median runtime', 'Success', 'Evidence']) {
    assert.match(models.app, new RegExp(`aria-label="Sort models by ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), `${label} must be sortable`)
  }
  assert.match(models.app, /aria-sort="descending"/)
  assert.match(models.app, /<svg class="chart"[^>]*role="group"[^>]*aria-label="Cost versus completeness Pareto frontier"/)
  assert.match(models.app, /class="canonical-evidence-link"/)
  assert.match(models.app, /id="canonical-evidence-title"/)
  assert.match(models.app, /href="#runs\?runIds=[^"]+" class="runs-link"/)
  assert.match(models.app, /historical\/inferred|historical \/ inferred/)
  assert.match(models.app, /issues\/42/)
  const completedRows = completedCohortRows(models.app)
  const completedCohorts = DASHBOARD_DATA.cohorts.filter((cohort) => cohort.complete && !cohort.legacy)
  assert.equal(completedRows.length, completedCohorts.length, 'every completed modern cohort must appear automatically')
  for (const cohort of completedCohorts) {
    const row = completedRows.find((html) => html.includes(`<strong>${cohort.id}</strong>`))
    assert.ok(row, `completed cohort ${cohort.id} must appear in Models`)
    const runCount = DASHBOARD_DATA.runs.filter((run) => run.cohortId === cohort.id).length
    assert.match(row, new RegExp(`>${runCount} runs?<\\/a>`))
  }
  assert.ok(completedRows.some((html) => /Claude Sonnet 5\.5/.test(html) && /sonnet-5-5-2026-09-30/.test(html)))
  const denominators = modelCompletenessDenominators(models.app)
  assert.deepEqual(modelRows(models.app).map((row) => row.name), ['Claude Opus 5.5', 'Claude Fable 5.1', 'Claude Opus 5'])
  assert.equal(denominators.length, 3, 'all-model scope must compare exactly three models')
  assert.equal(new Set(denominators).size, 1, 'completeness denominator must be fixed across models')
  assert.deepEqual(linkedEvidenceCounts(models.app), [17, 17, 17])

  const skillFilteredModels = render('choose?tab=models&skills=builtin-code-review')
  assert.match(skillFilteredModels.app, /Skills · 1/)
  assert.deepEqual([...new Set(modelCompletenessDenominators(skillFilteredModels.app))], [...new Set(denominators)], 'skill filters must not change the target-level completeness denominator')
  assert.deepEqual(linkedEvidenceCounts(skillFilteredModels.app), [3, 3, 3], 'skill filters must change contributing evidence')
  assert.notEqual(modelRows(skillFilteredModels.app)[0].html, modelRows(models.app)[0].html, 'skill filters must change spend and findings')

  const targetFilteredModels = render('choose?tab=models&targets=tidepool')
  const targetDenominators = modelCompletenessDenominators(targetFilteredModels.app)
  assert.equal(new Set(targetDenominators).size, 1, 'target-filtered denominator must remain fixed across models')
  assert.notEqual(targetDenominators[0], denominators[0], 'target filters must change the canonical denominator')
  assert.deepEqual(linkedEvidenceCounts(targetFilteredModels.app), [6, 6, 6])

  const controlledPair = render('choose?tab=models&scope=controlled-pair')
  assert.match(controlledPair.app, /Current controlled pair · 19 matched cells/)
  assert.match(controlledPair.app, /<option value="controlled-pair" selected="">/)
  assert.deepEqual(modelRows(controlledPair.app).map((row) => row.name), ['Claude Opus 5.5', 'Claude Fable 5.1'])
  assert.deepEqual(linkedEvidenceCounts(controlledPair.app), [19, 19])

  const modelSorted = render('choose?tab=models&modelSort=model')
  assert.match(modelSorted.app, /<th class="" aria-sort="ascending">/)
  assert.deepEqual(modelRows(modelSorted.app).map((row) => row.name), ['Claude Fable 5.1', 'Claude Opus 5', 'Claude Opus 5.5'])

  const opusEvidence = render('choose?tab=models&evidenceModel=claude-opus-5-5&evidenceVerdict=real')
  assert.match(opusEvidence.app, /Canonical real evidence · Claude Opus 5\.5/)
  assert.match(opusEvidence.app, /class="panel model-evidence-panel" id="canonical-evidence" tabindex="-1"/)
  const evidencePanel = opusEvidence.app.match(/<section class="panel model-evidence-panel"[\s\S]*?<\/section>/)
  assert.ok(evidencePanel, 'selected canonical evidence panel must render')
  assert.equal(count(evidencePanel[0], /class="canonical-issue"/g), 42)
  assert.doesNotMatch(evidencePanel[0], /class="badge false-positive"|class="badge unproven"/)
  const firstEvidenceLink = evidencePanel[0].match(/href="(#runs\?runIds=[^"]+)" class="runs-link" aria-label="View exact contributing runs: ([0-9]+) credited cells? · view exact runs"/)
  assert.ok(firstEvidenceLink, 'canonical findings must link to their exact credited cells')
  const linkedRuns = render(firstEvidenceLink[1].slice(1).replaceAll('&amp;', '&'))
  const linkedRunBody = linkedRuns.app.match(/<tbody>([\s\S]*?)<\/tbody>/)
  assert.ok(linkedRunBody, 'canonical evidence run link must render a run table')
  assert.equal(count(linkedRunBody[1], /<tr>/g), Number(firstEvidenceLink[2]))

  const modelAlias = render('choose?group=model')
  assert.match(modelAlias.app, /Compare models against the canonical gold standard\./)
  assert.match(modelAlias.app, /aria-current="page" class="active">Models<\/a>/)

  const runs = render('runs?runIds=ironweave%2Ftob-c-review')
  assert.match(runs.app, /Linked set · 1 run/)
  const runBody = runs.app.match(/<tbody>([\s\S]*?)<\/tbody>/)
  assert.ok(runBody, 'the exact run-set view must render a table body')
  assert.equal(count(runBody[1], /<tr>/g), 1, 'the exact run-set link must render one row')
  assert.match(runs.app, /href="#run\/legacy%2Fironweave%2Ftob-c-review" class="run-link">Trail of Bits c-review<\/a>/)
  assert.match(runs.app, /Read from the stored Claude Code transcript cost and usage records\./)

  const anthropicRun = render('runs?runIds=tidepool%2Fanthropic-pr-review')
  assert.match(anthropicRun.app, /<span class="subline">tidepool · Claude Opus 5 · legacy · <a href="#skills\/anthropic-pr-review" class="skill-info-link">anthropic-pr-review<\/a><\/span>/)
  assert.doesNotMatch(anthropicRun.app, /pr-review-toolkit@claude-plugins-official|>Skill info</)

  const pickedRuns = render('runs?pick=tidepool%2Fbuiltin-code-review%2Ctidepool%2Fsuperpowers-review')
  assert.match(pickedRuns.app, /href="#run\/legacy%2Ftidepool%2Fbuiltin-code-review" class="run-link">Claude Code \/code-review<\/a> ↔/)
  assert.match(pickedRuns.app, /href="#run\/legacy%2Ftidepool%2Fsuperpowers-review" class="run-link">Superpowers requesting-code-review<\/a>/)

  const run = render('run/ironweave/tob-c-review')
  for (const label of ['Input', 'Output', 'Cache read', 'Cache creation', 'Thinking (within output)', 'Field provenance']) {
    assert.match(run.app, new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?class="hint-mark"`, 's'), `${label} needs a rendered hint`)
  }
  assert.match(run.app, /source: <span class="hinted-label">transcript/)
  assert.match(run.app, /Upstream human review/)

  const insights = render('insights?model=claude-opus-5')
  assert.match(insights.app, /non-dominated frontier<span class="hint-mark"/)
  assert.match(insights.app, /Bubble size: <span class="hinted-label">False-positive rate/)
  assert.match(insights.app, /class="chart-link"[^>]*role="link"/)
  assert.match(insights.app, /false-positive and unproven verdicts are excluded/)
  assert.match(insights.app, /automated cohort-local judgements are not the manually reviewed canonical gold comparison/)

  const findings = render('findings?model=claude-opus-5-5')
  assert.match(findings.app, /Cohort-adjudicated real/)
  assert.doesNotMatch(findings.app, /Verified real|verified real/)

  const skills = render('skills?model=claude-opus-5')
  assert.equal(count(skills.app, /class="skill-card"/g), 8)
  assert.equal(count(skills.app, />GitHub ↗<\/a>/g), 8)
  assert.equal(count(skills.app, />Skill page ↗<\/a>/g), 8)
  assert.match(skills.app, /The benchmark ran these as Claude Code plugins\./)

  const skillComparison = render('compare?model=claude-opus-5&compareSkills=builtin-code-review%2Csuperpowers-review')
  for (const label of ['Attempted cost', 'Distinct real', 'Only this skill', 'Shared', 'Completeness', 'Precision', 'Success']) {
    assert.match(skillComparison.app, new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?class="hint-mark"`, 's'), `${label} needs a rendered hint`)
  }
  assert.match(skillComparison.app, />6 attempted runs<\/a>/)
  assert.match(skillComparison.app, /href="#skills\/builtin-code-review\?model=claude-opus-5" class="skill-info-link">Skill info<\/a>/)

  const comparison = render('compare/tidepool/builtin-code-review/tidepool/superpowers-review')
  assert.match(comparison.app, /href="#run\/legacy%2Ftidepool%2Fbuiltin-code-review" class="run-link">legacy\/tidepool\/builtin-code-review<\/a>/)
  assert.match(comparison.app, /href="#run\/legacy%2Ftidepool%2Fsuperpowers-review" class="run-link">legacy\/tidepool\/superpowers-review<\/a>/)
  assert.match(comparison.app, /Thinking<span class="hint-mark"/)

  process.stdout.write('dashboard-browser-check: all rendered routes passed\n')
} finally {
  fs.rmSync(profile, { recursive: true, force: true })
}
