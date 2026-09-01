'use strict'
const fs = require('fs')
const path = require('path')

function pad (n) { return String(n).padStart(2, '0') }

// ~/Debrief/2026-08-21-1430.md — and if you somehow start two meetings in
// the same minute, the second becomes ...-1430-2.md rather than clobbering it.
function slotFor (dir, when = new Date()) {
  const base = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
               `-${pad(when.getHours())}${pad(when.getMinutes())}`
  let name = base
  let n = 2
  while (fs.existsSync(path.join(dir, `${name}.md`)) || fs.existsSync(path.join(dir, `${name}.m4a`))) {
    name = `${base}-${n++}`
  }
  return {
    base: name,
    markdown: path.join(dir, `${name}.md`),
    audio: path.join(dir, `${name}.m4a`)
  }
}

function humanDuration (seconds) {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${pad(m)}m`
  if (m) return `${m}m ${pad(sec)}s`
  return `${sec}s`
}

function build ({ when, durationSeconds, summary, summaryError, transcriptMarkdown, engine, audioFile }) {
  const stamp = when.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  })

  const front = [
    '---',
    `date: ${when.toISOString()}`,
    `duration: ${humanDuration(durationSeconds)}`,
    `audio: ${path.basename(audioFile)}`,
    `transcribed_with: ${engine}`,
    summary ? `summarized_with: ${summary.provider} ${summary.model}` : 'summarized_with: none',
    '---',
    ''
  ].join('\n')

  const body = []
  body.push(`# Meeting — ${stamp}`)
  body.push('')

  if (summary) {
    body.push(summary.text.trim())
  } else if (summaryError) {
    body.push('## Summary')
    body.push('')
    body.push(`_The summary step failed: ${summaryError}_`)
    body.push('')
    body.push('_The full transcript below is complete and untouched._')
  } else {
    body.push('## Summary')
    body.push('')
    body.push('_No LLM key is configured, so no summary was generated. Add `ANTHROPIC_API_KEY`, ' +
              '`OPENAI_API_KEY`, or `GROQ_API_KEY` to `.env` and future meetings will get one._')
  }

  body.push('')
  body.push('---')
  body.push('')
  body.push('## Transcript')
  body.push('')
  body.push(transcriptMarkdown || '_Nothing was transcribed._')
  body.push('')

  return front + body.join('\n')
}

function write (filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents, 'utf8')
  return filePath
}

module.exports = { slotFor, build, write, humanDuration }
