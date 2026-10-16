# Specification lens

Derive requirements from the PR body, linked issue or specification, commits, acceptance criteria,
and explicit scope boundaries. Map each requirement to observable implementation behavior and tests.
Enumerate literal claims, including what every new test is said to prove and whether all commits
belong to the stated purpose. For each claim, cite its source, the implementing line or missing
path, and direct proof or its absence. Check claims against the base revision when the PR says a
test fails there or a behavior is preserved.
Look for missing requirements, behavior that contradicts the request, unsupported claims of
completion, and unintended scope expansion. Do not invent requirements or treat ambiguous product
choices as defects; name the source and concrete mismatch for every finding.
