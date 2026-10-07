'use strict'

// Keep exact changed lines and stable hunk IDs in a small index. The complete frozen context
// remains available via its separate path; this is only a reading order for independent lanes.
function compactInventory(context) {
  const source = context?.canonicalDiffInventory
  if (!source || typeof source.patch !== 'string' || !source.inventory ||
      !Array.isArray(source.inventory.hunks)) throw new Error('frozen diff inventory is invalid')
  const units = []
  let current = null, hunk = null
  for (const line of source.patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { file: line.slice(11), hunks: [] }
      units.push(current)
      hunk = null
    } else if (line.startsWith('@@ ')) {
      if (!current) throw new Error('diff hunk has no file')
      hunk = { header: line, changes: [] }
      current.hunks.push(hunk)
    } else if (hunk && /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line)) {
      hunk.changes.push(line)
    }
  }
  return {
    prTitle: context.prTitle,
    acceptanceCriteria: context.acceptanceCriteria,
    changedFiles: source.inventory.changedFiles,
    hunkIds: source.inventory.hunks.map(({ id, path }) => ({ id, path })),
    structuralUnits: source.inventory.structuralUnits,
    exactChanges: units,
  }
}

module.exports = { compactInventory }
