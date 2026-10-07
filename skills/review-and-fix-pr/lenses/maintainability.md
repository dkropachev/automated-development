# Maintainability lens

Review structural changes, abstractions, and file movement for concrete future failure risks:
duplicated sources of truth, ownership split across layers, unreachable cleanup, misleading names,
hidden coupling, dead paths, or an abstraction whose invariants callers cannot satisfy. Report only
issues with a specific maintenance consequence, not subjective refactoring preferences.
Check duplicated comments/helpers or implementations, proliferating state, confusing ownership or
naming, fragile references, and invalidation hazards. A specific future-error risk is a concrete
consequence; a runtime reproduction is not required.
Compare every new helper and branch with adjacent code and existing helpers. Check repeated guards,
duplicated classification logic, copied protocol rules, hand-built fixtures, extra lifecycle flags,
and references into growable containers. For each lead, identify the two sources that can drift or
the edit that would expose the hazard.
Keep a plausible future-edit risk as an atomic candidate with that edit and consequence, even when
present behavior is correct; Codex may classify it as a suggestion.
