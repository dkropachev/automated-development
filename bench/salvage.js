'use strict'
// Recover audit evidence from a run whose parent process died while the review itself kept going.
// Recovered text never becomes a canonical benchmark result: it is stored under recovered/ for
// inspection, and the runner must rerun the expected cell through its normal publication path.
//
//   node bench/salvage.js <target> <tool> [--run <runId|legacy>] [--cwd <dir>]
const fs = require('node:fs')
const path = require('node:path')
const { projectsRoot, totalsForCwd, slugFor } = require('./lib/usage')
const {
  acquireLocalLock, assertCohortOpen, assertSafeId, cellId, cohortPaths, defaultRunId,
  loadModelConfig, manifestMetadata, readManifest, releaseLocalLock, validateResultIdentity,
  writeJsonExclusive,
} = require('./lib/artifacts')

const ROOT = __dirname
const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name)
  if (i < 0) return fallback
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
    console.error(`${name} requires a value`)
    process.exit(2)
  }
  return argv[i + 1]
}
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--run' || argv[i] === '--cwd') { i += 1; continue }
  if (argv[i] === '--short') continue
  if (argv[i].startsWith('--')) { console.error(`unknown option: ${argv[i]}`); process.exit(2) }
  positional.push(argv[i])
}
const selectedRun = flag('--run', defaultRunId(ROOT))
try { assertSafeId(selectedRun, 'run id') } catch (error) { console.error(error.message); process.exit(2) }
let cohort
try {
  if (selectedRun === 'legacy') {
    const config = loadModelConfig(ROOT)
    const paths = cohortPaths(ROOT, selectedRun)
    const exists = [paths.results, paths.findings, paths.judgement].some(file => fs.existsSync(file))
    if (!exists) throw new Error('cohort not found: legacy')
    cohort = { ...config.legacyCohort, legacy: true, claudeVersion: null, paths }
  } else {
    const manifest = readManifest(ROOT, selectedRun)
    cohort = { ...manifest, label: manifest.modelLabel, observedModel: null, legacy: false, paths: cohortPaths(ROOT, selectedRun) }
  }
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

// Historical `--short` rewrote recorded results. Results are immutable now, so retain the useful
// audit without mutating a cohort; rerun short cells under a new run ID instead.
if (argv.includes('--short')) {
  let count = 0
  if (fs.existsSync(cohort.paths.results)) {
    for (const target of fs.readdirSync(cohort.paths.results)) {
      const dir = path.join(cohort.paths.results, target)
      if (!fs.statSync(dir).isDirectory()) continue
      for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
        if ((rec.result || '').length >= 800) continue
        count += 1
        console.log(`short: ${target}/${rec.tool} (${(rec.result || '').length} chars) - unchanged; use a new --run to rerun it`)
      }
    }
  }
  console.log(`${count} short result${count === 1 ? '' : 's'} in ${selectedRun}`)
  process.exit(0)
}
if (cohort.legacy) {
  console.error('legacy cohort is read-only; its raw artifacts cannot be changed')
  process.exit(1)
}
try { assertCohortOpen(ROOT, selectedRun) } catch (error) { console.error(error.message); process.exit(1) }

const [target, tool] = positional
const cwdOverride = flag('--cwd')
if (!target || !tool || positional.length !== 2) {
  console.error('usage: node bench/salvage.js <target> <tool> [--run <runId|legacy>] [--cwd <dir>] | --short [--run <runId|legacy>]')
  process.exit(2)
}
try {
  assertSafeId(target, 'target')
  assertSafeId(tool, 'tool')
} catch (error) { console.error(error.message); process.exit(2) }

const targets = cohort.targetMetadata
const cfg = cohort.toolConfig
const def = cfg.tools.find(t => t.id === tool)
if (!Object.hasOwn(targets, target)) { console.error(`unknown target: ${target}`); process.exit(2) }
const state = targets[target]
if (!def) { console.error(`unknown tool: ${tool}`); process.exit(2) }
if (def.languages && !def.languages.includes(state.language)) {
  console.error(`${tool} does not support ${state.language}`)
  process.exit(2)
}
if (!cohort.expectedCells.some(cell => cell.target === target && cell.tool === tool)) {
  console.error(`cell is outside sealed cohort plan: ${selectedRun}/${target}/${tool}`)
  process.exit(2)
}
const out = path.join(cohort.paths.results, target, `${tool}.json`)
if (fs.existsSync(out)) {
  console.error(`canonical result already exists: ${out}`)
  console.error('no recovery candidate is needed')
  process.exit(1)
}
const resultLock = acquireLocalLock(out + '.lock')
if (!resultLock) {
  console.error(`result is still being produced by another process: ${out}`)
  process.exit(1)
}
let resultLockHeld = true
process.once('exit', () => {
  if (resultLockHeld) {
    try { releaseLocalLock(resultLock) } catch {}
  }
})
try { assertCohortOpen(ROOT, selectedRun) } catch (error) {
  console.error(error.message)
  process.exit(1)
}

function newestWorkspace() {
  if (cohort.legacy) return path.join(ROOT, 'work', target, 'runs', tool, 'repo')
  const base = path.join(ROOT, 'work', target, 'runs', selectedRun, tool)
  if (!fs.existsSync(base)) return null
  const candidates = fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('attempt-'))
    .map(entry => {
      const attempt = path.join(base, entry.name)
      return { repo: path.join(attempt, 'repo'), mtime: fs.statSync(attempt).mtimeMs }
    })
    .filter(entry => fs.existsSync(entry.repo))
    .sort((a, b) => b.mtime - a.mtime)
  return candidates.length ? candidates[0].repo : null
}

// An interrupted attempt can supply its exact workspace explicitly, but it must still belong to
// this cohort cell. Otherwise unrelated transcripts could be stamped with this cohort's model.
const cwd = cwdOverride ? path.resolve(cwdOverride) : newestWorkspace()
if (!cwd || !fs.existsSync(cwd)) {
  console.error(`working directory not found for ${selectedRun}/${target}/${tool}; pass --cwd <dir>`)
  process.exit(1)
}
const workspaceBasePath = path.join(ROOT, 'work', target, 'runs', selectedRun, tool)
if (!fs.existsSync(workspaceBasePath)) {
  console.error(`workspace root not found for ${selectedRun}/${target}/${tool}`)
  process.exit(1)
}
const workspaceBase = fs.realpathSync(workspaceBasePath)
const workspace = fs.realpathSync(cwd)
const workspaceParts = path.relative(workspaceBase, workspace).split(path.sep)
if (workspaceParts.length !== 2 || !workspaceParts[0].startsWith('attempt-') || workspaceParts[1] !== 'repo') {
  console.error(`working directory does not belong to ${selectedRun}/${target}/${tool}: ${cwd}`)
  process.exit(1)
}
const dir = path.join(projectsRoot(), slugFor(cwd))
if (!fs.existsSync(dir)) { console.error('transcript directory not found:', dir); process.exit(1) }

// The report is not always the final message: a run that polls a background workflow often signs off
// with a one-line remark after it, so the longest late message is a better bet than the last one.
const texts = []
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.isSidechain) continue
    const m = ev.message
    if (ev.type !== 'assistant' || !m || !Array.isArray(m.content)) continue
    const text = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
    const ts = Date.parse(ev.timestamp || 0) || 0
    if (text) texts.push({ text, ts })
  }
}
if (!texts.length) { console.error('no assistant text in', dir); process.exit(1) }
texts.sort((a, b) => a.ts - b.ts)
const tail = texts.slice(-10)
const pick = tail.reduce((best, t) => (t.text.length > best.text.length ? t : best), tail[0])
const last = pick.text
const when = pick.ts
const usage = totalsForCwd(cwd)
const observedModels = Object.keys(usage.models || {})
if (!observedModels.some(model => model === cohort.requestedModel || model.startsWith(`${cohort.requestedModel}[`))) {
  console.error(`transcript does not contain requested model ${cohort.requestedModel}: ${observedModels.join(', ') || 'no model usage'}`)
  process.exit(1)
}
const metadata = cohort.legacy ? {} : {
  schemaVersion: 2,
  ...manifestMetadata(cohort),
  cellId: cellId(cohort.runId, target, tool),
  baseSha: cohort.targets[target].baseSha,
  headSha: cohort.targets[target].headSha,
  workspace: path.relative(ROOT, cwd).split(path.sep).join('/'),
}
const record = {
  ...metadata,
  artifactKind: 'recovered-candidate', canonical: false,
  target, language: state.language, fork: state.fork, pr: state.forkPr,
  tool, label: def && def.label, source: def && def.source,
  recoveredFrom: dir, usageCwd: cwd, reportedCostUsd: usage.costUsd,
  transcriptUsage: usage, result: last, finishedAt: new Date(when).toISOString(),
}
// Recovered text is audit evidence, never a benchmark result. Runner must rerun this cell and
// publish its own canonical result through the normal parsed-response path.
validateResultIdentity(record, cohort, target, tool)
const stamp = new Date(when || Date.now()).toISOString().replace(/[-:.]/g, '')
const recovered = path.join(cohort.paths.root, 'recovered', target, `${tool}-${stamp}.json`)
try {
  writeJsonExclusive(recovered, record)
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error(`recovery candidate already exists: ${recovered}`)
    process.exit(1)
  }
  throw error
}
releaseLocalLock(resultLock)
resultLockHeld = false
console.log(`${target}/${tool}: audit candidate only; runner will rerun cell -> ${recovered}`)
