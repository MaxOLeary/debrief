'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const audio = require('./audio')
const parakeet = require('./parakeet')

const MAX_UPLOAD_BYTES = 24 * 1024 * 1024 // API limit is 25 MB; leave headroom.

function hhmmss (ms) {
  const s = Math.floor(ms / 1000)
  const h = String(Math.floor(s / 3600)).padStart(2, '0')
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const sec = String(s % 60).padStart(2, '0')
  return `${h}:${m}:${sec}`
}

// ── Remote: OpenAI or Groq Whisper ──────────────────────────────────────────
function apiTarget (cfg) {
  if (cfg.openaiKey && cfg.transcribeApiPreference !== 'groq') {
    return {
      name: 'OpenAI Whisper',
      url: 'https://api.openai.com/v1/audio/transcriptions',
      key: cfg.openaiKey,
      model: 'whisper-1'
    }
  }
  return {
    name: 'Groq Whisper',
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    key: cfg.groqKey,
    model: 'whisper-large-v3'
  }
}

async function postOneFile (target, filePath, language) {
  const buf = fs.readFileSync(filePath)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'audio/mp4' }), path.basename(filePath))
  form.append('model', target.model)
  form.append('response_format', 'verbose_json')
  if (language && language !== 'auto') form.append('language', language)

  const res = await fetch(target.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.key}` },
    body: form
  })
  if (!res.ok) {
    throw new Error(`${target.name} returned ${res.status}: ${(await res.text()).slice(0, 500)}`)
  }
  return res.json()
}

async function apiWhisper (cfg, sourcePath, onProgress) {
  const target = apiTarget(cfg)
  if (!target.key) throw new Error('No OpenAI or Groq key available for API transcription.')

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-upload-'))
  try {
    // The recording is already compact AAC; it only needs slicing when a long
    // meeting pushes it over the upload cap (that step needs ffmpeg).
    let parts = [sourcePath]
    if (fs.statSync(sourcePath).size > MAX_UPLOAD_BYTES) {
      parts = await audio.splitForUpload(cfg.ffmpeg, sourcePath, work, 600)
    }

    const segments = []
    let offsetMs = 0
    for (let i = 0; i < parts.length; i++) {
      if (onProgress) onProgress(Math.round((i / parts.length) * 100))
      const json = await postOneFile(target, parts[i], cfg.transcribeLanguage)
      const segs = json.segments || []
      if (segs.length) {
        for (const s of segs) {
          const text = (s.text || '').trim()
          if (!text) continue
          segments.push({
            from: offsetMs + Math.round((s.start || 0) * 1000),
            to: offsetMs + Math.round((s.end || 0) * 1000),
            speaker: null, // the hosted APIs don't diarise
            text
          })
        }
        offsetMs += Math.round((segs[segs.length - 1].end || 0) * 1000)
      } else if (json.text) {
        segments.push({ from: offsetMs, to: offsetMs, speaker: null, text: json.text.trim() })
      }
    }
    if (onProgress) onProgress(100)
    return { segments, engine: target.name }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

// ── Junk filter ─────────────────────────────────────────────────────────────
// Speech models emit garbage on near-silence now and then: long runs of one
// letter, whisper-style [BLANK_AUDIO] markers, looped repeats of a phrase.
// Parakeet only ever sees gated speech so this rarely fires, but the cloud
// route still needs it, and it costs nothing.
const BOILERPLATE = [
  /^\[?blank_?audio\]?$/i,
  /^\(?(silence|music|applause|laughter|inaudible|no speech)\)?$/i,
  /^thanks? for watching[.!]?$/i,
  /^(subtitles?|captions?)( by| provided by)?\b/i,
  /^you$/i
]

function isJunk (text) {
  const t = text.trim()
  if (!t) return true
  const bare = t.replace(/[^\p{L}\p{N}]/gu, '')
  if (!bare) return true
  if (BOILERPLATE.some(re => re.test(t.replace(/^[\s\-–—]+|[\s.]+$/g, '')))) return true

  // A single character repeated ("Eeeeeee…", "Mmmmm…").
  const counts = new Map()
  for (const ch of bare.toLowerCase()) counts.set(ch, (counts.get(ch) || 0) + 1)
  const topShare = Math.max(...counts.values()) / bare.length
  if (bare.length > 12 && topShare > 0.6) return true

  return false
}

function clean (segments) {
  const kept = []
  let repeats = 0
  for (const seg of segments) {
    if (isJunk(seg.text)) continue
    const prev = kept[kept.length - 1]
    // Hallucination loops repeat the same line over and over.
    if (prev && prev.text.trim().toLowerCase() === seg.text.trim().toLowerCase()) {
      if (++repeats >= 2) continue
    } else {
      repeats = 0
    }
    kept.push(seg)
  }
  return kept
}

// ── Public ──────────────────────────────────────────────────────────────────
// onStatus gets short text for the menu bar ("Transcribing 40%"). Speaker
// '0' is the left channel (you), '1' the right (the call).
async function transcribe (cfg, { wavPath, webmPath }, onStatus) {
  if (cfg.resolvedTranscriber === 'local') {
    const r = await parakeet.transcribe(cfg, wavPath, onStatus)
    return { ...r, segments: clean(r.segments) }
  }
  if (cfg.resolvedTranscriber === 'api') {
    const r = await apiWhisper(cfg, webmPath || wavPath, (pct) => onStatus && onStatus(`Transcribing ${pct}%`))
    return { ...r, segments: clean(r.segments) }
  }
  throw new Error(
    'No transcriber available. Either install Parakeet (npm run fetch-model) ' +
    'or put OPENAI_API_KEY / GROQ_API_KEY in .env.'
  )
}

// Turn segments into the transcript that goes in the note, and into the
// flat text handed to the summarising model.
function render (segments, { speakerNames = { 0: 'You', 1: 'Them' } } = {}) {
  const lines = []
  let lastSpeaker
  for (const s of segments) {
    const who = s.speaker !== null && speakerNames[s.speaker] ? speakerNames[s.speaker] : null
    const stamp = hhmmss(s.from)
    if (who && who !== lastSpeaker) lines.push('')
    lines.push(who ? `**[${stamp}] ${who}:** ${s.text}` : `**[${stamp}]** ${s.text}`)
    lastSpeaker = who
  }
  const markdown = lines.join('\n').trim()

  const plain = segments.map(s => {
    const who = s.speaker !== null && speakerNames[s.speaker] ? speakerNames[s.speaker] : 'Speaker'
    return `[${hhmmss(s.from)}] ${who}: ${s.text}`
  }).join('\n')

  return { markdown, plain }
}

module.exports = { transcribe, render, hhmmss, clean, isJunk }
