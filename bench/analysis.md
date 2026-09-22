## Analysis

### Nobody agrees with anybody

148 distinct issues came out of 32 reviews, and **68 of them were raised by exactly one tool** — 55
of those 68 survived verification. Only 40 issues were raised by three or more tools. Two reviewers
picked at random will mostly hand you disjoint lists, so "run one good reviewer" and "run several
and take the union" are genuinely different products, and the union costs what the sum of its parts
costs.

Consensus is also not a truth signal. Of the 40 issues with three or more reporters, 4 are false
positives, and the worst of them had **eight tools agreeing on a double-decrement of
`total_connections` that does not happen**. The single most-reported issue in the matrix (10 of 11
tools) is real, but the second most-reported and the third are one real leak and one confident
fiction. A claim's weight comes from reading the code, which is what the judge did and what a
reviewer downstream of these tools has to do too.

### The yield is overwhelmingly cosmetic

Of 129 verified-real issues: 13 high, 15 medium, 62 low, 39 nit. No tool found more than three
high-severity defects that this PR itself introduced — the column that would justify the spend is
the emptiest one in the report. What the tools are reliably good at is the layer above the bug:
missing test coverage for a branch the PR added, a comment that no longer matches the code, an
error message that names the wrong type. That is worth something, and it is not what "found a bug"
means.

The clearest example is the C++ PR. Six tools independently said `stream_close()` now parks
`write_buf.close()`, `stop()` and `abort()` behind an unbounded queue drain, which is the real
remaining risk in that change and is graded high. Seven said the new regression test never asserts
that the send was actually refused — also true, also the kind of thing a human reviewer says. But
the two things the upstream maintainers caught on the first revision, that the barrier promise was
unnecessary and that `_stream_closing` was redundant with the two flags already there, were caught
by nobody, in any of the 11 reviews of that PR.

### Price

The 32 scored reviews cost $310.24. Getting them cost $639.97, because every attempt the account's
usage limit cut off mid-review was thrown away and retried from scratch. On top of that, judging
cost $14.00, extraction $4.87, and the orchestration session that drove all of it $99.60 — about
$758 end to end for three pull requests.

Two tools dominate that bill, and both for the same reason: they are fan-out workflows, not single
reviews. `ce-code-review` spent $53.88 on reviews and lost $54.12 to interrupted attempts.
`review-and-fix-pr` spent $60.16 and lost $52.93, and its `detailedReview` variant spent $95.56 —
one run of it on the C++ PR took 99 minutes and 27M tokens. Against that, `pr-review-toolkit`
raised 69 issues, 66 of them real, for $27.88 and no losses at all, and it is the only tool in the
matrix whose false-positive rate rounds to 3%.

`c-review` never finished. Its Workflow needs more tokens than one usage window holds, so all 28
attempts were cut off mid-fan-out, $186.41 went into that one cell, and no report ever came out of
it. It is parked in `tools.json` rather than deleted: the number is the finding.

At the other end, `/scoped-code-review` without `--detailed` raised **three** issues across three
PRs for $10.03, one of which was false. Cheap, and effectively silent; `--detailed` turns it into an
ordinary reviewer (16 real issues for $11.15) and is the variant worth having.

`review-and-fix-pr` ran at its default `mode: 'auto'` in all six runs, so it picked by diff size:
the Rust PR (26.2KB) got the chunked parallel shape, the Go and C++ PRs (18.3KB and 15.9KB) got the
whole-PR shape. That is not a single-agent price either - the whole-PR shape still runs its reviewer
and fixer turns as separate agents, 2 to 5 of them per run by the runs' own count, and 4 to 11
subagent transcripts land on disk per scored attempt. Only one of the three PRs was large enough to
exercise chunking, and the other two cost what they cost without it.

### False positives cluster in the confident tools

`mattpocock-review` (23%), `builtin-code-review` (23%) and `tob-rust-review` (25%) are the three
most likely to be wrong, and they are wrong in the same way: a plausible mechanism asserted without
checking the call sites that would have to exist for it to fire. `tob-diff-review` made 17 claims
and none of them were false — the only clean sheet in the matrix — but it also made the fewest
claims per dollar of any non-trivial tool.

### What the harness got wrong, and what it cost

- **Blinding is not airtight.** Every `owner/repo` reference was rewritten and `WebSearch`/`WebFetch`
  were denied, so no run could reach the upstream PR. Product names survive in the source itself
  ("seastar", "gocql", "scylla") and cannot be scrubbed without changing the code under review, so a
  determined reviewer could have guessed the project. Nothing in the transcripts suggests one did.
- **The replayed PR bodies and commits kept the upstream authors' Claude attribution trailers**, and
  five tools dutifully reported them as a policy violation (two separate issues in the table). They
  are real findings about the input and tell you nothing about the reviewer, so read those two rows
  as harness noise.
- **A workflow-based skill ends its headless turn while its own Workflow is still running**, and
  returns a stub. That silently cost the first `c-review` and the first two `review-and-fix-pr` runs
  about $8.50 before it was caught; every tool prompt now carries an instruction to keep the turn
  alive until the workflow result lands. Anything that shells out to a fan-out workflow needs that
  instruction or the measurement is a stub.
- **`/pr-review-fix` was renamed to `review-and-fix-pr` mid-run.** The runs made under the old name
  actually executed `scoped-code-review`, so they are reported under that name (`SCR`, `SCR-D`), and
  `review-and-fix-pr` (`RAFP`, `RAFP-D`) was run separately. `tools.json` records this.
- **Four runs were recovered from their transcripts** after a `pkill` pattern matched the runner
  itself. They have no recorded wall time, so their attempt windows were reconstructed by hand from
  session start times and marked `wallMsDerived`.
- **The judge is lenient.** "Real" means the code does what the finding says and that is a defect —
  it does not mean anybody would fix it. 39 of the 129 real issues are nits. The verdict to trust in
  the table is `false-positive`, which required the judge to show the code contradicting the claim.

### If you keep one

`pr-review-toolkit` — best yield per dollar, lowest false-positive rate, 17 issues nobody else
found. Add `tob-diff-review` when the diff is what matters and a wrong claim is expensive. Add
`ce-code-review` only when you are willing to pay ten times as much for 18 more issues nobody else
saw, and to lose half the spend to interrupted attempts.
