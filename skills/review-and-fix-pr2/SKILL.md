---
name: review-and-fix-pr2
description: Review a pull request with independent toolkit, repository standards, and specification passes; report findings without changing code.
---

# Review a pull request

`$1` is a PR number or URL. If omitted, use the PR for the checked-out branch.
This skill is read-only: never edit files, including temporary scope or scratch files, run a formatter, commit, push, post a review, or resolve a thread. Do not run `git checkout`, `switch`, `reset`, `stash`, or `worktree`, even temporarily; use `git show` and pinned diffs to inspect other commits. Pass the frozen scope directly in each native agent prompt, never through a Bash heredoc or temporary file. It needs no source review plugins. Keep review reasoning in this Claude Code session and its native agents; do not launch model CLIs, APIs, or nested workflows.

Read [review.md](${CLAUDE_PLUGIN_ROOT}/skills/review-and-fix-pr2/review.md) and follow it. Return the review report, including `## Toolkit`, `## Standards`, and `## Spec`.
