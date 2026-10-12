# Review-tool bake-off: 1 review configuration, 1 real PR

**Cohort:** `opus-5-5-review-and-fix-pr2-r66-tidepool-2026-10-12`. **Requested model:** Claude Opus 5.5 (`claude-opus-5-5`). Claude Code: `2.1.296 (Claude Code)`.

**Experimental cohort-local evidence:** `review-and-fix-pr2` is experimental and self-authored. These results are not canonical gold.

Every number below is produced by `bench/` in this repository and can be regenerated with
`make bench-report RUN=opus-5-5-review-and-fix-pr2-r66-tidepool-2026-10-12`.
This complete cohort contains 1 hash-pinned review cells.
Every run used its own headless `claude -p` process and
working directory so its token spend is attributable.

## What was reviewed

| Target | Language | Diff | Commits | PR under review | Upstream original |
|---|---|---:|---:|---|---|
| `tidepool` | Go | 18,335 B | 2 commits | https://github.com/dkropachev/tidepool/pull/1 | https://github.com/scylladb/gocql/pull/1094 |

Each PR was replayed in its own fork with its commits under a neutral author. The preparer rewrote
repository references in review material and denied `WebSearch`/`WebFetch`. The benchmark freezes
the review inputs because access to upstream comments would bias discovery.

## Cohort accounting

- Reviews: 1 calls, 1,464,939 tokens, $2.46, 3.3 minutes wall time.
- Extraction: 1 calls, 24 raw claims, $0.43.
- Judging: 1 calls, 24 merged issues (19 real, 5 false-positive, 0 unproven), $1.53.
- Total known cohort spend: $4.42. Discarded attempts are not included in immutable stage artifacts.

## Findings, by issue

One row per distinct issue claim, including false positives, merged across tools by a judge that had
the code in front of it. `✓` = that tool reported it.

| # | Issue | Verdict | Scope | New? | Sev | review-and-fix-pr2 |
|---|---|---|---|---|---|---|
| | **tidepool (Go)** | | | | |  |
| 1 | Non-positive inner vector dimensions floor vectorElemMinSize to 1, letting bound balloon… `marshal.go:1125` | real | in-scope | yes | medium | ✓ |
| 2 | Comment claims 32-bit wrap coverage, but the package itself never builds on 386 `marshal_vector_test.go:586` | real | in-scope | yes | low | ✓ |
| 3 | Test comment says no element describes zero bytes, but vector<float,0> is zero bytes `marshal_vector_test.go:813` | real | in-scope | yes | low | ✓ |
| 4 | Test comment's 'never fewer than N bytes' claim is broken by a zero-dim inner vector `marshal_vector_test.go:693` | real | in-scope | yes | low | ✓ |
| 5 | Test comment conflates one inner vector's byte size with the two-element fixture total `marshal_vector_test.go:772` | real | in-scope | yes | low | ✓ |
| 6 | Stale 'nil/empty and dim=0 fall through' comment no longer matches the new bound check… `marshal.go:1006` | real | in-scope | yes | low | ✓ |
| 7 | New comment overclaims every path below turns the payload into an allocation `marshal.go:987` | real | in-scope | yes | low | ✓ |
| 8 | Nested-vector 'no Go type' and bound errors render with no element type or dimension `marshal.go:1047` | real | in-scope | yes | low | ✓ |
| 9 | New bound check duplicates the pre-existing fast-path's Dimensions>0 && data!=nil… `marshal.go:998` | real | in-scope | yes | nit | ✓ |
| 10 | Both PR commits carry a forbidden Claude/Anthropic co-author trailer  | real | in-scope | yes | low | ✓ |
| 11 | PR body's referenced GitHub issue numbers (#1085, #1086, #1091, #1093, #1106) don't exist  | real | in-scope | yes | medium | ✓ |
| 12 | Commit 0276a66's body describes a one-byte-per-element design the commit doesn't ship  | real | in-scope | yes | low | ✓ |
| 13 | Commit 78891dd's subject names only the vector fix, not its wider helpers.go behavior…  | real | in-scope | yes | low | ✓ |
| 14 | vectorElemMinSize, vectorFixedElemSize and isVectorVariableLengthType must be kept… `marshal.go:1125` | real | in-scope | yes | nit | ✓ |
| 15 | vectorElemMinSize's classification cost grows with nesting depth squared `marshal.go:1125` | real | in-scope | yes | nit | ✓ |
| 16 | makeVectorType duplicates makeDoubleVectorType/makeFloat32VectorType with elem/elemName… `marshal_vector_test.go:557` | real | in-scope | yes | nit | ✓ |
| 17 | makeNestedVectorType's custom string doesn't match what the real parser produces for… `marshal_vector_test.go:570` | false-positive | out-of-scope | yes | nit | ✓ |
| 18 | wireVectorType's name doesn't mention it parses via framer.readTypeInfo `marshal_vector_test.go:860` | false-positive | out-of-scope | no | nit | ✓ |
| 19 | New tests use t.Parallel() while some existing tests in the file don't `marshal_vector_test.go` | false-positive | out-of-scope | no | nit | ✓ |
| 20 | Allocation regression test reads process-wide TotalAlloc, a theoretical noise source `marshal_vector_test.go:831` | false-positive | out-of-scope | no | nit | ✓ |
| 21 | No defect: marshal.go:978 precondition comment is still accurate `marshal.go:978` | false-positive | out-of-scope | no | nit | ✓ |
| 22 | helpers.go's '// basic type' comment now also covers the new named-custom-type fallback `helpers.go:279` | real | in-scope | yes | nit | ✓ |
| 23 | PR body's 'every new test fails against pristine code' is true only because pristine…  | real | in-scope | yes | low | ✓ |
| 24 | PR body's 'short/zero-length payload now errors' claim holds only for fixed-size elements  | real | in-scope | yes | nit | ✓ |

## Per tool

*Tokens* and *Cost* are the attempt that produced the report being scored.
New cohorts commit the final attempt's transcript usage only. Earlier retry spend is unavailable
and is shown as `-`; the report does not rescan mutable local transcripts to estimate it.

**Compare tools by cost, not by tokens.** The token figure is a raw sum of four classes that are
priced an order of magnitude apart, and 81.2% of it is cache reads, which bill at a tenth of
input; cache creation, another 15.9%, bills at 1.25x. Output - the tokens a reviewer
actually wrote - is 2.9% of the total. A tool that re-reads a large tree under a warm cache
therefore looks enormous and costs little. The cost column is not computed from these counts: it is
the per-session figure Claude Code itself bills, already priced per class. Thinking tokens
(18,822 across the matrix) are counted in the cost and reported by the model as part of
its output, so they are deliberately not added on top of it here.

| Tool | Runs | Raised | Real | False | Unproven | In scope | Pre-existing | Tokens | Cost | Wall | Lost to limits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Automated Development review-and-fix-pr2 | 1 | 24 | 19 | 5 | 0 | 19 | 0 | 1,464,939 | $2.46 | 3.3 min | - |

### Spend per run

| Tool | tidepool |
|---|---:|
| Automated Development review-and-fix-pr2 | 1,464,939 tok / $2.46 / 3.3 min |

**The 1 scored reviews' recorded attempts cost 1,464,939 tokens, $2.46.**
Retry attempts, judging, and extraction are not included.

### Raw claims before judging

What each run said before verification. Self-rejected claims are excluded, and the judge may merge several claims about one mechanism. The gap from *Raised* is not a miss count.

| Tool | tidepool |
|---|---:|
| Automated Development review-and-fix-pr2 | 24 |

## What the maintainers actually said

The upstream reviews, fetched at prepare time and never shown to any reviewer or to the judge.
Bot comments are dropped, and so are the PR author's own replies, which are answers rather than
findings.

Read these as context, not as a scoreboard. The PRs were reviewed at their pinned revisions,
after some upstream comments may already have been addressed. Not repeating a comment is not
automatically a miss; the useful question is whether a concern still applies to the pinned code.

**`tidepool`** - https://github.com/scylladb/gocql/pull/1094 - 0 inline review comments, 0 thread comments.

No human review comments upstream.

### Runs that did not complete

None - every run in the matrix returned a report.

## Analysis

No hand-written analysis is attached to this cohort. `bench/analysis.md` describes only the immutable `legacy` results.
