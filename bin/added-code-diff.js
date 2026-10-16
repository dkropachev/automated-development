#!/usr/bin/env node
'use strict'

// A display-only Git diff for prompts. Replacement removals use explicit placeholder lines.
const fs = require('fs')

const NOTICE = 'Display-only diff: each -[N removed lines omitted] marker replaces one consecutive run of removed lines in a replacement. Deletion-only lines are shown. Whole-file deletion contents are omitted. Hunk ranges are adjusted for this view. To inspect hidden code, run git diff manually. Do not apply this filtered diff.\n'
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || []
}

function renderBlock(block) {
  const replacement = block.some(entry => entry.kind === '+') && block.some(entry => entry.kind === '-')
  if (!replacement) return { lines: block.flatMap(entry => [entry.line, ...(entry.marker ? [entry.marker] : [])]),
    hidden: 0, collapsed: 0 }
  const lines = []
  let run = 0
  let hidden = 0
  let collapsed = 0
  const flush = () => {
    if (!run) return
    lines.push(`-[${run} removed ${run === 1 ? 'line' : 'lines'} omitted]\n`)
    hidden += run
    collapsed += run - 1
    run = 0
  }
  for (const entry of block) {
    if (entry.kind === '-') { run++; continue }
    flush()
    lines.push(entry.line)
    if (entry.marker) lines.push(entry.marker)
  }
  flush()
  return {
    lines, hidden, collapsed,
  }
}

function filterDiff(input) {
  if (input && !input.endsWith('\n')) throw new Error('diff must end with a newline')
  const lines = splitLines(input)
  const result = [NOTICE]
  let index = 0
  while (index < lines.length) {
    if (!lines[index].startsWith('diff --git ')) throw new Error('expected a Git diff --git file header')
    const fileHeader = lines[index++]
    const metadata = []
    while (index < lines.length && !lines[index].startsWith('@@ ') && !lines[index].startsWith('diff --git ')) {
      metadata.push(lines[index++])
    }
    result.push(fileHeader)
    const deleted = metadata.some(line => line.startsWith('deleted file mode '))
    if (deleted) {
      const mode = metadata.find(line => line.startsWith('deleted file mode '))
      result.push(mode)
    } else {
      const binaryPatch = metadata.findIndex(line => line.startsWith('GIT binary patch'))
      const printable = binaryPatch < 0 ? metadata : metadata.slice(0, binaryPatch)
      result.push(...printable.filter(line => !line.startsWith('index ')))
      if (binaryPatch >= 0) result.push('Binary patch omitted\n')
    }

    let collapsedBefore = 0
    while (index < lines.length && lines[index].startsWith('@@ ')) {
      const original = lines[index++].trimEnd()
      const match = HUNK.exec(original)
      if (!match) throw new Error('malformed unified diff hunk header: ' + original)
      const oldStart = Number(match[1])
      const oldCount = Number(match[2] ?? 1)
      const newStart = Number(match[3])
      const newCount = Number(match[4] ?? 1)
      let readOld = 0
      let readNew = 0
      const entries = []
      while (index < lines.length && (readOld < oldCount || readNew < newCount)) {
        const line = lines[index++]
        const kind = line[0]
        if (kind === '-') readOld++
        else if (kind === '+') readNew++
        else if (kind === ' ') { readOld++; readNew++ }
        else if (kind === '\\' && line.startsWith('\\ No newline at end of file')) {
          if (!entries.length || entries[entries.length - 1].marker) throw new Error('misplaced no-newline marker')
          entries[entries.length - 1].marker = line
        } else throw new Error('malformed unified diff hunk body')
        if (readOld > oldCount || readNew > newCount) throw new Error('unified diff hunk exceeds its declared range')
        if (kind !== '\\') entries.push({ kind, line })
      }
      if (readOld !== oldCount || readNew !== newCount) throw new Error('incomplete unified diff hunk')
      // A no-newline marker may follow the final source line after counts are satisfied.
      if (index < lines.length && lines[index].startsWith('\\ No newline at end of file')) {
        if (!entries.length || entries[entries.length - 1].marker) throw new Error('misplaced no-newline marker')
        entries[entries.length - 1].marker = lines[index]
        index++
      }
      const body = []
      let block = []
      let hidden = 0
      let collapsed = 0
      const flush = () => {
        if (!block.length) return
        const rendered = renderBlock(block)
        body.push(...rendered.lines)
        hidden += rendered.hidden
        collapsed += rendered.collapsed
        block = []
      }
      for (const entry of entries) {
        if (entry.kind === ' ') {
          flush()
          body.push(entry.line)
          if (entry.marker) body.push(entry.marker)
        } else block.push(entry)
      }
      flush()
      const annotation = hidden ? ` [${hidden} removed ${hidden === 1 ? 'line' : 'lines'} omitted]` : ''
      const heading = `@@ -${oldStart - collapsedBefore},${oldCount - collapsed} +${newStart},${newCount} @@${match[5]}${annotation}\n`
      if (!deleted) result.push(heading, ...body)
      collapsedBefore += collapsed
    }
  }
  return result.join('')
}

function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 || argv[0] === '--help') {
    process.stdout.write('Usage: git diff ... | node bin/added-code-diff.js [patch-file]\n')
    return argv[0] === '--help' ? 0 : 2
  }
  const input = fs.readFileSync(argv[0] || 0, 'utf8')
  process.stdout.write(filterDiff(input))
  return 0
}

if (require.main === module) {
  try { process.exitCode = main() } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}

module.exports = { filterDiff, main }
