'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dashboard = require('../bench/dashboard')

const ROOT = path.join(__dirname, '..')

function reviewTool() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'tools.json'), 'utf8'))
  return config.tools.find((tool) => tool.id === 'review-and-fix-pr')
}

function writeJson(root, file, value) {
  const output = path.join(root, file)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(value))
}

test('review-and-fix-pr is a local review-only experimental benchmark tool', () => {
  const tool = reviewTool()
  assert.ok(tool)
  assert.deepEqual({
    id: tool.id,
    label: tool.label,
    source: tool.source,
    experimental: tool.experimental,
    selfAuthored: tool.selfAuthored,
    reviewOnly: tool.reviewOnly,
    requiresPluginDir: tool.requiresPluginDir,
    cohortOnly: tool.cohortOnly,
    resultContract: tool.resultContract,
  }, {
    id: 'review-and-fix-pr',
    label: 'Automated Development review-and-fix-pr',
    source: 'automated-development@inline',
    experimental: true,
    selfAuthored: true,
    reviewOnly: true,
    requiresPluginDir: true,
    cohortOnly: true,
    resultContract: 'review-and-fix-pr-v3',
  })
  assert.match(tool.description, /whole-pull-request review/i)
  assert.match(tool.install, /marketplace add dkropachev\/automated-development/)
  assert.match(tool.install, /plugin install automated-development@automated-development/)
  assert.equal(tool.invoke, '/automated-development:review-and-fix-pr <PR number or URL>')
  assert.equal(tool.repoUrl, 'https://github.com/dkropachev/automated-development')
  assert.equal(tool.pageUrl, 'https://github.com/dkropachev/automated-development/blob/main/skills/review-and-fix-pr/SKILL.md')
  assert.match(tool.prompt, /^Use the loaded `automated-development:review-and-fix-pr` skill/)
  assert.match(tool.prompt, /runner-frozen pull request/)
  assert.match(tool.prompt, /do not refetch or rebuild that context/)
  assert.match(tool.prompt, /trusted `review-and-fix-pr-fast\.js` helper/)
  assert.match(tool.prompt, /exact task ID or output file/)
  assert.match(tool.prompt, /one `REVIEW_AND_FIX_PR_RESULT_JSON=` v3 marker/)
  assert.match(tool.prompt, /final nonempty line/)
  assert.doesNotMatch(tool.prompt, /Wait for the workflow result|relay that result|stopAt|workflow `model`/)
  assert.match(tool.prompt, /REVIEW_AND_FIX_PR_RESULT_JSON=/)
  assert.doesNotMatch(JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'tools.json'), 'utf8')).context,
    /background workflow|keep making small tool calls/)
})

test('experimental metadata survives tool, run, and cohort dashboard snapshots', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-experimental-dashboard-'))
  const tool = reviewTool()
  try {
    writeJson(fixture, 'models.json', {
      schemaVersion: 1,
      defaultModel: 'claude-opus-5-5',
      models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }],
      legacyCohort: {
        runId: 'legacy', label: 'Fixture cohort', requestedModel: null,
        observedModel: 'claude-opus-5-5', modelLabel: 'Claude Opus 5.5',
      },
    })
    writeJson(fixture, 'state.json', {
      targets: {
        sample: {
          id: 'sample', language: 'JavaScript', upstreamTitle: 'Fixture PR',
          fork: 'example/project', forkPr: 1, forkPrUrl: 'https://example.test/pull/1',
        },
      },
    })
    writeJson(fixture, 'tools.json', { context: 'Review {fork}', tools: [tool] })
    writeJson(fixture, 'results/sample/review-and-fix-pr.json', {
      target: 'sample', tool: tool.id, label: tool.label, source: tool.source,
      exitCode: 0, signal: null, isError: false, result: 'fixture result',
      reportedCostUsd: 1, reportedUsage: { input_tokens: 2, output_tokens: 3 },
    })
    writeJson(fixture, 'findings/sample/review-and-fix-pr.json', { findings: [], extractError: null })
    writeJson(fixture, 'judgement/sample.json', { issues: [] })

    const data = dashboard.loadArtifacts(fixture)
    const globalTool = data.tools.find((entry) => entry.id === tool.id)
    assert.equal(globalTool.experimental, true)
    assert.equal(globalTool.selfAuthored, true)
    assert.equal(globalTool.reviewOnly, true)
    assert.equal(globalTool.requiresPluginDir, true)
    assert.equal(globalTool.resultContract, 'review-and-fix-pr-v3')

    assert.equal(data.runs.length, 1)
    const run = data.runs[0]
    const snapshot = run.toolSnapshot
    assert.equal(run.experimental, true)
    assert.equal(run.selfAuthored, true)
    assert.equal(run.reviewOnly, true)
    assert.equal(run.resultContract, 'review-and-fix-pr-v3')
    assert.deepEqual(globalTool.snapshots.legacy, snapshot)

    assert.equal(data.cohorts.length, 1)
    assert.deepEqual(data.cohorts[0].toolSnapshots, [snapshot])
    const html = dashboard.render(data)
    assert.match(html, /"experimental":true/)
    assert.match(html, /"selfAuthored":true/)
    assert.match(html, /\.badge\.experimental/)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test('cohort-local skill, run, and completed-cohort renderers show the experimental badge', () => {
  const source = fs.readFileSync(path.join(ROOT, 'bench', 'dashboard', 'app.js'), 'utf8')
  const functionBody = (name, next) => source.slice(source.indexOf(`function ${name}`), source.indexOf(`function ${next}`))

  assert.match(source, /labels\.join\(' · '\), 'experimental'/)
  assert.match(functionBody('toolTraits', 'experimentalToolBadge'), /Object\.values\(tool\.snapshots \|\| \{\}\)/)
  assert.match(functionBody('landingRankCard', 'landingSkillCard'), /experimentalToolBadge\(group\.rows\)/)
  assert.match(functionBody('landingSkillCard', 'completenessRankCard'), /experimentalToolBadge\(skill\)/)
  assert.match(functionBody('leaderboard', 'comparisonList'), /experimentalToolBadge\(group\.rows\)/)
  assert.match(functionBody('skillCard', 'renderSkills'), /experimentalToolBadge\(skill\)/)
  assert.match(functionBody('compareSelector', 'comparisonMatrix'), /experimentalToolBadge\(tool\)/)
  assert.match(functionBody('comparisonMatrix', 'renderSkillCompare'), /experimentalToolBadge\(group\.rows\)/)
  assert.match(functionBody('runTable', 'comparisonDock'), /experimentalToolBadge\(run\)/)
  assert.match(functionBody('runSummary', 'tokenComposition'), /experimentalToolBadge\(run\)/)
  assert.match(functionBody('compareRun', 'comparisonTable'), /experimentalToolBadge\(run\)/)
  assert.match(functionBody('toolChart', 'reporterCount'), /experimental · self-authored/)
  assert.match(functionBody('analysisLabel', 'metricOrder'), /experimentalToolBadge\(group\.runs\)/)
  assert.match(functionBody('completedCohortStats', 'completedCohortTable'), /cohortRows/)
  assert.match(functionBody('completedCohortTable', 'completedCohortPanel'), /experimentalToolBadge\(row\.cohortRows\)/)

  // Canonical gold rows remain separate and receive no cohort-local authorship label.
  assert.doesNotMatch(functionBody('modelComparisonTable', 'modelEvidencePanel'), /experimentalToolBadge/)
})
