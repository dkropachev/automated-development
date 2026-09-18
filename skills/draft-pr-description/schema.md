# Canonical fields

What a PR description must convey, regardless of repo. Every field in the **first** table has to
survive into a repo's learned prompt — renamed, reordered, reformatted, merged with a neighbour, all
fine; silently dropped, not fine. The second table is the opposite and says so there: those fields
appear only where the repo itself writes them.

Edit this file to change what you want in your PR descriptions. Existing caches keep the old shape
until they are rebuilt, so run `/draft-pr-description --refresh-cache` in a repo after changing it.

| field | what it answers | notes |
|---|---|---|
| `motivation` | Why does this change exist? What was broken, missing or slow? | User-visible framing, not "refactor X". If an issue exists, this is where it is linked. |
| `summary-of-changes` | What did you actually change? | One item per logical change. Not a file list — the diff already is one. |
| `risk` | What could this break, and what happens if it does? | Blast radius, rollback, feature flag, migration order. Explicitly "none" when none. |
| `breaking-changes` | Does anything downstream have to change? | API, config, schema, wire format. Omit the section entirely when there are none, unless the repo always shows it. |

## Repo-conditional fields

These are **only** included when the repo's own PRs or its template actually have such a section.
The gate does not require them, and a learned prompt must not invent one because it looks like good
practice. A repo that does not write about testing in its PRs gets descriptions that do not either.

| field | what it answers | notes |
|---|---|---|
| `testing` | How do you know it works? | Named tests, or the manual steps taken. Include only on the evidence of the sampled PRs or the repo's template — never by default. "Tested locally" is not an answer even where the section does belong. |

## Two different kinds of conditional

The section above is conditional **on the repo**: the field never appears unless that repo writes
about it. This one is conditional **on the change**: the field is always part of the prompt, but its
section may be absent from a particular description.

`breaking-changes` is the only field that may disappear when empty. `risk` says "none" rather than
vanishing — an empty risk section and an unconsidered risk look identical, and the point is to show
it was considered.

## What never goes in

- **Any tooling banner.** No "🤖 Generated with Claude Code", no `Co-Authored-By: Claude`, no link
  to claude.com. A PR description is the author's account of their own change; a generated-by line
  turns it into an advert that reviewers learn to skip past. Whatever attribution convention applies
  to commit messages does not apply here. This one is enforced mechanically by the driver, not left
  to good intentions.
- **`file:line` code references.** Anything written for GitHub points at code with a raw permalink
  pinned to a full commit SHA, on a line of its own, and the commit has to be pushed. `path/to/x.py:42`
  is a terminal convention and is dead text in a browser. Also mechanically enforced.
- Restating the diff line by line.
- Tables of contents, emoji headers, or a "Summary" that repeats the title.
- Anything the author cannot substantiate from the code or the issue — no invented benchmarks,
  no invented test runs, no invented reviewers.
