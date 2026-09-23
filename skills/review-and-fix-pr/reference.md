# review-and-fix-pr — reference

Read this for advanced arguments, selected-skill compatibility, driver behavior, or run diagnosis.

## Arguments

| arg | default | meaning |
|---|---|---|
| `pr` | current branch's PR | PR number or URL |
| `fix` | `false` | `true` to edit, validate, and commit; `false` for review only |
| `reviewSkill` | native correctness | Exact loaded user, project, or plugin skill name; runs as the first discovery lens |
| `reviewMode` | `bounded` | `bounded` stops discovery at a finding threshold; `unbounded` runs every applicable lens |
| `maxFindings` | 10 | Unique counted findings; `null` disables this bounded threshold |
| `maxMajorFindings` | 2 | Unique counted `critical` or `high` findings; `null` disables |
| `maxSeverityScore` | 10 | Weighted unique finding score; `null` disables |
| `severityWeights` | `{critical:10, high:5, medium:2, low:1}` | Partial override; values are non-negative integers |
| `validation` | `single` | `off`, `single`, or `double`; double challenges confirmations in the same validator conversation |
| `maxFixBatch` | 10 | Findings per serial fixer |
| `detailedReview` | false | Let reviewer trace callers and run experiments in throwaway clone; repository remains read-only |
| `model` | inherited | Run workflow agents on one specified model |
| `maxAgents` | 900 | Hard stop on agents spawned |
| `maxTokens` | none | Stop after this run spends given token delta |
| `repoRoot` | session cwd | Absolute repository path |

Legacy chunk arguments (`mode`, `reviewConcurrency`, `maxOutstanding`, `chunkBytes`, `isolation`,
`stages`, `ignoreLedger`, `refreshRules`, and `findingsPerChunk`) are accepted by old saved calls but
do not affect active whole-PR mode.

Thresholds must be positive integers or `null`; bounded mode needs at least one enabled threshold.
Zero, negative, fractional, non-numeric, and unknown mode/weight values fail before an agent starts.
Unbounded mode ignores thresholds but still reports scores. `maxAgents` and `maxTokens` are emergency
circuit breakers, not review-cost controls. `detailedReview` permits scratch experiments but does not
make review unbounded.

Only unique, in-scope, non-deferred, non-rejected findings with `certain` or `likely` confidence
consume thresholds. Discovery stops at `>=` any enabled threshold. A stopped bounded review is
partial: validation and authorized fixing continue, but validation rejection never resumes lenses.

## Discovery lenses

The selected `reviewSkill`, when present, runs first. Otherwise native `correctness` runs first.
Applicable native lenses then run sequentially in consequence order:

```
security -> reliability -> contracts -> testing
-> performance -> comments -> maintainability
```

Each lens sees the full PR and no earlier findings, performs one focused pass and one self-check,
and remains read-only. Results are normalized to `path:symbol:defect-class`, deduplicated, and scored
before the next lens may start. Duplicate reports count once; their reporting lenses are retained.

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

Discovery reviewers and validators always receive read-only tools. Even with `fix: true`, a selected
skill cannot write the branch. After validation, the workflow sends eligible findings to separate
fixer agents.
Fixers run serially, at most `maxFixBatch` findings per agent.

`bin/review-and-fix-pr-driver.js` runs inside reviewer and fixer conversations:

```
review  start → found --new N → checked --kept N --clean-files ... → marked
fix     start → fixed --followups N → validated --passed yes|no → committed
validate start → screened --confirmed N → rechecked --kept N → final
```

Review mode remains for backward compatibility; active lens discovery does not use its repeated-pass
loop. Double validation uses one validator and the validate driver to challenge only its first-pass
confirmations. Fix driver measures changed files with
`git status`, permits commit only after validation passes, and confirms `HEAD` moved. A failed batch
is never reverted; its edits remain for human inspection.

With validation off, retained self-checked findings are marked unvalidated and the fixer re-reads
them. With single/double validation, only confirmed findings may reach a fixer. Unresolved and
rejected findings are never automatically fixed.

## Scope and outcomes

Scope is label, never pre-review filter:

- `in`: PR introduces, worsens, makes reachable, or claims to fix defect;
- `deferred`: author explicitly deferred it in quoted PR/issue text;
- `out`: defect predates PR and PR neither worsens nor claims it.

Undecidable means `in`. Out-of-scope real defects are reported but not fixed. Review-only findings
remain explicit open findings; `deferred` is reserved for author deferral or disproportionate fixes.
Rejected candidates, unresolved findings, deferred findings, still-present findings, and release
blockers remain separate in the final report.

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
