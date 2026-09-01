'use strict'
// Offline end-to-end check: audio file -> converted -> transcribed -> note.
// Usage: node scripts/test-pipeline.js <audio> [outDir]
const fs = require('fs')
const os = require('os')
const path = require('path')
const cfgLib = require('../src/lib/config')
const audio = require('../src/lib/audio')
const transcribeLib = require('../src/lib/transcribe')
const summarizeLib = require('../src/lib/summarize')
const note = require('../src/lib/note')

async function main () {
  const input = process.argv[2]
  if (!input) { console.error('usage: node scripts/test-pipeline.js <audio> [outDir]'); process.exit(1) }
  const cfg = cfgLib.load()
  if (process.argv[3]) cfg.notesDir = process.argv[3]

  console.log('transcriber:', cfg.resolvedTranscriber, '| summarizer:', cfg.resolvedSummarizer)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-test-'))
  const wav = path.join(tmp, 'a.wav')

  console.time('convert')
  await audio.toWhisperWav(input, wav)
  console.timeEnd('convert')

  fs.mkdirSync(cfg.notesDir, { recursive: true })
  const slot = note.slotFor(cfg.notesDir, new Date())
  fs.copyFileSync(input, slot.audio)
  const seconds = await audio.durationSeconds(wav)
  console.log('duration:', seconds, 's')

  console.time('transcribe')
  const { segments, engine } = await transcribeLib.transcribe(cfg, { wavPath: wav, webmPath: slot.audio },
    p => process.stdout.write(`\r  transcribing ${p}%   `))
  console.log('')
  console.timeEnd('transcribe')

  const rendered = transcribeLib.render(segments, { speakerNames: { 0: cfg.yourName, 1: cfg.theirName } })
  console.log('\n--- transcript ---\n' + rendered.markdown + '\n')

  let summary = null; let summaryError = null
  if (!rendered.plain.trim()) {
    summaryError = 'the transcript was empty, so there was nothing to summarise'
  } else if (cfg.resolvedSummarizer !== 'none') {
    console.time('summarize')
    try {
      summary = await summarizeLib.summarize(cfg, rendered.plain,
        { date: new Date().toDateString(), duration: note.humanDuration(seconds), diarized: true,
          me: cfg.yourName, them: cfg.theirName })
    } catch (e) { summaryError = e.message; console.error('summary failed:', e.message) }
    console.timeEnd('summarize')
  }

  const md = note.build({
    when: new Date(), durationSeconds: seconds, summary, summaryError,
    transcriptMarkdown: rendered.markdown, engine, audioFile: slot.audio
  })
  note.write(slot.markdown, md)
  console.log('wrote', slot.markdown)
  fs.rmSync(tmp, { recursive: true, force: true })
}
main().catch(e => { console.error(e); process.exit(1) })
