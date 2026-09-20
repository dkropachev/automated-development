'use strict'
// What differs between the things this plugin drafts - a PR description, an issue, a commit
// message - and nothing else. The driver is one state machine. The cache root, the state directory,
// the files that outrank observed practice, the frontmatter key the sampled identifiers live under,
// the header the verifier reports them under, which mechanical checks apply (a commit message is
// read in a terminal, so permalinks are not required of it), and every instruction that talks about
// "the diff" or "the maintainer" come from here, so adding a thing to draft is adding an entry, not
// a driver.
//
// Every line of text here is fixed. Nothing derived from a repository is interpolated into an
// instruction: the driver prints repo-derived strings as data under a header, never as imperatives.
const path = require('path')

const PERMALINKS = [
  'CODE REFERENCES ARE PERMALINKS. Never `path/to/file.py:42` - that is a terminal convention and',
  'is dead text on GitHub. Use a raw URL on this repository host, pinned to a full commit SHA, never a branch, on a',
  'line of its own so GitHub expands it into a snippet:',
  '  https://<host>/<owner>/<repo>/blob/<full-sha>/<path>#L42-L50',
  'Get the SHA with `git rev-parse HEAD`, use the one the line actually exists at upstream, and do',
  'not wrap the url in markdown link text or a fenced block - either one kills the preview.',
]

const pr = {
  key: 'pr',
  skill: 'draft-pr-description',
  cacheRoot: path.join('.claude', 'pr-style-cache'),
  stateDir: path.join('.claude', 'draft-pr-description', 'state'),
  // What the DRAFT machine produces, and what the BUILD machine's prompt teaches a later run to write.
  artifact: 'PR description',
  produces: 'a PR title and description',
  // What the builder samples, singular and plural, and where their numbers are recorded.
  sample: 'PR', samples: 'PRs',
  sourceKey: 'source_prs', resultKey: 'sourcePrs', checkedKey: 'CHECKED_PRS',
  // What a sampled identifier looks like - a PR number here, a commit SHA for a commit.
  idPattern: /^\d+$/,
  // A description is checked against the change it describes; there is a diff and a changed-file
  // list. An issue has neither.
  hasDiff: true,
  // Read in a browser: code references must be permalinks, and path:line is rejected.
  web: true,
  // Soft ceilings on the title, and the floor under which a draft is not a draft at all.
  titleMax: 100, minBytes: 120,
  // Whether a prompt may declare `Label:`-style sections as well as markdown headings.
  labels: false,
  // The files whose change makes the cache wrong the same day: the PR template, the contributing
  // guide, CLAUDE.md, AGENTS.md, commitlint.
  sources: {
    dirs: ['', '.github', 'docs', path.join('.github', 'workflows'), path.join('.github', 'PULL_REQUEST_TEMPLATE'), path.join('docs', 'PULL_REQUEST_TEMPLATE')],
    name: /^(pull_request_template(\.|$)|contributing(\.|$)|claude\.md$|agents\.md$|\.commitlintrc|commitlint\.config\.|.*lint.*\.ya?ml$)/i,
    templateDir: /PULL_REQUEST_TEMPLATE$/,
  },
  text: {
    writeHeadline: 'WRITE THE DESCRIPTION',
    write: (st) => [
      'Write the PR title and description for the change in front of you, following the cached',
      'prompt for this repository - its sections, its order, its title format, its tone:',
      '  ' + st.prompt,
      '',
      'That prompt is authoritative. Do not substitute your own conventions for it, do not add a',
      'section it does not ask for, and do not drop one because this change seems too small to',
      'need it. In particular: if the prompt does not ask how the change was tested, write nothing',
      'about testing. That is not an oversight in the prompt - it means this repo does not write',
      'test plans in its PRs, and adding one puts words in their mouth.',
      '',
      'Draw on THIS conversation first. You have been working on this change: you know why it was',
      'made, what was tried and abandoned, which tests you actually ran. None of that is in the',
      'diff, and it is the part a description exists to carry. Fetch from git or gh only what you',
      'genuinely do not already have.',
      '',
      'Claim nothing you cannot point at. Every file you name, every test you say passes, every',
      'benchmark - if it is not in the diff or in this conversation, it does not go in.',
      '',
      'Write it the way the best PRs in this repo are written, not the average ones: short, direct,',
      'and leading with the fact. The first sentence of a section carries its point - no warm-up',
      'clause, no restating the heading. Cut every word that carries nothing ("in order to" is "to",',
      '"due to the fact that" is "because", "it is worth noting that" is nothing at all), and do not',
      'hedge where you actually know the answer. Shorter is the tie-breaker, always.',
      '',
      ...PERMALINKS,
      '',
      'NO TOOLING BANNER. No "Generated with Claude Code", no robot emoji, no Co-Authored-By line,',
      'no link to claude.com - not at the end, not anywhere. This is the author\'s description of',
      'their own change. Whatever attribution convention applies to commits does not apply here,',
      'and this is checked.',
    ],
    format: () => [
      'The first line must be `Title: <the title>`, then a blank line, then the body.',
    ],
    review: () => [
      'Now read the description back as it stands on disk - not your memory of writing it - and read',
      'the diff again beside it.',
      '',
      'CUT FIRST. This pass is for taking things out, and most passes should end shorter than they',
      'started. A PR description is read by someone deciding where to look, not by someone who wants',
      'the change explained to them - they have the diff for that.',
      '',
      '  - What in here restates the diff? Delete it. A bullet per file, a walk through the control',
      '    flow, a list of renamed symbols: the reviewer is about to read all of that anyway.',
      '  - What is true but not worth the reader\'s time? Delete it.',
      '  - Which sentence hedges a claim you could either prove or drop? Do one or the other.',
      '  - Is any section saying the same thing as its neighbour under a different heading?',
      '  - Does the whole thing look like the PRs the cached prompt describes, in SHAPE and LENGTH,',
      '    or is it visibly longer than what this repo merges?',
      '',
      'Only then, what is missing:',
      '',
      '  - Is anything in the diff genuinely unexplained - not undescribed, unexplained?',
      '  - Does the motivation say what you understood the problem to be, or has it drifted into a',
      '    summary of the code you wrote?',
      '  - Would a reviewer who has not read this conversation know what to look at first?',
      '  - Is anything in here only true of an earlier version of the change?',
    ],
    again: (changed) => changed
      ? 'You changed something, so there was something to change. A description with one weak claim usually has its neighbour: the section you wrote first and never re-read, the sentence carried over from the commit message. If that pass only ADDED, it was half a pass - go back and take something out.'
      : 'Nothing that pass. That is not yet evidence it is right - it is evidence of one pass. Try something you have not: read it aloud and stop at the first sentence a reviewer would skip, or read the description without looking at the code at all and see what it leaves you guessing.',
    passed: 'every section is present and every file named exists in the repository.',
    longTitle: (n) => [
      'The title is ' + n + ' characters. Every listing a reviewer meets it in will',
      'truncate it, so the part past ~70 is written for nobody. Say the one thing it is for and',
      'move the rest into the body.',
    ],
    print: () => 'Then print the title and body to the user, exactly as the file has them, and:',
    lastRead: () => [
      'One last thing, and it is a read, not a write. Read it once as the reviewer who gets this PR',
      'cold on a Monday morning. If the first paragraph does not tell them why this exists, fix that',
      'one thing now.',
    ],
    referenced: (files) => [
      '', 'Files you name that exist but this change does not touch. That is allowed - a',
      'description may point at context - but check each one is deliberate:',
      ...files.map(f => '  - ' + f),
    ],
    // The BUILD machine.
    buildIntro: () => [
      'You are writing a GENERATION PROMPT for one repository: the instructions a later run will',
      'follow to draft a PR title and description in that repo\'s own style. You are not writing a PR',
      'description yourself, and nothing you produce is shown to a user.',
    ],
    critique: () => [
      '  - Would a competent writer given ONLY this prompt, a diff and a commit log produce something',
      '    that looks like the sampled PRs? Where would they guess?',
      '  - Is every rule stated concretely - a real heading, a real prefix, a real length - or does it',
      '    hide behind "follow the repo\'s conventions" and "match the existing style"?',
      '  - Is it describing what these PRs CONSISTENTLY do, or something one PR did once?',
      '  - Does anything contradict the repo\'s own template or CONTRIBUTING, which outrank observation?',
      '  - Does it invent a section, a checklist or a sign-off line that the evidence does not support?',
      '  - Would it survive a PR unlike the ones you sampled - a revert, a one-line fix, a big refactor?',
    ],
    againBuild: () => 'Nothing that pass. That is not yet evidence the prompt is good - it is evidence of one pass. Look along something you have not tried yet: re-read the raw PR bodies you sampled and check the prompt against two of them you have not thought about since.',
  },
}

const issue = {
  key: 'issue',
  skill: 'draft-issue-description',
  cacheRoot: path.join('.claude', 'issue-style-cache'),
  stateDir: path.join('.claude', 'draft-issue-description', 'state'),
  artifact: 'issue',
  produces: 'an issue title and body',
  sample: 'issue', samples: 'issues',
  sourceKey: 'source_issues', resultKey: 'sourceIssues', checkedKey: 'CHECKED_ISSUES',
  idPattern: /^\d+$/,
  hasDiff: false,
  web: true,
  titleMax: 100, minBytes: 120,
  labels: false,
  // The issue templates - legacy markdown, issue forms, config.yml with its contact links - plus
  // the contributing guide, CLAUDE.md and AGENTS.md.
  sources: {
    dirs: ['', '.github', 'docs', path.join('.github', 'ISSUE_TEMPLATE'), path.join('docs', 'ISSUE_TEMPLATE')],
    name: /^(issue_template(\.|$)|support(\.|$)|contributing(\.|$)|claude\.md$|agents\.md$)/i,
    templateDir: /ISSUE_TEMPLATE$/,
  },
  text: {
    writeHeadline: 'WRITE THE ISSUE',
    write: (st) => [
      'Write the issue title and body for the problem in front of you, following the cached prompt',
      'for this repository - its kinds, its sections, its order, its title format, its labels, its',
      'tone:',
      '  ' + st.prompt,
      ...(st.kind ? ['',
        'The kind of issue being written is recorded under this header. Use the sections the prompt',
        'declares for that kind, in that order, and no others:',
        '  kind: ' + st.kind] : []),
      '',
      'That prompt is authoritative. Do not substitute your own conventions for it, do not add a',
      'section it does not ask for, and do not drop one because this problem seems too small to',
      'need it. In particular: if the prompt does not ask for a proposed fix, do not propose one.',
      'That is not an oversight - it means this repo\'s issues describe the problem and leave the',
      'design to the thread, and a fix in the report puts words in the maintainers\' mouths.',
      '',
      'Draw on THIS conversation first. You have seen the failure: the command that was run, what it',
      'printed, the version it ran against, the file the trace names, what was tried and ruled out.',
      'None of that is on GitHub yet, and it is the part an issue exists to carry. Fetch from git or',
      'gh only what you genuinely do not already have.',
      '',
      'Claim nothing you cannot point at. Every version, every log line, every file, every "since',
      'X.Y" - if it is not in this conversation or in the repository, it does not go in. A',
      'reproduction you have not actually run is a guess, and is written as one.',
      '',
      'Write it for the maintainer who has not seen what you saw. The first sentence says what is',
      'wrong, as a user meets it - not what you think the cause is, and not the fix. Cut every word',
      'that carries nothing ("in order to" is "to", "due to the fact that" is "because", "it is',
      'worth noting that" is nothing at all), and do not hedge where you actually know the answer.',
      'Shorter is the tie-breaker, always - a log trimmed to the lines that matter beats a paste.',
      '',
      ...PERMALINKS,
      '',
      'NO TOOLING BANNER. No "Generated with Claude Code", no robot emoji, no Co-Authored-By line,',
      'no link to claude.com - not at the end, not anywhere. This is the author\'s report of what',
      'they saw. Whatever attribution convention applies to commits does not apply here, and this',
      'is checked.',
    ],
    format: () => [
      'The first line must be `Title: <the title>`. If the prompt names labels for this kind, the',
      'second line is `Labels: <comma-separated>`. Then a blank line, then the body.',
      '',
      'Template comments - `<!-- ... -->` - are the template\'s instructions to the author, not',
      'content. None of them survive into the body, and neither does any placeholder line the',
      'template shipped with.',
    ],
    review: () => [
      'Now read the issue back as it stands on disk - not your memory of writing it - as the',
      'maintainer who will triage it: someone with the repository open but not your terminal.',
      '',
      'CUT FIRST. This pass is for taking things out, and most passes should end shorter than they',
      'started. An issue is read by someone deciding whether it is real, whether it is a duplicate,',
      'and who should look - not by someone who wants the story of how it was found.',
      '',
      '  - What in here is the story of your afternoon rather than the failure? Delete it. What was',
      '    tried before the cause was found matters only where it narrows the cause.',
      '  - What is speculation about the cause dressed as fact? Show the evidence or mark it a guess.',
      '  - Which sentence hedges a claim you could either prove or drop? Do one or the other.',
      '  - Is a log or trace pasted whole where six lines would do?',
      '  - Is any section saying the same thing as its neighbour under a different heading?',
      '  - Does the whole thing look like the issues the cached prompt describes, in SHAPE and LENGTH,',
      '    or is it visibly longer than what this repo\'s own maintainers file?',
      '',
      'Only then, what is missing:',
      '',
      '  - Could a maintainer reproduce this from what is here, with nothing from your machine? If',
      '    the prompt has a reproduction section, are the steps numbered, minimal, and ones you ran?',
      '  - Is the version a number, not "latest"? Is the platform stated where it could matter?',
      '  - Is the expected behaviour stated, or only implied by the complaint?',
      '  - Is a related issue or PR linked where you know of one?',
      '  - Is anything in here only true of an earlier understanding of the problem?',
    ],
    again: (changed) => changed
      ? 'You changed something, so there was something to change. An issue with one weak claim usually has its neighbour: the section you wrote first and never re-read, the log block pasted whole. If that pass only ADDED, it was half a pass - go back and take something out.'
      : 'Nothing that pass. That is not yet evidence it is right - it is evidence of one pass. Try something you have not: read it with your terminal closed and list what a maintainer would still have to ask you for, or read only the first paragraph and see whether it says what is wrong.',
    passed: 'every section present, every file named exists in the repository.',
    longTitle: (n) => [
      'The title is ' + n + ' characters. Every listing a maintainer meets it in will',
      'truncate it, so the part past ~70 is written for nobody. Say the one thing that is wrong and',
      'move the rest into the body.',
    ],
    print: (r) => 'Then print the title' + (r.labels ? ', labels' : '') + ' and body to the user, exactly as the file has them, and:',
    lastRead: () => [
      'One last thing, and it is a read, not a write. Read it once as the maintainer who gets this',
      'issue cold on a Monday morning. If the first paragraph does not tell them what is wrong and',
      'where, fix that one thing now.',
    ],
    // An issue has no diff, so a file it names that exists is simply a file it names. Nothing to say.
    referenced: () => [],
    buildIntro: () => [
      'You are writing a GENERATION PROMPT for one repository: the instructions a later run will',
      'follow to draft an issue title and body in that repo\'s own style. You are not writing an',
      'issue yourself, and nothing you produce is shown to a user.',
    ],
    critique: () => [
      '  - Would a competent writer given ONLY this prompt and a failure they had just seen produce',
      '    something that looks like the sampled issues? Where would they guess?',
      '  - Is every rule stated concretely - a real heading, a real label, a real length - or does it',
      '    hide behind "follow the repo\'s conventions" and "match the existing style"?',
      '  - Is it describing what these issues CONSISTENTLY do, or something one issue did once?',
      '  - Does anything contradict the repo\'s own templates, config.yml or CONTRIBUTING, which',
      '    outrank observation? Is every issue-form label reproduced verbatim, in the form\'s order?',
      '  - Does it invent a section, a checklist or a kind that the evidence does not support?',
      '  - Would a writer know WHICH kind an issue is from the prompt alone, and what happens to a',
      '    report that fits none - a question, a support request the repo routes elsewhere?',
      '  - Would it survive an issue unlike the ones you sampled - a one-line crash, a feature with',
      '    a design sketch, a docs typo?',
    ],
    againBuild: () => 'Nothing that pass. That is not yet evidence the prompt is good - it is evidence of one pass. Look along something you have not tried yet: re-read the raw issue bodies you sampled and check the prompt against two of them you have not thought about since.',
  },
}

const commit = {
  key: 'commit',
  skill: 'draft-commit-message',
  cacheRoot: path.join('.claude', 'commit-style-cache'),
  stateDir: path.join('.claude', 'draft-commit-message', 'state'),
  artifact: 'commit message',
  produces: 'a commit subject and body',
  sample: 'commit', samples: 'commits',
  sourceKey: 'source_commits', resultKey: 'sourceCommits', checkedKey: 'CHECKED_COMMITS',
  // Abbreviated or full SHAs. Two of them name the same commit when one is a prefix of the other.
  idPattern: /^[0-9a-f]{7,40}$/i,
  // A commit message describes the staged change: there is a diff and a changed-file list.
  hasDiff: true,
  // Read in a terminal. path:line is the natural form; a web permalink is not asked for.
  web: false,
  // 72 is where `git log --oneline`, GitHub and every mail client start truncating a subject. A
  // one-line commit has no body, so the floor is the subject alone.
  titleMax: 72, minBytes: 30,
  // A body may be shaped by `Problem:` / `Solution:` labels rather than markdown headings.
  labels: true,
  // The commit template, commitlint, commitizen, semantic-release, a commit-msg hook, the
  // contributing guide, CLAUDE.md, AGENTS.md, and any workflow that lints commits.
  sources: {
    dirs: ['', '.github', 'docs', '.husky', path.join('.github', 'workflows')],
    name: /^(\.gitmessage|\.git-commit-template|commit[-_]?template|\.commitlintrc|commitlint\.config\.|\.czrc$|\.cz\.|cz\.json$|\.versionrc|\.releaserc|release\.config\.|\.pre-commit-config\.ya?ml$|commit-msg$|contributing(\.|$)|claude\.md$|agents\.md$|.*(commit|dco).*\.ya?ml$)/i,
    templateDir: /$^/,
  },
  text: {
    writeHeadline: 'WRITE THE COMMIT MESSAGE',
    write: (st) => [
      'Write the commit message for the change in front of you - the staged diff, or the commit being',
      'amended - following the cached prompt for this repository: its subject grammar, its body shape,',
      'its wrap column, its references and trailers, its tone:',
      '  ' + st.prompt,
      '',
      'That prompt is authoritative. Do not substitute your own conventions for it: not Conventional',
      'Commits where this repo does not use them, not a body where this repo\'s one-line changes have',
      'none, not a Signed-off-by this repo never asks for - and never without one where it does.',
      '',
      'Draw on THIS conversation first. You made this change: you know why, what was tried and',
      'abandoned, and what a future `git blame` will need that the diff does not say. That is what',
      'the body is for. The subject says WHAT changed, in this repo\'s grammar; the body says WHY, and',
      'what a reader of the log two years from now would otherwise have to reconstruct.',
      '',
      'Claim nothing you cannot point at. Every file you name, every issue you reference, every test',
      'you say you ran - if it is not in the diff or in this conversation, it does not go in.',
      '',
      'Write it the way the best commits in this repo are written, not the average ones: a subject',
      'that stands alone in `git log --oneline`, a body that leads with the reason. Cut every word',
      'that carries nothing ("in order to" is "to", "this commit" is nothing at all), do not narrate',
      'the diff hunk by hunk, and do not hedge where you know the answer. Shorter is the tie-breaker.',
      '',
      '`path/to/file.py:42` is fine here - a commit message is read in a terminal, not a browser. Do',
      'not paste web permalinks into it.',
      '',
      'NO TOOLING BANNER. No "Generated with Claude Code", no robot emoji, no Co-Authored-By: Claude',
      'trailer, no link to claude.com. This is the author\'s account of their own change, and this is',
      'checked. Trailers the REPO requires - Signed-off-by, Fixes - are a different matter, and the',
      'prompt names them.',
    ],
    format: () => [
      'The first line must be `Title: <the subject line>`, then a blank line, then the body exactly as',
      'it will be committed - wrapped at the column the prompt gives, trailers last, no markdown',
      'headings unless this repo\'s commits carry them. The body may be empty only where the prompt',
      'says this repo commits one-liners for a change like this.',
    ],
    review: () => [
      'Now read the message back as it stands on disk - not your memory of writing it - and read the',
      'diff again beside it.',
      '',
      'CUT FIRST. This pass is for taking things out. A commit message is read by someone running',
      '`git log` or `git blame` who wants to know why this line is the way it is - not by someone who',
      'wants the diff narrated; they have `git show` for that.',
      '',
      '  - What in here restates the diff? Delete it. A sentence per hunk, a list of renamed symbols,',
      '    "also updated the tests": the reader is one keystroke from all of that.',
      '  - Does the subject say WHAT changed, or is it a vague "fix bug" / "update code" / "changes"?',
      '  - Is the body explaining WHY, or repeating the subject in more words?',
      '  - Which sentence hedges a claim you could either prove or drop? Do one or the other.',
      '  - Does the whole thing look like the commits the cached prompt describes, in SHAPE and',
      '    LENGTH - or is it visibly longer than what this repo\'s authors write for a change this size?',
      '',
      'Only then, what is missing:',
      '',
      '  - Would `git blame` on the trickiest line of this diff land on a message that explains it?',
      '  - Is the alternative you rejected, or the constraint that forced this shape, written down?',
      '  - Is the issue referenced in the form this repo uses, where there is one?',
      '  - Is every trailer the repo requires present, spelled as the repo spells it?',
      '  - Is anything in here only true of an earlier version of the change?',
    ],
    again: (changed) => changed
      ? 'You changed something, so there was something to change. A message with one weak line usually has its neighbour: the subject you wrote first and never re-read against the final diff, the paragraph carried over from a PR description. If that pass only ADDED, it was half a pass - go back and take something out.'
      : 'Nothing that pass. That is not yet evidence it is right - it is evidence of one pass. Try something you have not: read only the subject and ask whether it would let you pick this commit out of fifty in `git log --oneline`, or read the body without the diff and see what it leaves you guessing.',
    passed: 'every part the prompt asks for present, every file named exists in the repository.',
    longTitle: (n, max) => [
      'The subject is ' + n + ' characters against this repo\'s guide of ' + max + '. `git log --oneline`,',
      'GitHub and every mail client truncate it there. Say the one thing this commit does and move',
      'the rest into the body.',
    ],
    print: () => 'Then print the message to the user exactly as the file has it below the Title line - subject, blank line, body - in one fenced block, and:',
    lastRead: () => [
      'One last thing, and it is a read, not a write. Read it once as the person running `git blame`',
      'on this change in two years. If the body does not tell them why, fix that one thing now.',
    ],
    referenced: (files) => [
      '', 'Files you name that exist but this change does not touch. That is allowed - a message may',
      'point at context - but check each one is deliberate:',
      ...files.map(f => '  - ' + f),
    ],
    buildIntro: () => [
      'You are writing a GENERATION PROMPT for one repository: the instructions a later run will',
      'follow to write a commit message in that repo\'s own style. You are not writing a commit',
      'message yourself, and nothing you produce is shown to a user.',
    ],
    critique: () => [
      '  - Would a competent writer given ONLY this prompt and a staged diff produce something that',
      '    belongs in this repo\'s `git log`? Where would they guess?',
      '  - Is every rule stated concretely - a real subject grammar, a real length, a real wrap column,',
      '    a real trailer spelling - or does it hide behind "follow the repo\'s conventions"?',
      '  - Is it describing what these commits CONSISTENTLY do, or something one author did once?',
      '  - Does anything contradict commitlint, the commit template, CONTRIBUTING or a commit-msg hook,',
      '    which outrank observation?',
      '  - Does it invent a body requirement, a trailer or a type vocabulary the evidence does not',
      '    support?',
      '  - Would it survive a commit unlike the ones you sampled - a revert, a one-line typo fix, a',
      '    large refactor, a dependency bump?',
    ],
    againBuild: () => 'Nothing that pass. That is not yet evidence the prompt is good - it is evidence of one pass. Look along something you have not tried yet: re-read the raw commit messages you sampled and check the prompt against two of them you have not thought about since.',
  },
}

const DOMAINS = { pr, issue, commit }

// Whether two sampled identifiers name the same thing: PR and issue numbers by equality, commit SHAs
// by prefix - the builder records abbreviated SHAs and the verifier may quote full ones.
function sameId(a, b) {
  const x = String(a).toLowerCase(), y = String(b).toLowerCase()
  if (x === y) return true
  if (!/^[0-9a-f]{7,40}$/.test(x) || !/^[0-9a-f]{7,40}$/.test(y)) return false
  return x.startsWith(y) || y.startsWith(x)
}

function domain(key) {
  return DOMAINS[key || 'pr'] || null
}

module.exports = { DOMAINS, domain, sameId, PERMALINKS }
