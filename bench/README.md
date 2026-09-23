# bench - the review-tool bake-off

Ten review tools and three real pull requests in three languages, published as a report and an
offline dashboard:

- [`docs/review-bakeoff.md`](../docs/review-bakeoff.md) is the narrative report.
- [`docs/index.html`](../docs/index.html) is a self-contained skill-selection workbench. It separates
  choosing, comparing, broad insights, findings, and raw-run inspection into focused views. Open it
  directly from disk; it has no server, framework, CDN, or network dependency. The legacy
  `docs/run-explorer.html` path contains the same export.

Every stage is a Node script behind a Makefile target, and every stage is resumable - a stage that
is interrupted, or a run the account's usage limit kills, is picked up on the next pass instead of
starting the matrix over.

```
make bench-prepare   # republish each upstream PR into a blinded private repo, fetch ground truth
make bench-run       # 26 tool x PR pairs, each in its own headless `claude -p` and its own cwd
make bench-extract   # turn each prose report into comparable JSON findings
make bench-judge     # merge across tools, verify against the code, classify
make bench-report    # render docs/review-bakeoff.md
make bench-dashboard # render docs/run-explorer.html
```

`ARGS` passes through: `make bench-run ARGS="--only ironweave --concurrency 2"`,
`make bench-judge ARGS="--only tidepool"`.

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
| `state.json` | what `prepare.js` published, written once and read by every later stage |
| `groundtruth/` | the upstream human review, for comparison after the fact |
| `results/` | one record per run: the report, exit status, wall time, token accounting |
| `findings/` | the same reports as JSON findings |
| `judgement/` | per PR, the merged and verified issue list |
| `analysis.md` | the hand-written half of the report; `report.js` appends it verbatim |
| `dashboard.js`, `dashboard/` | deterministic dashboard generator and browser assets |
| `work/`, `logs/` | working trees and run logs, not committed |

A tool that cannot finish inside one usage window is marked `"parked": true` in `tools.json`. It
stays in the matrix and in the report, and `run.js` skips it unless `--include-parked` is passed.

## Accounting

Each run gets a working directory nobody else uses, and Claude Code files transcripts per working
directory, so the directory is the run - including the sessions a fan-out workflow spawns, which is
where most of the tokens go. `lib/usage.js` sums each session's last `cost-state` record, and
`opts.since` narrows the sum to the attempt that actually produced the report, so a pair the usage
limit hit five times is not charged five times for one review.

## Dashboard data and metrics

The dashboard generator reads only committed `state.json`, `tools.json`, `results/`, `findings/`,
`judgement/`, and `groundtruth/` artifacts. Unlike the narrative report's historical accounting,
it never scans `work/`, logs, or local Claude transcripts. Recorded usage therefore means the
stored cell total. It prefers `transcriptUsage` fields already present in a result, fills missing
fields from `modelUsage`, then `reportedUsage`/`reportedCostUsd`, and labels the provenance. Missing
measurements remain unavailable rather than becoming zero.

Quality measures are intentionally direct: extracted claims; real, false-positive, and unproven
judgements; in-scope, PR-introduced, and unique real findings; and precision (`real / (real + false
positive)`, excluding unproven). Efficiency views show real findings per dollar and cost/minutes per
real finding. A zero denominator is shown as N/A. Upstream review comments are context only and
never affect these measures.

The run explorer shows every run by default. Its optional **Useful only** filter retains the old
view: complete or salvaged, at least one real finding, known token use, and no more than 25 million
tokens. Decision aggregates include successful zero-yield runs and display reliability separately.

The focused views share URL-persisted multi-select filters for skills, exact model stacks,
languages, and targets. **Choose** ranks configurable groupings, **Compare** evaluates two to five
skills on their common target cohort, **Insights** combines the economic and robustness charts,
**Findings** browses distinct judged issue IDs, and **Runs** audits the raw benchmark cells.

Skill economics group runs by skill plus exact model mix. Multi-model runs remain one group because
the artifacts attribute findings to the run, not to an individual model. The analysis shows
in-scope and all-scope real findings per dollar, cumulative severity yield (`>= high`, `>= medium`,
and `>= low`, excluding nits), unique-issue completeness, and false-positive rate. Completeness uses
the union of real judgement IDs found by every complete or salvaged run on targets eligible for that
skill; false-positive rate is `false / (real + false)`, excluding unproven issues. The Pareto chart
shows cost versus completeness, and target robustness shows min/median/max completeness or
findings-per-dollar across eligible targets.

Analysis charts include every complete or salvaged run with recorded cost, including zero-yield and
token-heavy runs. Skill, model-stack, language, and target filters narrow chart inputs.

`docs/index.html` and `docs/run-explorer.html` are committed so the dashboard works from a checkout
or static docs host. After any benchmark artifact changes, run `make bench-dashboard`; the test
suite fails if either tracked export has drifted. A GitHub Actions workflow regenerates, verifies,
and publishes `docs/` to GitHub Pages on pushes to `main`.
