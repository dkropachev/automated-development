---
name: review-and-fix-pr
description: Review an entire PR with either the built-in method or any loaded user, project, or plugin review skill, then optionally fix verified findings in serial validated commits. Use when asked to review and fix a PR, review PR 1234 with a named skill, apply a security or domain-specific review skill to a PR, or iterate until review findings are handled.
---

# Review and fix a whole PR

Run the `review-and-fix-pr` workflow. Read-only whole-PR discovery lenses run sequentially until the
bounded finding budget is reached. When the user names a loaded review skill, it runs first;
otherwise native correctness runs first. Applicable native risk lenses follow. The workflow
normalizes, deduplicates, scores, and validates results before any fix begins.

If fixing is enabled, fresh fixer agents take at most 10 findings each, one at a time. Each fixer
re-reads its changes, validates them, and commits only after the driver confirms the checks passed.
Nothing is pushed, posted, or reverted.

The selected skill controls review expertise. The workflow always controls:

- whole-PR scope and author intent;
- read-only review permissions;
- structured findings and evidence;
- fix batching, validation, and commits;
- final reporting.

Not every loaded skill is compatible. It must be model-invocable and able to guide a read-only
whole-PR review. If it is missing, user-only, or requires owning edits/comments/workflow execution,
the run stops as NOT REVIEWED instead of silently substituting another method.

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
- `HEAD` differs from PR `headRefOid`;
- GitHub authentication or PR resolution fails.

Confirm `${CLAUDE_PLUGIN_ROOT}/bin/review-and-fix-pr-driver.js` and
`${CLAUDE_PLUGIN_ROOT}/bin/review-and-fix-pr-reviewed.js` exist. Workflow repeats every gate.

## Choose review method and write authority

If user named a skill, pass its exact loaded name as `reviewSkill`, including plugin namespace such
as `vendor:security-review`. Do not guess or shorten names. If user named none, omit `reviewSkill`;
the built-in review method runs.

Always ask whether to fix or review only. Default from authorship, but offer both:

- Own PR: **Review and fix (Recommended)**.
- Someone else's PR, or unknown author: **Review only (Recommended)**; explain that fixing creates
  commits on checked-out branch.

Pass answer explicitly as `fix: true` or `fix: false`. Omission is deliberately review-only.

```js
Workflow({
  scriptPath: '${CLAUDE_PLUGIN_ROOT}/workflows/review-and-fix-pr.js',
  args: {
    pr: '<number-or-url>',
    pluginRoot: '${CLAUDE_PLUGIN_ROOT}',
    reviewSkill: '<exact-loaded-skill-name>', // omit for built-in review
    fix: true | false,
  },
})
```

Pass `repoRoot` when session working directory is outside repository. Read `reference.md` only for
advanced arguments, driver behavior, or diagnosing a run.

## Report result

Relay workflow summary. Lead with:

1. release blockers;
2. findings still present after fixes;
3. deferred findings;
4. open follow-ups;
5. validation failures and uncommitted edits;
6. NOT REVIEWED, especially selected-skill incompatibility.

When uncommitted edits remain, inspect `git status` and `git diff`, summarize what fixer attempted,
and offer to commit worthwhile finished work. Never offer `git reset --hard`; nothing in workflow
reverts user or agent work.
