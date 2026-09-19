'use strict'
// What differs between the two things this plugin drafts - a PR description and an issue - and
// nothing else. The driver is one state machine. The cache root, the state directory, the files
// that outrank observed practice, the frontmatter key the sampled numbers live under, the header
// the verifier reports them under, and every instruction that talks about "the diff" or "the
// maintainer" come from here, so adding a third thing to draft is adding an entry, not a driver.
//
// Every line of text here is fixed. Nothing derived from a repository is interpolated into an
// instruction: the driver prints repo-derived strings as data under a header, never as imperatives.
const path = require('path')

const PERMALINKS = [
  'CODE REFERENCES ARE PERMALINKS. Never `path/to/file.py:42` - that is a terminal convention and',
  'is dead text on GitHub. Use a raw GitHub url pinned to a full commit SHA, never a branch, on a',
  'line of its own so GitHub expands it into a snippet:',
  '  https://github.com/<owner>/<repo>/blob/<full-sha>/<path>#L42-L50',
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
  // A description is checked against the change it describes; there is a diff and a changed-file
  // list. An issue has neither.
  hasDiff: true,
  // The files whose change makes the cache wrong the same day: the PR template, the contributing
  // guide, CLAUDE.md, AGENTS.md, commitlint.
  sources: {
    dirs: ['', '.github', 'docs', path.join('.github', 'PULL_REQUEST_TEMPLATE'), path.join('docs', 'PULL_REQUEST_TEMPLATE')],
    name: /^(pull_request_template(\.|$)|contributing(\.|$)|claude\.md$|agents\.md$|\.commitlintrc|commitlint\.config\.)/i,
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
    passed: 'every section present, every file named is one this change touches.',
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
  hasDiff: false,
  // The issue templates - legacy markdown, issue forms, config.yml with its contact links - plus
  // the contributing guide, CLAUDE.md and AGENTS.md.
  sources: {
    dirs: ['', '.github', 'docs', path.join('.github', 'ISSUE_TEMPLATE'), path.join('docs', 'ISSUE_TEMPLATE')],
    name: /^(issue_template(\.|$)|contributing(\.|$)|claude\.md$|agents\.md$)/i,
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

const DOMAINS = { pr, issue }

function domain(key) {
  return DOMAINS[key || 'pr'] || null
}

module.exports = { DOMAINS, domain, PERMALINKS }
