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
const { USER_CONFIG_DIR } = require('./config')
const engine = require('./localengine')

const LLAMA_BUILD = 'b10639'
const LLAMA_URL = (arch) =>
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/llama-${LLAMA_BUILD}-bin-macos-${arch}.tar.gz`

// Everything here fits an 8 GB Apple Silicon Mac with room for Parakeet.
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
  const home = USER_CONFIG_DIR
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

// ── Installing ──────────────────────────────────────────────────────────────
async function installServer (p, onProgress) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  await engine.fetchArchive(LLAMA_URL(arch), p.llamaDir, (pct) => onProgress && onProgress({ noun: 'AI engine', pct }))
  if (!fs.existsSync(p.server)) throw new Error('llama-server was not in the downloaded build')
}

const ensure = engine.singleflight(async (cfg, onProgress) => {
  const s = status(cfg)
  if (s.ready) return s
  if (!s.supported) throw new Error('Local summaries need macOS.')
  if (!s.haveServer) await installServer(s, onProgress)
  if (!s.haveModel) {
    if (!s.model.url) throw new Error(`LLM model not found: ${s.model.path}`)
    await engine.download(s.model.url, s.model.path, s.model.bytes,
      (pct, got, total) => onProgress && onProgress({ noun: 'AI model', pct, got, total }))
  }
  return status(cfg)
})

// ── Serving ─────────────────────────────────────────────────────────────────
function startServer (p) {
  return engine.startServer({
    name: 'llama-server',
    bin: p.server,
    libDir: p.llamaDir,
    args: (port) => [
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
  const p = await ensure(cfg, (prog) => onStatus && onStatus(engine.progressLabel(prog)))
  onStatus && onStatus('Loading model…')
  const server = await startServer(p)
  const port = server.port

  try {
    await server.ready((port) => engine.httpOk(`http://127.0.0.1:${port}/health`), 120 * 1000)
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
    server.logStderr('[localllm]')
    throw e
  } finally {
    server.stop()
  }
}

module.exports = { MODELS, DEFAULT_MODEL, LLAMA_BUILD, paths, status, ensure, chat }
