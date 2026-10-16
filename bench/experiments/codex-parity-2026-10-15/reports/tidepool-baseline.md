## Toolkit

- **P2 — Recursive bounds add cubic decoding work** — [marshal.go:1130](/tmp/ad-codex-parity-20261015/tidepool/marshal.go:1130). `isVectorVariableLengthType` traverses the remaining subtype chain, and `vectorElemMinSize` repeats that traversal recursively. Computing the minimum therefore costs Θ(d²); decoding each nested level repeats it, producing Θ(d³) work. The parsers accept 1,000 dimension-one vector levels in roughly 47 KB of metadata, with only four payload bytes. A concrete nested destination then causes approximately 167 million classifier visits per value on the Scan goroutine.

## Standards

- **P3 — The test comment doubles the per-element byte count** — [marshal_vector_test.go:772](/tmp/ad-codex-parity-20261015/tidepool/marshal_vector_test.go:772). Each inner vector occupies four bytes: one enclosing length byte plus three zero-length prefixes. Eight bytes describes the entire two-element fixture, whereas the comment attributes it to each inner vector.

- **P3 — Required public documentation is absent** — [marshal.go:1000](/tmp/ad-codex-parity-20261015/tidepool/marshal.go:1000). Short non-NULL payloads now return errors instead of decoding successfully. [CONTRIBUTING.md:24](/tmp/ad-codex-parity-20261015/tidepool/CONTRIBUTING.md:24) requires notable behavior changes and bug fixes in `CHANGELOG.md`, with functional changes also documented in godoc. Neither is included, and the supplied PR description states no exception.

- **P3 — Both commit subjects violate the capitalization requirement.** Subjects for `0276a669` and `78891dd7` begin with lowercase `fix(marshal)`. [CONTRIBUTING.md:42](/tmp/ad-codex-parity-20261015/tidepool/CONTRIBUTING.md:42) explicitly requires a capital initial letter.

## Spec

- **P2 — Zero-dimensional inner vectors invalidate the new minimum** — [marshal.go:1142](/tmp/ad-codex-parity-20261015/tidepool/marshal.go:1142). Both pinned metadata parsers admit `vector<vector<float,0>,N>`; the companion positive-dimension validation mentioned in the PR is absent. For `N=1`, a non-NULL empty payload previously decoded into one empty inner slice but now fails because the helper substitutes one for the actual zero-byte minimum.

  Conversely, an `N`-byte malformed payload passes this floor with outer dimension `N`. Decoding into `[][]float32` allocates `24N` bytes of slice headers on 64-bit Go before the first inner decoder rejects its one-byte segment: 16 MiB of payload causes 384 MiB of allocation. This allocation risk predates the PR, but remains reachable through the new protection; the empty-payload rejection is newly introduced.