#!/usr/bin/env node
'use strict'

const { parentPort, workerData } = require('node:worker_threads')
const { runAdjudication } = require('./review-and-fix-pr-codex')

try {
  parentPort.postMessage({ ok: true, receipt: runAdjudication(workerData) })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.stack || error.message })
}
