# Canonical fields

What an issue must convey, regardless of repo. Every field in the **first** table has to survive
into a repo's learned prompt — renamed, reordered, reformatted, merged with a neighbour, all fine;
silently dropped, not fine. When the prompt distinguishes kinds of issue (a bug report, a feature
request), every kind is judged separately: a `problem` section that exists only for bugs leaves the
feature kind uncovered. The second table is the opposite and says so there: those fields appear
only where the repo itself asks for them.

Edit this file to change what you want in your issues. Existing caches keep the old shape until they
are rebuilt, so run `/draft-issue-description --refresh-cache` in a repo after changing it.

| field | what it answers | notes |
|---|---|---|
| `problem` | What is wrong, missing or slow, as a user or operator meets it? | The symptom or the gap, and why it matters — not the cause you suspect and not the fix. For a feature, what cannot be done today. |
| `expected` | What should happen instead? | For a bug, the correct behaviour. For a feature, the outcome wanted, stated as behaviour rather than as an implementation. |

## Repo-conditional fields

These are **only** included when the repo's own templates or its maintainers' issues actually have
such a section. The gate does not require them, and a learned prompt must not invent one because it
looks like good practice. A repo whose bug form has no log field gets bug reports that do not either.

| field | what it answers | notes |
|---|---|---|
| `context` | Which version, component, platform or configuration is involved? | Only where the template has a version or environment field, or the repo's own issues carry one. A version is a number, never "latest"; for a feature, the component it belongs to. |
| `reproduction` | How does a maintainer see it for themselves? | Numbered, minimal, actually run. Nearly every bug template asks for it, so it is nearly always present for the bug kind — but on the evidence of the template, never by default, and never for a feature request. |
| `evidence` | What did you actually see? | The log lines, the trace, the screenshot, trimmed to what matters. Include where the template has a log or output field. |
| `proposal` | What would you do about it? | A sketch of a fix or a design. Only where the template asks ("Describe the solution you'd like") or a clear majority of maintainers' issues of that kind carry one. |
| `workaround` | Is there a way round it today? | Only where the template asks. |

## Two different kinds of conditional

The section above is conditional **on the repo**: the field never appears unless that repo asks for
it. This one is conditional **on the issue**: a field the repo does ask for is always part of the
prompt, but its section may be thin in a particular draft.

`problem` and `expected` are full sections whatever the kind, and neither may be a line: "it's
broken" is not a problem statement and "it should work" is not an expected behaviour. A
repo-conditional field that the repo does ask for may still be thin in a particular draft —
`context` is usually the one that collapses to "2.3.1 on Linux" — but it is not left out of a draft
whose repo asks for it.

## What never goes in

- **Any tooling banner.** No "🤖 Generated with Claude Code", no `Co-Authored-By: Claude`, no link
  to claude.com. An issue is the reporter's account of what they saw; a generated-by line turns it
  into something maintainers learn to deprioritise. Enforced mechanically by the driver.
- **`file:line` code references.** Anything written for GitHub points at code with a raw permalink
  pinned to a full commit SHA, on a line of its own, and the commit has to be pushed. `path/to/x.py:42`
  is a terminal convention and is dead text in a browser. Also mechanically enforced.
- **Template comments and placeholder text.** `<!-- A clear and concise description -->` and the
  form's own hints are instructions to the author. None survive into the body. Mechanically enforced.
- **The fix, where the problem should be.** A first paragraph that says what to change instead of
  what is wrong makes the maintainer reverse-engineer the symptom. If the repo has a place for
  proposals, it goes there; if not, it goes in the thread later.
- Speculation about the cause stated as fact, invented versions, invented log lines, a reproduction
  that was not run, a "since X.Y" that was not checked.
- Emoji headers, a "Summary" that repeats the title, the story of how the bug was found.
