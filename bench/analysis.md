## Analysis

### Nobody agrees with anybody

137 distinct issues came out of 20 reviews, and **71 of them were raised by exactly one tool** — 58
of those 71 survived verification. Only 31 issues were raised by three or more tools. Two reviewers
picked at random will mostly hand you disjoint lists, so "run one good reviewer" and "run several
and take the union" are genuinely different products, and the union costs what the sum of its parts
costs.

Consensus is also not a truth signal. Of the 31 issues with three or more reporters, 3 are false
positives, and the worst of them had **four tools agreeing on a double-decrement of
`total_connections` that does not happen**. The most-reported issue in the matrix (6 of 8 tools) is
real, but a claim's weight comes from reading the code, which is what the judge did and what a
reviewer downstream of these tools has to do too.

### The yield is overwhelmingly cosmetic

Of 118 verified-real issues: 10 high, 14 medium, 58 low, 36 nit. Only **three** high-severity
defects in the whole matrix were introduced by the PR under review, and no tool found more than
three of them — the column that would justify the spend is the emptiest one in the report. What the
tools are reliably good at is the layer above the bug: missing test coverage for a branch the PR
added, a comment that no longer matches the code, an error message that names the wrong type. That
is worth something, and it is not what "found a bug" means.

The clearest example is the C++ PR. Five tools independently said `stream_close()` now parks
`write_buf.close()`, `stop()` and `abort()` behind an unbounded queue drain, which is the real
remaining risk in that change and is graded high. Five said the new regression test never asserts
that the send was actually refused — also true, also the kind of thing a human reviewer says. But
the two things the upstream maintainers caught on the first revision, that the barrier promise was
unnecessary and that `_stream_closing` was redundant with the two flags already there, were caught
by nobody, in any of the 7 reviews of that PR.

### Price

The 20 scored reviews cost $133.34. Getting them cost $400.51, because every attempt the account's
usage limit cut off mid-review was thrown away and retried from scratch. The landing page counts
that lost spend in its price ratios; the detailed table splits successful and interrupted attempts.

Two fan-out tools dominate the bill. `ce-code-review` spent $53.88 on completed reviews and lost
$54.12 to interrupted attempts. `c-review` spent $186.41 without producing a report. Against that,
`pr-review-toolkit` raised 69 issues, 66 of them real, for $27.88 and no losses at all, and it is the
only tool in the matrix whose false-positive rate rounds to 3%. `requesting-code-review` found 40
real issues for $13.26 including interrupted spend, the best findings-per-dollar result.

`c-review` never finished. Its Workflow needs more tokens than one usage window holds, so all 28
attempts were cut off mid-fan-out, $186.41 went into that one cell, and no report ever came out of
it. It is parked in `tools.json` rather than deleted: the number is the finding.

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
  several tools dutifully reported them as a policy violation (two separate issues in the table).
  They are real findings about the input and tell you nothing about the reviewer, so read those two
  rows as harness noise.
- **A workflow-based skill ends its headless turn while its own Workflow is still running**, and
  returns a stub. This affected an early `c-review` attempt before it was caught; every tool prompt
  now carries an instruction to keep the turn alive until the workflow result lands. Anything that
  shells out to a fan-out workflow needs that instruction or the measurement is a stub.
- **Two runs were recovered from their transcripts** after a `pkill` pattern matched the runner
  itself. They have no recorded wall time, so their attempt windows were reconstructed by hand from
  session start times and marked `wallMsDerived`.
- **The judge is lenient.** "Real" means the code does what the finding says and that is a defect —
  it does not mean anybody would fix it. 36 of the 118 real issues are nits. The verdict to trust in
  the table is `false-positive`, which required the judge to show the code contradicting the claim.

### If you keep one

`requesting-code-review` gives the most verified findings per attempted dollar. `pr-review-toolkit`
gives the broadest completeness and the lowest false-positive rate, with 22 issues nobody else
found. Add `tob-diff-review` when the diff is what matters and a wrong claim is expensive. Add
`ce-code-review` only when major-issue coverage matters enough to justify the higher and less
predictable spend.
