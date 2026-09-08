'use strict'
// Local transcription with NVIDIA Parakeet TDT through sherpa-onnx, the same
// engine UltraWhisper uses, pointed at a whole meeting. We only connect on
// 127.0.0.1; startServer wraps sherpa because it has no --host flag.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { USER_CONFIG_DIR } = require('./config')
const engine = require('./localengine')

const SAMPLE_RATE = 16000
const FRAME = 320                 // 20 ms of 16 kHz audio
const MAX_CHUNK_S = 30            // Parakeet's comfortable utterance length
const MIN_CHUNK_S = 0.3           // anything shorter is a click, not a word
const PAD_BEFORE = 12             // frames of real audio kept around speech (240 ms)
const PAD_AFTER = 20              // (400 ms)
const MERGE_GAP = 30              // pauses shorter than this stay inside a chunk (600 ms)
const IN_FLIGHT = 2               // chunks decoding at once

// The build the app installs: small enough for an 8 GB Mac.
const DEFAULT_MODEL = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
const SERVER_BIN = 'bin/sherpa-onnx-offline-websocket-server'

// sherpa-onnx's runtime (~30 MB) and the model (~490 MB), the exact pair
// UltraWhisper installs.
const SHERPA_VER = 'v1.13.6'
const SHERPA_URL = process.arch === 'arm64'
  ? `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_VER}/sherpa-onnx-${SHERPA_VER}-onnxruntime-1.27.1-osx-arm64-shared.tar.bz2`
  : `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_VER}/sherpa-onnx-${SHERPA_VER}-osx-x64-shared.tar.bz2`
const MODEL_URL = (name) => `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${name}.tar.bz2`

// ── Paths ───────────────────────────────────────────────────────────────────
// Everything installs under ~/.config/debrief/. If UltraWhisper already has
// the same runtime and model in ~/.config/ultrawhisper/, use those rather
// than downloading 500 MB twice; the files are byte-identical.
const HOMES = [USER_CONFIG_DIR, path.join(os.homedir(), '.config', 'ultrawhisper')]

function paths (cfg) {
  // PARAKEET_MODEL is a build's folder name under models/, or a path to one.
  const want = cfg.parakeetModel || DEFAULT_MODEL
  const custom = path.isAbsolute(want)
  return {
    runtimeDirs: HOMES.map(h => path.join(h, 'sherpa-onnx')),         // first is where we install
    modelDirs: custom ? [want] : HOMES.map(h => path.join(h, 'models', want)),
    modelName: custom ? null : want                                   // null: nothing to download
  }
}

// Each Parakeet build names its weights differently (encoder.int8.onnx /
// encoder.fp16.onnx / encoder.onnx), so look for whichever is there.
function modelFiles (dir) {
  const find = (stem) => ['.int8.onnx', '.fp16.onnx', '.onnx']
    .map(ext => path.join(dir, stem + ext)).find(f => fs.existsSync(f))
  const encoder = find('encoder'); const decoder = find('decoder'); const joiner = find('joiner')
  const tokens = path.join(dir, 'tokens.txt')
  if (!encoder || !decoder || !joiner || !fs.existsSync(tokens)) return null
  return { dir, name: path.basename(dir), encoder, decoder, joiner, tokens }
}

// "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8" -> "Parakeet TDT 0.6B v3 int8"
function label (model) {
  const raw = model.name.replace(/^sherpa-onnx-nemo-/, '').replace(/-/g, ' ')
  return raw.replace(/\bparakeet\b/i, 'Parakeet').replace(/\btdt\b/i, 'TDT').replace(/(\d)b\b/, '$1B')
}

function status (cfg) {
  const p = paths(cfg)
  const runtime = p.runtimeDirs.find(d => fs.existsSync(path.join(d, SERVER_BIN))) || null
  const model = p.modelDirs.map(modelFiles).find(Boolean) || null
  return { ...p, runtime, model, ready: Boolean(runtime && model), label: model ? label(model) : null }
}

const ensure = engine.singleflight(async (cfg, onProgress) => {
  const s = status(cfg)
  if (s.ready) return s
  if (!s.runtime) {
    const dir = s.runtimeDirs[0]
    await engine.fetchArchive(SHERPA_URL, dir, (pct) => onProgress && onProgress({ noun: 'speech engine', pct }))
    if (!fs.existsSync(path.join(dir, SERVER_BIN))) throw new Error('sherpa-onnx server was not in the downloaded build')
  }
  if (!s.model) {
    if (!s.modelName) throw new Error(`Parakeet model not found: ${s.modelDirs[0]}`)
    await engine.fetchArchive(MODEL_URL(s.modelName), s.modelDirs[0],
      (pct, got, total) => onProgress && onProgress({ noun: 'speech model', pct, got, total }))
  }
  const done = status(cfg)
  if (!done.ready) throw new Error('Parakeet download finished but the model files are missing')
  return done
})

// ── WAV ─────────────────────────────────────────────────────────────────────
// The file stays on disk and is read in pieces: an hour of stereo PCM is
// 230 MB, which the Electron process should not hold next to a 500 MB model.
// afconvert writes plain PCM16 but pads the header with a FLLR chunk, so walk
// the RIFF chunks properly instead of assuming a 44-byte header.
function openWav (file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(64 * 1024)
  const headLen = fs.readSync(fd, head, 0, head.length, 0)
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    fs.closeSync(fd)
    throw new Error(`${path.basename(file)} is not a WAV file`)
  }
  let pos = 12
  let channels = 0; let rate = 0; let bits = 0
  let dataOffset = -1; let dataBytes = 0
  while (pos + 8 <= headLen) {
    const id = head.toString('ascii', pos, pos + 4)
    const size = head.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      channels = head.readUInt16LE(body + 2)
      rate = head.readUInt32LE(body + 4)
      bits = head.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataOffset = body
      dataBytes = Math.min(size, fs.fstatSync(fd).size - body)
      break
    }
    pos = body + size + (size & 1)
  }
  if (dataOffset < 0 || bits !== 16 || rate !== SAMPLE_RATE) {
    fs.closeSync(fd)
    throw new Error(`expected 16-bit ${SAMPLE_RATE} Hz WAV, got ${bits}-bit ${rate} Hz`)
  }
  const stride = channels * 2 // bytes per sample frame
  return {
    channels,
    frames: Math.floor(dataBytes / stride),
    // Interleaved int16 samples [from, to), as one typed array.
    read (from, to) {
      const out = new Int16Array((to - from) * channels)
      fs.readSync(fd, Buffer.from(out.buffer), 0, out.byteLength, dataOffset + from * stride)
      return out
    },
    close () { fs.closeSync(fd) }
  }
}

// ── Who is talking when ─────────────────────────────────────────────────────
// One dB level per 20 ms frame per channel, in one pass over the file.
function frameLevels (wav) {
  const n = Math.floor(wav.frames / FRAME)
  const levels = Array.from({ length: wav.channels }, () => new Float32Array(n))
  const perRead = 1000 // frames per read: 20 s of audio, ~1.3 MB in stereo
  const sums = new Float64Array(wav.channels)
  for (let f0 = 0; f0 < n; f0 += perRead) {
    const f1 = Math.min(n, f0 + perRead)
    const pcm = wav.read(f0 * FRAME, f1 * FRAME)
    for (let f = f0, p = 0; f < f1; f++) {
      sums.fill(0)
      for (let i = 0; i < FRAME; i++) {
        for (let ch = 0; ch < wav.channels; ch++, p++) sums[ch] += pcm[p] * pcm[p]
      }
      for (let ch = 0; ch < wav.channels; ch++) {
        const rms = Math.sqrt(sums[ch] / FRAME) / 32768
        levels[ch][f] = 20 * Math.log10(Math.max(rms, 1e-5)) // -100 dB floor
      }
    }
  }
  return levels
}

// A channel's speech threshold sits a little above its own quiet level, but
// never so low that room tone or a digitally silent channel counts as talk.
function threshold (db) {
  const sorted = Float32Array.from(db).sort()
  const floor = sorted[Math.floor(sorted.length * 0.15)] || -100
  return Math.min(Math.max(floor + 12, -52), -32)
}

function speechRuns (levels, ch) {
  const db = levels[ch]
  const thr = threshold(db)
  const others = levels.filter((_, i) => i !== ch)
  const n = db.length
  const on = new Uint8Array(n)
  for (let f = 0; f < n; f++) {
    if (db[f] <= thr) continue
    let loudest = true
    for (const o of others) if (o[f] > db[f]) { loudest = false; break }
    if (loudest) on[f] = 1
  }

  // Runs of speech frames, padded, then merged across short pauses.
  const runs = []
  let start = -1
  for (let f = 0; f <= n; f++) {
    const v = f < n ? on[f] : 0
    if (v && start < 0) start = f
    if (!v && start >= 0) {
      const a = Math.max(0, start - PAD_BEFORE)
      const b = Math.min(n, f + PAD_AFTER)
      const last = runs[runs.length - 1]
      if (last && a - last.end <= MERGE_GAP) last.end = b
      else runs.push({ start: a, end: b })
      start = -1
    }
  }

  // Long stretches get split at the quietest moment before the 30 s mark.
  const maxF = Math.floor(MAX_CHUNK_S * SAMPLE_RATE / FRAME)
  const out = []
  for (const r of runs) {
    let s = r.start
    while (r.end - s > maxF) {
      let cut = s + maxF
      let quietest = Infinity
      for (let f = s + Math.floor(maxF * 0.6); f < s + maxF; f++) {
        if (db[f] < quietest) { quietest = db[f]; cut = f }
      }
      out.push({ start: s, end: cut })
      s = cut
    }
    out.push({ start: s, end: r.end })
  }

  // Drop blips: too short, or never clearly louder than the threshold.
  const minF = Math.ceil(MIN_CHUNK_S * SAMPLE_RATE / FRAME)
  return out.filter(r => {
    if (r.end - r.start < minF) return false
    let peak = -Infinity
    for (let f = r.start; f < r.end; f++) if (db[f] > peak) peak = db[f]
    return peak > thr + 6
  }).map(r => ({ ch, from: r.start * FRAME, to: r.end * FRAME }))
}

// ── The server ──────────────────────────────────────────────────────────────
function startServer (s, threads) {
  return engine.startServer({
    name: 'sherpa-onnx server',
    bin: path.join(s.runtime, SERVER_BIN),
    libDir: path.join(s.runtime, 'lib'),
    localhostOnly: true,
    readyFromStderr: /Listening on/,
    args: (port) => [
      `--port=${port}`,
      `--encoder=${s.model.encoder}`, `--decoder=${s.model.decoder}`,
      `--joiner=${s.model.joiner}`, `--tokens=${s.model.tokens}`,
      '--model-type=nemo_transducer',
      `--num-threads=${threads}`,
      `--max-batch-size=${IN_FLIGHT}`,
      `--log-file=${path.join(os.tmpdir(), 'debrief-sherpa.log')}`
    ]
  })
}

// sherpa-onnx offline websocket payload, exactly as UltraWhisper sends it:
// [u32 sample-rate][u32 byte-count][float32 samples in -1..1]. Built straight
// from the file, one chunk at a time, so the meeting never sits in RAM as floats.
function chunkPayload (wav, c) {
  const n = c.to - c.from
  const buf = new ArrayBuffer(8 + n * 4)
  const payload = Buffer.from(buf)
  payload.writeUInt32LE(SAMPLE_RATE, 0)
  payload.writeUInt32LE(n * 4, 4)
  const out = new Float32Array(buf, 8, n)
  const pcm = wav.read(c.from, c.to)
  for (let i = 0, p = c.ch; i < n; i++, p += wav.channels) out[i] = pcm[p] / 32768
  return payload
}

// One binary message in, one JSON message (text + token timestamps) back.
function decodeChunk (port, payload, timeoutMs = 90 * 1000) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') return reject(new Error('This Node runtime has no WebSocket'))
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.binaryType = 'arraybuffer'
    let settled = false
    const timer = setTimeout(() => finish(new Error('Parakeet timed out on a chunk')), timeoutMs)
    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* already closed */ }
      err ? reject(err) : resolve(value)
    }
    ws.onopen = () => ws.send(payload)
    ws.onerror = () => finish(new Error('lost the connection to the Parakeet server'))
    ws.onclose = () => finish(new Error('the Parakeet server closed the connection without answering'))
    ws.onmessage = (m) => {
      const raw = typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8')
      try { finish(null, JSON.parse(raw)) } catch { finish(null, { text: raw, tokens: [], timestamps: [], durations: [] }) }
    }
  })
}

// ── Tokens -> segments ──────────────────────────────────────────────────────
// Parakeet returns sentencepiece tokens (a leading space starts a word) with
// a start time and duration each. Sentences end at . ? ! or at a pause of
// more than a second; a few sentences in a row become one transcript line.
function segmentsFrom (result, offsetSeconds, speaker) {
  const tokens = result.tokens || []
  const ts = result.timestamps || []
  const dur = result.durations || []
  const text = (result.text || '').trim()
  if (!text) return []
  if (!tokens.length || tokens.length !== ts.length) {
    return [{ from: offsetSeconds, to: offsetSeconds, speaker, text }]
  }

  const sentences = []
  let cur = null
  for (let i = 0; i < tokens.length; i++) {
    const t0 = ts[i]
    const t1 = ts[i] + (dur[i] || 0.08)
    const gap = cur ? t0 - cur.to : 0
    if (!cur || gap > 1.2) {
      if (cur) sentences.push(cur)
      cur = { from: t0, to: t1, text: tokens[i] }
    } else {
      cur.text += tokens[i]
      cur.to = Math.max(cur.to, t1)
    }
    const next = tokens[i + 1]
    if (/[.?!]["')]*$/.test(tokens[i]) && (next === undefined || next.startsWith(' '))) {
      sentences.push(cur); cur = null
    }
  }
  if (cur) sentences.push(cur)

  const lines = []
  for (const s of sentences) {
    const last = lines[lines.length - 1]
    if (last && s.from - last.to < 0.8 && s.to - last.from <= 15) {
      last.text += ' ' + s.text.trim()
      last.to = s.to
    } else {
      lines.push({ from: s.from, to: s.to, text: s.text.trim() })
    }
  }
  return lines.map(l => ({
    from: Math.round((offsetSeconds + l.from) * 1000),
    to: Math.round((offsetSeconds + l.to) * 1000),
    speaker,
    text: l.text.replace(/\s+/g, ' ').trim()
  })).filter(l => l.text)
}

// ── Public ──────────────────────────────────────────────────────────────────
// Installs the engine if it isn't there yet (onStatus gets download progress
// as text, then "Transcribing N%"). Segments come back sorted by time:
// { from, to } in ms, speaker '0' for the left channel (your mic) and '1'
// for the right (the call), text.
async function transcribe (cfg, wavPath, onStatus) {
  const say = (text) => onStatus && onStatus(text)
  const s = await ensure(cfg, (prog) => say(engine.progressLabel(prog)))
  const engineName = `${s.label} (sherpa-onnx)`

  // The model takes a couple of seconds to load, so start that first and
  // scan the audio while it happens.
  say('Loading speech model…')
  const threads = cfg.transcribeThreads || Math.max(2, os.cpus().length - 2)
  let server, wav
  const segments = []
  try {
    server = await startServer(s, threads)
    wav = openWav(wavPath)
    const levels = frameLevels(wav)
    const chunks = []
    for (let ch = 0; ch < wav.channels; ch++) chunks.push(...speechRuns(levels, ch))
    chunks.sort((a, b) => a.from - b.from)
    const totalSamples = chunks.reduce((n, c) => n + (c.to - c.from), 0)
    console.log(`[parakeet] ${wav.channels} ch, ${(wav.frames / SAMPLE_RATE / 60).toFixed(1)} min, ` +
      `${chunks.length} speech chunks (${(totalSamples / SAMPLE_RATE / 60).toFixed(1)} min of talk)`)
    if (!chunks.length) return { segments, engine: engineName }

    await server.ready(engine.tcpOpen, 120 * 1000)
    say('Transcribing 0%')

    let next = 0
    let doneSamples = 0
    const worker = async () => {
      while (next < chunks.length) {
        const c = chunks[next++]
        const payload = chunkPayload(wav, c)
        const result = await decodeChunk(server.port, payload)
          .catch(() => decodeChunk(server.port, payload)) // one retry, then let it fail
        segments.push(...segmentsFrom(result, c.from / SAMPLE_RATE, String(c.ch)))
        doneSamples += c.to - c.from
        say(`Transcribing ${Math.min(99, Math.floor(doneSamples * 100 / totalSamples))}%`)
      }
    }
    await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, chunks.length) }, worker))
    say('Transcribing 100%')
    console.log(`[parakeet] ${chunks.length} chunks -> ${segments.length} segments`)
  } catch (e) {
    if (server) server.logStderr('[parakeet]')
    throw e
  } finally {
    if (server) server.stop()
    if (wav) wav.close()
  }

  segments.sort((a, b) => a.from - b.from || a.to - b.to)
  return { segments, engine: engineName }
}

module.exports = { DEFAULT_MODEL, paths, status, ensure, transcribe }
