#!/usr/bin/env node
'use strict'
// Drift checks between the prose and the code. A skill tells the model which driver verbs to run,
// which flags to pass and which files to read; the code moves and the instructions rot silently
// unless something compares them. Exit 1 with every problem listed.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const problems = []
const bad = (m) => problems.push(m)

// ---- versions agree
const plugin = JSON.parse(rd('.claude-plugin/plugin.json'))
const pkg = JSON.parse(rd('package.json'))
const market = JSON.parse(rd('.claude-plugin/marketplace.json'))
const lock = JSON.parse(rd('package-lock.json'))
if (plugin.version !== pkg.version) bad(`version: plugin.json says ${plugin.version}, package.json says ${pkg.version}`)
if (lock.version !== pkg.version || (lock.packages && lock.packages[''] && lock.packages[''].version !== pkg.version)) {
  bad(`version: package-lock.json does not match package.json ${pkg.version}`)
}
if (!/^\d+\.\d+\.\d+$/.test(plugin.version || '')) bad(`plugin.json version "${plugin.version}" is not X.Y.Z`)
if (plugin.name !== pkg.name) bad(`name: plugin.json says ${plugin.name}, package.json says ${pkg.name}`)
if (market.name !== plugin.name) bad(`marketplace.json name ${market.name} != plugin name ${plugin.name}`)
const entry = (market.plugins || []).find((p) => p.name === plugin.name)
if (!entry) bad(`marketplace.json lists no plugin named ${plugin.name}`)
else if (entry.source !== './') bad(`marketplace.json plugin source is ${entry.source}, expected ./ (this repo is the plugin)`)

// ---- frontmatter helpers
function fm(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) return null
  const out = {}
  for (const line of m[1].split('\n')) { const kv = /^([\w-]+):\s*(.*)$/.exec(line); if (kv) out[kv[1]] = kv[2].trim() }
  return out
}

// ---- agents: name == filename, description present, only honoured keys
const AGENT_KEYS = new Set(['name', 'description', 'tools', 'disallowedTools', 'model', 'skills', 'color', 'background', 'omitClaudeMd', 'memory', 'isolation', 'effort', 'maxTurns'])
const agentTypes = []
for (const f of fs.existsSync(path.join(ROOT, 'agents')) ? fs.readdirSync(path.join(ROOT, 'agents')) : []) {
  if (!f.endsWith('.md')) continue
  const h = fm(rd(path.join('agents', f)))
  if (!h) { bad(`agents/${f}: no frontmatter`); continue }
  if (h.name !== f.replace(/\.md$/, '')) bad(`agents/${f}: name "${h.name}" does not match the filename`)
  if (!h.description) bad(`agents/${f}: no description`)
  for (const k of Object.keys(h)) if (!AGENT_KEYS.has(k)) bad(`agents/${f}: frontmatter key "${k}" is ignored for plugin agents`)
  agentTypes.push(`${plugin.name}:${h.name}`)
}

// ---- skills: name == dir, description present, driver verbs/flags/files it references exist
// Every driver this plugin ships, so a skill naming a verb or flag that its own driver does not
// have is caught here rather than at runtime. Keyed by the basename a skill would write.
const DRIVERS = ['promptgen-driver.js', 'review-and-fix-pr-driver.js'].map((f) => {
  const src = rd(path.join('bin', f))
  return {
    file: f,
    verbs: new Set([...src.matchAll(/VERB === '([\w-]+)'/g)].map((m) => m[1])),
    flags: new Set([...src.matchAll(/\b(?:one|has|num|list)\('([\w-]+)'/g)].map((m) => m[1])),
  }
})
const driverByFile = new Map(DRIVERS.map((d) => [d.file, d]))
const driver = rd('bin/promptgen-driver.js')
const verbs = driverByFile.get('promptgen-driver.js').verbs
const flags = driverByFile.get('promptgen-driver.js').flags
const skillsDir = path.join(ROOT, 'skills')
for (const d of fs.readdirSync(skillsDir)) {
  const dir = path.join('skills', d)
  if (!fs.existsSync(path.join(ROOT, dir, 'SKILL.md'))) { bad(`${dir}: no SKILL.md`); continue }
  const h = fm(rd(path.join(dir, 'SKILL.md')))
  if (!h) bad(`${dir}/SKILL.md: no frontmatter`)
  else {
    if (h.name !== d) bad(`${dir}/SKILL.md: name "${h.name}" does not match the directory`)
    if (!h.description) bad(`${dir}/SKILL.md: no description`)
  }
  const texts = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.md')).map((f) => [path.join(dir, f), rd(path.join(dir, f))])
  for (const [file, text] of texts) {
    // node "$DRIVER" <verb>   /   promptgen-driver.js" <verb>   /   promptgen-driver.js <verb>
    for (const m of text.matchAll(/promptgen-driver\.js"?\s+([a-z][\w-]*)\b/g)) {
      if (!verbs.has(m[1])) bad(`${file}: refers to driver verb "${m[1]}", which the driver does not have`)
    }
    for (const m of text.matchAll(/\$DRIVER"\s+([a-z][\w-]*)\b/g)) {
      if (!verbs.has(m[1])) bad(`${file}: refers to driver verb "${m[1]}", which the driver does not have`)
    }
    // flags on driver command lines only - including backslash-continued lines of one
    let inDriverCmd = false
    for (const line of text.split('\n')) {
      const isDriver = /promptgen-driver\.js|\$DRIVER/.test(line)
      if (isDriver || inDriverCmd) {
        for (const m of line.matchAll(/--([a-z][\w-]*)/g)) {
          if (!flags.has(m[1])) bad(`${file}: passes --${m[1]} to the driver, which does not read it`)
        }
      }
      inDriverCmd = (isDriver || inDriverCmd) && /\\\s*$/.test(line)
    }
    // the same two checks for every other driver this plugin ships
    for (const d of DRIVERS) {
      if (d.file === 'promptgen-driver.js') continue
      const nameRe = d.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Only real invocations - `node .../<driver> <verb>`. Matching the bare filename would read
      // the next word of any sentence that names the file as a verb ("... -driver.js two state
      // machines" reported a verb "two").
      for (const m of text.matchAll(new RegExp('node\\s+\\S*' + nameRe + '"?\\s+([a-z][\\w-]*)\\b', 'g'))) {
        if (!d.verbs.has(m[1])) bad(`${file}: refers to ${d.file} verb "${m[1]}", which it does not have`)
      }
      let inCmd = false
      for (const line of text.split('\n')) {
        const isCmd = new RegExp('node\\s+\\S*' + nameRe).test(line)
        if (isCmd || inCmd) {
          for (const m of line.matchAll(/--([a-z][\w-]*)/g)) {
            if (!d.flags.has(m[1])) bad(`${file}: passes --${m[1]} to ${d.file}, which does not read it`)
          }
        }
        inCmd = (isCmd || inCmd) && /\\\s*$/.test(line)
      }
    }

    // sibling markdown files it names
    for (const m of text.matchAll(/`([\w-]+\.md)`/g)) {
      if (!fs.existsSync(path.join(ROOT, dir, m[1])) && !['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SKILL.md', 'README.md'].includes(m[1]) && !/PULL_REQUEST|_TEMPLATE/i.test(m[1])) {
        bad(`${file}: names ${m[1]}, which is not next to it`)
      }
    }
    // agent types it spawns
    for (const m of text.matchAll(new RegExp('`(' + plugin.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':[\\w-]+)`', 'g'))) {
      if (!agentTypes.includes(m[1])) bad(`${file}: spawns ${m[1]}, but no such agent is shipped under agents/`)
    }
  }
}

// ---- workflows call make targets that exist; Makefile targets call scripts that exist
const makefile = rd('Makefile')
const targets = new Set([...makefile.matchAll(/^([a-z][\w-]*):/gm)].map((m) => m[1]))
for (const f of fs.readdirSync(path.join(ROOT, '.github', 'workflows'))) {
  const y = rd(path.join('.github', 'workflows', f))
  for (const m of y.matchAll(/\bmake\s+([a-z][\w-]*)/g)) if (!targets.has(m[1])) bad(`.github/workflows/${f}: runs "make ${m[1]}", which the Makefile does not define`)
  if (/^\s+run:\s*\|/m.test(y)) bad(`.github/workflows/${f}: has a multi-line run: block; put the logic in scripts/*.js behind a make target`)
}
for (const m of makefile.matchAll(/\$\(NODE\)\s+(scripts\/[\w-]+\.js)/g)) {
  if (!fs.existsSync(path.join(ROOT, m[1]))) bad(`Makefile: runs ${m[1]}, which does not exist`)
}

// ---- every driver verb is documented in the header comment
const header = driver.slice(0, driver.indexOf("const fs = require('fs')"))
for (const v of verbs) if (!header.includes(v)) bad(`bin/promptgen-driver.js: verb "${v}" is not mentioned in the header comment`)

if (problems.length) {
  console.error('check-consistency: ' + problems.length + ' problem(s)')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log(`check-consistency: ok (${DRIVERS.map((d) => d.verbs.size + '+' + d.flags.size).join(', ')} verbs+flags across ${DRIVERS.length} drivers, ${agentTypes.length} agents, version ${plugin.version})`)
