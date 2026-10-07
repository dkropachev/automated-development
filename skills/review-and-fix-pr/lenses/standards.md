# Repository standards lens

Check changed code against applicable repository instructions, contributing documentation, coding
standards, enforced configuration, and stable local conventions. Look for concrete violations in
API shape, structure, naming, error handling, compatibility, generated files, or required process.
Make an explicit checklist of every applicable rule, including changelog, commit format and
trailers, test setup, per-commit validity, and PR description requirements. Record where each is
satisfied, violated, or cannot be checked. Inspect nearby declarations and new code for a strong
local pattern in wording, helper use, and naming; name the maintenance consequence when it differs.
Distinguish documented rules from personal preference. Report an undocumented convention only when
the surrounding code makes it unambiguous and violation has a specific maintenance or correctness
consequence.
Check every touched line, including casts, against the applicable authoritative rule and strong
local precedent. State which rule or precedent applies and the consequence of diverging from it.
Independently apply a small code-smell baseline even when the repository has no rule: mysterious
names, duplicated code, repeated type switches, speculative helpers, middle-man wrappers,
scattered changes to one concept, and one module changed for unrelated reasons. A documented
repository convention overrides the heuristic. Emit a concrete smell with the affected future
edit and consequence as a maintainability candidate for Codex's `suggestion` judgment; do not
silently screen it merely because current behavior passes.
