#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { pathToFileURL, URLSearchParams } = require('node:url')

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

function render(hash, action = null) {
  const file = action ? path.join(profile, 'interaction.html') : DASHBOARD
  if (action) fs.writeFileSync(file, DASHBOARD_SOURCE.replace('</body>', `<script>setTimeout(() => { ${action} }, 0)</script></body>`))
  const url = `${pathToFileURL(file).href}#${hash}`
  const dom = execFileSync(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1600,1200',
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
  if (!table) return []
  return [...table[1].matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)]
    .filter((match) => !match[1].includes('protocol-detail-row')).map((match) => ({
    html: match[2],
    name: (match[2].match(/<strong>([^<]+)<\/strong>/) || [])[1],
  }))
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
  assert.match(defaultHome.app, /<option value="all" selected="">All models<\/option>/)
  assert.doesNotMatch(defaultHome.app, /id="platform-filter"/)
  assert.equal(count(defaultHome.app, /id="model-filter"/g), 1)
  assert.match(defaultHome.app, /<optgroup label="Codex">/)
  assert.match(defaultHome.app, /<optgroup label="Claude">/)
  assert.match(defaultHome.app, /value="codex:all">All Codex models/)
  assert.match(defaultHome.app, /value="claude:all">All Claude models/)
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
  assert.match(sonnetHome.app, /<strong>[1-9][0-9]*<\/strong><span>review runs<\/span>/)

  // Use a verified model for discovered rankings. Legacy Opus stays available as raw run evidence.
  const home = render('home?model=claude-opus-5-5')
  assert.match(home.app, /Find the code-review skill worth its price\./)
  assert.match(home.app, /discovered real findings/)
  assert.doesNotMatch(home.app, /verified findings|verified issues|verified real/)
  assert.match(home.app, /<h2 id="leaders-title">Leaders<\/h2>/)
  assert.doesNotMatch(home.app, /Completeness leaders/)
  assert.match(home.app, /Best return for the money · All issues/)
  assert.match(home.app, /[0-9]+\.[0-9]+ findings \/ \$/)
  assert.equal(count(home.app, /id="completeness-scope"/g), 1)
  assert.equal(count(home.app, /id="language-scope"/g), 1)
  assert.match(home.app, /class="leader-pickers"[\s\S]*id="completeness-scope"[\s\S]*id="language-scope"/)
  assert.ok(home.app.indexOf('id="completeness-scope"') < home.app.indexOf('class="landing-rank-grid leader-grid"'), 'the count picker must appear above the leader cards')
  const valueCards = rankingCards(home.app, 'leader-grid')
  assertTopThree(valueCards)
  assert.doesNotMatch(valueCards, /value-leader-card|class="eyebrow"|See leaderboard/)
  const opusSkills = new Set(DASHBOARD_DATA.runs.filter((run) => run.cohortId !== 'legacy' && run.modelId === 'claude-opus-5-5').map((run) => run.toolId))
  assert.equal(count(home.app, /class="skill-summary-card"/g), opusSkills.size)
  assert.match(home.app, /href="#skills\/claude%3Asuperpowers-review\?model=claude-opus-5-5"/)
  assert.doesNotMatch(home.app, /review-bakeoff\.md/)
  assert.match(home.app, /Best coverage · All issues/)
  assert.match(home.app, /class="landing-rank-grid completeness-grid"/)
  const coverageCards = rankingCards(home.app, 'completeness-grid')
  assertTopThree(coverageCards)
  assert.match(home.app, /Fastest useful review · All issues/)
  assertTopThree(rankingCards(home.app, 'fastest-grid'))
  assert.match(home.app, /Most unique discoveries · All issues/)
  assertTopThree(rankingCards(home.app, 'unique-grid'))
  assert.equal(count(home.app, /class="leader-section"/g), 4)

  const majorHome = render('home?model=claude-opus-5-5&completeness=major')
  assert.match(majorHome.app, /Best return for the money · Major only/)
  assert.match(majorHome.app, /[0-9]+\.[0-9]+ findings \/ \$/)
  assert.match(majorHome.app, /Best coverage · Major only/)
  assert.match(majorHome.app, /class="landing-rank-grid completeness-grid"/)
  assertTopThree(rankingCards(majorHome.app, 'leader-grid'))

  const majorMinorHome = render('home?model=claude-opus-5-5&completeness=majorMinor')
  assert.match(majorMinorHome.app, /Best return for the money · Major \+ minor/)
  assert.match(majorMinorHome.app, /[0-9]+\.[0-9]+ findings \/ \$/)
  assert.match(majorMinorHome.app, /Best coverage · Major \+ minor/)
  assert.match(majorMinorHome.app, /class="landing-rank-grid completeness-grid"/)
  assertTopThree(rankingCards(majorMinorHome.app, 'leader-grid'))

  const goHome = render('home?model=claude-opus-5-5&language=Go')
  assert.match(goHome.app, /Best return for the money · All issues · Go/)
  assert.match(goHome.app, /Best coverage · All issues · Go/)
  assert.match(goHome.app, /Fastest useful review · All issues · Go/)
  assert.match(goHome.app, /Most unique discoveries · All issues · Go/)
  assert.match(goHome.app, /<option value="Go" selected="">Go<\/option>/)
  assertTopThree(rankingCards(goHome.app, 'completeness-grid'))
  assert.doesNotMatch(rankingCards(goHome.app, 'completeness-grid'), /[23] targets/)

  const rustMajorHome = render('home?model=claude-opus-5-5&completeness=major&language=Rust')
  assert.match(rustMajorHome.app, /Fastest useful review · Major only · Rust/)
  assert.match(rustMajorHome.app, /Most unique discoveries · Major only · Rust/)

  const choose = render('choose?model=claude-opus-5-5')
  assert.match(choose.app, /class="choose-tabs" aria-label="Leaderboard views"/)
  assert.match(choose.app, /aria-current="page" class="active">Skills<\/a>/)
  assert.doesNotMatch(choose.app, /<option value="model">Model under test<\/option>/)
  for (const label of ['Candidate', 'Cost', 'Real / run', 'High + med', 'Precision', 'Completeness', 'Cost / real', 'Success']) {
    assert.match(choose.app, new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?class="hint-mark"`, 's'), `${label} needs a rendered hint`)
    assert.match(choose.app, new RegExp(`aria-label="Sort leaderboard by ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, (?:ascending|descending)"`), `${label} must be sortable`)
  }
  assert.equal(count(choose.app, /aria-sort="none"/g), 8, 'the hidden best-value preset must not mark a visible column as sorted')
  assert.match(choose.app, /href="#runs\?runIds=[^"]+" class="runs-link">3 runs<\/a>/)
  assert.match(choose.app, /href="#skills\/claude%3Asuperpowers-review\?model=claude-opus-5-5" class="skill-info-link">Skill info<\/a>/)
  assert.match(choose.dom, /class="hint-tooltip" role="tooltip" hidden=""/)

  const candidateAscending = render('choose?model=claude-opus-5-5&decision=candidate')
  const ascendingNames = leaderboardRows(candidateAscending.app)
  assert.deepEqual(ascendingNames, [...ascendingNames].sort((a, b) => a.localeCompare(b)))
  assert.equal(count(candidateAscending.app, /aria-sort="ascending"/g), 1)
  assert.equal(count(candidateAscending.app, /aria-sort="none"/g), 7)
  assert.match(candidateAscending.app, /<option value="candidate" selected="">Candidate<\/option>/)

  const candidateDescending = render('choose?model=claude-opus-5-5&decision=candidate&decisionDir=desc')
  assert.deepEqual(leaderboardRows(candidateDescending.app), [...ascendingNames].reverse())
  assert.equal(count(candidateDescending.app, /aria-sort="descending"/g), 1)

  const costDescending = render('choose?model=claude-opus-5-5&decision=cost&decisionDir=desc')
  assert.equal(leaderboardRows(costDescending.app)[0], 'Automated Development review-and-fix-pr · Claude')
  assert.match(costDescending.app, /<option value="cost" selected="">Cost<\/option>/)

  const models = render('choose?tab=models')
  assert.match(models.app, /Compare models against the canonical gold standard\./)
  assert.match(models.app, /aria-current="page" class="active">Models<\/a>/)
  assert.match(models.app, /id="model-filter"/)
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
  assert.doesNotMatch(models.app, /Completed cohorts|completed-cohort-panel/)
  const discoveredPanel = models.app.match(/<h2>Discovered coverage<\/h2>[\s\S]*?<\/section>/)
  assert.ok(discoveredPanel, 'Models must retain aggregate results from completed runs')
  assert.match(discoveredPanel[0], /Claude Sonnet 5\.5/)
  assert.match(discoveredPanel[0], /Claude Opus 5\.5/)
  const denominators = modelCompletenessDenominators(models.app)
  assert.deepEqual(modelRows(models.app).map((row) => row.name), ['Claude Opus 5.5', 'Claude Fable 5.1', 'Claude Opus 5'])
  assert.equal(denominators.length, 3, 'the table includes only the three matched models')
  assert.equal(new Set(denominators).size, 1, 'completeness denominator must be fixed across models')
  assert.deepEqual(linkedEvidenceCounts(models.app), [17, 17, 17])
  assert.doesNotMatch(models.app, /class="protocol-detail-row"/)
  assert.doesNotMatch(models.app, /<option value="supplemental-rafp-six-pass-parallel-broker-2026-10-08"/)
  assert.doesNotMatch(models.app, /Read site report/)
  const focusedRanking = render('choose?tab=models&focus=ranking')
  assert.match(focusedRanking.app, /class="panel model-results-panel" id="model-ranking"/)
  assert.doesNotMatch(focusedRanking.app, /class="protocol-detail-row"/)
  const supplementalSkill = render('choose?tab=skills&skills=review-and-fix-pr')
  assert.match(supplementalSkill.app, /Supplemental skill evidence/)
  assert.match(supplementalSkill.app, /review-and-fix-pr[\s\S]*?35 \/ 113 canonical real/)
  assert.match(supplementalSkill.app, /3 review cells/)
  assert.match(supplementalSkill.app, /Codex judgment tokens have no USD receipt/)

  const skillFilteredModels = render('choose?tab=models&skills=builtin-code-review')
  assert.match(skillFilteredModels.app, /Skills · 1/)
  assert.deepEqual([...new Set(modelCompletenessDenominators(skillFilteredModels.app))], [...new Set(denominators)], 'skill filters must not change the target-level completeness denominator')
  assert.deepEqual(linkedEvidenceCounts(skillFilteredModels.app), [3, 3, 3], 'skill filters must change contributing evidence')
  assert.notEqual(modelRows(skillFilteredModels.app)[0].html, modelRows(models.app)[0].html, 'skill filters must change spend and findings')

  const discoveredRuns = (html) => {
    const panel = html.match(/<h2>Discovered coverage<\/h2>[\s\S]*?<\/section>/)
    assert.ok(panel, 'the Models tab must render discovered coverage')
    return [...panel[0].matchAll(/href="#runs\?([^"]+)"/g)]
      .flatMap((match) => new URLSearchParams(match[1].replaceAll('&amp;', '&')).get('runIds').split(',')).sort()
  }
  const expectedDiscoveredRuns = (skill) => DASHBOARD_DATA.runs
    .filter((run) => run.cohortId !== 'legacy' && run.status === 'complete' && (!skill || run.skillId === (skill.includes(':') ? skill : `claude:${skill}`)) && (run.platform !== 'codex' || run.currentEvaluation))
    .map((run) => run.id).sort()
  assert.deepEqual(discoveredRuns(models.app), expectedDiscoveredRuns(), 'unfiltered coverage must retain every completed modern run')
  assert.deepEqual(discoveredRuns(skillFilteredModels.app), expectedDiscoveredRuns('builtin-code-review'), 'discovered coverage must honor the Skills filter')
  const cohortSkillModels = render('choose?tab=models&skills=code-review-ad')
  assert.deepEqual(discoveredRuns(cohortSkillModels.app), expectedDiscoveredRuns('code-review-ad'), 'cohort-only skills must filter discovered coverage')

  const protocolFiltered = render('choose?tab=models&skills=review-and-fix-pr')
  assert.equal(modelRows(protocolFiltered.app).length, 0)
  assert.match(protocolFiltered.app, /No canonical benchmark results for these filters/)
  for (const row of modelRows(protocolFiltered.app)) {
    assert.match(row.html, /N\/A/)
    assert.doesNotMatch(row.html, /0 \/ 113/)
  }
  assert.doesNotMatch(protocolFiltered.app, /class="protocol-detail-row"/)

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

  const supplemental = render('choose?tab=models&scope=supplemental-rafp-six-pass-parallel-broker-2026-10-08')
  assert.deepEqual(modelRows(supplemental.app).map((row) => row.name), ['Claude Opus 5.5', 'Claude Fable 5.1', 'Claude Opus 5'])

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
  assert.match(runs.app, /href="#run\/legacy%2Fironweave%2Ftob-c-review" class="run-link">Trail of Bits c-review · Claude<\/a>/)
  assert.match(runs.app, /Read from the stored runtime transcript usage records\./)

  const anthropicRun = render('runs?runIds=tidepool%2Fanthropic-pr-review')
  assert.match(anthropicRun.app, /<span class="subline">tidepool · Claude Opus 5 · legacy · <a href="#skills\/claude%3Aanthropic-pr-review" class="skill-info-link">claude:anthropic-pr-review<\/a><\/span>/)
  assert.doesNotMatch(anthropicRun.app, /pr-review-toolkit@claude-plugins-official|>Skill info</)

  const pickedRuns = render('runs?pick=tidepool%2Fbuiltin-code-review%2Ctidepool%2Fsuperpowers-review')
  assert.match(pickedRuns.app, /href="#run\/legacy%2Ftidepool%2Fbuiltin-code-review" class="run-link">Claude Code \/code-review · Claude<\/a> ↔/)
  assert.match(pickedRuns.app, /href="#run\/legacy%2Ftidepool%2Fsuperpowers-review" class="run-link">Superpowers requesting-code-review · Claude<\/a>/)

  const run = render('run/ironweave/tob-c-review')
  for (const label of ['Input', 'Output', 'Cache read', 'Cache creation', 'Thinking (within output)', 'Field provenance']) {
    assert.match(run.app, new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?class="hint-mark"`, 's'), `${label} needs a rendered hint`)
  }
  assert.match(run.app, /source: <span class="hinted-label">transcript/)
  assert.match(run.app, /Upstream human review/)

  const reviewedRun = render('run/rafp-six-pass-parallel-broker-2026-10-08/ironweave/review-and-fix-pr')
  assert.match(reviewedRun.app, /53 extracted claims: 19 Codex-confirmed leads and 34 suggestions/)
  assert.equal(count(reviewedRun.app, /Needs reviewer judgment<\/span>/g), 34)
  assert.equal(count(reviewedRun.app, /Codex-confirmed lead<\/span>/g), 19)

  const insights = render('insights?model=claude-opus-5-5')
  assert.match(insights.app, /non-dominated frontier<span class="hint-mark"/)
  assert.match(insights.app, /Bubble size: <span class="hinted-label">False-positive rate/)
  assert.match(insights.app, /class="chart-link"[^>]*role="link"/)
  assert.match(insights.app, /false-positive and unproven verdicts are excluded/)
  assert.match(insights.app, /automated cohort-local judgements are not the manually reviewed canonical gold comparison/)

  const findings = render('findings?model=claude-opus-5-5')
  assert.match(findings.app, /Discovered real/)
  assert.doesNotMatch(findings.app, /Verified real|verified real/)

  const skills = render('skills?model=claude-opus-5-5')
  assert.equal(count(skills.app, /class="skill-card"/g), opusSkills.size)
  assert.equal(count(skills.app, />GitHub ↗<\/a>/g), opusSkills.size)
  assert.equal(count(skills.app, />Skill page ↗<\/a>/g), opusSkills.size)
  assert.match(skills.app, /Skills are identified by platform and name/)

  const skillComparison = render('compare?model=claude-opus-5-5&compareSkills=builtin-code-review%2Csuperpowers-review')
  for (const label of ['Attempted cost', 'Distinct real', 'Only this skill', 'Shared', 'Total real found', 'Completeness', 'Precision', 'Success']) {
    assert.match(skillComparison.app, new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?class="hint-mark"`, 's'), `${label} needs a rendered hint`)
  }
  assert.match(skillComparison.app, />6 attempted runs<\/a>/)
  assert.match(skillComparison.app, /href="#skills\/claude%3Abuiltin-code-review\?model=claude-opus-5-5" class="skill-info-link">Skill info<\/a>/)

  const unmatchedSkills = render('compare?compareSkills=anthropic-pr-review%2Cmattpocock-review%2Ccode-review-ad%2Creview-and-fix-pr&targets=ironweave')
  assert.match(unmatchedSkills.app, /Completed evidence/)
  assert.match(unmatchedSkills.app, /<h2>Head-to-head evidence<\/h2>/)
  assert.match(unmatchedSkills.app, /Only this skill/)
  assert.match(unmatchedSkills.app, /Combined coverage/)

  const crossRun = render('compare?model=all&compareSkills=anthropic-pr-review%2Cmattpocock-review%2Ccode-review-ad')
  assert.match(crossRun.app, /All models/)
  assert.match(crossRun.app, /<h2>Head-to-head evidence<\/h2>/)
  assert.match(crossRun.app, /Completeness/)
  assert.match(crossRun.app, /C\+\+/)
  assert.match(crossRun.app, /Rust/)
  assert.match(crossRun.app, /Go/)
  for (const toolId of ['anthropic-pr-review', 'mattpocock-review', 'code-review-ad']) {
    const targetIds = new Set(DASHBOARD_DATA.runs.filter((run) => run.toolId === toolId && run.status === 'complete').map((run) => run.targetId))
    assert.deepEqual([...targetIds].sort(), ['ironweave', 'quillstone', 'tidepool'], `${toolId} must contribute all three languages`)
  }
  const crossRunPair = render('compare?model=all&compareSkills=anthropic-pr-review%2Ccode-review-ad')
  const coverageFor = (html) => {
    const row = html.match(/<tr><td><strong><a[^>]*>code-review-ad · Claude<\/a><\/strong>[\s\S]*?<\/tr>/)
    assert.ok(row, 'the cross-run skill must be shown')
    const cells = [...row[0].matchAll(/<td class="num">([^<]+)<\/td>/g)].map((match) => match[1])
    return { everFound: cells[4], completeness: cells[5] }
  }
  assert.deepEqual(coverageFor(crossRun.app), coverageFor(crossRunPair.app), 'changing selected skills must not change the discovered denominator or completeness')
  const realIdentityIds = new Set(DASHBOARD_DATA.identityIssues.filter((issue) => issue.verdict === 'real').map((issue) => issue.id))
  const verifiedComplete = DASHBOARD_DATA.runs.filter((run) => run.status === 'complete' && run.cohortId !== 'legacy')
  const expectedEverFound = new Set(verifiedComplete.flatMap((run) => run.identityIssueIds.filter((id) => realIdentityIds.has(id)))).size
  assert.equal(Number(coverageFor(crossRun.app).everFound.replaceAll(',', '')), expectedEverFound)
  const includingLegacy = new Set(DASHBOARD_DATA.runs.filter((run) => run.status === 'complete').flatMap((run) => run.identityIssueIds.filter((id) => realIdentityIds.has(id)))).size
  assert.ok(includingLegacy > expectedEverFound, 'legacy-only identities must stay outside discovered coverage')
  const rustComparison = render('compare?model=all&compareSkills=anthropic-pr-review%2Ccode-review-ad&languages=Rust')
  const rustRealFound = new Set(verifiedComplete.filter((run) => run.targetId === 'quillstone').flatMap((run) => run.identityIssueIds.filter((id) => realIdentityIds.has(id)))).size
  assert.equal(Number(coverageFor(rustComparison.app).everFound.replaceAll(',', '')), rustRealFound)
  const locallyRejected = DASHBOARD_DATA.issues.find((issue) => issue.id === 'opus-5-5-code-review-ad-r62-ironweave-2026-10-12/ironweave/I7')
  assert.equal(locallyRejected.verdict, 'false-positive')
  assert.deepEqual(locallyRejected.identityIds, ['ironweave-I014'])
  assert.equal(DASHBOARD_DATA.identityIssues.find((issue) => issue.id === 'ironweave-I014').verdict, 'real')

  const comparison = render('compare/tidepool/builtin-code-review/tidepool/superpowers-review')
  assert.match(comparison.app, /href="#run\/legacy%2Ftidepool%2Fbuiltin-code-review" class="run-link">legacy\/tidepool\/builtin-code-review<\/a>/)
  assert.match(comparison.app, /href="#run\/legacy%2Ftidepool%2Fsuperpowers-review" class="run-link">legacy\/tidepool\/superpowers-review<\/a>/)
  assert.match(comparison.app, /Thinking<span class="hint-mark"/)

  const catalogue = render('skills')
  assert.match(catalogue.app, /code-review-ad · Codex/)
  assert.match(catalogue.app, /code-review-ad · Claude/)
  const codexSkill = render('skills/codex%3Acode-review-ad')
  assert.match(codexSkill.app, /<h1>code-review-ad · Codex<\/h1>/)
  assert.equal(count(codexSkill.app, /class="skill-card"/g), 1)
  assert.match(codexSkill.app, /3 benchmark runs/)
  assert.match(codexSkill.app, /Latest evaluation/)
  assert.doesNotMatch(codexSkill.app, /27 experiment/)
  assert.match(codexSkill.app, /\.agents\/skills\/code-review-ad\/SKILL.md/)
  const codexWithClaudeModel = render('skills/codex%3Acode-review-ad?model=claude-opus-5-5')
  assert.match(codexWithClaudeModel.app, /<h1>code-review-ad · Codex<\/h1>/)
  assert.match(codexWithClaudeModel.app, /0 benchmark runs/)
  const claudeSkill = render('skills/claude%3Acode-review-ad')
  assert.match(claudeSkill.app, /<h1>code-review-ad · Claude<\/h1>/)
  assert.doesNotMatch(claudeSkill.app, /\.agents\/skills/)
  assert.equal(render('skills/code-review-ad').app, claudeSkill.app, 'unqualified old skill page aliases Claude')
  const codexCatalogue = render('skills?platform=codex')
  assert.equal(count(codexCatalogue.app, /class="skill-card"/g), 1)
  assert.match(codexCatalogue.app, /<option value="codex:all" selected="">All Codex models<\/option>/)
  const experimentModelCatalogue = render('skills?model=gpt-6.1-sol')
  assert.equal(count(experimentModelCatalogue.app, /class="skill-card"/g), 1)
  assert.match(experimentModelCatalogue.app, /3 benchmark runs/)

  const experiments = render('experiments?history=all')
  assert.match(experiments.app, /Every archived trial · 30 records/)
  assert.match(experiments.app, /code-review-ad · Claude: 3 target records · 22 verified groups · 11 bug groups/)
  assert.match(experiments.app, /7 Rust groups and 22 total groups/)
  assert.ok(experiments.app.indexOf('Installed Codex versus matched Claude') < experiments.app.indexOf('Every archived trial'))
  assert.match(experiments.app, /quillstone-toolkit-split-r2/)
  assert.match(experiments.app, /quillstone-toolkit-split<\/span>/)
  assert.match(experiments.app, /medium \/ unavailable/)
  const codexExperiments = render('experiments?history=all&platform=codex')
  assert.match(codexExperiments.app, /Every archived trial · 27 records/)
  const claudeExperiments = render('experiments?history=all&skills=claude%3Acode-review-ad')
  assert.match(claudeExperiments.app, /Every archived trial · 3 records/)
  assert.match(render('experiments?history=all&skills=code-review-ad').app, /Every archived trial · 3 records/)
  const focusedExperiments = render('experiments?platform=codex&skills=codex%3Acode-review-ad&model=gpt-6.1-sol&targets=quillstone&experiment=codex-focus-2026-10-16')
  const expectedFocused = DASHBOARD_DATA.experiments.filter((r) => r.experimentId === 'codex-focus-2026-10-16' && r.targetId === 'quillstone')
  assert.match(focusedExperiments.app, new RegExp(`Every archived trial · ${expectedFocused.length} records`))
  assert.equal(count(focusedExperiments.app, /data-experiment-record=/g), expectedFocused.length)
  const offlineReport = render('experiments?report=codex-parity-2026-10-15%2Fquillstone-claude-matched')
  assert.match(offlineReport.app, /id="experiment-report"/)
  assert.match(offlineReport.app, /class="experiment-raw-report"/)
  assert.match(offlineReport.app, /165c45de68d976b82822e233577eb9a092b88bae0f9a12cd3ed8d9815adff0c2/)
  assert.match(offlineReport.app, /Correction evidence/)

  const crossPlatformComparison = render('compare?compareSkills=claude%3Acode-review-ad,codex%3Acode-review-ad')
  assert.match(crossPlatformComparison.app, /<span>Selected<\/span><strong>2<\/strong>/)
  assert.equal(count(crossPlatformComparison.app, /class="selection-card selected"/g), 2)
  assert.doesNotMatch(crossPlatformComparison.app, /Benchmark metrics unavailable · no completed benchmark runs/)
  assert.match(crossPlatformComparison.app, /code-review-ad · Claude/)
  assert.match(crossPlatformComparison.app, /code-review-ad · Codex/)
  const qualifiedModels = render('choose?tab=models&skills=claude%3Abuiltin-code-review')
  assert.deepEqual(linkedEvidenceCounts(qualifiedModels.app), linkedEvidenceCounts(skillFilteredModels.app))
  assert.deepEqual(modelCompletenessDenominators(qualifiedModels.app), modelCompletenessDenominators(skillFilteredModels.app))
  const currentEvaluation = DASHBOARD_DATA.currentEvaluations.find((entry) => entry.skillId === 'codex:code-review-ad')
  assert.ok(currentEvaluation, 'the current Codex skill must have a completed full-suite evaluation')
  const latestRunIds = [...currentEvaluation.runIds].sort()
  assert.equal(latestRunIds.length, 3)
  assert.equal(currentEvaluation.skillFingerprint, DASHBOARD_DATA.currentSkillVersions['codex:code-review-ad'])
  const assertNoCanonicalResults = (html) => {
    assert.deepEqual(modelRows(html), [])
    assert.doesNotMatch(html, /class="model-comparison-table"|class="model-winners"|class="notice model-legacy-warning"|id="canonical-evidence-title"|17 matched cells|19 matched cells/)
    assert.match(html, /No canonical benchmark results for these filters|Latest completed skill evaluation/)
  }
  const assertCurrentEvaluation = (html) => {
    assert.equal(count(html, /class="panel current-evaluation"/g), 1)
    assert.ok(html.includes(`data-evaluation-id="${currentEvaluation.id}"`))
    assert.match(html, /Completed on all 3 benchmark targets/)
    assert.ok(html.includes(currentEvaluation.skillFingerprint.slice(0, 12)))
    assert.match(html, /Estimated API cost/)
    assert.match(html, /Standard API rates · independent of subscription/)
    assert.match(html, /\$3\.42/)
    assert.doesNotMatch(html, /Every archived trial|27 experimental reports|toolkit-split-r2/)
  }
  const codexModels = render('choose?tab=models&platform=codex&scope=all-models')
  assertNoCanonicalResults(codexModels.app)
  assertCurrentEvaluation(codexModels.app)
  assert.deepEqual(discoveredRuns(codexModels.app), latestRunIds)
  assert.doesNotMatch(codexModels.app, /<td[^>]*>(?:<strong>)?Claude/)
  const explicitCodexModel = render('choose?tab=models&model=gpt-6.1-sol')
  assertNoCanonicalResults(explicitCodexModel.app)
  assertCurrentEvaluation(explicitCodexModel.app)
  assert.deepEqual(discoveredRuns(explicitCodexModel.app), latestRunIds)
  const explicitClaudeModel = render('choose?tab=models&model=claude-opus-5-5')
  assert.deepEqual(modelRows(explicitClaudeModel.app).map((row) => row.name), ['Claude Opus 5.5'])
  assert.ok(discoveredRuns(explicitClaudeModel.app).every((id) => DASHBOARD_DATA.runs.find((run) => run.id === id).modelId === 'claude-opus-5-5'))
  const unknownModel = render('choose?tab=models&model=unknown-model')
  assertNoCanonicalResults(unknownModel.app)
  assert.deepEqual(discoveredRuns(unknownModel.app), [])
  assert.doesNotMatch(unknownModel.app, /class="evaluation-link"/)
  const noTargets = render('choose?tab=models&targets=not-recorded')
  assertNoCanonicalResults(noTargets.app)
  assert.deepEqual(discoveredRuns(noTargets.app), [])

  const latestPage = render('experiments?platform=codex')
  assertCurrentEvaluation(latestPage.app)
  assert.match(latestPage.app, /Latest skill evaluation/)
  assert.match(latestPage.app, /class="evaluation-targets"/)
  assert.equal(count(latestPage.app, /class="run-link"/g), 3)
  assert.match(latestPage.app, /View archived trials/)
  for (const price of ['$1.28', '$1.03', '$1.12']) assert.ok(latestPage.app.includes(price))
  const pricedRun = render(`run/${encodeURIComponent(latestRunIds[0])}`)
  assert.match(pricedRun.app, /Estimated API cost/)
  assert.match(pricedRun.app, /openai-api-standard-2026-10-17/)
  assert.match(pricedRun.app, /independent of subscription billing/)

  const changePicker = (id, value) => `const picker = document.getElementById(${JSON.stringify(id)}); picker.value = ${JSON.stringify(value)}; picker.dispatchEvent(new Event('change'));`
  const chooseCodex = render('experiments?platform=claude&model=claude-opus-5-5', changePicker('model-filter', 'codex:gpt-6.1-sol'))
  assertCurrentEvaluation(chooseCodex.app)
  assert.match(chooseCodex.app, /value="codex:gpt-6.1-sol" selected=""/)
  const chooseClaude = render('experiments?platform=codex&model=gpt-6.1-sol', changePicker('model-filter', 'claude:claude-opus-5-5'))
  assert.match(chooseClaude.app, /No completed evaluation of the current skill matches these filters/)
  assert.doesNotMatch(chooseClaude.app, /class="panel current-evaluation"/)
  const chooseAll = render('experiments?platform=codex&model=gpt-6.1-sol', changePicker('model-filter', 'all'))
  assertCurrentEvaluation(chooseAll.app)
  assert.match(chooseAll.app, /value="all" selected=""/)
  const chooseCodexScope = render('choose?tab=models', changePicker('model-filter', 'codex:all'))
  assert.deepEqual(discoveredRuns(chooseCodexScope.app), latestRunIds)
  assertCurrentEvaluation(chooseCodexScope.app)
  assert.match(chooseCodexScope.app, /value="codex:all" selected=""/)
  const restoreScope = render('choose?tab=models&platform=codex', changePicker('model-filter', 'all'))
  assert.deepEqual(discoveredRuns(restoreScope.app), expectedDiscoveredRuns())
  const followLeaderboard = render('experiments?platform=codex', `document.querySelector('.header-actions a[href^="#choose"]').click();`)
  assert.match(followLeaderboard.app, /value="codex:all" selected=""/)
  assert.deepEqual(leaderboardRows(followLeaderboard.app), ['code-review-ad · Codex'])
  const followModels = render('choose?platform=codex&model=gpt-6.1-sol', `document.querySelector('.choose-tabs a[href*="tab=models"]').click();`)
  assertNoCanonicalResults(followModels.app)
  assertCurrentEvaluation(followModels.app)
  const clearArchive = render('experiments?history=all&platform=codex&model=gpt-6.1-sol&targets=quillstone', `document.querySelector('a[href="#experiments?history=all"]').click();`)
  assert.match(clearArchive.app, /Every archived trial · 30 records/)
  assert.match(clearArchive.app, /value="all" selected=""/)
  const evaluationLink = codexModels.app.match(/href="(#experiments\?[^"]+)" class="evaluation-link"/)[1].replaceAll('&amp;', '&')
  const modelEvaluation = render(evaluationLink.slice(1))
  assertCurrentEvaluation(modelEvaluation.app)
  assert.equal(count(modelEvaluation.app, /class="run-link"/g), 3)
  const singleTargetEvaluation = render('choose?tab=models&platform=codex&targets=quillstone')
  assert.match(singleTargetEvaluation.app, /Showing 1 of 3 targets/)
  const rustCodexSummary = render('home?platform=codex&language=Rust')
  assert.match(rustCodexSummary.app, /Showing 1 of 3 targets/)
  assert.match(rustCodexSummary.app, /languages=Rust[^"]*" class="evaluation-link"/)
  const rustLink = rustCodexSummary.app.match(/href="(#experiments\?[^"]+)" class="evaluation-link"/)[1].replaceAll('&amp;', '&')
  const rustEvaluation = render(rustLink.slice(1))
  assert.equal(count(rustEvaluation.app, /class="run-link"/g), 1)
  assert.match(rustEvaluation.app, /<td>quillstone<\/td>/)
  const compareCodexOnly = render('compare?platform=codex&compareSkills=claude%3Acode-review-ad,codex%3Acode-review-ad')
  assert.doesNotMatch(compareCodexOnly.app, /class="selection-card selected"[^>]*>[\s\S]*?code-review-ad · Claude/)

  // The summary controls must occupy one row with matching bottom edges at desktop width.
  const aligned = render('home', `const controls = [...document.querySelectorAll('.leader-pickers > .field')]; document.body.setAttribute('data-picker-layout', JSON.stringify(controls.map((node) => ({ bottom: node.getBoundingClientRect().bottom, height: node.getBoundingClientRect().height }))));`)
  const boxes = JSON.parse(aligned.dom.match(/data-picker-layout="([^"]+)"/)[1].replaceAll('&quot;', '"'))
  assert.equal(boxes.length, 3)
  assert.ok(boxes.every((box) => Math.abs(box.bottom - boxes[0].bottom) < 2 && Math.abs(box.height - boxes[0].height) < 2), 'model, count, and language controls must align')

  process.stdout.write('dashboard-browser-check: all rendered routes passed\n')
} finally {
  fs.rmSync(profile, { recursive: true, force: true })
}
