# review-and-fix-pr — reference

Read this for configuration, scoring, extra-skill compatibility, completeness semantics, resume,
or run diagnosis.

## Public arguments

```ts
type SeverityWeights = Partial<{
  critical: number
  high: number
  medium: number
  low: number
}>

type ReviewAndFixArgs = {
  pr?: string | number
  fix?: boolean
  extraReviewSkills?: string[]
  stopAt?: {
    count?: number
    score?: {
      code?: number
      other?: number
    }
    tokens?: number
  }
  severityWeights?: {
    code?: SeverityWeights
    other?: SeverityWeights
  }
  verification?: "none" | "single" | "double"
  model?: string
}
```

| argument | default | meaning |
|---|---|---|
| `pr` | current branch's PR | PR number or URL |
| `fix` | `false` | Edit, validate, and commit locally when `true`; review only otherwise |
| `extraReviewSkills` | `[]` | Ordered exact names of loaded review skills, added before mandatory native lenses |
| `stopAt.count` | disabled | Stop discovery after this many qualified unique provisional findings |
| `stopAt.score.code` | disabled | Stop discovery when weighted code-finding score reaches this value |
| `stopAt.score.other` | disabled | Stop discovery when weighted non-code score reaches this value |
| `stopAt.tokens` | disabled | Stop after this run spends the given token delta |
| `severityWeights.code` | `{critical:10, high:5, medium:2, low:1}` | Partial code-score weight override |
| `severityWeights.other` | `{critical:10, high:5, medium:2, low:1}` | Partial non-code-score weight override |
| `verification` | `double` | `none`, one blind verifier, or blind verifier plus independent challenges |
| `model` | inherited | Run workflow agents on one specified model |

`pluginRoot` is required skill plumbing. `repoRoot` is exceptional plumbing when the session starts
outside the repository. Neither is part of the ordinary user configuration API.

Omitted `stopAt` means run the coverage protocol to closure. A present `stopAt` and a present
`stopAt.score` must each be non-empty. Thresholds form an OR condition evaluated after a whole
discovery wave drains, so reported count or score may exceed the requested limit. If that wave
crosses several thresholds, the report retains every hit and uses deterministic primary order
`count`, `code-score`, then `other-score`; parallel results cannot establish which crossed first.
Count and score stops still verify collected findings. A token stop launches no new auditor,
verifier, or fixer after the current wave. Because a stopped run must resume under the same model,
any `stopAt` configuration requires an explicit `model`; inherited-model runs are allowed only when
no stop threshold is configured.

Threshold values must be positive safe integers. Weight values must be non-negative safe integers;
an omitted severity inherits its bucket default. Arrays, unknown keys, `null`, strings, fractions,
zero thresholds, and negative values fail before the first agent starts.

Only unique, in-scope, non-deferred, non-rejected findings with `certain` or `likely` confidence
consume count or score. Provisional values drive stopping; canonical values after verification drive
the final report.

## Split scoring

Reviewers choose a `defectClass`, never a score bucket. Workflow assigns the bucket deterministically:

- **code:** `logic`, `nil-deref`, `bounds`, `concurrency`, `resource-leak`, `error-handling`,
  `security`, `api-contract`, `perf`, and `regression`;
- **other:** `test-gap`, `docs`, `style`, `dead-code`, and `design`.

Code and other scores accumulate and stop independently. The global count covers both buckets.
Severity weights affect only their own bucket. Default examples: one critical code finding scores 10;
two high other findings score 10; neither contributes to the other score.

## Completeness protocol

Workflow freezes merge-base/head SHAs, intent, acceptance criteria, repository instructions, commits,
changed paths, and a hunk-level coverage manifest. Rename, deletion, binary, mode-only, and other
non-text changes remain explicit manifest units rather than disappearing. A local deterministic
helper independently resolves GitHub PR identity, the local base/head merge base, linked issue text,
and tracked instruction-file hashes; that trusted source fingerprint keys resume. A second helper
inventories exact hunk hashes and structural changes; relayed manifests must match before any lens runs.

Independent lenses run in waves of three and do not see earlier finding prose:

```text
extra review skills
correctness -> spec -> standards -> security -> reliability
-> contracts -> testing -> performance -> comments -> maintainability
```

Every lens returns findings plus structured receipts for the hunks, requirements, paths, symbols,
contracts, tests, documentation, and repository rules it examined. A fresh coverage auditor sees the
manifest and receipts, but not finding prose. It creates targeted gap tasks; those run once, then a
fresh auditor rechecks coverage. New or unresolved gaps stop as `incomplete-gaps`; the workflow does
not loop until an agent happens to say clean.

`coverage: complete` means every mandatory lens returned valid output, required manifest units have
receipts, the one gap round finished, and every candidate has a disposition. It never means all bugs
were found. A failed, missing, malformed, or truncated lens remains explicit and prevents complete
coverage. An early `stopAt` result is `partial-stop`, with remaining units saved for resume.

## Extra review skills

Each `extraReviewSkills` entry must be an exact loaded skill name, including plugin namespace. It
runs as an independent read-only discovery lens before native lenses and adds domain methodology.
It cannot replace, reorder, or suppress native lenses.

A compatible skill must be model-invocable, accept the whole PR as its target, work under read-only
permissions, and allow findings and receipts to be normalized into workflow schemas. A missing,
disabled, user-only, recursive, or write-owning skill records a failed lens and incomplete coverage;
workflow never silently substitutes another method.

## Candidate union and verification

Every raw candidate receives an immutable source/index/semantic ID that is stable across resume and
retains lens provenance. Persisted dispositions repeat that semantic identity and fail closed on an
ID collision. Workflow preserves the union before conservative clustering. It merges candidates
only when path, symbol, defect class,
trigger, mechanism, and observable impact describe the same defect; one symbol may have multiple
distinct defects.

- `verification: "none"` reports candidates as unverified. An authorized fixer must re-check each
  `certain` or `likely` candidate before changing code. These have a separate unverified-eligible
  score and never inflate confirmed count or “score after validation.”
- `verification: "single"` sends every candidate to one blind verifier. Only confirmed findings may
  reach fixers.
- `verification: "double"` adds fresh independent challenges for first-pass rejects, unresolved
  candidates, and confirmed critical/high findings. Rejection requires two independent disproofs;
  disagreement remains unresolved.

Verifiers do not receive lens identity or reporter count. Every raw candidate must end confirmed,
rejected, unresolved, or mapped to one canonical duplicate cluster. Rejected and unresolved
findings are never automatically fixed.

## Stops, fixes, and resume

With `fix: false`, a count or score stop drains the current wave, verifies what was collected,
checkpoints uncovered work, and returns `partial-stop`. On resume, the next invocation gets a fresh
threshold window while cumulative count and scores stay visible.

With `fix: true`, a count or score stop is backpressure: drain, verify, fix eligible findings in
internal serial batches of at most ten, validate, and commit locally. A successful commit changes
the review target, so workflow rebuilds the manifest from new `HEAD` and restarts every mandatory
lens. If verification finds nothing fixable, it records those dispositions and continues the same
manifest instead of immediately retriggering.

Checkpoint state lives outside the repository under:

```text
~/.claude/review-and-fix-pr/<owner>__<repo>/runs/
```

When `model` is explicit, workflow automatically resumes the newest incomplete run matching PR
lineage, scope-source fingerprint, workflow/schema version, model, mandatory lenses, and ordered extra skills. An
inherited model cannot be identified reliably by the Workflow API, so those invocations start fresh
rather than risking cross-model checkpoint reuse, except when recovering a transaction-proven local
fix commit. Stop limits, weights, verification
strength, and `fix` may change. A workflow-confirmed local fix commit is resumable before push.
Unrelated commits, dirty edits, state hash mismatch, or changed identity inputs (scope, model, or
ordered lenses) invalidate resume. Identical concurrent runs are locked; abandoned incomplete
checkpoints expire after seven days. Completed checkpoints remain audit records. Cached lens and gap
results skip repeated discovery, but their candidates are verified again unless a later complete
disposition is safely reconstructed. Atomic commit receipts retain fixes, still-open findings, and
follow-ups across a crash; large receipts are staged as hash-verified bounded parts before the
lineage advance, so operating-system argument limits cannot truncate them. Before a fixer starts,
the workflow records a write-ahead transaction and conservative fallback disposition. The driver
stamps its unpredictable transaction ID into the commit; if the workflow disappears after `git
commit`, the next claim verifies that proof and recovers the lineage without trusting ancestry alone.
Exact-key active markers prevent an unrelated corrupt historical run from poisoning new claims.

Each checkpoint payload is capped below common operating-system argument limits. An oversized lens
artifact fails checkpointing, blocks automatic fixes, and reports incomplete coverage instead of
silently producing a non-resumable run. Resume exports only the frozen scope, latest cycle, latest
disposition, and prior final-summary/index artifacts in bounded pages; lineage receipts are fetched
one at a time, so a long valid run does not create one unbounded relay response. Restoring prior
summary names also makes a crash immediately before terminal sealing retry with a new append-only
attempt instead of colliding with its own files.

Checkpoint hashes detect accidental corruption and ordinary partial writes; they are not a security
boundary against repository code running as the same operating-system user. Run untrusted PR build
or test commands inside an external sandbox/account if adversarial repository code is in scope.
The Workflow API also has no direct subprocess primitive: exact Bash-clamped helper agents are the
trusted execution transport. Response journals recover crashes, truncation, and malformed relays;
they cannot authenticate a deliberately dishonest tool-running model. If the runtime gains attested
direct execution, these helper calls should move to that boundary.

Fix failure, still-present findings, uncommitted edits, no-progress recurrence, token limit, the internal 900-agent safety
limit, or 20 review/fix cycles stops safely and preserves state. Nothing pushes, comments, reverts,
or resets.

Fix mode distinguishes “no commands exist” from “baseline could not be measured.” The former may
continue explicitly unvalidated; the latter stops before any fixer runs. A repaired batch is
remeasured, and build artifacts are cleaned before a mandatory final pass so the sealed commit tree
is byte-for-byte the tree that received the green verdict.

## Status and reporting

Final state has independent axes:

- coverage: `complete`, `partial-stop`, `incomplete-lens`, or `incomplete-gaps`;
- verification: `none`, `complete`, or `incomplete`;
- fix: `not-requested`, `complete`, or `failed`;
- stop trigger: `count`, `code-score`, `other-score`, `tokens`, `agent-cap`, `cycle-cap`, or `none`;
  every simultaneously crossed finding threshold is also reported with its measured value and limit.

Report completed and failed lenses, uncovered manifest units, resume eligibility, provisional and
validated count plus split scores, cumulative cycle totals, unresolved findings, local commits, and
remaining edits. Scope remains a label rather than a pre-review filter: `in`, explicitly `deferred`,
or `out` because the defect predates and was not worsened or claimed fixed by the PR. A `deferred`
finding must carry the exact matching author quote; an unrelated deferral never suppresses it.

## Removed arguments

This is a clean API break. Workflow rejects these keys with migration-specific errors:

| removed | replacement |
|---|---|
| `reviewSkill` | `extraReviewSkills: [name]`; skills are additive |
| `reviewMode` | omit `stopAt` for complete coverage; set `stopAt` for partial review |
| `maxFindings` | `stopAt.count` |
| `maxMajorFindings` | use severity weights with `stopAt.score.code` / `.other` |
| `maxSeverityScore` | `stopAt.score.code` / `.other` |
| flat `severityWeights` | nested `severityWeights.code` / `.other` |
| `validation` | `verification` (`off` becomes `none`) |
| `maxTokens` | `stopAt.tokens` |
| `maxFixBatch` | fixed internal batches of at most ten |
| `maxAgents` | fixed internal 900-agent safety limit |
| `detailedReview` | mandatory lenses always follow relevant code; executable probes are disabled by the read-only boundary |
| `mode`, `reviewConcurrency`, `maxOutstanding`, `chunkBytes`, `isolation`, `stages`, `ignoreLedger`, `refreshRules`, `findingsPerChunk` | removed; no replacement |
