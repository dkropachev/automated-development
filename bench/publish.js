#!/usr/bin/env node
'use strict'

// Publish every immutable modern cohort in one deterministic operation. This command never runs
// a review, extractor, or judge: it only renders already-complete, hash-verified artifacts.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const dashboard = require('./dashboard')
const { discoverCohorts, readComplete } = require('./lib/artifacts')

const ROOT = __dirname
const DOCS = path.join(ROOT, '..', 'docs')
const MAX_REPORT_BYTES = 64 * 1024 * 1024

function parseArgs(args) {
  if (args.length !== 1 || !['--write', '--check'].includes(args[0])) {
    throw new Error('usage: node bench/publish.js --write|--check')
  }
  return args[0].slice(2)
}

function discoverCompletedCohorts(root = ROOT, dependencies = {}) {
  const discover = dependencies.discoverCohorts || discoverCohorts
  const verify = dependencies.readComplete || readComplete
  const fileExists = dependencies.existsSync || fs.existsSync
  const completed = []
  for (const cohort of discover(root)) {
    if (cohort.legacy || !cohort.paths.complete || !fileExists(cohort.paths.complete)) continue
    // A complete marker is a publication promise. Do not silently omit one whose hashes or
    // artifact inventory no longer validate.
    const snapshot = verify(root, cohort.runId)
    completed.push({ ...cohort, snapshot })
  }
  return completed.sort((left, right) => left.runId.localeCompare(right.runId))
}

function renderReport(root, runId, dependencies = {}) {
  const spawn = dependencies.spawnSync || spawnSync
  const result = spawn(process.execPath, [path.join(root, 'report.js'), '--run', runId], {
    cwd: path.dirname(root),
    encoding: 'utf8',
    maxBuffer: MAX_REPORT_BYTES,
  })
  if (result.error) throw new Error(`cannot render report for ${runId}: ${result.error.message}`)
  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit ${result.status}`
    const detail = String(result.stderr || '').trim()
    throw new Error(`cannot render report for ${runId}: ${reason}${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout
}

function renderDashboard(root, dependencies = {}) {
  const renderer = dependencies.dashboard || dashboard
  return renderer.render(renderer.loadArtifacts(root), path.join(root, 'dashboard'))
}

function expectedPublication(options = {}, dependencies = {}) {
  const root = options.root || ROOT
  const docs = options.docs || path.join(path.dirname(root), 'docs')
  const cohorts = discoverCompletedCohorts(root, dependencies)
  const reportRenderer = dependencies.renderReport || renderReport
  const dashboardRenderer = dependencies.renderDashboard || renderDashboard
  const files = cohorts.map((cohort) => ({
    file: path.join(docs, `review-bakeoff-${cohort.runId}.md`),
    content: reportRenderer(root, cohort.runId, dependencies),
    kind: 'cohort-report',
    runId: cohort.runId,
  }))
  const html = dashboardRenderer(root, dependencies)
  files.push(
    { file: path.join(docs, 'index.html'), content: html, kind: 'dashboard' },
    { file: path.join(docs, 'run-explorer.html'), content: html, kind: 'dashboard-alias' },
  )
  return { cohorts, files }
}

function inspectPublication(files, dependencies = {}) {
  const fileExists = dependencies.existsSync || fs.existsSync
  const readFile = dependencies.readFileSync || fs.readFileSync
  return files.map((entry) => {
    if (!fileExists(entry.file)) return { ...entry, status: 'missing' }
    return { ...entry, status: readFile(entry.file, 'utf8') === entry.content ? 'current' : 'stale' }
  })
}

function orphanedReports(files, docs, dependencies = {}) {
  const fileExists = dependencies.existsSync || fs.existsSync
  const readDirectory = dependencies.readdirSync || fs.readdirSync
  const readFile = dependencies.readFileSync || fs.readFileSync
  if (!fileExists(docs)) return []
  const expected = new Set(files.filter((entry) => entry.kind === 'cohort-report').map((entry) => path.resolve(entry.file)))
  return readDirectory(docs, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^review-bakeoff-.+\.md$/.test(entry.name))
    .map((entry) => ({
      file: path.resolve(docs, entry.name),
      runId: entry.name.slice('review-bakeoff-'.length, -'.md'.length),
    }))
    .filter(({ file, runId }) => !expected.has(file) && readFile(file, 'utf8').includes(`**Cohort:** \`${runId}\``))
    .map(({ file }) => file)
    .map((file) => ({ file, kind: 'orphaned-cohort-report', status: 'orphan' }))
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`)
  let descriptor = null
  let operationError = null
  try {
    descriptor = fs.openSync(temporary, 'wx')
    fs.writeFileSync(descriptor, content)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(temporary, file)
  } catch (error) {
    operationError = error
  }
  if (descriptor != null) {
    try { fs.closeSync(descriptor) } catch (error) {
      if (!operationError) operationError = error
    }
  }
  try { fs.unlinkSync(temporary) } catch (error) {
    if (error.code !== 'ENOENT' && !operationError) operationError = error
  }
  if (operationError) throw operationError
}

function publish(mode, options = {}, dependencies = {}) {
  if (!['write', 'check'].includes(mode)) throw new Error(`invalid publication mode: ${mode}`)
  const expected = expectedPublication(options, dependencies)
  const inspected = inspectPublication(expected.files, dependencies)
  const docs = options.docs || path.join(path.dirname(options.root || ROOT), 'docs')
  const changed = [
    ...inspected.filter((entry) => entry.status !== 'current'),
    ...orphanedReports(expected.files, docs, dependencies),
  ]
  if (mode === 'write') {
    const writer = dependencies.atomicWrite || atomicWrite
    const remove = dependencies.unlinkSync || fs.unlinkSync
    for (const entry of changed) {
      if (entry.status === 'orphan') remove(entry.file)
      else writer(entry.file, entry.content)
    }
  }
  return { ...expected, changed, ok: mode === 'write' || changed.length === 0 }
}

function displayPath(file) {
  const relative = path.relative(path.join(ROOT, '..'), file)
  return relative.startsWith('..') ? file : relative
}

function main(args = process.argv.slice(2)) {
  let mode
  try {
    mode = parseArgs(args)
  } catch (error) {
    console.error(error.message)
    return 2
  }
  try {
    const result = publish(mode, { root: ROOT, docs: DOCS })
    if (mode === 'check' && !result.ok) {
      for (const entry of result.changed) console.error(`${entry.status}: ${displayPath(entry.file)}`)
      return 1
    }
    if (mode === 'write') {
      for (const entry of result.changed) console.log(`${entry.status === 'orphan' ? 'removed ' : ''}${displayPath(entry.file)}`)
    }
    console.log(`${result.cohorts.length} complete cohort${result.cohorts.length === 1 ? '' : 's'}, ${result.files.length} publication files current`)
    return 0
  } catch (error) {
    console.error(error.message)
    return 1
  }
}

module.exports = {
  atomicWrite,
  discoverCompletedCohorts,
  expectedPublication,
  inspectPublication,
  main,
  orphanedReports,
  parseArgs,
  publish,
  renderDashboard,
  renderReport,
}

if (require.main === module) process.exitCode = main()
