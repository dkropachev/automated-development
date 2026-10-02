---
name: review-and-fix-pr
description: Review a complete pull request with mandatory independent code, spec, standards, and risk lenses, coverage auditing, optional additive review skills, independent finding verification, and optional fix commits. Use when asked to review a PR, review and fix a PR, maximize review completeness, add specialist review expertise, or iterate until verified findings are handled.
---

# Review and fix a whole PR

Run the `review-and-fix-pr` workflow. It reviews a frozen PR scope through independent mandatory
lenses, audits what those lenses covered, investigates uncovered areas once, and verifies candidate
findings before any authorized fix. A `complete` coverage result means the protocol closed; it is
not a claim that every possible defect was found.

The workflow is review-only unless `fix: true`. Fixers work in serial batches, validate, and commit
locally. After a successful fix commit, the workflow rebuilds the coverage manifest from the new
`HEAD` and reruns the complete review protocol. Nothing is
pushed, posted, reverted, or reset.

`$1` is an optional PR number or URL. With no argument, use the PR for the checked-out branch.

## Preflight

Run inline:

```bash
git rev-parse --abbrev-ref HEAD && git status --porcelain && gh auth status 2>&1 | head -3
gh pr view $1 --json number,title,headRefOid,baseRefName,url,author
gh api user --jq .login
```

Omit `$1` from `gh pr view` when no PR argument was supplied. Refuse when:

- working tree is dirty;
- `HEAD` differs from both the PR head and a resumable workflow-owned fix commit;
- GitHub authentication or PR resolution fails.

Confirm `${CLAUDE_PLUGIN_ROOT}/bin/review-and-fix-pr-driver.js`,
`${CLAUDE_PLUGIN_ROOT}/bin/review-and-fix-pr-reviewed.js`, and
`${CLAUDE_PLUGIN_ROOT}/bin/review-and-fix-pr-state.js`,
`${CLAUDE_PLUGIN_ROOT}/bin/review-and-fix-pr-chunker.js`,
`${CLAUDE_PLUGIN_ROOT}/bin/review-and-fix-pr-diff.js`, and
`${CLAUDE_PLUGIN_ROOT}/bin/review-and-fix-pr-scope.js` exist. Workflow repeats every gate.

## Configure and run

Use `fix: true` only when the user asked to change the branch; otherwise use `fix: false`. When the
user names loaded review skills, pass their exact names in order as `extraReviewSkills`. They add
methodology to the mandatory native lenses; they never replace correctness or another native lens.
Missing, user-only, or write-owning extra skills make coverage incomplete instead of causing silent
fallback.

Do not invent a stopping limit. Omitted `stopAt` runs the complete coverage protocol. Translate an
explicit count, separate code/other score, or token limit into `stopAt`; an early stop is always
reported as partial. Read `reference.md` for the exact API, scoring, verification modes, resume
rules, and status model.

```js
Workflow({
  scriptPath: '${CLAUDE_PLUGIN_ROOT}/workflows/review-and-fix-pr.js',
  args: {
    pr: '<number-or-url>',
    pluginRoot: '${CLAUDE_PLUGIN_ROOT}',
    fix: false,
    extraReviewSkills: ['<exact-loaded-skill-name>'], // omit when none were requested
  },
})
```

Pass `repoRoot` only when the session working directory is outside the repository. Pass explicit
advanced arguments unchanged; never recreate removed legacy controls.

## Report result

Relay the workflow summary and distinguish coverage, verification, and fix status. Lead with:

1. release blockers and confirmed findings still present;
2. unresolved findings and deferred findings;
3. uncovered units, failed lenses, and stop trigger;
4. validation failures, failed fixes, and uncommitted edits;
5. saved local commits and whether the run can resume.

Never describe `coverage: complete` as exhaustive or bug-free. When uncommitted edits remain,
inspect `git status` and `git diff`, summarize what the fixer attempted, and offer to commit useful
finished work. Never offer destructive cleanup.
