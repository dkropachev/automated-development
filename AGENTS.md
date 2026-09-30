# Repository instructions

## Benchmark publication

Publishing a completed model cohort is end-to-end. Reporting must derive every cohort-local model
row from all hash-verified `complete.json` snapshots; never maintain a model allow-list. Run
`make bench-publish`, require `make bench-publish-check` to pass, then verify the model appears on
`#choose?tab=models` before opening or merging the PR. Pages must run the same publisher before
deploying so completed cohort artifacts are the source of every generated report and dashboard.

Keep cohort-local results distinct from the manually reviewed canonical gold comparison. Never
claim canonical inclusion without a new accepted and sealed gold snapshot.
