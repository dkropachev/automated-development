# Comments and claims lens

Check comments, documentation, examples, help text, changelogs, and user-facing claims against the
implemented behavior. Look for commands that no longer work, guarantees the code does not provide,
stale parameter or return descriptions, misleading security claims, and examples that teach an
unsafe or incompatible use. Ignore wording preferences that do not change meaning.
An admissible finding names the literal statement and the implemented fact that contradicts it;
misleading invariants and materially incomplete claims count even without a runtime failure.
Check each added or modified comment and adjacent old comments against the new control flow.
Treat comments that restate an obsolete state, duplicate another explanation, omit a material
error condition, or claim a test proves more than its assertion as possible drift risks.
