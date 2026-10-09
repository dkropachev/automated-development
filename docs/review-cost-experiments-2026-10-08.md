# Review cost experiments, 2026-10-08

The goal is to lower the **review-only** cost of `review-and-fix-pr` without losing its
general PR review coverage. Cohort-local judgments are separate from the manually accepted
canonical gold snapshot.

## Six Sonnet 5.5 discovery passes: rejected

The unchanged six-pass protocol was run with `claude-sonnet-5-5` on the pinned Ironweave PR
in the completed, hash-verified `rafp-six-pass-sonnet-2026-10-08` cohort. This changed only
the discovery and outer orchestration model. Codex clustering and adjudication still ran.
The matched Opus 5.5 cell is in `rafp-six-pass-parallel-broker-2026-10-08`.

| Ironweave review | Claude review cost | Six pass cost | Codex confirmed claims | Cohort-judged real issues |
|---|---:|---:|---:|---:|
| Opus 5.5 | $5.35 | $4.42 | 19 | 12 |
| Sonnet 5.5 | $1.80 | $1.46 | 13 | 8 |

The lower cost did not preserve coverage on this PR. The Sonnet review missed distinct
Opus findings about deserialization errors contradicting the source documentation, the
new queue-drain wait blocking under peer backpressure, two inaccurate queue/error
comments, and the public compressor-factory contract. It found other issues, including
commit sign-off and attribution violations, so the counts are not a simple subset.
The comparison is one PR, not a general model ranking. It is sufficient to reject a
default model swap under the requirement to keep the current quality.

The six Opus passes each contributed at least one uniquely sourced confirmed lead
across Ironweave, Quillstone, and Tidepool. Dropping a pass without replacing its
coverage is therefore a poor next candidate.

## Frozen patch in every discovery prompt: rejected

Each of the six passes received the runner's already frozen canonical patch before
using tools. This was a language-neutral way to reduce repeated diff discovery.
The completed `rafp-six-pass-frozen-patch-2026-10-08` cohort measured the pinned
Quillstone Rust PR against the same-model, same-protocol Opus cell above. A later
token-focused retest used the same prompt on the pinned Ironweave C++ PR in the
completed `rafp-frozen-patch-tokens-ironweave-2026-10-08` cohort.

| Quillstone review | Claude review cost | Six pass cost | Codex confirmed claims | Cohort-judged real issues | In-scope real |
|---|---:|---:|---:|---:|---:|
| Prior Opus 5.5 | $5.67 | $5.04 | 10 | 8 | 7 |
| Frozen patch Opus 5.5 | $5.32 | $4.64 | 13 | 10 | 8 |

| Ironweave review | Claude tokens | Claude review cost | Codex confirmed | Cohort-judged real |
|---|---:|---:|---:|---:|
| Prior Opus 5.5 | 3,530,403 | $5.35 | 19 | 12 |
| Frozen patch Opus 5.5 | 2,359,207 | $4.70 | 8 | 8 |

The trial saved 6% and found additional real issues, but lost four distinct prior
findings, including a stale-keyspace check and factual comments about the changed
connection path. Two of its ten judged real issues were out of scope. In Ironweave,
tokens fell 33% and cost fell 12%, but the review lost four distinct judged real
issues, including the compressor contract and stated validation gap. The prompt
change was reverted; both completed cohorts remain available for inspection.

## Low effort for all six Opus passes: rejected before adjudication

An incomplete Tidepool pilot used `--effort low` for every discovery pass while
keeping all six prompts. Its pass receipts recorded $1.88 of Claude spend versus
$4.70 for the prior Tidepool pass set, a 60% reduction at this stage. The pilot
produced 18 clustered candidates. The prior completed review had 18 confirmed
claims, but the pilot's discovery input lacked the zero-dimension nested-vector
defect and several related behavior changes. These losses were visible before
adjudication and cannot be recovered by merely judging the existing candidates.

The first Codex wave also returned judgments for 18 visible candidates when only
12 were requested, so the pilot has no complete result or cohort judgment. Its
run files are archived under ignored
`bench/work/pilots/rafp-incomplete-2026-10-08/rafp-six-pass-low-effort-2026-10-08/`
for audit. No total-review cost or
judged-quality claim is made from that failed run. Low effort was reverted.

## One call for all six lenses: rejected

A direct read-only pilot concatenated the six language-neutral review instructions
into one structured discovery call on Tidepool. It used the same frozen PR evidence
as the completed baseline. This was a screening pilot, not a publishable cohort;
it did not change the skill's six-pass coverage contract. The local receipts are
under ignored `bench/work/pilots/rafp-consolidated-2026-10-08/`.

| Discovery design | Claude discovery cost | Raw leads | Codex confirmed |
|---|---:|---:|---:|
| Six Opus passes (completed baseline) | $4.70 | 37 | 18 |
| One Opus 5.5 call | $1.18 | 15 | 7 |
| One Sonnet 5.5 call | $0.25 | 10 | Not run |

The one-call Opus review found several important mechanisms, but Codex confirmed
only seven of its leads and treated the zero-byte nested-vector issue as a
suggestion. The six-pass baseline confirmed eighteen leads, including that defect.
The Sonnet call's raw leads omitted the same zero-byte defect and other baseline
issues, so adjudicating it would not establish comparable coverage. Both designs
were rejected without changing the review protocol.

The first Opus pilot adjudication failed because Codex returned judgments for
context candidates outside the requested twelve-candidate wave. A narrow validator
fix now checks those extra rows against the known candidate IDs, preserves the raw
trace, and discards their judgments so they are still judged in their assigned wave.
Unknown IDs and duplicates still fail. The saved failed trace reproduced the error;
the corrected live replay completed in two invocations with all sixteen leads
resolved. This fix prevents that class of wasted review attempt and is retained.

## Hybrid pass effort: rejected

A three-target pilot, `rafp-six-pass-hybrid-effort-2026-10-08`, froze the same six
Opus passes with medium effort for holistic behavior, specification/tests, and
maintenance, and low effort for standards, contracts, and API/commits. Only Tidepool
was run. The trial is incomplete, archived under ignored
`bench/work/pilots/rafp-incomplete-2026-10-08/`, and is not a published cohort comparison.

| Tidepool review | Six pass cost | Total Claude review cost | Codex confirmed |
|---|---:|---:|---:|
| Prior six-pass protocol | $4.70 | $5.39 | 18 |
| Hybrid effort | $3.81 | $4.35 | 12 |

The 19% cost reduction lost important confirmed mechanisms, including the nested
nil-SubType panic and the broad unknown-type behavior change. The original effort
settings were restored without spending on the remaining two PRs.

## Cost-accounting limit

The dashboard's review dollar figure is Claude's recorded charge; the Codex CLI
receipts contain tokens but no billed USD amount. At the [official GPT-5.6 Sol API
text rates](https://developers.openai.com/api/docs/models/gpt-5.6-sol) available on
2026-10-08 ($4 per million input, $0.40 cached input, $20 output), Tidepool's
baseline Codex receipt is about **$0.91 API-equivalent** and the hybrid trial's is
about **$0.73 API-equivalent**. These are estimates, not observed CLI charges or
dashboard costs. Moving review work from Claude to Codex solely to lower the
dashboard figure would not establish a cheaper end-to-end review.

## Mixed Opus/Sonnet passes: rejected

A counterfactual pilot combined the saved Ironweave pass outputs from the same
frozen PR: Opus for holistic behavior, specification/tests, and maintenance;
Sonnet for standards, contracts, and API/commits. The normal semantic clustering
and fixed-point Codex adjudicator then processed the mixed candidates. It was
not launched as a skill or admitted as a benchmark cohort; the pilot receipt is
under ignored `bench/work/pilots/rafp-mixed-model-2026-10-08/`.

| Ironweave discovery | Six pass Claude cost | Clustered candidates | Codex confirmed |
|---|---:|---:|---:|
| All Opus baseline | $4.42 | 43 | 19 |
| Mixed Opus/Sonnet | $3.17 | 32 | 10 |

The mixed pass set saved $1.25 in discovery, but lost confirmed mechanisms such
as the new queue-drain wait's backpressure risk and the PR's incomplete stated
validation. It was rejected before changing the skill or model attribution.
The completed all-Sonnet Ironweave review already cost $1.80 and found fewer
judged real issues than the all-Opus baseline; substituting costlier Opus passes
cannot bring this six-call design down to $0.78 on that PR.

## Decision

The last completed, quality-retaining six-pass cohort costs $16.42 across three
PRs, or **$5.47 per review** in recorded Claude spend. No tested steady-state
change preserved its finding coverage. The tested cost levers were a cheaper
reviewer model, preloading frozen evidence, lower reasoning effort, fewer model
calls, and mixed reviewer models. The only retained change prevents a known
Codex wave-format error from wasting an otherwise completed discovery attempt.

The $0.78 dashboard target was not reached. Further variants within these same
levers either have a measured coverage failure or cannot plausibly close the
remaining price gap without removing review work or shifting unpriced work to
Codex. This concludes the current search; a new model with independently
measured equal recall or a different verified review architecture would be new
evidence for another round.

## Batched read-only inspections: rejected

A later token-focused Tidepool trial told all six passes to batch independent
read-only searches and file reads while permitting unlimited further inspection.
The complete Claude/Codex review ran under
`rafp-batched-reads-tidepool-2026-10-08`; its unjudged cohort files were archived
under ignored `bench/work/pilots/rafp-incomplete-2026-10-08/` rather than
published as a completed cohort.

| Tidepool review | Claude tokens | Claude cost | Codex confirmed |
|---|---:|---:|---:|
| Prior six-pass protocol | 4,691,424 | $5.39 | 18 |
| Batched-read prompt | 5,201,304 | $5.88 | 12 |

The prompt increased tokens by 11% and lost six confirmed claims. It was
reverted. In the baseline pass transcripts, 96 tool calls returned about 327 KB
of text across six passes; the multi-million-token count is dominated by cached
context reread across model turns, so fewer tool-output bytes alone do not
establish a better review.

## Expanded contextual diff and frozen evidence: rejected

Another C++ pilot supplied all six passes with a language-neutral packet: a
30-line-context diff, frozen PR claims and commits, and applicable repository
rules. Reviewers retained unrestricted read-only repository access. The completed
Claude/Codex attempt was archived under ignored
`bench/work/pilots/rafp-incomplete-2026-10-08/rafp-expanded-evidence-ironweave-2026-10-08/`.

| Ironweave review | Claude tokens | Claude cost | Codex confirmed |
|---|---:|---:|---:|
| Prior six-pass protocol | 3,530,403 | $5.35 | 19 |
| Expanded evidence packet | 2,582,623 | $5.02 | 13 |

Although the packet cut tokens by 27%, it exceeded Matt Pocock's 2,512,768-token
Ironweave run and lost six confirmed claims. It was reverted before testing other
targets. Wider preloaded evidence did not preserve the independent passes' full
finding set in this pilot.

## Complete changed-file packet: rejected

A later Ironweave pilot supplied the exact patch, frozen PR claims and rules,
and complete head versions of changed UTF-8 text files to each pass. A generic
512 KiB ceiling would have fallen back to normal exploration on larger changes;
reviewers retained unrestricted read-only repository access. The first attempt
hit the operating system's argument-size limit, so a second attempt transported
oversized prompts through Claude CLI stdin. Both attempts are archived under
ignored `bench/work/pilots/rafp-incomplete-2026-10-08/`.

| Ironweave review | Claude tokens | Claude cost | Codex confirmed |
|---|---:|---:|---:|
| Prior six-pass protocol | 3,530,403 | $5.35 | 19 |
| Complete changed-file packet | 3,296,621 | $7.50 | 11 |

This packet reduced tokens only 7%, raised cost 40%, and lost eight confirmed
claims. The packet and its prompt-transport change were reverted. Supplying
more source bytes in every pass did not solve repeated context replay and was
not a quality-preserving optimization.

## Early Claude Code autocompaction: rejected

A later Ironweave trial added `--autocompact 100000` to each of the same six
Opus discovery passes. No review prompt or repository access changed. Its
unjudged run files are archived under ignored
`bench/work/pilots/rafp-incomplete-2026-10-08/rafp-autocompact-ironweave-2026-10-08/`.

| Ironweave review | Claude tokens | Claude cost | Codex confirmed |
|---|---:|---:|---:|
| Prior six-pass protocol | 3,530,403 | $5.35 | 19 |
| 100k autocompact | 3,146,557 | $4.76 | 8 |

The 11% token reduction did not reach Matt Pocock's 2,512,768-token ceiling
and lost eleven confirmed claims. The autocompact flag was reverted.

## One high-effort Opus discovery call: rejected at screening

A direct, read-only Ironweave pilot combined all six generic review lenses into
one Opus 5.5 call at high effort. Its structured output and usage are archived
under ignored `bench/work/pilots/rafp-consolidated-high-2026-10-08/`. It found
25 raw leads at $2.21 but used about 2.62 million tokens before any outer
wrapper. That already exceeds Matt Pocock's 2,512,768-token Ironweave ceiling.
The raw list also omitted baseline concerns about the new queue-drain wait's
backpressure risk and the PR's stated validation. It was rejected before Codex
adjudication or a skill change.

## One high-effort Sonnet discovery call: rejected at screening

The same generic, combined Ironweave prompt was run with Sonnet 5.5 at high
effort. Its raw output under ignored
`bench/work/pilots/rafp-consolidated-high-2026-10-08/ironweave-sonnet.json`
used about 417k tokens and found 11 leads. It omitted baseline findings about
source deserialization, the `_error` comment, the test header, and the stated
repository validation rule. The large token saving therefore did not meet the
no-loss condition; no full adjudication or skill change followed.

## One xhigh-effort Sonnet discovery call: rejected

The same combined Ironweave prompt was run with Sonnet 5.5 at xhigh effort.
Its local pilot output under ignored
`bench/work/pilots/rafp-consolidated-high-2026-10-08/` used about 2.18 million
Claude tokens and produced 24 raw leads. Independent fixed-point Codex
adjudication confirmed only eight claims, versus nineteen in the current
six-pass C++ baseline. The missing mechanisms were not recovered by the broad
changed-hunk scan. This option was rejected without changing the skill.

## One-call GPT-6 model discovery: rejected at screening

Read-only, structured pilots on a disposable Ironweave checkout used the six
generic review lenses and counted Codex CLI tokens directly. GPT-6.1 Sol was
unavailable for this ChatGPT account. GPT-6 Sol high used about 630k tokens for
16 raw leads; xhigh used about 1.24M for 13. GPT-6 Astra high used about 856k
for 12. All missed baseline issues. Astra max failed to complete at its
15-minute cap after a service HTTP 451 response. The trial files are under
ignored `bench/work/pilots/rafp-codex-discovery-2026-10-08/`. The production
Claude discovery and Codex adjudication protocol was not changed.

Official model details: [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol),
[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra).

## Six Sonnet passes at high effort: rejected

A full Ironweave benchmark attempt kept the six independent review prompts but
used Sonnet 5.5 at high effort for every discovery pass. The six passes alone
used 2,658,898 tokens, above Matt Pocock's 2,512,768-token C++ run, and Codex
confirmed 13 claims rather than the Opus baseline's 19. The outer benchmark
also rejected a new-lead mapping, so this attempt has no publishable result.
Its artifacts are archived under ignored
`bench/work/pilots/rafp-incomplete-2026-10-08/rafp-sonnet-high-ironweave-2026-10-08/`.
The effort change was reverted.

## Six Sonnet passes plus one Opus maintenance pass: rejected

A counterfactual Ironweave pilot combined the saved six Sonnet medium-effort
pass outputs with the saved Opus maintenance pass. Its measured Claude discovery
tokens plus the earlier Sonnet wrapper estimate total about 2.08 million,
below the 2.51-million C++ comparator. Fixed-point Codex adjudication confirmed
21 rows, but several were duplicate phrasings of the same unasserted-send test
defect. Baseline mechanisms concerning the compressor contract, queue-drain
backpressure risk, stated validation, and stale test header remained absent.
The pilot receipt is under ignored
`bench/work/pilots/rafp-sonnet-plus-opus-2026-10-08/`. It was rejected without
changing the skill or claiming benchmark success.

## GPT-6 Sol gap audit after six Sonnet passes: rejected

A staged Ironweave pilot supplied GPT-6 Sol with the frozen PR evidence and
the thirteen Codex-confirmed leads from the completed six-pass Sonnet review,
asking only for distinct uncovered mechanisms. It used about 755k Codex CLI
tokens and returned four leads. It recovered the deserialization documentation
issue but still missed the queue/error comments, backpressure risk, compressor
contract, and stated validation finding. The disposable checkout remained
clean. Its trace is under ignored
`bench/work/pilots/rafp-codex-discovery-2026-10-08/`. The staged design was
rejected before changing the skill or benchmark accounting.

## Two independent Sonnet six-pass runs: rejected

A second direct Sonnet 5.5 medium-effort six-pass Ironweave discovery used
1,295,079 tokens, essentially the same as the first set's 1,290,924 discovery
tokens. Their measured discovery union used 2,586,003 tokens, already above the
2,512,768-token C++ comparator before the outer wrapper. Conservative semantic
clustering reduced 90 raw leads to 41 groups; fixed-point Codex adjudication
confirmed only nine claims, versus nineteen in the six-pass Opus baseline.
The run and receipt are under ignored
`bench/work/pilots/rafp-sonnet-repeat-2026-10-08/`. Repetition was rejected
without changing the skill.

## File-focused Sonnet discovery plus Opus holistic: rejected at screening

Five independent Sonnet medium-effort calls reviewed the five changed
Ironweave files, with the frozen PR claims and rules but unrestricted local
read-only inspection of relevant callers and tests. Their combined discovery
used 695,076 tokens and returned only four raw leads; the three changed code
files produced none. The saved Opus holistic pass could not make this sparse
candidate set cover the existing full six-pass findings. The pilot records are
under ignored `bench/work/pilots/rafp-file-review-2026-10-08/`; no production
change or adjudication followed.

## Claude Haiku 5.5 discovery: rejected at screening

The isolated Claude Code 2.1.295 could run the newly available Haiku 5.5
model. Six original Ironweave passes returned 84 raw findings, but an
API/commit candidate used an unsafe absolute rule path and the strict helper
rejected the attempt. Re-running that pass with a generic safe-location
instruction yielded a valid six-pass candidate set at about $0.785 in
recorded Claude discovery cost, already over the $0.78 target before the
outer wrapper or Codex. Conservative clustering and fixed-point Codex
adjudication confirmed 17 rows, including repeated attribution claims, and
missed baseline issues. A 100k autocompaction pilot cut the specification
pass from about $0.266 to $0.027 but returned zero findings. Splitting that
pass into independent test-proof and requirements calls cost $0.538 together,
twice the original pass, and returned only one requirement finding. These
local pilots are under ignored `bench/work/pilots/rafp-haiku55-2026-10-08/`.
No Haiku change was retained.

Official model and threshold pricing: [Claude Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview).

## GPT-6 Luna discovery: rejected at screening

One broad GPT-6 Luna Ironweave call used about 203k Codex CLI tokens and found
two raw leads. Six independent, language-neutral lens calls used about 2.16M
CLI tokens in total and found only eight raw leads; they did not fill the
important gaps in the Haiku review. The disposable checkout stayed clean.
Their traces are under ignored `bench/work/pilots/rafp-codex-luna-2026-10-09/`.
These calls have no billed-USD receipt, so the [official GPT-6 Luna API rates](https://developers.openai.com/api/docs/models/gpt-6-luna)
provide only an API-equivalent estimate. Luna was rejected on coverage before
any production change.

## Stronger generic Codex first-wave audit: rejected

The saved six-pass Sonnet Ironweave candidate input was adjudicated again with
an expanded, language-neutral first-wave instruction to check changed public
contracts, literal documentation/comments, validation claims, and dependencies
of new waits. This changed no Claude discovery tokens. The revised fixed-point
receipt confirmed nine claims in about 103k Codex tokens, versus thirteen
confirmed by the prior Sonnet receipt, and it did not recover the missing Opus
baseline issues. The prompt change was reverted. The pilot receipt is under
ignored `bench/work/pilots/rafp-codex-discovery-2026-10-08/`.

## Frozen commit patches and rules in API/commit pass: rejected

A generic packet supplied the API/commit pass with every pinned commit patch,
base/head repository rules, and an explicit check of new public error
contracts. Direct pass pilots used 449k versus 735k tokens on C++, 571k versus
932k on Rust, and 672k versus 792k on Go. They retained the C++ `test.py`
validation lead and Go negative-dimension NULL lead that were unique to the
original pass, and the C++ pilot also found the compressor-factory contract.

The production-path Ironweave benchmark changed only this pass. Other unchanged
passes varied upward, so the complete review used 3,438,138 versus 3,530,403
Claude tokens and Codex confirmed sixteen rather than nineteen claims. It
missed distinct baseline queue-comment, backpressure, and compressor-contract
findings and remained above the 2,512,768-token C++ comparator. The packet was
reverted; the incomplete run is archived under ignored
`bench/work/pilots/rafp-incomplete-2026-10-08/rafp-commit-packet-2026-10-08/`.

## Claude Code safe-mode for nested passes: rejected

A C++ benchmark attempt added CLI `--safe-mode` to the six nested Opus passes
without changing their prompts or source access. It used 3,697,148 Claude
tokens versus 3,530,403 in the original baseline and Codex confirmed ten
claims versus nineteen. Disabling installed customizations did not lower token
consumption or preserve findings. The flag was reverted and the incomplete
attempt archived under ignored
`bench/work/pilots/rafp-incomplete-2026-10-08/rafp-safe-mode-ironweave-2026-10-08/`.

## Unchanged six-pass C++ control: finding-set variance

The completed `rafp-control-repeat-ironweave-2026-10-08` cohort reran the
current six-pass Opus review with no optimization active. Its Claude total was
3,630,562 tokens, compared with 3,530,403 originally. Codex confirmed twelve
claims, versus nineteen originally; the independent cohort judge merged them
into eleven real issues, versus twelve. The control lost the original source
deserialization documentation issue, stale test header, and compressor-factory
contract while finding other issues. A literal requirement that every rerun
contain every previous finding is therefore not satisfied by the unchanged
protocol itself. The control is published as separate cohort-local evidence,
not as a new canonical gold snapshot.

## Haiku 5.5 changed-hunk discovery and gap audits: rejected

Eight independent, generic changed-hunk reviews on the Ironweave PR cost
$0.2837802 and produced 29 raw candidates. Generic cross-hunk, public
contract/comment, mechanically extracted added-comment, and new-wait audits
added 20 candidates for $0.26976069. Total recorded Claude discovery cost was
$0.55354089 for 49 candidates. The prompts did not name benchmark findings.

Semantic clustering produced 41 candidates. The normal fixed-point Codex
judge confirmed 19 claims, equal to the original baseline *count*, but did
not preserve its finding set. It rejected the baseline queue-error comment,
left the `test.py` validation claim unresolved, and did not confirm the stale
test header or compressor-factory contract. The Codex CLI did not provide a
billed-dollar receipt; at published API rates its judge usage was about
$1.256, already over the $0.78 cap without discovery cost.

An independent Claude Haiku 5.5 source-grounded judge cost $0.02907397 and
confirmed 15 of the 41 clustered candidates. Discovery plus this judge cost
$0.58261486, before outer orchestration, but it also rejected or left
unresolved the four baseline findings above. The new judge therefore lowered
cost without meeting the exact no-loss condition. Neither design was installed
or benchmarked as a completed cohort. Pilot candidates, receipts, judge
output, and prompts are under ignored
`bench/work/pilots/rafp-haiku-hunks-2026-10-09/`.

A further GPT-6 Luna source-grounded judge used the identical 41-candidate
input and generic rubric. It confirmed 12 candidates, including the stale
test-header wording, but rejected the queue-error comment, compressor-factory
contract, and `test.py` validation claim. CLI usage was 112,901 input tokens
(76,032 cached) and 5,660 output tokens; the CLI supplied no billed-USD
receipt. At [published API rates](https://developers.openai.com/api/docs/models/gpt-6-luna),
that usage is about $0.0073 API-equivalent. The lower-priced judge still fails
the exact finding-set condition, so no production change follows from it.
