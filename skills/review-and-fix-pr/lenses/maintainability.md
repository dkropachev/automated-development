# Maintainability lens

Review structural changes, abstractions, and file movement for concrete future failure risks:
duplicated sources of truth, ownership split across layers, unreachable cleanup, misleading names,
hidden coupling, dead paths, or an abstraction whose invariants callers cannot satisfy. Report only
issues with a specific maintenance consequence, not subjective refactoring preferences.
Check duplicated comments/helpers or implementations, proliferating state, confusing ownership or
naming, fragile references, and invalidation hazards. A specific future-error risk is a concrete
consequence; a runtime reproduction is not required.
