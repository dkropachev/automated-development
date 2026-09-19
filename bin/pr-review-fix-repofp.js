#!/usr/bin/env node
'use strict'
// pr-review-fix repo fingerprint. Prints one sha256 and nothing else.
//
//   node pr-review-fix-repofp.js --root <repo>
//
// The fingerprint answers "has this repo's SHAPE changed enough that the generated reviewability
// rule might be wrong?" - not "has any file changed". So it covers the top-level entries plus the
// set of build-manifest and CI files present, and deliberately ignores file contents.
//
// This MUST be computed by code. It was prose in the setup agent's prompt at first, and two runs
// over a byte-identical tree produced two different fingerprints, which silently regenerated the
// classifier and cost ~86k input-token-equivalents.

const { execFileSync } = require('child_process')
const crypto = require('crypto')

function argv(name, dflt) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1) return dflt
  const v = process.argv[i + 1]
  return (v === undefined || v.startsWith('--')) ? true : v
}

const ROOT = argv('root', process.cwd())

const MANIFESTS = [
  'package.json', 'pnpm-workspace.yaml', 'Makefile', 'GNUmakefile', 'justfile', 'Taskfile.yml',
  'CMakeLists.txt', 'meson.build', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'tox.ini', 'noxfile.py', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'build.sbt',
  'mix.exs', 'Gemfile', 'composer.json', 'Dockerfile', 'docker-compose.yml',
]

let files
try {
  files = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n').filter(Boolean)
} catch (e) {
  console.error('repofp: not a git repository at ' + ROOT)
  process.exit(2)
}

// Top-level entries: the first path component of every tracked file, deduped and sorted.
const top = [...new Set(files.map(f => f.split('/')[0]))].sort()

// Second-level entries under the usual source roots, so that e.g. adding src/test/ is a shape change.
const SOURCE_ROOTS = new Set(['src', 'lib', 'tests', 'test', 'app', 'pkg', 'cmd', 'internal', 'packages'])
const second = [...new Set(
  files.map(f => f.split('/')).filter(p => p.length > 2 && SOURCE_ROOTS.has(p[0])).map(p => p[0] + '/' + p[1])
)].sort()

const manifests = MANIFESTS.filter(m => files.includes(m)).sort()
const ci = files.filter(f => f.startsWith('.github/workflows/') || f === '.gitlab-ci.yml' || f === '.travis.yml').sort()

const payload = JSON.stringify({ v: 1, top, second, manifests, ci })
process.stdout.write(crypto.createHash('sha256').update(payload).digest('hex') + '\n')
