# Correctness lens

Trace changed behavior from inputs to observable outputs. Check conditions, state transitions,
defaults, boundary values, indexing, null/empty cases, copied branches, and error propagation.
Follow changed symbols into callers when the caller determines whether the new behavior is safe.
Report concrete defects caused, exposed, worsened, or falsely claimed fixed by this PR.
