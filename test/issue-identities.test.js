'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { applyIdentities, loadCatalog, revisionKey } = require('../bench/issue-identities')

test('reviewed identities span cohorts, split compound findings, and override local verdicts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-identities-'))
  try {
    const pin = { baseSha: 'base', headSha: 'head' }
    fs.writeFileSync(path.join(root, 'issue-identities.json'), JSON.stringify({
      schemaVersion: 1,
      identities: [
        { id: 't-I1', targetId: 't', revisionKey: 't/base/head', verdict: 'real' },
        { id: 't-I2', targetId: 't', revisionKey: 't/base/head', verdict: 'real' },
      ],
      mappings: [
        { recordId: 'old/t/I1', identityIds: ['t-I1'] },
        { recordId: 'new/t/I1', identityIds: ['t-I1', 't-I2'] },
      ],
    }))
    const issue = (id, verdict, reporter) => ({ id, targetId: 't', title: id, verdict, reporterIds: [reporter] })
    const run = (id, ids, head = pin.headSha) => ({ id, targetId: 't', targetPins: { ...pin, headSha: head }, issueIds: ids, usage: { costUsd: 2 }, metrics: {} })
    const data = { issues: [issue('old/t/I1', 'real', 'old/t/skill'), issue('new/t/I1', 'false-positive', 'new/t/skill'), issue('later/t/I1', 'real', 'later/t/skill')], runs: [run('old/t/skill', ['old/t/I1']), run('new/t/skill', ['new/t/I1']), run('later/t/skill', ['later/t/I1'], 'different')] }
    applyIdentities(data, loadCatalog(root))
    assert.deepEqual(data.runs[0].identityIssueIds, ['t-I1'])
    assert.deepEqual(data.runs[1].identityIssueIds, ['t-I1', 't-I2'])
    assert.equal(data.runs[1].metrics.real, 2)
    assert.equal(data.runs[1].metrics.falsePositive, 0)
    assert.deepEqual(data.runs[1].localIssueIds, ['new/t/I1'])
    assert.deepEqual(data.runs[2].identityIssueIds, ['provisional:later/t/I1'])
    assert.notEqual(revisionKey(data.runs[0]), revisionKey(data.runs[2]))
    assert.equal(data.identityIssues.find((row) => row.id === 't-I1').originalIssueIds.length, 2)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
