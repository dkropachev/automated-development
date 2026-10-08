# review-and-fix-pr fast protocol

The helper is a trusted orchestration script. It does not run project code or modify the reviewed
tree. Six separate Claude Code processes review the same frozen PR: holistic behavior, repository
standards, specification/tests, contracts, maintenance/comments, and API/commit integrity. Their prompts live under
`passes/`. Each has read/search and non-mutating Git access, a structured output schema, no agent
or skill fan-out, no web access, and an independent cost/timeout cap. None sees another pass's
findings. The engine validates every row, merges exact duplicates, and asks a read-only Codex
clustering call to propose conservative semantic groups. The original rows, sources, groups,
reasons, pass usage, and final candidate IDs remain in the pass receipt and discovery ledger.

Codex then independently adjudicates the canonical candidates. A distinct new lead is judged in a
fresh invocation; the originating invocation cannot judge itself. The broad changed-hunk scan runs
once. Later waves see known candidate mechanisms and judge pending leads without repeating the
scan. `real` means a verified defect, factual doc/test mismatch, or applicable rule violation.
`suggestion` means exact evidence supports a plausible named future edit and consequence without
an established present defect. `false_positive` requires disproof of the premise or consequence;
`unresolved` records missing evidence. Suggestions appear under **Needs reviewer judgment**, with
Codex's objection, and are never fixed automatically. Rejected observations are kept in the
receipt but are not reported as findings.

## Frozen context outside a benchmark

Require a clean HEAD and resolve the PR with `gh pr view`, the scope helper, and direct Git
checks before building the context. Use the same canonical diff options as
`bin/review-and-fix-pr-diff.js`. Read governing rules at merge base and head, plus the relevant
specification. Treat head-side changes to a governing rule as review evidence; base rules still
govern. Record unavailable/truncated linked sources and instruction omissions. Cross-repository
or private source access needs explicit authorization. Never include any benchmark judgments or
evaluation mapping in this context or a reviewer prompt.

The context file is a JSON object with exactly these keys, populated with verbatim source text and
exact patch/inventory. It must be a regular file at an absolute path outside the reviewed tree:

```json
{
  "acceptanceCriteria": [],
  "applicableBaseRules": [],
  "applicableHeadRules": [],
  "canonicalDiffInventory": {"inventory": {}, "patch": ""},
  "commitMessages": [],
  "linkedSources": [],
  "missingSourceIndicators": {},
  "prBody": "",
  "prTitle": "",
  "remoteIdentity": {},
  "repositoryIdentity": "owner/name",
  "upstreamIdentity": {}
}
```

In a benchmark, the runner supplies this file, target pins, expected plugin fingerprint, and
outside-tree paths for Codex input, discovery ledger, pass receipt, and Codex receipt. Copy the
context exactly; the runner-owned one-shot Codex broker verifies the pins and frozen bytes. The
helper writes each output exclusively and refuses overwrites. Pass records and the broker receipt
are hash-bound to the immutable result. V1/v2 result readers remain for historical cohorts; new
reviews emit schema v3.

## Completion and edits

`coverage: complete` means all six passes and Codex fixed-point closure finished. It is not a
claim that the PR has no remaining defects. A failed pass, malformed row, incomplete grouping,
missing/changed receipt, dirty tree, model drift, or pending Codex lead makes the result
unpublishable. Report the concrete failure instead of inventing a marker. For a review-only
request, HEAD remains the original PR head. For authorized fixes, only confirmed in-scope findings
may be edited; commit locally, rebuild context and rerun all six passes and Codex on the new HEAD.
Never push or comment on the PR without explicit authorization.
