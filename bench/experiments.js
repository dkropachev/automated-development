'use strict'

// Publication annotations are separate from immutable receipts. Platform is never inferred
// from the reviewer or adjudicator model; every archived record must have an explicit binding.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const REPO_URL = 'https://github.com/dkropachev/automated-development'
const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

function resolveReference(root, relative) {
  if (typeof relative !== 'string' || !relative) throw new Error('missing experiment publication reference')
  const file = path.resolve(root, relative)
  if (!file.startsWith(path.resolve(root) + path.sep) || !fs.statSync(file).isFile()) {
    throw new Error(`unresolved experiment publication reference: ${relative}`)
  }
  return file
}

function loadExperiments(root = __dirname) {
  const directory = path.join(root, 'experiments')
  if (!fs.existsSync(directory)) return []
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const base = path.join(directory, entry.name)
    if (!fs.existsSync(path.join(base, 'evidence.json')) && !fs.existsSync(path.join(base, 'publication.json'))) continue
    const evidence = readJson(resolveReference(base, 'evidence.json'))
    const publication = readJson(resolveReference(base, 'publication.json'))
    if (publication.schemaVersion !== 1 || !Array.isArray(publication.records)) throw new Error(`invalid publication: ${entry.name}`)
    const bindings = new Map(publication.records.map((binding) => [binding.recordId, binding]))
    const ids = new Set(evidence.records.map((record) => record.id))
    if (bindings.size !== publication.records.length || ids.size !== evidence.records.length || bindings.size !== ids.size || [...bindings.keys()].some((id) => !ids.has(id))) {
      throw new Error(`unresolved or duplicate experiment publication records: ${entry.name}`)
    }
    for (const record of evidence.records) {
      const binding = bindings.get(record.id)
      if (!binding || !['codex', 'claude'].includes(binding.platform) || binding.skill !== 'code-review-ad' || !['ironweave', 'quillstone', 'tidepool'].includes(binding.target) || !binding.layout) {
        throw new Error(`invalid experiment publication binding: ${entry.name}/${record.id}`)
      }
      if (record.target && record.target !== binding.target) throw new Error(`experiment target mismatch: ${record.id}`)
      const report = fs.readFileSync(resolveReference(base, record.report))
      if (crypto.createHash('sha256').update(report).digest('hex') !== record.reportSha256) {
        throw new Error(`experiment report hash mismatch: ${entry.name}/${record.id}`)
      }
      let measurement = null
      let correction = null
      if (binding.measurement) {
        const file = resolveReference(directory, binding.measurement.file)
        const pointer = binding.measurement.pointer
        if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error(`invalid measurement pointer: ${record.id}`)
        measurement = pointer.slice(1).split('/').reduce((value, key) => value?.[key], readJson(file))
        if (!measurement || measurement.source_report !== `bench/experiments/${entry.name}/${record.report}`) throw new Error(`unresolved measurement reference: ${record.id}`)
        correction = {
          url: `${REPO_URL}/blob/main/bench/experiments/${binding.measurement.file}`,
          reference: `${binding.measurement.file}#${pointer}`,
          note: 'October 16 category review: matched Claude has 7 Rust groups and 22 total groups; unsupported proxy-cleanup credit was retracted.',
        }
      }
      const grade = record.grade || record.grading || {}
      result.push({
        id: `${entry.name}/${record.id}`, recordId: record.id, experimentId: entry.name,
        platform: binding.platform, toolId: binding.skill, skillId: `${binding.platform}:${binding.skill}`,
        skillLabel: `${binding.skill} · ${binding.platform === 'codex' ? 'Codex' : 'Claude'}`,
        targetId: binding.target, layout: binding.layout, featured: binding.featured === true,
        modelId: record.model || null, effort: record.reasoningEffort || null,
        reviewerEffort: record.reviewerReasoningEffort || null,
        verifiedGroups: finite(measurement ? measurement.all_verified_groups : record.verifiedGroups ?? grade.valid_groups),
        bugGroups: finite(measurement ? measurement.runtime_test_diagnostic_groups : grade.bug_groups),
        totalTokens: finite(record.totalTokens), correction,
        report: report.toString('utf8'), reportSha256: record.reportSha256,
        reportUrl: `${REPO_URL}/blob/main/bench/experiments/${entry.name}/${record.report}`,
        evidenceUrl: `${REPO_URL}/blob/main/bench/experiments/${entry.name}/evidence.json`,
        targetBase: record.targetBase, targetHead: record.targetHead,
      })
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}

function experimentTools(records) {
  return [...new Map(records.map((record) => [record.skillId, {
    id: record.toolId, skillId: record.skillId, platform: record.platform, label: record.skillLabel,
    source: `${record.platform}:code-review-ad`, install: record.platform === 'codex' ? 'Use .agents/skills/code-review-ad from the repository checkout.' : '/plugin install automated-development@automated-development', description: 'Independent Toolkit, Standards, and Spec review passes. Archived layouts are experimental evidence only.',
    repoUrl: REPO_URL,
    pageUrl: `${REPO_URL}/blob/main/${record.platform === 'codex' ? '.agents/' : ''}skills/code-review-ad/SKILL.md`,
    invoke: record.platform === 'codex' ? '$code-review-ad <PR>' : '/code-review-ad <PR>',
    experimental: true, selfAuthored: true, reviewOnly: true,
  }])).values()]
}

function renderExperimentSummary(records) {
  const measure = (value) => value == null ? 'unavailable' : String(value)
  const table = (rows) => [
    '| Skill | Trial / layout | Target | Model | Parent / reviewer effort | Verified groups | Bug groups | Tokens | Report |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |',
    ...rows.map((r) => `| ${r.skillLabel} | ${r.recordId} / ${r.layout} | ${r.targetId} | ${r.modelId || 'unavailable'} | ${r.effort || 'unavailable'} / ${r.reviewerEffort || 'unavailable'} | ${measure(r.verifiedGroups)} | ${measure(r.bugGroups)} | ${measure(r.totalTokens)} | [raw report](${r.reportUrl}) |`),
  ].join('\n')
  const correction = records.find((r) => r.correction)?.correction
  return [
    '# Archived skill experiments', '',
    'Exploratory evidence only. These repeated trials contribute no benchmark precision, completeness, cost ranking, or canonical gold credit. Missing measurements are unavailable.', '',
    '## Installed Codex versus matched Claude', '',
    correction ? `${correction.note} [Correction evidence](${correction.url}). Original reports remain intact.` : '', '',
    table(records.filter((r) => r.featured)), '',
    '## Every archived trial', '', table(records), '',
  ].join('\n')
}

module.exports = { loadExperiments, experimentTools, renderExperimentSummary }
