## Toolkit

- **[P2] Recursive sizing introduces cubic decoding work — [marshal.go:1130](/tmp/ad-codex-focus-20261015/tidepool-toolkit-preserved-checks/marshal.go:1130).** Each `vectorElemMinSize` level recursively classifies its remaining subtype chain, making sizing quadratic in nesting depth. Nested decoding repeats sizing at every level, making the complete decode cubic, versus quadratic at base. A 1,000-level chain of dimension-one vectors ending in float fits within the wire type-name limit and adds approximately **167 million classification visits for four payload bytes**.

- **[P2] The one-byte floor rejects supported empty nested vectors — [marshal.go:1142](/tmp/ad-codex-focus-20261015/tidepool-toolkit-preserved-checks/marshal.go:1142).** For `vector<vector<float,0>,2>`, a non-NULL empty payload previously decoded into `[][]float32` or `[2][0]float32`. Each inner vector consumes zero bytes, but the new floor returns one, so the outer guard rejects it. The pinned metadata parsers still admit zero dimensions; the companion rejection mentioned in the PR is absent.

## Standards

- **[P2] Required behavior documentation is missing — [marshal.go:1000](/tmp/ad-codex-focus-20261015/tidepool-toolkit-preserved-checks/marshal.go:1000).** The PR changes short-payload and unsupported-element behavior without updating `CHANGELOG.md` or caller-facing godoc. [CONTRIBUTING.md:24](/tmp/ad-codex-focus-20261015/tidepool-toolkit-preserved-checks/CONTRIBUTING.md:24) explicitly requires both for these changes. The supplied description states no exception.

- **[P3] The comment assigns the aggregate byte count to each element — [marshal_vector_test.go:773](/tmp/ad-codex-focus-20261015/tidepool-toolkit-preserved-checks/marshal_vector_test.go:773).** Each encoded inner text vector occupies **four bytes**: one enclosing length prefix and three empty-string prefixes. Eight bytes is the total for both inner vectors. The assertion checks that total correctly; the per-element comment is false.

- **[P3] The universal byte-minimum claims exclude an accepted zero-byte shape — [marshal_vector_test.go:693](/tmp/ad-codex-focus-20261015/tidepool-toolkit-preserved-checks/marshal_vector_test.go:693).** An outer vector containing N zero-dimensional fixed vectors can encode in zero bytes, contradicting “never encoded in fewer than N bytes.” The equivalent assertion at line 813 and the first commit’s “Every element takes at least one byte” claim have the same counterexample. The helper description at `marshal.go:1121` consequently describes its defensive floor as an actual minimum.

- **[P3] “Every path” allocating from Dimensions is incorrect — [marshal.go:986](/tmp/ad-codex-focus-20261015/tidepool-toolkit-preserved-checks/marshal.go:986).** Concrete array destinations skip `reflect.MakeSlice` and decode into existing storage. The new array-test comment itself acknowledges this. This contradicts the allocation claim independently of constant reflection bookkeeping.

- **[P3] Both commit subjects violate the capitalization requirement.** Subjects for `0276a669` and `78891dd7` start with lowercase `fix`, contrary to [CONTRIBUTING.md:42](/tmp/ad-codex-focus-20261015/tidepool-toolkit-preserved-checks/CONTRIBUTING.md:42). Both commits otherwise have explanatory bodies and tests accompanying their fixes.

## Spec

- **[P3] The validation description overstates base-failing coverage — [marshal_vector_test.go:937](/tmp/ad-codex-focus-20261015/tidepool-toolkit-preserved-checks/marshal_vector_test.go:937).** The PR says “Every new test fails against pristine `marshal.go`/`helpers.go`.” The zero-dimension test follows unchanged successful branches at base, as do ordinary acceptance cases. Those are legitimate acceptance tests, but they contradict the universal validation claim.

The absent companion parser validation also leaves a pre-existing allocation exposure: with zero-dimensional inner vectors, B nonempty payload bytes permit B outer elements, allocating **24B bytes of slice headers on amd64** before rejection. This is retained exposure, not an introduced regression.

Review was source-only. Tests, builds, CI results, linked issue contents, and 32-bit compilation were not verified. HEAD and the clean worktree remained unchanged.