# Codex review recall experiment — 2026-10-15

This is an exploratory skill evaluation, not a completed benchmark cohort or a canonical gold
comparison. Claude's `skills/code-review-ad/` files were unchanged. The user observed a local
recall gap but supplied no saved example; these three repository fixtures are the available proxy.

**October 16 correction:** the follow-up investigation retracted the Opus Rust proxy-cleanup
claim. Corrected Opus counts are **7 Rust groups and 22 total**, rather than the historical 8 and
23 below. The table and raw receipts remain the original record. See the
[correction and focused-agent follow-up](../codex-focus-2026-10-16/README.md) for the source-based
reason and corrected category comparison. The installed Codex counts are unchanged.

## Matched comparison

All reviews used the same pinned PR source and metadata, isolated read-only checkouts, and three
independent Toolkit, Standards, and Spec passes. Codex baseline used GPT-6.1 Sol/high throughout;
the final package uses a high parent and three xhigh reviewers. The fresh Opus 5.5 comparator
used its unchanged skill and medium effort. The installed user's optional Performance overlay
was preserved separately; it is not part of this three-pass comparison.

| Target | Codex baseline groups | Fresh Opus groups | Final Codex groups | Baseline tokens | Opus tokens | Final tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ironweave | 5 | 8 | 8 | 1,919,514 | 1,707,068 | 1,887,535 |
| tidepool | 5 | 7 | 8 | 1,645,174 | 1,508,537 | 1,747,279 |
| quillstone | 2 | 8 | 6 | 1,580,717 | 1,161,741 | 1,512,595 |
| Total | 12 | 23 | 22 | 5,145,405 | 4,377,346 | 5,147,409 |

Counts are independently checked unique issue groups. Duplicate headings, suggestions, disputed
contracts, and unsupported causal explanations receive no credit. More findings does not mean
that every comparator finding was reproduced. Single runs do not establish stable model parity.
These fixtures were used during iteration,
not held out. The selected package retains all baseline groups, but Rust still trails fresh Opus
and total Codex usage remains 17.6% higher than Opus (approximately unchanged from Codex baseline).
The final preparation-budget experiment produced 19 verified groups at 5,462,275 tokens,
losing two C++ baseline groups. It was rejected; no further general prompt changes were validated.
[Evidence](evidence.json) retains the source commit, exact skill hashes, target pins, usage, and
report hashes. [Grading](grading.json) records exclusions and corrections; original final reports
are retained under `reports/`. Full iteration traces remain in the local ignored directory
`bench/work/codex-parity/2026-10-15/`.

## Diagnosis and change

Older Opus runs were not equivalent: their harness supplied extra comment, code-construct and
commit/file inventories, and some prompts asked for suggestions. Fresh matched runs still showed
Codex dropping verified low-severity facts during reconciliation or substituting an easier
predicate for the actual claim. Increasing effort alone raised token use substantially; fresh
contexts alone did not improve recall.

The Codex-only change prepares frozen source inventories deterministically, loads relevant check
references, and separates runtime, test, documentation, rule and diagnostic obligations. It keeps
three independent passes, six total read calls per reviewer, and three parent verification calls.
Higher reviewer effort is paired with bounded reads. Two inherited directives were corrected:
future identity must survive reasoning about replacement objects, and retained retry state is a
finding only when its consequence violates an applicable contract.

The helper was tested inside Codex's read-only sandbox. Explicitly ignoring unused Git stdin
avoids a reproduced Node `spawnSync` EPERM. Six tests cover frozen reads despite dirty files,
exact line attribution, hostile filenames, renames/deletions, directory reuse after rename,
missing pins, display omissions, and first-parent merge metadata. A reproduced rename-directory
misattribution failed before its fix and passed after. Full `make ci` passed with 297 tests,
publication validation and dashboard route checks. Existing completed cohort artifacts and
canonical gold were not changed.
