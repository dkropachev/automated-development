# bench - the review-tool bake-off

Eight configured review tools and three real pull requests in three languages, published as a
report and an offline dashboard. The active matrix has 19 cells; parked
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
make bench-report    # verify the completed snapshot and render its cohort-specific report
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
dashboard accept new cohorts only through that hash-verified complete snapshot. New cohort reports
have cohort-specific filenames, so they cannot replace the legacy `docs/review-bakeoff.md`. `ARGS`
passes other flags through, for example `make bench-run ARGS="--only ironweave --concurrency 2"`.

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
| `runs/<runId>/manifest.json` | requested model and Claude version; pinned base/head commits; frozen target metadata, upstream ground truth, tool prompts/context, and expected cell matrix |
| `runs/<runId>/seal.json` | hashes of every expected result; extraction creates it and permanently closes the result set |
| `runs/<runId>/complete.json` | final seal, finding, and judgement hashes; required by reports and dashboard |
| `runs/<runId>/probe.json` | sanitized exact-model probe evidence and its quota reference |
| `runs/<runId>/quota.jsonl` | sanitized quota preflights and final snapshot; no raw account or UI data |
| `runs/<runId>/{results,findings,judgement}/` | append-only artifacts for one new model cohort |
| `runs/<runId>/recovered/` | audit-only transcript recoveries; never scored as results, so their cells must be rerun |
| `analysis.md` | hand-written analysis for the legacy narrative report |
| `dashboard.js`, `dashboard/` | deterministic dashboard generator and browser assets |
| `work/`, `logs/` | working trees and run logs, not committed |

A tool that cannot finish inside one usage window is marked `"parked": true` in `tools.json`. It
stays in the matrix and in the report, and `run.js` skips it unless `--include-parked` is passed.

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

`docs/index.html` and `docs/run-explorer.html` are committed so the dashboard works from a checkout
or static docs host. After any benchmark artifact changes, run `make bench-dashboard`; the test
suite fails if either tracked export has drifted. A GitHub Actions workflow regenerates, verifies,
and publishes `docs/` to GitHub Pages on pushes to `main`.
