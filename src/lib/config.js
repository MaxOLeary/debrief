'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

const APP_ROOT = path.join(__dirname, '..', '..')

// Tiny .env reader. No dependency, no surprises: KEY=value, # comments,
// optional quotes. Never overwrites a real environment variable.
function loadEnvFile (file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return {} }
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (key) out[key] = val
  }
  return out
}

function expandHome (p) {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function firstExisting (candidates) {
  for (const c of candidates) {
    if (!c) continue
    try { if (fs.existsSync(c)) return c } catch { /* ignore */ }
  }
  return null
}

// Inside a signed .app, APP_ROOT is Contents/Resources/app. Writing a config
// file there would invalidate the code signature, and macOS would then throw
// away the Screen Recording grant — so packaged builds keep config in ~/.config.
const IS_PACKAGED = APP_ROOT.includes('.app/Contents/Resources/app')
const USER_CONFIG_DIR = path.join(os.homedir(), '.config', 'debrief')
const USER_ENV_FILE = path.join(USER_CONFIG_DIR, '.env')

function load () {
  // Later entries win: the user's own config always beats a bundled default.
  const fileEnv = {
    ...loadEnvFile(path.join(APP_ROOT, '.env')),
    ...loadEnvFile(path.join(os.homedir(), '.debrief.env')),
    ...loadEnvFile(USER_ENV_FILE)
  }
  const get = (k, dflt) => {
    const v = process.env[k] !== undefined && process.env[k] !== ''
      ? process.env[k]
      : fileEnv[k]
    return (v === undefined || v === '') ? dflt : v
  }

  const notesDir = expandHome(get('NOTES_DIR', path.join(os.homedir(), 'Debrief')))

  // The repo ships its own whisper-cli (vendor/, a static arm64 build of
  // whisper.cpp), so nothing has to be installed. Homebrew's copy is a fallback.
  const whisperBin = expandHome(get('WHISPER_BIN')) || firstExisting([
    process.arch === 'arm64' ? path.join(APP_ROOT, 'vendor', 'whisper-cli') : null,
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
    '/opt/homebrew/bin/whisper-cpp',
    '/usr/local/bin/whisper-cpp'
  ])

  // Models live under ~/.config, never inside the repo: this tree sits on the
  // Desktop, which is iCloud-synced, and a 1.5 GB model has no business there.
  const modelHome = path.join(os.homedir(), '.config', 'debrief', 'models')
  const modelPref = expandHome(get('WHISPER_MODEL'))
  const whisperModel = firstExisting([
    modelPref && (path.isAbsolute(modelPref) ? modelPref : path.join(APP_ROOT, modelPref)),
    path.join(modelHome, 'ggml-medium.bin'),
    path.join(modelHome, 'ggml-small.bin'),
    path.join(os.homedir(), '.cache', 'whisper', 'ggml-medium.bin'),
    // Fall back to the model the dictation app already downloaded.
    path.join(os.homedir(), '.config', 'dictation', 'models', 'ggml-small.en.bin'),
    '/opt/homebrew/share/whisper-cpp/ggml-medium.bin'
  ])

  // Silero VAD (~860 KB). Without it, whisper.cpp invents dialogue during
  // silence — a quiet meeting comes back as a repeated hallucinated phrase.
  const vadPref = expandHome(get('VAD_MODEL'))
  const vadModel = get('USE_VAD', '1') === '0' ? null : firstExisting([
    vadPref,
    path.join(modelHome, 'ggml-silero-v5.1.2.bin'),
    path.join(modelHome, 'ggml-silero-v5.1.bin')
  ])

  const cfg = {
    appRoot: APP_ROOT,
    vadModel,
    modelHome,
    notesDir,
    // What the "Edit Configuration" menu item opens. Never inside the bundle.
    envFile: IS_PACKAGED ? USER_ENV_FILE : path.join(APP_ROOT, '.env'),
    userEnvFile: USER_ENV_FILE,
    isPackaged: IS_PACKAGED,

    anthropicKey: get('ANTHROPIC_API_KEY'),
    openaiKey: get('OPENAI_API_KEY'),
    groqKey: get('GROQ_API_KEY'),
    summaryProvider: get('SUMMARY_PROVIDER', 'auto'),
    summaryModel: get('SUMMARY_MODEL'),

    // Local llama.cpp summaries: the default, and the only route that needs
    // no account of any kind. The engine and model download themselves on
    // first launch into ~/.config/debrief (see lib/localllm.js).
    llmModel: get('LLM_MODEL', ''),                    // qwen3-4b | qwen2.5-3b | llama3.2-3b | /path/to/x.gguf
    llamaServerBin: expandHome(get('LLAMA_SERVER_BIN')), // only if you built llama.cpp yourself
    localLlmHome: USER_CONFIG_DIR,

    transcribeBackend: get('TRANSCRIBE_BACKEND', 'auto'),
    whisperBin,
    whisperModel,
    whisperThreads: parseInt(get('WHISPER_THREADS', String(Math.max(4, os.cpus().length - 2))), 10),
    whisperLanguage: get('WHISPER_LANGUAGE', 'en'),

    // Claude Code's headless mode runs on the subscription Max already pays
    // for, so it costs nothing extra. Note this must be the real binary — the
    // shell has a `claude` function that wraps it in tmux.
    claudeBin: expandHome(get('CLAUDE_BIN')) || firstExisting([
      path.join(os.homedir(), '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude'
    ]),

    // Optional. Only the cloud-transcription path needs it (to slice long
    // uploads); recording, conversion and local transcription use macOS's
    // own afconvert/afinfo and the vendored whisper-cli.
    ffmpeg: expandHome(get('FFMPEG_BIN')) || firstExisting([
      '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'
    ]),

    // What the two channels get called in the transcript. Using a real name
    // makes the LLM assign action items to that name instead of "You".
    // Short text shown next to the icon when idle. On a crowded menu bar (or a
    // laptop with a notch) a 16px glyph is genuinely hard to find; text isn't.
    trayLabel: get('TRAY_LABEL', ''),
    // HIDE_TRAY=1 skips creating the menu bar item entirely. The app still
    // runs: the global shortcut, the bridge commands, and state.json all keep
    // working — there's just nothing to click in the bar.
    hideTray: get('HIDE_TRAY', '0') === '1',
    // Which app opens a finished note. Blank = whatever macOS has set as the
    // default for .md, which on this Mac is a code editor showing raw markdown.
    // Name it here (e.g. "Obsidian") to get the rendered version instead.
    markdownApp: get('MARKDOWN_APP', ''),

    yourName: get('YOUR_NAME', 'You'),
    theirName: get('THEIR_NAME', 'Them'),

    // System-audio capture is OFF by default. The only route macOS offers an
    // Electron app is the screen-capture API, and macOS 26 words that prompt
    // as "bypass the private window picker and access your screen" — scary,
    // and Max declined it. Flip SYSTEM_AUDIO=1 to try anyway; until then the
    // app never touches the screen APIs and only ever asks for the mic.
    systemAudio: get('SYSTEM_AUDIO', '0') === '1',
    micGain: parseFloat(get('MIC_GAIN', '1.0')),
    systemGain: parseFloat(get('SYSTEM_GAIN', '1.0')),
    keepVideoTrack: get('KEEP_VIDEO_TRACK', '0') === '1',
    globalShortcut: get('GLOBAL_SHORTCUT', 'Command+Shift+R')
  }

  // Which transcription route will actually run?
  const canLocal = Boolean(cfg.whisperBin && cfg.whisperModel)
  const canApi = Boolean(cfg.openaiKey || cfg.groqKey)
  if (cfg.transcribeBackend === 'local') cfg.resolvedTranscriber = canLocal ? 'local' : 'none'
  else if (cfg.transcribeBackend === 'api') cfg.resolvedTranscriber = canApi ? 'api' : 'none'
  else cfg.resolvedTranscriber = canLocal ? 'local' : (canApi ? 'api' : 'none')

  // Which summariser will actually run?
  const p = cfg.summaryProvider
  const pick = (want) => {
    if (want === 'anthropic') return cfg.anthropicKey ? 'anthropic' : 'none'
    if (want === 'openai') return cfg.openaiKey ? 'openai' : 'none'
    if (want === 'groq') return cfg.groqKey ? 'groq' : 'none'
    if (want === 'claude-cli') return cfg.claudeBin ? 'claude-cli' : 'none'
    if (want === 'none') return 'none'
    if (want === 'local') return 'local'
    // An API key only exists if someone typed one in, so it wins. Otherwise the
    // local model: no account, nothing leaves the Mac. The Claude CLI is the
    // last resort for platforms the local engine doesn't cover yet.
    if (cfg.anthropicKey) return 'anthropic'
    if (cfg.openaiKey) return 'openai'
    if (cfg.groqKey) return 'groq'
    if (process.platform === 'darwin') return 'local'
    if (cfg.claudeBin) return 'claude-cli'
    return 'none'
  }
  cfg.resolvedSummarizer = pick(p)

  return cfg
}

module.exports = { load, expandHome, USER_ENV_FILE, USER_CONFIG_DIR }
