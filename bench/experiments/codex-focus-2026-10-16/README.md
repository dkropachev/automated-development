# Focused reviewer experiments — 2026-10-16

The user requested narrower agent responsibilities to improve bug detection. These exploratory
runs start from installed commit `b075eb4881f6e059417f4818f31b6d6daef38097`. They are not completed
benchmark cohorts or canonical gold. The production Codex and Claude skills remain unchanged.

## Results

A dedicated test-assertion reviewer reproduced one additional Rust test defect in two runs,
but the same layout missed a C++ compatibility-build defect. Restoring the original mandatory
compatibility check recovered the C++ finding while the Rust gain disappeared. Neither layout
improves aggregate bug coverage, and both use more tokens than the installed skill.

| Layout | Rust bugs | C++ bugs | Go bugs | Total bugs | All groups | Tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Installed package-v5 | 3 | 5 | 2 | 10 | 22 | 5,147,409 |
| Separate test-assertion reviewer | 4 | 4 | 2 | 10 | 20 | 5,543,534 |
| Original compatibility checks restored | 3 | 5 | 2 | 10 | 21 | 5,674,290 |

The first split's Rust repeat also found four bug groups, at 1,759,984 tokens versus 1,822,666
in its first run. A different three-role pilot initially found four Rust bug groups at
1,563,269 tokens, then only two at 1,490,941 on repetition. A promising single run is insufficient
to select a replacement. The complete individual-run results and exclusions are in
[grading.json](grading.json).

The final feature-area pilot kept code and tests together under bounded subsystem ownership.
It found two Rust bug groups and five total groups at 1,574,625 tokens: one fewer bug than the
installed skill, using 62,030 more tokens. It missed both the refill-regression defect and the
additional gauge assertion. That pilot was not expanded to other languages. Across 21 completed
runs, no tested replacement demonstrated a reliable overall improvement within the existing
token use. The decision is to retain package-v5 and stop this experiment series.

Bug groups comprise runtime, test/build, and diagnostic defects. Documentation and repository
rules contribute only to all-groups counts. The additional Rust finding is a new test assertion
that accepts a leaked active-connection count after teardown; it is not a new production leak.
Duplicate symptoms of the same defect receive one group, and unsupported allegations receive no
credit. These three fixtures were used repeatedly during iteration, not held out; the results
do not establish a general model ranking.

## Method and evidence

Each run uses the same pinned target source and PR metadata, an isolated read-only checkout,
GPT-6.1 Sol/high parent and xhigh native reviewer agents, a budget of 18 aggregate reviewer read
batches, and three parent verification batches. Parent preparation reads are separate. Proposals record
how the reviewer budget is distributed. Feature-area experiments narrow ownership by changed
subsystem rather than issue category. Reviewers receive no expected findings or grading feedback.

[Evidence](evidence.json) retains source commit, target pins, exact prompt and skill hashes,
native agent IDs and settings, per-agent token usage, and report hashes. Raw reports are retained
with rejected claims intact. Skill snapshots and runner source permit inspection of each
experimental protocol; they are not installed skills. Cached input is a subset of input tokens,
and reasoning is a subset of output tokens, so neither is added twice.

[Protocol audit](protocol-audit.json) records observed read counts, peer-inspection calls,
truncation, and read failures. One early test reviewer inspected peer status, potentially seeing a
completed peer's report; later variants prohibit this explicitly. Large batched reads sometimes
hit the outer tool-output cap even when inner commands requested more output. Read-only zsh
heredocs sometimes failed before reading source. These are operational limitations, not findings
against the target PRs. Later candidates use targeted reads and retain the original detailed
checks; none of those operational changes alone establishes a recall improvement.

The initial bounded plan was extended with several diagnostic variants after mixed results.
Every attempt is retained rather than selecting only successful pilots. The unchanged Opus
reference comes from the preceding investigation; no fresh Claude reviews ran in this study.

## Correction to the preceding comparison

The earlier [October 15 archive](../codex-parity-2026-10-15/README.md) credited an unsupported
Rust proxy-cleanup allegation to Opus. A per-test Tokio runtime drops its asynchronous tasks and
sockets on panic; skipping an explicit finish call alone did not establish a surviving leak or
violated cleanup contract. That claim is retracted across models. Corrected Opus totals are
**7 Rust groups and 22 overall groups**, including **4 Rust bugs and 11 overall bug groups**.
Installed Codex remains 22 overall groups, including 10 bug groups. Historical raw reports and
receipts remain intact; [category-baseline.json](category-baseline.json) records the correction.
