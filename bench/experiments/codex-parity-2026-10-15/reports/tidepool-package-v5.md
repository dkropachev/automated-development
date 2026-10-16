## Toolkit

- **P2 — Empty nested vectors are newly rejected.** At [marshal.go:1142](/tmp/ad-codex-parity-20261015/tidepool-package-v5/marshal.go:1142), the helper assigns a one-byte minimum to `vector<float,0>`, whose fixed encoding occupies zero bytes. Both pinned metadata parsers accept that type. For `vector<vector<float,0>,2>`, an empty non-NULL payload and `[][]float32` destination succeed at base; head rejects them at the new bound.

- **P2 — Recursive sizing introduces cubic decoding work.** At [marshal.go:1130](/tmp/ad-codex-parity-20261015/tidepool-package-v5/marshal.go:1130), each helper level rescans the remaining subtype chain, and each nested decode repeats the helper. With 1,000 dimension-one vector layers, a matching concrete destination, and four payload bytes, the new guard adds **167,166,000 classifier visits**, versus 500,499 from the existing decoder classification. This changes decoding from quadratic to cubic work on the Scan goroutine.

## Standards

- **P3 — Incorrect per-element byte count.** [marshal_vector_test.go:773](/tmp/ad-codex-parity-20261015/tidepool-package-v5/marshal_vector_test.go:773) says each inner vector occupies eight bytes. Each occupies **four**: three empty-element prefixes plus one enclosing prefix. Eight bytes describes the complete two-element fixture.

- **P3 — Universal byte-minimum claims are false.** [marshal_vector_test.go:693](/tmp/ad-codex-parity-20261015/tidepool-package-v5/marshal_vector_test.go:693), its comment at line 813, and [marshal.go:1121](/tmp/ad-codex-parity-20261015/tidepool-package-v5/marshal.go:1121) assert positive or exact minima contradicted by zero-dimensional fixed inner vectors. An outer vector containing those elements can occupy zero bytes. Commit `0276a669` repeats the false one-byte assertion.

- **P3 — Allocation comment overstates its scope.** [marshal.go:986](/tmp/ad-codex-parity-20261015/tidepool-package-v5/marshal.go:986) says every subsequent path turns Dimensions into an allocation. Array destinations bypass `reflect.MakeSlice`; float slices with sufficient capacity reuse their backing storage.

- **P3 — Required public change documentation is missing.** [CONTRIBUTING.md:24](/tmp/ad-codex-parity-20261015/tidepool-package-v5/CONTRIBUTING.md:24) requires changelog documentation for bug fixes and godoc for functional changes. The new rejection behavior has neither, and the supplied PR body states no exception.

- **P3 — Both commit messages violate the prescribed format.** `0276a669` and `78891dd` begin with lowercase `fix(marshal):` and omit the attribution/review footer required by [CONTRIBUTING.md:30](/tmp/ad-codex-parity-20261015/tidepool-package-v5/CONTRIBUTING.md:30). Both do contain explanatory bodies and corresponding tests.

## Spec

- **P2 — The declared parser prerequisite is absent, leaving allocation amplification.** The PR says it lands with rejection of `dim < 1`, but neither pinned parser implements that rejection. At [marshal.go:1000](/tmp/ad-codex-parity-20261015/tidepool-package-v5/marshal.go:1000), `vector<vector<float,0>,B>` accepts a malformed B-byte payload with outer count B. A `[][]float32` destination then allocates **24B backing bytes on amd64** before its first child rejects: **25,165,824 bytes for a 1 MiB payload**. This is an unresolved pre-existing exposure under the declared prerequisite, not a newly introduced allocation regression.

- **P3 — The validation claim overstates regression coverage.** The PR says every new test fails against pristine production files. The new [zero-dimension test](/tmp/ad-codex-parity-20261015/tidepool-package-v5/marshal_vector_test.go:937) exercises unchanged successful NULL/empty branches; the well-formed acceptance cases also preserve base behavior. These are compatibility checks, not reproductions of base failures.

Review remained read-only; HEAD and worktree were unchanged. Tests, builds, CI results, linked issue contents, and actual 32-bit execution were not verified.