# Canonical fields

What a commit message must convey, regardless of repo. Every field in the **first** table has to
survive into a repo's learned prompt — renamed, reordered, reformatted, merged with a neighbour, all
fine; silently dropped, not fine. The second table is the opposite and says so there: those fields
appear only where the repo itself writes them.

Edit this file to change what you want in your commit messages. Existing caches keep the old shape
until they are rebuilt, so run `/draft-commit-message --refresh-cache` in a repo after changing it.

| field | what it answers | notes |
|---|---|---|
| `summary` | What changed, in one line? | The subject, in this repo's grammar: its prefix or type, its tense, its case, its length. It stands alone in `git log --oneline`. "fix bug" and "update code" are not summaries. |
| `motivation` | Why? | The problem, the constraint that forced this shape, the alternative rejected — what `git blame` will need that the diff does not say. This is the body. It may collapse into the subject only where the repo commits one-liners for changes of this size and the prompt says so. |
| `references` | Which issue, ticket or PR does this belong to, in the repo's form? | `Fixes #N`, `Refs: #N`, a Jira key in the subject, a URL — whatever this repo does. Omit only when there is genuinely nothing to reference. |

## Repo-conditional fields

These are **only** included when the repo's own configuration or its authors' commits actually have
them. The gate does not require them, and a learned prompt must not invent one because it looks like
good practice. A repo that does not sign off its commits gets messages that do not either.

| field | what it answers | notes |
|---|---|---|
| `testing` | How was it verified? | A line or two, only where a clear majority of the sampled human-written bodies carry one. |
| `sign-off` | `Signed-off-by: Name <email>` | Only where CONTRIBUTING, a DCO check or a commit-msg hook requires it. The identity is the committer's (`git var GIT_COMMITTER_IDENT`), never invented. |
| `breaking-change` | `BREAKING CHANGE:` footer or `!` after the type | Only in repos that follow Conventional Commits, and only when the change breaks something. |
| `co-authors` | `Co-authored-by:` trailers for human pair authors | Only where the repo uses them. Never a tool. |

## Two different kinds of conditional

The section above is conditional **on the repo**: the field never appears unless that repo writes
it. This one is conditional **on the change**: the field is always part of the prompt, but its
line may be absent from a particular message.

`references` is the field that may vanish when there is nothing to reference. `motivation` does not
vanish: where the repo allows a one-line commit, the subject *is* the motivation, and the prompt has
to say for which changes that is acceptable.

## What never goes in

- **Any tooling banner.** No `Co-Authored-By: Claude`, no "Generated with Claude Code", no robot
  emoji, no link to claude.com. The commit is the author's. Trailers the repo requires of humans —
  `Signed-off-by`, `Co-authored-by` for a real pair — are a different matter. Enforced mechanically
  by the driver.
- **A narration of the diff.** "Changed X to Y in foo.py, also updated the tests" — the reader is one
  `git show` from all of that. The body is for what the diff cannot say.
- **Web permalinks.** A commit message is read in a terminal. `path/to/file.py:42` is the right form
  here, the opposite of the rule for PR descriptions and issues.
- **Markdown.** No headings, no bold, no fenced blocks — unless this repo's commits demonstrably
  carry them. A `#` line is a comment to git the moment the message is opened in an editor.
- **A subject that is a sentence.** Past the wrap column it is truncated in every listing that
  shows it. The one thing the commit does, then the body.
- Anything the author cannot substantiate from the diff or the conversation: an invented issue
  number, a test run that did not happen, a "since X.Y" that was not checked.
