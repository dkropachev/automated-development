# `review-and-fix-pr` paired Opus 5.5 review

This is a cohort-local experiment on the same pinned Ironweave, Quillstone, and Tidepool PRs as
the [Matt Pocock Opus 5.5 bake-off](review-bakeoff-opus-5-5-2026-09-29.md). The PR revisions and
model ID match. The older Matt run used Claude Code 2.1.284; these runs used 2.1.287. All new
reviews were read-only. They used OpenAI Codex `gpt-5.6-sol` for candidate adjudication and the
benchmark's Sonnet judge for independent, cohort-local classification. No canonical gold was
changed.

| Tool/cohort | Completed | Extracted claims | Locally judged real / false / unproven | Final Codex-confirmed | Claude review cost | Codex tokens | Sum of review wall time |
|---|---:|---:|---:|---:|---:|---:|---:|
| Matt Pocock, [Opus 5.5](review-bakeoff-opus-5-5-2026-09-29.md) | 3/3 | 34 | 31 / 2 / 1 | n/a | $6.07 | n/a | 10.5 min |
| Anthropic `pr-review-toolkit`, [Opus 5.5](review-bakeoff-opus-5-5-2026-09-29.md) | 3/3 | 18 | 17 / 1 / 0 | n/a | $2.33 | n/a | 7.7 min |
| Unchanged skill, [baseline](review-bakeoff-rafp-baseline-2026-10-04.md) | 3/3 | 30 | 24 / 4 / 1 | 22 | $27.89 | 105,688 | 42.8 min |
| Shared evidence path, explicit requirements/rules/code smells, [coverage revision](review-bakeoff-rafp-coverage-2026-10-04.md) | 3/3 | 41 | 33 / 7 / 1 | 30 | $30.96 | 111,185 | 48.7 min |
| Broader maintenance admission, discarded local pilot | 3/3 reviews; 2/3 judgments | 38 | not scored | 29 | $30.22 | 105,875 | 47.9 min |

The dollar column is Claude's recorded reviewer charge. Codex receipts report tokens but no USD
cost, so a combined reviewer dollar cost cannot be calculated from the artifacts. Sonnet extraction
and judgment are separate benchmark overhead: $4.75 for the unchanged cohort and $4.34 for the
coverage revision. Wall times above are sums of individual review calls, matching the bake-off's
per-tool convention, even where cells ran concurrently.

The local judge scores **every extracted claim**. It can extract claims from prose headed
"Rejected" or "screened", then classify them as real or false; that does not mean the reviewer
presented them as final findings. The coverage revision's 41 extracted claims include 11 marked
`selfRejected`, versus 7 in the unchanged cohort and 1 in Matt's cohort. Compare the final Codex
counts alongside the raw judged totals. Neither measure is canonical completeness credit.

## Three-way finding overlap

This comparison uses **real findings actually presented by each tool**: 31 for Matt Pocock, 17 for
Anthropic, and the retained skill's 30 Codex-confirmed findings that the cohort judge also marked
real. The retained skill's three additional locally judged real rows came from prose it explicitly
rejected, so they are excluded here. Findings are aligned manually by trigger and faulty
mechanism, not merely by file or proposed fix. Matt and Anthropic share the original Opus 5.5
[judgment IDs](../bench/runs/opus-5-5-2026-09-29/judgement/); `R/I*` below refers to the retained
skill's [coverage-cohort judgments](../bench/runs/rafp-coverage-2026-10-04/judgement/).
"Unique" means unique **among these three tools**, not among every tool in the bake-off. Scope
labels are retained in the source judgments; Ironweave's API-level guard is marked out of scope
in the original judgment and in scope in the retained skill's judgment.

| Reported by | Ironweave | Quillstone | Tidepool | Total |
|---|---:|---:|---:|---:|
| All three | 3 | 2 | 0 | **5** |
| Matt + Anthropic only | 2 | 0 | 0 | **2** |
| Matt + retained skill only | 0 | 3 | 2 | **5** |
| Anthropic + retained skill only | 1 | 1 | 0 | **2** |
| Matt only | 9 | 6 | 4 | **19** |
| Anthropic only | 2 | 2 | 4 | **8** |
| Retained skill only | 5 | 7 | 6 | **18** |

**All three found the same five issues:** Ironweave's test does not assert `closed_error` (I1),
its doc says shutdown happens only after both halves close (I4), and its compressor factory uses
`const_cast` against the local `mutable` precedent (I7); Quillstone can permanently lose a node
after repeated failed `USE` (I1) and downgrades the failure log from `warn!` to `debug!` (I3).

The pairwise overlaps account for nine more issues:

- **Matt + Anthropic:** Ironweave's inaccurate queue-wait comment (I6) and broken PR issue links
  (I9).
- **Matt + retained:** Quillstone's missing `setup_tracing()` (I6), divergent error-message text
  (I10), and unmentioned metrics changes (I15); Tidepool's duplicated vector test helper (I20)
  and overstated claim that every new test fails on base (I21).
- **Anthropic + retained:** Ironweave's missing `SEASTAR_API_LEVEL` guard (original I3, retained
  R/I6); Quillstone's test that never drives the real failed-`USE` refill loop (original I5,
  retained R/I7).

The unique findings are listed below with their target's judgment IDs. Each item is one aligned
issue, even where its title is shortened here.

| Tool only | Ironweave | Quillstone | Tidepool |
|---|---|---|---|
| **Matt (19)** | I14 undocumented drain wait; I15 extra lifecycle flag; I16 copied socket wrappers; I17 duplicate doxygen; I18 unclosed-sink assertion understated; I19 overlong doc line; I20 unclear helper names; I21 vector-reference invalidation; I24 unbounded wait/early failure | I7 no same-commit metrics test; I8 hand-built `PoolRefiller`; I9 copied proxy rules; I12 bundled changes; I13 sharder/port update ordering; I14 hung `USE` | I16 missing changelog; I17 commit trailers; I18 duplicated adjacent guard; I19 third element-type classifier |
| **Anthropic (8)** | I2 server-side hook path untested; I8 PR attribution line | I4 excess shard-aware connection metric; I22 metrics test polling/decrement | I1 nonexistent PR issue links; I2 stale empty-payload comment; I3 32-bit test-coverage claim; I4 PR attribution line |
| **Retained skill (18)** | R/I1 queue drain untested; R/I3 deserialization-error doc; R/I5 stale test header; R/I7 exceptional-future comment; R/I8 poller comment | R/I2 reconnect churn; R/I3 stale-keyspace error; R/I6 per-commit clippy failure; R/I8 reshard excess term untested; R/I9 `is_filling()` guard untested; R/I10 repeated decrement/clear; R/I12 moved comment | R/I1 quadratic vector nesting work; R/I2 saturation branch untested; R/I3 float length check untested; R/I5 inaccurate allocation comment; R/I6 wrong nested-vector byte count; R/I7 stale minimum-size rationale |

## Where Matt Pocock findings were lost in the unchanged skill

The IDs below refer to the 2026-09-29 [judgment files](../bench/runs/opus-5-5-2026-09-29/judgement/).
Only Matt-reported **real** issues are listed. "Admission" means a lane inspected the lead but put
it in `checked_nonissues`; "discovery" means neither the lane final receipts nor the Codex input
contained that defect; "adjudication" means Codex received it but rejected it. "Reported" means
the unchanged skill carried the same mechanism into its report; a combined Matt issue can have a
separate missed subclaim. These classifications come from the baseline subagent final receipts,
Codex input, and final report. The transcript receipts are local audit evidence, while the sealed
cohort results and Codex proof are the durable benchmark artifacts.

| Target | Matt real issue | Baseline stage | Observation |
|---|---|---|---|
| Ironweave | I1 test never asserts refusal | Reported | Same test mechanism. |
| Ironweave | I4 shutdown-only-after-both-halves doc | Reported | Same literal claim. |
| Ironweave | I6 queue wait comment | Admission | Standards checked the comment as a nonissue. |
| Ironweave | I7 `const_cast` style | Reported | Same local precedent. |
| Ironweave | I9 broken PR issue references | Discovery | No corresponding candidate. |
| Ironweave | I14 undocumented drain latency | Admission | Contracts and root-cause lanes checked the possible wait but did not admit it. |
| Ironweave | I15 extra lifecycle state | Admission | Standards checked `_stream_closing` state proliferation. |
| Ironweave | I16 copied socket wrappers | Admission | Standards checked the new wrappers against `loopback_socket.hh`. |
| Ironweave | I17 duplicate doxygen comments | Admission | Standards checked the old comments left beside new blocks. |
| Ironweave | I18 unclosed sink assertion understated | Admission | Standards checked the wording and considered it adequate. |
| Ironweave | I19 overlong doc line (out of scope) | Admission | Gap audit checked line length without a rule. |
| Ironweave | I20 unclear helper names | Discovery | No corresponding candidate. |
| Ironweave | I21 vector reference invalidation | Discovery | No corresponding candidate. |
| Ironweave | I24 unbounded wait and early-failure abort | Partly reported | Early-failure abort was reported; the unbounded wait was checked and screened. |
| Quillstone | I1 permanent failed-USE pool regression | Reported | Same trigger and effect. |
| Quillstone | I3 warning downgraded to debug | Reported | Same logging change. |
| Quillstone | I6 tests omit `setup_tracing()` | Reported | Same rule. |
| Quillstone | I7 metrics commit has no same-commit test | Discovery | The candidate about a warning-clean build is different. |
| Quillstone | I8 hand-built `PoolRefiller` | Adjudication | Included in combined duplicate-test-helper candidate rejected by Codex. |
| Quillstone | I9 copied proxy rules | Adjudication | Included in the same rejected candidate. |
| Quillstone | I10 error message pattern | Discovery | Recovered by the coverage revision. |
| Quillstone | I12 bundled unrelated changes | Discovery | No equivalent candidate. |
| Quillstone | I13 sharder/port update ordering | Discovery | The stale-keyspace candidate has a different trigger. |
| Quillstone | I14 hung USE (out of scope) | Discovery | Not a change caused by this PR. |
| Quillstone | I15 metrics work omitted from PR body | Reported | Same description mismatch. |
| Tidepool | I16 missing changelog (out of scope) | Admission | Standards treated the rule as inapplicable because the file was removed at base. |
| Tidepool | I17 commit trailer rule (out of scope) | Admission | Standards favored current local history over the old CONTRIBUTING text. |
| Tidepool | I18 duplicated adjacent guard | Discovery | Recovered by the later admission revision. |
| Tidepool | I19 third element-type classifier | Admission | Standards called it taste-only. |
| Tidepool | I20 duplicated vector-type test helper | Discovery | Recovered by the coverage revision. |
| Tidepool | I21 PR's base-test claim overstates proof | Discovery | Recovered by the coverage revision. |

No baseline loss was traced to deduplication, and none of its three cells stopped incomplete. The
largest repeatable gap was leads that lanes examined but classified as nonissues before Codex.
The coverage revision also added distinct real test, comment, and performance findings that Matt's
review did not report. It improved local real findings by nine for $3.07 more Claude review cost
and 5.9 more review minutes, so that change was kept. Its total reviewer charge is still over five
times Matt's before Codex USD cost, and its review time is over four times Matt's.

## Protocol decision and audit limits

The retained change makes requirements, repository rules, and concrete maintenance risks explicit
in the spec and standards work; it gives every lane one shared exact evidence file instead of
repeated prompt copies. A runner-owned discovery ledger records each raw lane candidate's source,
claim, admission/merge/screen disposition, reason, and canonical candidate ID. The result embeds
that ledger and validates every Claude-origin Codex candidate against it. A later ledger version
requires substantive checked-nonissue reasons. The runner also snapshots final subagent receipts
into new results so observations omitted from a compact ledger remain hash-bound and inspectable.

The older coverage cohort's compact ledger does not embed every checked-nonissue observation.
Its original lane transcripts remain local, but are not part of its immutable result. The new
runner receipt capture was tested against a real Tidepool transcript (10 final receipts, 74 checked
observations) and with synthetic transcript tests; it was added after the measured review calls.
Likewise, the stricter ledger version was validated live on the admission cohort but its cost
effect cannot be separated from that cohort's admission-rule experiment.

The broader admission rule was discarded. It recovered the duplicated-guard Tidepool lead and the
split-state Ironweave lead, but the three reviews yielded 29 Codex-confirmed claims versus 30 in
the coverage revision at nearly the same cost. The two completed local judgments produced 17 real
claims versus 25 for the same two targets in the coverage revision. A Claude session limit stopped
the final Tidepool judgment; the local pilot has no `complete.json`, is not published as a cohort,
and is not used for the scored comparison. Its artifacts were archived under ignored
`bench/work/pilots/` for local audit. The retained protocol is the coverage revision plus the
versioned ledger and runner-owned receipt capture.
The Quillstone admission judge also called the persistent failed-USE regression false while the
baseline and coverage judges called the same mechanism real. This evaluator variation is another
reason not to treat the pilot's partial judged total as a precise effect estimate.
