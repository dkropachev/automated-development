## Toolkit

- **[P2] Recursive sizing introduces cubic decoding cost** — [marshal.go:1130](/tmp/ad-codex-focus-20261015/tidepool-toolkit-split/marshal.go:1130). Each helper invocation rescans the remaining subtype through `isVectorVariableLengthType`, making sizing Θ(d²). Nested decoding repeats this at every level, becoming Θ(d³), versus Θ(d²) at base. A parser-admissible 1,000-level dimension-one float type carries four payload bytes but causes approximately 166 million additional classifier edges.

- **[P2] Zero-byte nested encodings are newly rejected** — [marshal.go:1142](/tmp/ad-codex-focus-20261015/tidepool-toolkit-split/marshal.go:1142). For `vector<vector<float,0>,2>`, a non-NULL empty payload previously decoded into two empty slices, or into `[2][0]float32`. The new inner minimum of one rejects both. The pinned parsers still accept zero dimensions; the companion rejection described in the PR is absent.

- **[P2] The minimum-size test codifies that overestimate** — [marshal_vector_test.go:814](/tmp/ad-codex-focus-20261015/tidepool-toolkit-split/marshal_vector_test.go:814). The test requires one byte for `vector<float,0>`, although its encoding occupies zero bytes. It therefore passes while the claimed non-narrowing bound rejects the previously accepted encoding above.

## Standards

- **[P3] Universal byte-minimum comments are false** — [marshal_vector_test.go:693](/tmp/ad-codex-focus-20261015/tidepool-toolkit-split/marshal_vector_test.go:693), repeated at [line 813](/tmp/ad-codex-focus-20261015/tidepool-toolkit-split/marshal_vector_test.go:813) and in commit `0276a669`. An N-element vector containing fixed zero-dimension inner vectors can occupy zero bytes, contradicting the stated N-byte minimum.

- **[P3] The nested fixture’s per-element byte count is wrong** — [marshal_vector_test.go:773](/tmp/ad-codex-focus-20261015/tidepool-toolkit-split/marshal_vector_test.go:773). Each inner text vector contributes one length byte plus three empty-element prefixes: **four bytes**. Eight bytes describes the complete two-element fixture. The subsequent assertion is correct.

- **[P3] The allocation comment overstates its scope** — [marshal.go:986](/tmp/ad-codex-focus-20261015/tidepool-toolkit-split/marshal.go:986). “Every path below” does not turn dimensions into an allocation: matching array destinations allocate no dimension-dependent storage, and sufficiently large float slices reuse their backing arrays.

- **[P2] Required behavior-change documentation is missing** — [marshal.go:998](/tmp/ad-codex-focus-20261015/tidepool-toolkit-split/marshal.go:998). [CONTRIBUTING.md:24](/tmp/ad-codex-focus-20261015/tidepool-toolkit-split/CONTRIBUTING.md:24) requires notable bugfixes and behavior changes in `CHANGELOG.md`, with functional changes also documented in godoc. This PR changes short-payload handling but updates neither; its description states no exception.

- **[P3] Both commits violate the documented message format** — commits `0276a669` and `78891dd`. Both subjects start lowercase and omit the specified `Patch by …; reviewed by … for #####` footer. These requirements appear in [CONTRIBUTING.md:30](/tmp/ad-codex-focus-20261015/tidepool-toolkit-split/CONTRIBUTING.md:30). Both commits do contain explanatory bodies and tests for their respective fixes.

## Spec

- **[P3] The universal regression-test claim is incorrect** — PR description, evidenced by [marshal_vector_test.go:937](/tmp/ad-codex-focus-20261015/tidepool-toolkit-split/marshal_vector_test.go:937) and [line 695](/tmp/ad-codex-focus-20261015/tidepool-toolkit-split/marshal_vector_test.go:695). “Every new test fails against pristine `marshal.go`/`helpers.go`” is contradicted by the zero-dimension preservation test and well-formed acceptance tests, whose production paths already succeed at base. These are valid acceptance tests; the validation claim is false.

Four independent passes completed. HEAD remained pinned and the worktree clean. Tests and builds were not run. Reported validation results, background-allocation isolation, architecture support, and external issue contents remain unverified.