'use strict'
// Local summaries with llama.cpp. No account, no API key, nothing leaves the Mac.
//
// Two downloads, both one-time, both into ~/.config/debrief (never the
// repo, which lives on the iCloud-synced Desktop):
//   llama/   the llama.cpp release build (~11 MB) — we only use llama-server
//   models/  a GGUF chat model (~2.5 GB)
//
// To summarise, we start llama-server on a random localhost port, wait for
// /health, send one OpenAI-style chat request, and kill it. Nothing stays
// resident between meetings.
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const { spawn } = require('child_process')

const LLAMA_BUILD = 'b10639'
const LLAMA_URL = (arch) =>
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/llama-${LLAMA_BUILD}-bin-macos-${arch}.tar.gz`

// Everything here fits an 8 GB Apple Silicon Mac with room for whisper.
const MODELS = {
  'qwen3-4b': {
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    bytes: 2497280736,
    label: 'Qwen3 4B Instruct'
  },
  'qwen2.5-3b': {
    file: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    bytes: 1929903264,
    label: 'Qwen2.5 3B Instruct'
  },
  'llama3.2-3b': {
    file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    bytes: 2019377696,
    label: 'Llama 3.2 3B Instruct'
  }
}
const DEFAULT_MODEL = 'qwen3-4b'
const CONTEXT_TOKENS = 16384 // ~90 minutes of talk; KV cache is quantised to fit

// ── Paths ───────────────────────────────────────────────────────────────────
function paths (cfg) {
  const home = cfg.localLlmHome || path.join(os.homedir(), '.config', 'debrief')
  const llamaDir = path.join(home, 'llama')
  const modelsDir = path.join(home, 'models')

  // LLM_MODEL is a key from MODELS, or a path to any .gguf you already have.
  const want = cfg.llmModel || DEFAULT_MODEL
  let model
  if (MODELS[want]) {
    model = { key: want, ...MODELS[want], path: path.join(modelsDir, MODELS[want].file) }
  } else {
    const p = want.startsWith('~/') ? path.join(os.homedir(), want.slice(2)) : want
    model = { key: 'custom', file: path.basename(p), url: null, bytes: 0, label: path.basename(p, '.gguf'), path: p }
  }

  return {
    llamaDir,
    modelsDir,
    server: cfg.llamaServerBin || path.join(llamaDir, 'llama-server'),
    model
  }
}

function status (cfg) {
  const p = paths(cfg)
  const haveServer = fs.existsSync(p.server)
  const haveModel = fs.existsSync(p.model.path)
  return {
    ...p,
    haveServer,
    haveModel,
    ready: haveServer && haveModel,
    supported: process.platform === 'darwin'
  }
}

// ── Downloads ───────────────────────────────────────────────────────────────
// Streams to a .part file and renames on success, so a killed download never
// leaves a half-model that looks complete.
async function download (url, dest, expectedBytes, onProgress) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const part = dest + '.part'
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`)
  const total = parseInt(res.headers.get('content-length') || '0', 10) || expectedBytes || 0

  const out = fs.createWriteStream(part)
  let got = 0
  let lastPct = -1
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.length
      if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r))
      if (onProgress && total) {
        const pct = Math.floor(got * 100 / total)
        if (pct !== lastPct) { lastPct = pct; onProgress(pct, got, total) }
      }
    }
    await new Promise((resolve, reject) => { out.end(); out.on('finish', resolve); out.on('error', reject) })
  } catch (e) {
    try { out.destroy() } catch { /* ignore */ }
    try { fs.unlinkSync(part) } catch { /* ignore */ }
    throw e
  }
  if (total && got < total) {
    try { fs.unlinkSync(part) } catch { /* ignore */ }
    throw new Error(`Download of ${path.basename(dest)} stopped early (${got} of ${total} bytes)`)
  }
  fs.renameSync(part, dest)
}

function run (cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let err = ''
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`)))
  })
}

async function installServer (p, onProgress) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const tar = path.join(p.llamaDir, 'llama.tar.gz')
  fs.mkdirSync(p.llamaDir, { recursive: true })
  await download(LLAMA_URL(arch), tar, 0, (pct) => onProgress && onProgress({ what: 'engine', pct }))
  await run('/usr/bin/tar', ['-xzf', tar, '--strip-components=1', '-C', p.llamaDir])
  fs.unlinkSync(tar)
  // Strip the quarantine flag so Gatekeeper doesn't block a binary we fetched ourselves.
  await run('/usr/bin/xattr', ['-cr', p.llamaDir]).catch(() => {})
  if (!fs.existsSync(p.server)) throw new Error('llama-server was not in the downloaded build')
}

// One in-flight install at a time: the app kicks this off at launch, and a
// summary that arrives mid-download simply awaits the same promise.
let inflight = null
function ensure (cfg, onProgress) {
  const s = status(cfg)
  if (s.ready) return Promise.resolve(s)
  if (inflight) return inflight
  if (!s.supported) return Promise.reject(new Error('Local summaries need macOS.'))

  inflight = (async () => {
    if (!s.haveServer) await installServer(s, onProgress)
    if (!s.haveModel) {
      if (!s.model.url) throw new Error(`LLM model not found: ${s.model.path}`)
      await download(s.model.url, s.model.path, s.model.bytes,
        (pct, got, total) => onProgress && onProgress({ what: 'model', pct, got, total }))
    }
    return status(cfg)
  })().finally(() => { inflight = null })
  return inflight
}

function installing () { return Boolean(inflight) }

// ── Whisper model (transcription) ───────────────────────────────────────────
// Same idea for the speech model: if config found none, fetch the default
// medium model plus the tiny Silero VAD file beside it.
const WHISPER_MODEL = {
  file: 'ggml-medium.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
  bytes: 1533774781
}
const VAD_MODEL = {
  file: 'ggml-silero-v5.1.2.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
  bytes: 885000
}

let whisperInflight = null
function ensureWhisper (cfg, onProgress) {
  if (cfg.whisperModel && fs.existsSync(cfg.whisperModel)) return Promise.resolve(cfg.whisperModel)
  if (whisperInflight) return whisperInflight
  const dir = cfg.modelHome
  whisperInflight = (async () => {
    const vad = path.join(dir, VAD_MODEL.file)
    if (!fs.existsSync(vad)) await download(VAD_MODEL.url, vad, VAD_MODEL.bytes, null)
    const model = path.join(dir, WHISPER_MODEL.file)
    if (!fs.existsSync(model)) {
      await download(WHISPER_MODEL.url, model, WHISPER_MODEL.bytes,
        (pct, got, total) => onProgress && onProgress({ what: 'whisper', pct, got, total }))
    }
    return model
  })().finally(() => { whisperInflight = null })
  return whisperInflight
}

// ── Serving ─────────────────────────────────────────────────────────────────
function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function waitForHealth (port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let exited = null
  child.once('exit', code => { exited = code })
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`llama-server exited (${exited}) before it was ready`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('llama-server did not become ready in time')
}

function startServer (p, port) {
  const args = [
    '-m', p.model.path,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', String(CONTEXT_TOKENS),
    '-ngl', '99',             // whole model on the GPU (Metal)
    '-fa', 'on',
    '-ctk', 'q8_0', '-ctv', 'q8_0', // 8-bit KV cache: halves memory for long meetings
    '--no-webui',
    '--log-disable'
  ]
  return spawn(p.server, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, DYLD_LIBRARY_PATH: p.llamaDir }
  })
}

// Keep a very long transcript inside the context window. Rough: ~3.5 chars per
// token, and the system prompt + answer need headroom.
function fitTranscript (text) {
  const maxChars = Math.floor((CONTEXT_TOKENS - 2500) * 3.5)
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: text.slice(0, maxChars) + '\n\n[Transcript truncated here: the meeting was longer than the local model can read at once.]',
    truncated: true
  }
}

async function chat (cfg, systemPrompt, userText, onStatus) {
  const p = await ensure(cfg, (prog) => onStatus && onStatus(progressLabel(prog)))
  const port = await freePort()
  onStatus && onStatus('Loading model…')
  const child = startServer(p, port)
  let stderr = ''
  child.stderr.on('data', d => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000) })

  try {
    await waitForHealth(port, child, 120 * 1000)
    onStatus && onStatus('Summarizing…')
    const fitted = fitTranscript(userText)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15 * 60 * 1000)
    let res
    try {
      res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: p.model.key,
          temperature: 0.2,
          max_tokens: 1500,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: fitted.text }
          ]
        })
      })
    } finally { clearTimeout(timer) }
    if (!res.ok) throw new Error(`llama-server returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const json = await res.json()
    let text = (json.choices?.[0]?.message?.content || '').trim()
    // Some chat templates leak reasoning tags; the notes never want them.
    text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim()
    if (!text) throw new Error('The local model returned an empty summary.')
    return { text, model: p.model.label, provider: 'local (llama.cpp)', truncated: fitted.truncated }
  } catch (e) {
    if (stderr.trim()) console.error('[localllm] llama-server stderr:', stderr.trim().split('\n').slice(-5).join(' | '))
    throw e
  } finally {
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 3000).unref()
  }
}

function progressLabel (prog) {
  if (!prog) return 'Preparing local AI…'
  if (prog.what === 'engine') return `Downloading AI engine ${prog.pct}%`
  const gb = prog.total ? ` of ${(prog.total / 1e9).toFixed(1)} GB` : ''
  if (prog.what === 'whisper') return `Downloading speech model ${prog.pct}%${gb}`
  return `Downloading AI model ${prog.pct}%${gb}`
}

module.exports = { MODELS, DEFAULT_MODEL, LLAMA_BUILD, paths, status, ensure, ensureWhisper, installing, chat, progressLabel }
