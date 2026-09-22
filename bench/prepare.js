'use strict'
// Republish one upstream PR as a PR in a private repo of its own, with every link repointed at that
// repo. A reviewer we are measuring is handed the copy, never the original: the original has the
// maintainers' review on it, and a reviewer that finds that review can score well without reviewing
// anything. What the copy keeps is what a reviewer legitimately gets - full history for blame, the
// PR's own commits, its title and body.
//
//   node bench/prepare.js [--only <id>] [--dry-run]
//
// Everything lands under bench/work/<id>/src and the result is recorded in bench/state.json.
const fs = require('node:fs')
const path = require('node:path')
const { run, git, gitTry, gh, ghJson } = require('./lib/exec')
const { buildMap, rewriteText, rewriteTree, residualLeaks } = require('./lib/rewrite')

const ROOT = __dirname
const WORK = path.join(ROOT, 'work')
const STATE = path.join(ROOT, 'state.json')
// The PR commits are replayed under one neutral identity. An upstream author's name in `git log` of
// the branch under review is a search term that leads straight back to the original PR.
const AUTHOR = { name: 'Bench Author', email: 'bench@example.invalid' }

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const dryRun = args.includes('--dry-run')

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return { targets: {} } }
}
function saveState(s) {
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n')
}

// The upstream PR, its diff and the human review on it. The review is ground truth for the report
// and is written to bench/groundtruth/, which no reviewer is ever pointed at.
function fetchUpstream(t) {
  const pr = ghJson('api', `repos/${t.upstream}/pulls/${t.pr}`)
  const diff = gh('api', `repos/${t.upstream}/pulls/${t.pr}`, '-H', 'Accept: application/vnd.github.v3.diff')
  const paged = (p) => {
    const raw = gh('api', p, '--paginate', '--slurp')
    return JSON.parse(raw).flat()
  }
  const review = {
    inline: paged(`repos/${t.upstream}/pulls/${t.pr}/comments?per_page=100`).map(c => ({
      user: c.user && c.user.login, path: c.path, line: c.line || c.original_line, body: c.body,
    })),
    issue: paged(`repos/${t.upstream}/issues/${t.pr}/comments?per_page=100`).map(c => ({
      user: c.user && c.user.login, body: c.body,
    })),
    reviews: paged(`repos/${t.upstream}/pulls/${t.pr}/reviews?per_page=100`).map(r => ({
      user: r.user && r.user.login, state: r.state, body: r.body,
    })),
  }
  return { pr, diff, review }
}

function clone(t, upstreamUrl, src) {
  if (!fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(src), { recursive: true })
    run('git', ['clone', '--quiet', upstreamUrl, src])
  }
  gitTry(src, 'fetch', '--quiet', 'origin', `pull/${t.pr}/head:prhead`, '--force')
}

// main = the PR's base commit with every link repointed. The rewrite is one commit BELOW the PR, so
// it never shows up in the PR's own diff.
function buildBase(src, baseSha, pairs) {
  gitTry(src, 'am', '--abort')
  gitTry(src, 'cherry-pick', '--abort')
  git(src, 'checkout', '--quiet', '-B', 'main', baseSha)
  git(src, 'clean', '-xfdq')
  const changed = rewriteTree(src, pairs)
  if (changed.length) {
    git(src, 'add', '-A')
    run('git', ['-c', `user.name=${AUTHOR.name}`, '-c', `user.email=${AUTHOR.email}`,
      'commit', '--quiet', '-m', 'chore: point project links at this repository'], { cwd: src })
  }
  return changed
}

// The PR's commits, replayed on top of the rewritten base. Each patch is rewritten the same way the
// tree was - context lines included - so it applies to the rewritten base without conflicts, and the
// authorship header is replaced before it is applied.
function replayPr(src, baseSha, pairs) {
  const patchDir = path.join(src, '.bench-patches')
  fs.rmSync(patchDir, { recursive: true, force: true })
  fs.mkdirSync(patchDir, { recursive: true })
  run('git', ['format-patch', '--no-signature', `${baseSha}..prhead`, '-o', patchDir], { cwd: src })
  const patches = fs.readdirSync(patchDir).filter(f => f.endsWith('.patch')).sort()
  git(src, 'checkout', '--quiet', '-B', 'pr', 'main')
  for (const f of patches) {
    const p = path.join(patchDir, f)
    let text = rewriteText(fs.readFileSync(p, 'utf8'), pairs)
    text = text.replace(/^From: .*$/m, `From: ${AUTHOR.name} <${AUTHOR.email}>`)
    text = text.replace(/^Signed-off-by: .*$/gm, `Signed-off-by: ${AUTHOR.name} <${AUTHOR.email}>`)
    fs.writeFileSync(p, text)
    const r = run('git', ['-c', `user.name=${AUTHOR.name}`, '-c', `user.email=${AUTHOR.email}`,
      'am', '--3way', '--quiet', p], { cwd: src, allowFail: true })
    if (r.code !== 0) {
      gitTry(src, 'am', '--abort')
      throw new Error(`patch ${f} did not apply:\n${r.err.slice(0, 2000)}`)
    }
  }
  fs.rmSync(patchDir, { recursive: true, force: true })
  return patches.length
}

function publish(t, src, pr, pairs) {
  // SSH, not HTTPS: an OAuth token without the `workflow` scope is refused the moment a push
  // carries a .github/workflows file, and every one of these repos has one.
  const forkUrl = `git@github.com:${t.fork}.git`
  const exists = run('gh', ['repo', 'view', t.fork, '--json', 'name'], { allowFail: true }).code === 0
  if (!exists) {
    gh('repo', 'create', t.fork, '--private', '--description', `${t.language} service code - review bench copy`)
  }
  gitTry(src, 'remote', 'remove', 'bench')
  git(src, 'remote', 'add', 'bench', forkUrl)
  const head = rewriteText(pr.head.ref, pairs).replace(/[^\w./-]/g, '-')
  run('git', ['push', '--quiet', '--force', 'bench', 'main:refs/heads/main', `pr:refs/heads/${head}`], { cwd: src })
  gh('api', `repos/${t.fork}`, '-X', 'PATCH', '-f', 'default_branch=main')
  const body = rewriteText(pr.body || '', pairs)
  const open = run('gh', ['pr', 'create', '--repo', t.fork, '--base', 'main', '--head', head,
    '--title', rewriteText(pr.title, pairs), '--body', body || '(no description)'], { allowFail: true })
  const list = ghJson('pr', 'list', '--repo', t.fork, '--head', head, '--state', 'all', '--json', 'number,url')
  if (!list.length) throw new Error(`no PR on ${t.fork}: ${open.err.slice(0, 500)}`)
  return { number: list[0].number, url: list[0].url, head }
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'targets.json'), 'utf8'))
const state = loadState()
fs.mkdirSync(path.join(ROOT, 'groundtruth'), { recursive: true })

for (const t of cfg.targets) {
  if (only && t.id !== only) continue
  const src = path.join(WORK, t.id, 'src')
  const pairs = buildMap(t)
  console.log(`\n=== ${t.id} (${t.language}) <- ${t.upstream}#${t.pr}`)
  const { pr, diff, review } = fetchUpstream(t)
  fs.writeFileSync(path.join(ROOT, 'groundtruth', `${t.id}.json`), JSON.stringify({
    upstream: t.upstream, pr: t.pr, title: pr.title, url: pr.html_url, merged: pr.merged_at,
    base: pr.base.sha, head: pr.head.sha, diffBytes: diff.length, review,
  }, null, 2) + '\n')
  console.log(`  upstream diff ${diff.length} bytes, ${review.inline.length} inline review comments`)
  if (dryRun) continue

  clone(t, pr.base.repo.clone_url, src)
  gitTry(src, 'fetch', '--quiet', 'origin', pr.base.sha)
  const changed = buildBase(src, pr.base.sha, pairs)
  console.log(`  rewrote ${changed.length} files on the base commit`)
  const n = replayPr(src, pr.base.sha, pairs)
  const localDiff = run('git', ['diff', 'main...pr'], { cwd: src }).out
  console.log(`  replayed ${n} commits, local PR diff ${localDiff.length} bytes`)
  const leaks = residualLeaks(src, [t.upstream, t.upstream.split('/')[1]])
  console.log(`  residual upstream mentions in tree: ${leaks.reduce((a, b) => a + b.count, 0)} in ${leaks.length} files`)
  const pub = publish(t, src, pr, pairs)
  console.log(`  published ${pub.url}`)

  state.targets[t.id] = {
    ...t, forkPr: pub.number, forkPrUrl: pub.url, forkHead: pub.head,
    upstreamPrUrl: pr.html_url, upstreamTitle: pr.title,
    upstreamDiffBytes: diff.length, localDiffBytes: localDiff.length,
    commits: n, rewrittenFiles: changed.length,
    residualLeakFiles: leaks.length, residualLeakHits: leaks.reduce((a, b) => a + b.count, 0),
    preparedAt: new Date().toISOString(),
  }
  saveState(state)
}
console.log('\nstate:', STATE)
