'use strict'

const fs = require('node:fs')
const path = require('node:path')

const SESSION_ID = /^[a-f0-9-]{36}$/i
const AGENT_FILE = /^agent-([a-f0-9]+)\.jsonl$/i

function captureDiscoveryReceipts(transcriptDir, sessionId) {
  if (!path.isAbsolute(transcriptDir || '') || !SESSION_ID.test(sessionId || '')) {
    throw new Error('discovery receipts require an absolute transcript directory and session ID')
  }
  const directory = path.join(transcriptDir, sessionId, 'subagents')
  if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory()) {
    throw new Error('discovery subagent transcripts are missing')
  }
  const receipts = []
  for (const file of fs.readdirSync(directory).sort()) {
    const match = AGENT_FILE.exec(file)
    if (!match) continue
    const absolute = path.join(directory, file)
    const stat = fs.lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe discovery transcript file')
    let finalText = null
    for (const line of fs.readFileSync(absolute, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.type !== 'assistant' || event.message?.stop_reason !== 'end_turn' ||
          !Array.isArray(event.message.content)) continue
      const text = event.message.content.filter((block) => block.type === 'text')
        .map((block) => block.text).filter((value) => typeof value === 'string').join('\n')
      if (text.trim()) finalText = text
    }
    if (finalText) receipts.push({ agentId: match[1], finalText })
  }
  return validateDiscoveryReceipts(receipts)
}

function validateDiscoveryReceipts(receipts) {
  if (!Array.isArray(receipts) || receipts.length < 6) {
    throw new Error('discovery receipts require at least six final subagent outputs')
  }
  const seen = new Set()
  for (const receipt of receipts) {
    if (!receipt || !/^[a-f0-9]+$/i.test(receipt.agentId || '') ||
        typeof receipt.finalText !== 'string' || !receipt.finalText.trim()) {
      throw new Error('discovery receipt has invalid agent ID or final text')
    }
    if (seen.has(receipt.agentId)) throw new Error('duplicate discovery receipt agent ID')
    seen.add(receipt.agentId)
  }
  return receipts
}

module.exports = { captureDiscoveryReceipts, validateDiscoveryReceipts }
