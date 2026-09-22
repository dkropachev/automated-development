# bench - the review-tool bake-off

Twelve review tools, three real pull requests in three languages, one report:
[`docs/review-bakeoff.md`](../docs/review-bakeoff.md).

Every stage is a Node script behind a Makefile target, and every stage is resumable - a stage that
is interrupted, or a run the account's usage limit kills, is picked up on the next pass instead of
starting the matrix over.

```
make bench-prepare   # republish each upstream PR into a blinded private repo, fetch ground truth
make bench-run       # 32 tool x PR pairs, each in its own headless `claude -p` and its own cwd
make bench-extract   # turn each prose report into comparable JSON findings
make bench-judge     # merge across tools, verify against the code, classify
make bench-report    # render docs/review-bakeoff.md
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
| `work/`, `logs/` | working trees and run logs, not committed |

A tool that cannot finish inside one usage window is marked `"parked": true` in `tools.json`. It
stays in the matrix and in the report, and `run.js` skips it unless `--include-parked` is passed.

## Accounting

Each run gets a working directory nobody else uses, and Claude Code files transcripts per working
directory, so the directory is the run - including the sessions a fan-out workflow spawns, which is
where most of the tokens go. `lib/usage.js` sums each session's last `cost-state` record, and
`opts.since` narrows the sum to the attempt that actually produced the report, so a pair the usage
limit hit five times is not charged five times for one review.
