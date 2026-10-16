## Toolkit

- **[P2] Nested empty vectors now fail decoding** — [marshal.go:1142](/tmp/ad-codex-focus-20261015/tidepool-focused-three/marshal.go:1142). For `vector<vector<float,0>,2>`, a non-NULL empty payload decoded into two empty slices at base. The new one-byte minimum rejects it. Both pinned metadata parsers accept zero dimensions; the companion rejection mentioned in the PR is absent.

- **[P2] Deeply nested decoding gains cubic CPU cost** — [marshal.go:1130](/tmp/ad-codex-focus-20261015/tidepool-focused-three/marshal.go:1130). The minimum helper repeatedly traverses nested subtypes, then runs again at each decoding level. For dimension-one nesting of depth `d`, decoding grows from Θ(d²) at base to Θ(d³). Depth 1,000 adds roughly 167 million classifier visits per four-byte value on the `Scan` goroutine. That metadata fits the protocol’s string limit.

- **[P3] The nested-text byte count describes the wrong quantity** — [marshal_vector_test.go:773](/tmp/ad-codex-focus-20261015/tidepool-focused-three/marshal_vector_test.go:773). Each inner vector occupies **four bytes**: one outer length prefix and three empty-string prefixes. Eight bytes is the entire two-element fixture; the adjacent assertion is correct.

- **[P3] The universal one-byte claim excludes an accepted encoding** — [marshal_vector_test.go:813](/tmp/ad-codex-focus-20261015/tidepool-focused-three/marshal_vector_test.go:813), also line 693 and commit `0276a669`. A zero-dimensional fixed inner vector occupies zero bytes. The new comments and commit body assert otherwise. This factual defect is separate from the decoding regression above.

- **[P3] The helper’s documented exact minimum is inaccurate** — [marshal.go:1121](/tmp/ad-codex-focus-20261015/tidepool-focused-three/marshal.go:1121). It returns one for a list element, while a valid empty list requires five bytes inside a vector: its four-byte collection count plus one vector length prefix. The result is a conservative bound rather than the claimed “fewest bytes.”

- **[P3] The allocation comment incorrectly covers every path** — [marshal.go:986](/tmp/ad-codex-focus-20261015/tidepool-focused-three/marshal.go:986). Correctly sized array destinations decode without dimension-dependent allocation, and sufficiently capacious float slices reuse storage. The new array-test comment explicitly confirms this counterexample.

## Standards

- **[P3] Both commits violate the documented message format.** [CONTRIBUTING.md:23](/tmp/ad-codex-focus-20261015/tidepool-focused-three/CONTRIBUTING.md:23) requires the prescribed format, including a capitalized subject and `Patch by …; reviewed by … for #####`. Both supplied commits begin with lowercase `fix(marshal):` and omit that attribution line. Both have rationale bodies, but no applicable exception is supplied.

- **[P3] Required behavior documentation is missing** — [marshal.go:1001](/tmp/ad-codex-focus-20261015/tidepool-focused-three/marshal.go:1001). The PR changes short-payload handling and interface errors without changelog or public godoc updates, contrary to [CONTRIBUTING.md:24](/tmp/ad-codex-focus-20261015/tidepool-focused-three/CONTRIBUTING.md:24). The frozen description states no exception.

## Spec

- **[P3] The universal regression-validation claim is false** — [marshal_vector_test.go:937](/tmp/ad-codex-focus-20261015/tidepool-focused-three/marshal_vector_test.go:937). The PR says “Every new test fails against pristine `marshal.go`/`helpers.go`.” This zero-dimension test and the positive/NULL acceptance cases exercise paths that already satisfy their assertions at base. They are valid acceptance tests, but do not support that claim.

Coverage limitations: linked issue contents, CI results, live-node behavior, and empirical performance remain unverified. The bounded 386 vet attempt stopped during toolchain verification, so 32-bit execution remains unverified. Both fixes include tests in their respective commits. HEAD and the clean working tree remained unchanged.