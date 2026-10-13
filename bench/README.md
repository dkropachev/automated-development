# bench - the review-tool bake-off

Nine configured review tools and three real pull requests in three languages, published as a
report and an offline dashboard. The default active matrix remains 19 cells; experimental
`review-and-fix-pr` and `code-review-ad` are cohort-only, and parked
`ironweave/tob-c-review` is excluded:

- [`docs/review-bakeoff.md`](../docs/review-bakeoff.md) is the narrative report.
- [`docs/index.html`](../docs/index.html) is a self-contained skill-selection workbench. It separates
  choosing, comparing, broad insights, findings, and raw-run inspection into focused views. Open it
  directly from disk; it has no server, framework, CDN, or network dependency. The legacy
  `docs/run-explorer.html` path contains the same export.

Every stage is a Node script behind a Makefile target. Result stages are resumable and append-only:
an interrupted cohort can continue, but a recorded result is never replaced. Each new benchmark
cohort lives under `runs/<runId>/`; its manifest freezes target commits, target metadata, tool
configuration, and expected cells before results are accepted. The original `results/`,
`findings/`, and `judgement/` trees are the immutable `legacy` cohort.

```
make bench-prepare   # republish each upstream PR into a blinded private repo, fetch ground truth
make bench-quota     # record a zero-spend quota preflight before the next paid call
make bench-probe     # quota-gate and record exact-model Fable evidence
make bench-run       # run the default claude-opus-5-5 cohort
make bench-extract   # seal the complete result matrix, then extract comparable JSON findings
make bench-judge     # merge, verify, classify, and mark the full cohort complete
make bench-report RUN=<completed-run> # verify one snapshot and render its cohort report
make bench-publish   # regenerate cohort reports and both Pages exports
make bench-publish-check # fail if a generated publication file is missing or stale
make bench-reconcile # propose, review, seal, or validate the canonical model-comparison gold
make bench-dashboard # render every cohort into docs/index.html and docs/run-explorer.html
```

The runner pins the configured default, `claude-opus-5-5`; it does not rely on Claude Code's moving
`opus` alias. Review calls explicitly use medium effort, matching the existing Opus 5.5 cohort;
Sonnet extraction and judgement calls explicitly use their existing high effort. This prevents a
local Claude Code setting from changing a cohort while isolating the reviewer-model change. `MODEL`
selects another configured model and `RUN` supplies a new, filesystem-safe cohort ID. Use the same
`RUN` for downstream stages:

```
make bench-run MODEL=claude-opus-5-5 RUN=opus-5-5-2026-09-28
make bench-extract bench-judge RUN=opus-5-5-2026-09-28
make bench-report RUN=opus-5-5-2026-09-28
make bench-report RUN=legacy             # regenerate the historical narrative report
```

Use `ARGS="--concurrency 1 --limit-retries 0"` for quota-gated orchestration. With zero retries, a
usage-limit response fails the cell without publishing a canonical result, so the orchestrator can
recheck quota before resuming that missing cell.

Every paid Fable review, extraction, and judgement call runs a structured zero-spend quota gate
immediately before its model process. The gate resolves, versions, and hashes the executable
selected by `CLAUDE`, then the paid stage launches that exact realpath. It permits the call only
when the current session, all-model week, and Fable week are each at most 95%; missing or ambiguous
quota data fails closed. Before the probe, initialize the Fable
manifest with a zero-call run filtered to a nonexistent cell, then verify its pins, frozen inputs,
and 19-cell scope against the Opus 5.5 manifest. Run
`make bench-probe RUN=fable-5-1-2026-09-29`; it performs its own fresh authorization and immediately
launches the returned executable with exact Fable 5.1, medium effort, no tools, and the minimal
exact-`OK` prompt. After the third judgement, run `make bench-quota RUN=... ARGS=--final`, then
rerun `make bench-judge RUN=...`; recorded judgements are skipped and completion requires no paid
call.

A repeated run command resumes cells in that cohort's original expected matrix. Extraction creates
`seal.json` only after every expected result exists; from that point no result can be added or
changed. Use a new `RUN` to extend the matrix, rerun a cell, or make any fresh measurement. Judging
creates `complete.json` only after every sealed finding and target judgement exists. Reports and the
dashboard accept new cohorts only through that hash-verified complete snapshot. `make bench-publish`
discovers every such modern cohort without a model allow-list, renders standalone reports except
for cohorts containing `code-review-ad`, and renders both dashboards. It leaves the
hand-written legacy report untouched. `make bench-publish-check`
fails on a missing or stale generated file. `ARGS`
passes other flags through, for example `make bench-run ARGS="--only ironweave --concurrency 2"`.

The dashboard's Choose, Compare, Insights, Findings, and run-overlap views use the separate
`issue-identities.json` cross-run catalog. Reviewed mappings can assign more than one underlying
identity to a cohort judgement and can give a finding a reviewed verdict that differs from its
local judge. The original judgement remains visible in the run evidence. New findings without a
reviewed mapping appear immediately under distinct provisional identities. Discovered coverage
uses all completed, hash-verified runs on the selected pinned PR revisions; the Models tab labels
this coverage separately from the sealed canonical gold ranking. Review new matches in the catalog
before treating provisional counts as deduplicated.

## Scoped cohorts and local plugins

`code-review-ad` is a separate read-only protocol with toolkit, Standards, and Spec reports.
The three October 12 cohorts were relabeled in their verified snapshots after the skill rename;
their recorded prompts preserve what Claude actually received. This relabeling did not rerun reviews
or add their findings to canonical gold.
It does not use the `review-and-fix-pr` completion marker. Run it from this plugin checkout with
`--plugin-dir .` and a fresh `RUN`; the default matrix does not include it. After all three Opus 5.5
results exist, run `node bench/check-review-tokens.js <RUN>`. This checks each result's recorded
transcript input, output, cache-read, and cache-creation total against 120% of the matching
`anthropic-pr-review` plus `mattpocock-review` results from `opus-5-5-2026-09-29`. A missing usage
record or one over-limit target fails. Then extract, judge, complete, and publish that cohort using
the commands below with the new tool ID. Keep its judgements cohort-local unless a new gold
snapshot is separately reviewed and sealed.

With no cohort-scope flags, `bench-run` retains the default 19-cell matrix. Cohort-only experimental
tools do not enter it merely because they are registered. On the first invocation
for a new `RUN`, `--cohort-tool <tool>` deliberately narrows the manifest to that tool and all of its
eligible targets; optional `--cohort-target <target>` narrows it to one target as well. These flags
define the immutable expected-cell set. Resuming the same `RUN` with a different scope is rejected,
and sealing still requires every cell in that frozen scope.

`--tool` and `--only` have a different job: they are invocation filters over the already-frozen
manifest. They choose which missing tool or target cells this process attempts without changing the
cohort's expected cells. This makes it safe to run a scoped three-target cohort serially. Supplying
only `--tool` or `--only` when creating an ordinary cohort does not shrink its manifest.

`review-and-fix-pr` must run from the plugin checkout being measured. Pass its root with
`--plugin-dir <path>` (from this repository root, `--plugin-dir .`). The runner isolates the local
plugin from any installed marketplace copy and launches Claude with the specified checkout. Its
manifest records the plugin version, the checkout's Git commit, and a deterministic content hash.
Every resume recomputes and compares that fingerprint, so a changed checkout, a different build, or
an installed copy with the same plugin name cannot silently enter the cohort.

Review, extraction, and judgement stages all accept `--max-budget-usd <amount>` and
`--timeout <minutes>`. The budget is passed to each paid Claude process as that call's ceiling, and
the timeout terminates that process if it does not finish in time. A timeout, budget stop, malformed
response, or failed validation never becomes a successful artifact; it must be retried under a
fresh attempt where the append-only rules permit one. These controls bound a call, not a whole
multi-command cohort, so inspect and report recorded usage after each cell.

### `review-and-fix-pr` publication contract

`review-and-fix-pr` is a review-only, experimental, self-authored Claude skill. Current runs keep
all review reasoning in the invoking Claude Code session and its native agents. They use the
schema-v1 `REVIEW_AND_FIX_PR_RESULT_JSON` marker. The parser admits a result only when all ten
methodology IDs are complete, verification and coverage are complete, no gaps or failed lanes
remain, fixing was not requested, and provisional findings partition into confirmed, rejected,
and unresolved counts. The marker must be the final nonempty line.

Earlier cohorts with schema-v2/v3 markers and external Codex receipts remain readable as
historical measurements of the former cross-harness protocol. Their sealed results are not
reinterpreted as native Claude-skill runs. Cohort-local judgements remain separate from the
manually reviewed canonical gold comparison.

### Three-cell Opus 5.5 cohort

The following commands, run from the repository root, create the skill-only cohort and attempt one
cell at a time. The omitted `--cohort-target` intentionally freezes all three eligible targets;
`--only` limits just the current invocation. A failed or contract-rejected cell is not recorded and
can be retried under the cohort's append-only rules.

```
make bench-run MODEL=claude-opus-5-5 RUN=opus-5-5-review-and-fix-pr-2026-10-01 ARGS="--cohort-tool review-and-fix-pr --tool review-and-fix-pr --only ironweave --plugin-dir . --concurrency 1 --limit-retries 0 --timeout 120 --max-budget-usd 50"
make bench-run MODEL=claude-opus-5-5 RUN=opus-5-5-review-and-fix-pr-2026-10-01 ARGS="--cohort-tool review-and-fix-pr --tool review-and-fix-pr --only quillstone --plugin-dir . --concurrency 1 --limit-retries 0 --timeout 120 --max-budget-usd 50"
make bench-run MODEL=claude-opus-5-5 RUN=opus-5-5-review-and-fix-pr-2026-10-01 ARGS="--cohort-tool review-and-fix-pr --tool review-and-fix-pr --only tidepool --plugin-dir . --concurrency 1 --limit-retries 0 --timeout 120 --max-budget-usd 50"
```

Only after all three complete results exist, extract and judge one target at a time with the pinned
Sonnet evaluator. Each paid post-processing call has its own $5 ceiling. The first extraction seals
the result matrix; each judgement command remains pending until the third target allows
`complete.json` to be written.

```
make bench-extract RUN=opus-5-5-review-and-fix-pr-2026-10-01 ARGS="--tool review-and-fix-pr --only ironweave --max-budget-usd 5 --timeout 120"
make bench-judge RUN=opus-5-5-review-and-fix-pr-2026-10-01 ARGS="--only ironweave --max-budget-usd 5 --timeout 120"
make bench-extract RUN=opus-5-5-review-and-fix-pr-2026-10-01 ARGS="--tool review-and-fix-pr --only quillstone --max-budget-usd 5 --timeout 120"
make bench-judge RUN=opus-5-5-review-and-fix-pr-2026-10-01 ARGS="--only quillstone --max-budget-usd 5 --timeout 120"
make bench-extract RUN=opus-5-5-review-and-fix-pr-2026-10-01 ARGS="--tool review-and-fix-pr --only tidepool --max-budget-usd 5 --timeout 120"
make bench-judge RUN=opus-5-5-review-and-fix-pr-2026-10-01 ARGS="--only tidepool --max-budget-usd 5 --timeout 120"
```

After `complete.json` validates, `make bench-publish` discovers the cohort from its verified
snapshot without a model allow-list. `code-review-ad` results appear in both dashboard exports
without a standalone Markdown report. `make bench-publish-check` must pass before the generated
dashboard is committed. Cohort publication alone is local; canonical inclusion requires
a separately reviewed, accepted, and sealed gold snapshot.

## Why each PR is republished

A reviewer that can reach the original pull request can read the maintainers' review instead of
doing its own. `prepare.js` therefore clones the upstream repository into a private repository under
a neutral name, rewrites every `owner/repo` reference to point at the copy, replays the PR's commits
under a neutral author, opens the PR there, and records the upstream review in `groundtruth/` where
no run and no judge can see it. `WebSearch` and `WebFetch` are denied to every run.

This is not airtight: product names inside the source cannot be scrubbed without changing the code
under review. See the analysis in the report.

## Layout

| Path | What is in it |
|---|---|
| `targets.json` | the three PRs, their blinded repositories and any extra strings to rewrite |
| `tools.json` | the tool matrix: one prompt per tool, plus the shared context block |
| `models.json` | configured model IDs and the pinned default model |
| `state.json` | what `prepare.js` published, written once and read by every later stage |
| `groundtruth/` | the upstream human review, for comparison after the fact |
| `results/`, `findings/`, `judgement/` | original artifacts, exposed as the read-only `legacy` cohort |
| `runs/<runId>/manifest.json` | requested model and Claude version; pinned base/head commits; frozen target metadata, upstream ground truth, tool prompts/context, expected cell matrix, optional cohort scope, and local-plugin fingerprint |
| `runs/<runId>/seal.json` | hashes of every expected result; extraction creates it and permanently closes the result set |
| `runs/<runId>/complete.json` | final seal, finding, and judgement hashes; required by reports and dashboard |
| `runs/<runId>/probe.json` | sanitized exact-model probe evidence and its quota reference |
| `runs/<runId>/quota.jsonl` | sanitized quota preflights and final snapshot; no raw account or UI data |
| `runs/<runId>/{results,findings,judgement}/` | append-only artifacts for one new model cohort |
| `runs/<runId>/recovered/` | audit-only transcript recoveries; never scored as results, so their cells must be rerun |
| `gold/index.json` | hash-bound pointer to the one published model-comparison snapshot |
| `gold/<comparisonId>/source-manifest.json` | declared cohorts, pinned targets, exact source hashes, eligibility policy, evidence cells, and comparison scopes |
| `gold/<comparisonId>/proposal/` | one generated reconciliation per target, editable only during manual review |
| `gold/<comparisonId>/canonical/` | accepted, reviewed per-target issues and exact `{cellId, findingIndex}` mappings |
| `gold/<comparisonId>/complete.json` | immutable hashes and totals for the source manifest, reviewed proposals, and canonical target files |
| `analysis.md` | hand-written analysis for the legacy narrative report |
| `dashboard.js`, `dashboard/` | deterministic dashboard generator and browser assets |
| `work/`, `logs/` | working trees and run logs, not committed |

A tool that cannot finish inside one usage window is marked `"parked": true` in `tools.json`. It
stays in the matrix and in the report, and `run.js` skips it unless `--include-parked` is passed.

## Canonical model-comparison gold

The model comparison does not reuse independent cohort judgements as if they were a shared truth
set. `bench/reconcile.js` builds versioned, reviewable gold snapshots. Its default ID is the
historical `model-comparison-2026-09-30`; the published snapshot is
`model-comparison-2026-10-08`. Set `GOLD_ID=<id>` when working on another snapshot.

The Models dashboard aggregates every hash-verified completed cohort by model in Discovered
coverage. Its cohort-local judgements remain separate from canonical completeness and detection
credit until a reviewed gold snapshot maps their findings. Individual runs remain available in
Runs. Historical legacy rows have no complete snapshot and do not enter discovered coverage.

For a fresh independent comparison, `proposal` runs Opus 5.5 reconciliation per target. The
published extension of the earlier gold used a deterministic decision file after reviewing all
new confirmed claims against the pinned code and existing canonical issues:

```
make bench-reconcile PHASE=source GOLD_ID=model-comparison-2026-10-08 ARGS="--declaration-file bench/gold/declarations/model-comparison-2026-10-08.json --supersedes model-comparison-2026-09-30 --issue-url https://github.com/dkropachev/automated-development/issues/42"
make bench-reconcile PHASE=proposal GOLD_ID=model-comparison-2026-10-08 ARGS="--decision-file bench/gold/decisions/model-comparison-2026-10-08.json"
# Review every proposal issue and source mapping before acceptance.
make bench-reconcile PHASE=accept GOLD_ID=model-comparison-2026-10-08 ARGS="--reviewer codex"
make bench-reconcile PHASE=seal GOLD_ID=model-comparison-2026-10-08
make bench-reconcile PHASE=validate GOLD_ID=model-comparison-2026-10-08
```

`proposal` hashes all source findings and checks the declared cohorts and target pins. Without a
decision file it runs one `claude-opus-5-5` high-effort reconciliation per target. A decision file
preserves the earlier sealed issues and mappings and supplies reviewed additions. Both paths retain
canonical `real`, `false-positive`, and `unproven` records. Review may correct proposal files before
`accept`; acceptance validates complete
source coverage and promotes the reviewed records into `canonical/`. `seal` refuses an already
sealed snapshot, writes `complete.json`, and publishes its hash through `gold/index.json`. Replacing
the published index requires an explicit, hash-matched `supersedes` declaration; the older sealed
snapshot remains intact.
`validate` is read-only and rechecks the index, completion marker, source, proposal, and canonical hashes,
target pins, enums, stable issue IDs, and every mapping. Changed inputs, missing or duplicate
mappings, cross-target references, incomplete coverage, and post-seal edits all fail validation.

The published source manifest contains 450 eligible claims: the earlier 403 and 47 confirmed
review-and-fix-pr claims. Its 74 suggestions and all `selfRejected: true` findings are excluded from
confirmed gold credit. Each eligible raw claim is mapped
exactly once by `{cellId, findingIndex}`. The parked legacy DNF is excluded from evidence and credit
but remains hash-bound as an excluded source; intentionally deleted historical tool cells are not
reconstructed. Two recovered legacy C++ reports remain discovery evidence: they may
support creation of a canonical issue, but are marked discovery-only and can never give Opus 5
detection credit.

The published manifest retains two matched scopes. **All models · 17 matched cells** compares Opus 5,
Fable 5.1, and Opus 5.5 only where all three have complete, non-salvaged evidence. **Current
controlled pair · 19 matched cells** compares every matched Fable 5.1 and Opus 5.5 cell. Every
matched attempt contributes recorded cost and success/failure evidence; finding credit requires a
complete, non-salvaged, credit-eligible cell. A third **Supplemental review protocol · 3 cells**
scope shows the new skill's canonical credit on the same pinned PRs. Its tool set differs from the
older model cohorts, which the new cohort report states beside its cross-model table. The Models
ranking keeps one row per model; review-and-fix-pr appears as an indented protocol detail beneath
Claude Opus 5.5 and does not affect model rankings or winner cards.

## Accounting

Each new attempt gets a working directory nobody else uses, and Claude Code files transcripts per
working directory, including the sessions a fan-out workflow spawns. The runner stores that final
attempt's transcript total in its result record. Reports for new cohorts use only this committed
`transcriptUsage`; they never rescan mutable local transcripts. The legacy report retains its
historical accounting behavior, including its hand-reconstructed attempt windows and lost spend.

## Dashboard data and metrics

The dashboard generator reads committed legacy inputs plus hash-verified complete cohorts under
`runs/`. New-cohort targets and tools come from each manifest snapshot, not current `state.json` or
`tools.json`. It never scans `work/`, logs, or local Claude transcripts. Recorded usage therefore
means the stored cell total. It prefers
`transcriptUsage` fields already present in a result, fills missing fields from `modelUsage`, then
`reportedUsage`/`reportedCostUsd`, and labels the provenance. Missing measurements remain
unavailable rather than becoming zero.

The embedded dashboard contract is schema v3. When `gold/index.json` exists, its validated published
snapshot is exposed as `modelComparison`, including canonical issues, exact source mappings and
evidence, declared cohorts, 17/19-cell scopes, and hash/pin provenance. Without an index the field is
`null`, so unsealed proposals never leak into the published comparison.

Quality measures are intentionally direct: extracted claims; real, false-positive, and unproven
judgements; in-scope, PR-introduced, and unique real findings; and precision (`real / (real + false
positive)`, excluding unproven). Efficiency views show real findings per dollar and cost/minutes per
real finding. A zero denominator is shown as N/A. Upstream review comments are context only and
never affect these measures.

The run explorer defaults to cohorts for the configured requested model. Choosing **All models**
exposes the full history. Its optional **Useful only** filter retains the old quality slice:
complete, at least one real finding, known token use, and no more than 25 million
tokens. Decision aggregates include successful zero-yield runs and display reliability separately.

The focused views share URL-persisted multi-select filters for skills, languages, and targets. A
single requested-model picker scopes every view and defaults to the configured
`claude-opus-5-5`; `#runs?model=all` exposes the full history. Observed runtime model stacks remain
visible as audit metadata but are not the cohort picker. Legacy model names are shown as
observed/inferred metadata, never as a model that the old runner requested. **Choose**
ranks configurable groupings, **Compare** evaluates two to five skills on their common target
cohort, **Insights** combines the economic and robustness charts, **Findings** browses distinct
judged issue IDs, and **Runs** audits the raw benchmark cells.

Skill economics group runs by skill plus exact model mix. Multi-model runs remain one group because
the artifacts attribute findings to the run, not to an individual model. The analysis shows
in-scope and all-scope real findings per dollar, cumulative severity yield (`>= high`, `>= medium`,
and `>= low`, excluding nits), unique-issue completeness, and false-positive rate. Completeness uses
the union of real judgement IDs found by every complete run on targets eligible for that
skill; false-positive rate is `false / (real + false)`, excluding unproven issues. The Pareto chart
shows cost versus completeness, and target robustness shows min/median/max completeness or
findings-per-dollar across eligible targets.

Analysis charts include every complete run with recorded cost, including zero-yield and
token-heavy runs. Skill, requested-model, language, and target filters narrow chart inputs.

The **Choose** view has URL-backed **Skills** and **Models** tabs. `#choose` remains the skill
leaderboard; `#choose?tab=models` opens the canonical model comparison. Historical
`#choose?group=model` links are treated as aliases for the Models tab, and model comparison omits
the single-model picker while retaining skill, language, and target filters. Its Discovered coverage
panel aggregates every completed run by model; individual cohort records remain in Runs.

Model completeness is the number of distinct canonical real issues credited to a model divided by
all canonical real issues on the selected targets; that denominator is fixed across the compared
models. Precision is canonical real divided by canonical real plus canonical false positives, with
unproven claims excluded. Value is canonical real findings per recorded benchmark dollar. Cost,
median cost, wall time, reliability, and evidence counts also come only from recorded benchmark
attempts—there is no vendor list-price lookup or runtime network request. Opus 5 is explicitly
historical/inferred because its requested model, effort, target pins, prompts, and accounting were
not all recorded; the dashboard links its warning to the controlled-rerun issue recorded in the
gold manifest.

`docs/index.html` and `docs/run-explorer.html` are committed so the dashboard works from a checkout
or static docs host. After any completed-cohort or dashboard change, run `make bench-publish`; the
test suite fails if any required cohort report or either tracked dashboard export has drifted. A
GitHub Actions workflow runs the same publisher, verifies it, and deploys `docs/` on pushes to
`main`.
