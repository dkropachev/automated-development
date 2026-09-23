# review-and-fix-pr — reference

Read this for advanced arguments, selected-skill compatibility, driver behavior, or run diagnosis.

## Arguments

| arg | default | meaning |
|---|---|---|
| `pr` | current branch's PR | PR number or URL |
| `fix` | `false` | `true` to edit, validate, and commit; `false` for review only |
| `reviewSkill` | built-in method | Exact loaded user, project, or plugin skill name; for example `security-review` or `vendor:security-review` |
| `maxFixBatch` | 10 | Findings per serial fixer |
| `detailedReview` | false | Let reviewer trace callers and run experiments in throwaway clone; repository remains read-only |
| `model` | inherited | Run workflow agents on one specified model |
| `maxAgents` | 900 | Hard stop on agents spawned |
| `maxTokens` | none | Stop after this run spends given token delta |
| `repoRoot` | session cwd | Absolute repository path |

Legacy chunk arguments (`mode`, `reviewConcurrency`, `maxOutstanding`, `chunkBytes`, `isolation`,
`stages`, `ignoreLedger`, `refreshRules`, and `findingsPerChunk`) are accepted by old saved calls but
do not affect active whole-PR mode.

## Selected skill contract

Reviewer invokes `reviewSkill` through Skill tool before inspecting PR. Skill supplies methodology
and domain knowledge. Workflow prompt and tool restrictions retain control of scope and safety.

Compatible skill must:

- be loaded and model-invocable;
- work as read-only review guidance;
- accept whole PR diff as target;
- allow reviewer to normalize results into workflow schema.

Skill is incompatible when it requires edits, comments, user interaction, another workflow, or owns
an inseparable fix lifecycle. Missing, disabled, user-only, and incompatible skills stop run as NOT
REVIEWED. Workflow never silently substitutes built-in review after explicit selection.
Selecting `review-and-fix-pr` itself is rejected to prevent recursive workflow invocation.

## Agent separation

Reviewer always receives read-only tools. Even with `fix: true`, selected skill cannot write branch.
After review completes, workflow sends normalized actionable findings to separate fixer agents.
Fixers run serially, at most `maxFixBatch` findings per agent.

`bin/review-and-fix-pr-driver.js` runs inside reviewer and fixer conversations:

```
review  start → found --new N → checked --kept N --clean-files ... → marked
fix     start → fixed --followups N → validated --passed yes|no → committed
```

Review driver requires repeated passes, then a double-check. Fix driver measures changed files with
`git status`, permits commit only after validation passes, and confirms `HEAD` moved. A failed batch
is never reverted; its edits remain for human inspection.

## Scope and outcomes

Scope is label, never pre-review filter:

- `in`: PR introduces, worsens, makes reachable, or claims to fix defect;
- `deferred`: author explicitly deferred it in quoted PR/issue text;
- `out`: defect predates PR and PR neither worsens nor claims it.

Undecidable means `in`. Out-of-scope real defects are reported but not fixed. Rejected candidates,
deferred findings, still-present findings, and release blockers remain separate in final report.

## State

Runtime state stays outside repository:

```
~/.claude/review-and-fix-pr/
  state/<batch>.state.json
  <owner>__<repo>/reviewed.json
  <owner>__<repo>/runs/<sha>-<suffix>/
```

Old classifier and chunk files may remain from previous plugin versions. Active whole-PR mode neither
reads nor updates them. Shipped chunker helpers remain for compatibility and possible future reuse.
