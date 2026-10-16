---
name: code-review-ad
description: Review a GitHub pull request through independent Toolkit, Standards, and Spec passes; report verified issues without editing code or suggesting fixes.
---

# Review a pull request

Use the supplied PR number or URL. If omitted, use the PR for the checked-out branch. This skill is read-only: do not edit files, run a formatter, commit, push, post a review, or resolve a thread. Do not run `git checkout`, `switch`, `reset`, `stash`, or `worktree`; use `git show` and pinned diffs to inspect other commits. Keep review reasoning in this Codex session and its subagents; do not launch model CLIs, APIs, or nested workflows.

Read [review.md](review.md) and follow it. Return the review report with `## Toolkit`, `## Standards`, and `## Spec`.
