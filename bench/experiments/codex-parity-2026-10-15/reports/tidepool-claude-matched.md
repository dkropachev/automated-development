# Review of PR #1 (`fix(marshal): stop a vector value from crashing the Scan goroutine`)

**Reviewed commits:** base `24c789ec`, head `78891dd7`, merge-base equal to base. The checkout was at the PR head and clean before and after the review, so it stayed read-only. All three passes (Toolkit, Standards, Spec) ran as independent agents on claude-opus-5-5 at medium reasoning. Nothing was executed; allocation and cost figures come from reading the code.

## Toolkit

1. **Medium — `marshal.go:1141-1143`: the minimum-size floor of 1 still lets the 24× allocation through.**
   - **Bad input:** a nested vector whose inner dimension is 0 or negative, e.g. `vector<vector<float,0>,N>` or `vector<vector<float,-3>,N>`, with an N-byte non-NULL payload, decoded into `*[][]float32` or `*[]any`.
   - **What happens:** a fixed-size inner vector carries no length prefix (`isVectorVariableLengthType`, `marshal.go:1181-1197`), so its real minimum is 0 bytes. `vectorElemMinSize` floors it to 1, so `N > len/1` is false and the guard passes. `reflect.MakeSlice` (`marshal.go:1083`) then allocates N slice headers (24 B each, 16 B for `[]any`). Only afterwards does the first inner `Unmarshal` fail, with "1 bytes of data for 0-dimension vector" or "negative dimensions".
   - **Why it matters:** that is about 25 MB per 1 MiB value, on Scan's goroutine. It is the same 24-bytes-per-payload-byte "before" ratio the PR says it removed, against its claimed "3.5 KB flat".
   - **Reachable in this checkout:** neither parser rejects such dimensions. `helpers.go:264` uses `strconv.Atoi` with no range check. `frame.go:861` uses `dim, _ := strconv.Atoi`, which also turns garbage into 0. The `dim < 1` rejection the PR relies on lives in #1093, which is not part of this checkout.
   - **Tests lock it in:** `TestVectorElemMinSize` asserts the floor of 1 for both of these shapes.
   - **The other side of the same floor:** the valid empty encoding of `vector<vector<float,0>,2>` is now rejected ("2 dimensions do not fit in 0 bytes").
   - **Same cause, lower severity, needs no bad metadata:** `list`/`set`/`map`/`tuple`/UDT elements also fall to the 1-byte floor. So `vector<list<int>,N>` with N zero bytes allocates 24N before any element is decoded.

2. **Low — `marshal.go:1048`: the "no Go type" error names the wrong type for a nested vector.**
   - A parsed inner vector's custom name is only the bare `...VectorType` prefix (`helpers.go:271`). The error therefore reads `no Go type for element type custom(org.apache.cassandra.db.marshal.VectorType)`. It loses the element type and dimension.
   - It also says the element has no Go type, yet the same value decodes into `[][]float32`. The real cause is that `Zero()` returns nil.
   - The tests use hand-built `makeNestedVectorType` (full name), and the parsed-type test only checks a substring, so the rendering is untested.

3. **Low — `marshal.go:1001`: the bound error leaves out the per-element minimum.** For example, `3 dimensions do not fit in 24 bytes` for `vector<vector<float,3>,3>` reads as contradictory without the 12-byte per-element figure.

4. **Low — `marshal.go:1125-1145`: nesting depth costs depth-cubed time.**
   - At each level, `vectorElemMinSize` calls `isVectorVariableLengthType`, which walks the rest of the chain, so one call is O(d²).
   - `unmarshalVector` runs the bound again at every nesting level as it decodes, so a dimension-1 chain chosen by the peer costs O(d³) per value, up from O(d²).
   - In practice this is small: parsing a type string under the 65535-byte frame cap is already O(n²).

**Numeric-comment audit:**
- **Wrong — `marshal_vector_test.go:772-773`:** "Each inner vector is a vint length followed by three vint lengths of zero: eight bytes". Each inner vector is 1+3 = 4 B; 8 B is the size of the whole two-element fixture.
- **Wrong — `marshal_vector_test.go:813`:** "Neither can describe an element in zero bytes". `vector<float,0>` encodes in exactly 0 bytes.
- **Wrong — `marshal_vector_test.go:693`:** "a vector of N elements is never encoded in fewer than N bytes". `vector<vector<float,0>,N>` is 0 B (see finding 1).
- **Correct:**
  - `1<<61+1` wraps `Dimensions*8` to exactly 8; with the 32-bit form, `(2^29+1)·8 ≡ 8` as well.
  - "Three elements, each a vint length of zero" is 3 B.
  - "25 MB for the megabyte" is 2²⁰ × 24 B ≈ 25.2 MB on 64-bit.
  - The "24 / 8" fixture totals.
  - The `TestVectorElemMinSize` values 4, 16, 1, 12, 4 and 48.
  - `size = 1` as the vint length of an empty element.

## Standards

1. **Low — commits `0276a66` and `78891dd`: commit messages don't follow `CONTRIBUTING.md`.** The rule asks for a capitalised short description and a `Patch by <authors>; reviewed by <Reviewers> for #####` line. Both commits use lowercase `fix(marshal): …` subjects and have no Patch-by line. The last 40 base commits use the same style, so the documented rule is stale in practice, but the PR still violates it as written.

2. **Low — notable change not recorded in a changelog.** `CONTRIBUTING.md` requires `CHANGELOG.md` entries for bugfixes and behaviour changes. The PR changes behaviour (a short or empty non-NULL vector payload now errors), but there is no `CHANGELOG*` file in the tree, so the change is recorded only in the PR body.

3. **Low — commit `0276a66` body misdescribes the bound.**
   - It says "Every element takes at least one byte on the wire … the way unmarshalList already does".
   - The code uses a recursive, type-aware minimum, and some elements take 0 bytes (Toolkit finding 1).
   - `unmarshalList` instead uses a flat `n > len(data)/4`, and only for slices (`marshal.go:835`). So the comment at `marshal.go:991`, "unmarshalList does the same", is likewise inaccurate.
   - The same commit body also does not mention that short or empty non-NULL payloads now error.

4. **Low — duplicated explanation and test builders.**
   - The "Nothing allocates at zero dimensions…" rationale appears at `marshal.go:995-997` and again in the doc comment of `TestUnmarshalVectorZeroDimensionsDoesNotTouchSubType`.
   - The new `makeVectorType` (`marshal_vector_test.go:557`) duplicates the existing `makeDoubleVectorType` and `makeFloat32VectorType` in the same file (:36, :49), and `makeFloatVectorType` in `vector_bench_test.go:19`.

The wrong numeric comments are reported under Toolkit.

## Spec

1. **Low — "Every new test fails against pristine `marshal.go`/`helpers.go`" is overstated.** At base, the package fails to compile because `TestVectorElemMinSize` references the new `vectorElemMinSize`, so every test "fails" for that reason alone. Judged on their own behaviour, these pass at base:
   - `TestUnmarshalVectorAcceptsWellFormedPayloads`
   - `TestUnmarshalVectorZeroDimensionsDoesNotTouchSubType`
   - the "still decodes" subtests of `TestUnmarshalVectorRejectsAnElementTypeWithNoGoType`

2. **Low — undocumented behaviour change: NULL with negative dimensions (`marshal.go:992-994`).** Negative dimensions are now rejected before the NULL check. A NULL value (`data == nil`) in a column with dimension < 0 now errors, where base returned nil. A test pins this, but the PR's "Behaviour change" section lists only short or empty payloads and the fast-path message.

3. **Shared with Toolkit finding 1 — the "3.5 KB flat" claim holds only for the measured shape.** "The bound now sits ahead of every consumer" and "3.5 KB flat" hold for `vector<vector<float,3>,N>` as measured. They do not hold for inner vectors with dimension ≤ 0, which this checkout's parser admits. Collection and tuple elements stay at a 24:1 ratio.

**Claims that check out:**
- Every Dimensions-driven allocation sits behind the new bound: both fast paths, `MakeSlice`, and the nested re-entry into `unmarshalVector`.
- A nested vector does reach the nil-`Zero()` path.
- The `getCassandraLongType` change affects only vector parsing paths (`frame.go:860`, `helpers.go:72`).
- A zero-length non-NULL value arrives as a non-nil empty slice (`frame.go:1911`), so the `data != nil` gate behaves as the PR says.
- Each commit's tests land in the same commit as its fix.
