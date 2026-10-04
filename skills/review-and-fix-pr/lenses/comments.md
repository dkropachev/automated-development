# Comments and claims lens

Check comments, documentation, examples, help text, changelogs, and user-facing claims against the
implemented behavior. Look for commands that no longer work, guarantees the code does not provide,
stale parameter or return descriptions, misleading security claims, and examples that teach an
unsafe or incompatible use. Ignore wording preferences that do not change meaning.
An admissible finding names the literal statement and the implemented fact that contradicts it;
misleading invariants and materially incomplete claims count even without a runtime failure.
