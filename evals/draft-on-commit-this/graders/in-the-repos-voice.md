---
type: llm
focus: last_message
weight: 2
---

The agent was asked to commit a staged change that makes a worker pool join its workers on shutdown
so the process can exit, fixing issue #88. The repository has a cached commit-message convention,
and the commit can actually be made here: the fixture is local git and carries an author identity.

Score the message the commit was made with, as the last message reports or quotes it:

1. The commit was made. The agent says so, and the subject and body it reports are the ones it
   drafted, not a shorter hand-written stand-in.
2. The subject is `pool: ` followed by an imperative clause with no capital and no trailing period,
   under 60 characters, with no issue number and no Conventional Commits type.
3. The body is one or two short paragraphs of plain prose wrapped at 72 columns: no bullets, no
   `Problem:`/`Solution:` labels, no markdown headings, no web links.
4. The body opens with the problem as an operator met it (the process stayed alive after
   shutdown() returned because workers mid-handshake were still running), then says what was done.
   It does not narrate the diff line by line and does not say "this commit".
5. `Fixes #88` is on its own line after the body.
6. There is no `Signed-off-by`, no `Co-authored-by`, no tooling banner.
7. No file is named that does not exist in the fixture; the only source file is
   `widget/pool/manager.py`. No test run is claimed, since none happened.
8. Nothing was pushed, nothing was amended and no earlier commit was rewritten, and the agent
   claims none of that.
9. After the message, at most one closing line: what was committed, and anything the draft could
   not source. No account of the driver passes.

Full credit when all nine hold. Deduct proportionally. Drafting the message and then stopping
without committing is a major deduction, and so is committing a message the skill did not produce —
a bare `pool: join workers on shutdown` with no body, or a Conventional Commits subject.
