'use strict'

const fs = require('node:fs')
const path = require('node:path')

const VERDICTS = new Set(['real', 'false-positive', 'unproven'])

function revisionKey(run) {
  const pin = run.targetPins || {}
  return pin.baseSha && pin.headSha ? `${run.targetId}/${pin.baseSha}/${pin.headSha}` : null
}

function loadCatalog(root) {
  const file = path.join(root, 'issue-identities.json')
  if (!fs.existsSync(file)) return { schemaVersion: 1, identities: new Map(), mappings: new Map() }
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.identities) || !Array.isArray(catalog.mappings)) throw new Error('Invalid cross-run identity catalog')
  const identities = new Map()
  for (const identity of catalog.identities) {
    if (!identity.id || !identity.targetId || !VERDICTS.has(identity.verdict) || identities.has(identity.id)) throw new Error(`Invalid identity: ${identity.id}`)
    identities.set(identity.id, identity)
  }
  const mappings = new Map()
  for (const mapping of catalog.mappings) {
    if (!mapping.recordId || !Array.isArray(mapping.identityIds) || !mapping.identityIds.length || mappings.has(mapping.recordId)) throw new Error(`Invalid identity mapping: ${mapping.recordId}`)
    if (mapping.identityIds.some((id) => !identities.has(id))) throw new Error(`Unknown mapped identity: ${mapping.recordId}`)
    mappings.set(mapping.recordId, mapping.identityIds)
  }
  return { ...catalog, identities, mappings }
}

function applyIdentities(data, catalog) {
  const originals = new Set(data.issues.map((issue) => issue.id))
  for (const recordId of catalog.mappings.keys()) if (!originals.has(recordId)) throw new Error(`Identity mapping has no verified cohort record: ${recordId}`)
  const runs = new Map(data.runs.map((run) => [run.id, run]))
  const identityById = new Map()
  const issueIdentities = new Map()
  for (const issue of data.issues) {
    const reporter = (issue.reporterIds || []).map((id) => runs.get(id)).find(Boolean)
    const revision = reporter && revisionKey(reporter)
    const mapped = catalog.mappings.get(issue.id)
    const ids = mapped || [`provisional:${issue.id}`]
    const resolved = []
    for (const id of ids) {
      const known = catalog.identities.get(id)
      if (known && (known.targetId !== issue.targetId || (revision && known.revisionKey !== revision))) throw new Error(`Identity revision mismatch: ${issue.id} -> ${id}`)
      const identity = known || { id, targetId: issue.targetId, revisionKey: revision, verdict: issue.verdict, title: issue.title, severity: issue.severity, scope: issue.scope, provisional: true }
      if (!identityById.has(id)) identityById.set(id, { ...issue, ...identity, id, key: id, issueId: id, localVerdict: issue.verdict, originalIssueIds: [], reporterIds: [] })
      const row = identityById.get(id)
      row.originalIssueIds.push(issue.id)
      for (const runId of issue.reporterIds || []) if (!row.reporterIds.includes(runId)) row.reporterIds.push(runId)
      resolved.push(id)
    }
    issue.identityIds = resolved
    issue.reviewedVerdicts = resolved.map((id) => ({ id, verdict: identityById.get(id).verdict, provisional: Boolean(identityById.get(id).provisional) }))
    issueIdentities.set(issue.id, resolved)
  }
  for (const run of data.runs) {
    run.localIssueIds = [...run.issueIds]
    run.identityIssueIds = [...new Set(run.issueIds.flatMap((id) => issueIdentities.get(id) || []))]
    const scored = run.identityIssueIds.map((id) => identityById.get(id))
    run.metrics = {
      ...run.metrics,
      judged: scored.length,
      real: scored.filter((issue) => issue.verdict === 'real').length,
      falsePositive: scored.filter((issue) => issue.verdict === 'false-positive').length,
      unproven: scored.filter((issue) => issue.verdict === 'unproven').length,
    }
    run.metrics.precision = run.metrics.real + run.metrics.falsePositive ? run.metrics.real / (run.metrics.real + run.metrics.falsePositive) : null
    run.metrics.inScope = scored.filter((issue) => issue.verdict === 'real' && issue.scope === 'in-scope').length
    run.metrics.prIntroduced = scored.filter((issue) => issue.verdict === 'real' && issue.introducedByPr).length
    run.metrics.uniqueReal = scored.filter((issue) => issue.verdict === 'real' && issue.reporterIds.length === 1).length
    run.metrics.severityHigh = scored.filter((issue) => issue.verdict === 'real' && ['blocker', 'high'].includes(issue.severity)).length
    run.metrics.severityMediumPlus = scored.filter((issue) => issue.verdict === 'real' && ['blocker', 'high', 'medium'].includes(issue.severity)).length
    run.metrics.severityLowPlus = scored.filter((issue) => issue.verdict === 'real' && ['blocker', 'high', 'medium', 'low'].includes(issue.severity)).length
    run.metrics.falsePositiveRate = run.metrics.real + run.metrics.falsePositive ? run.metrics.falsePositive / (run.metrics.real + run.metrics.falsePositive) : null
    run.metrics.realPerDollar = run.usage.costUsd > 0 ? run.metrics.real / run.usage.costUsd : null
    run.metrics.costPerReal = run.metrics.real > 0 ? run.usage.costUsd / run.metrics.real : null
    run.metrics.minutesPerReal = run.metrics.real > 0 && run.wallMs != null ? run.wallMs / 60000 / run.metrics.real : null
  }
  data.identityIssues = [...identityById.values()]
  data.identityCatalog = { reviewed: catalog.identities.size, provisional: data.identityIssues.filter((issue) => issue.provisional).length }
  return data
}

module.exports = { applyIdentities, loadCatalog, revisionKey }
