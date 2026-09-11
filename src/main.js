'use strict'
const {
  app, Tray, Menu, BrowserWindow, ipcMain, shell, dialog,
  Notification, desktopCapturer, session, systemPreferences, globalShortcut, nativeImage, screen
} = require('electron')

// One copy at a time. The LaunchAgent keeps Debrief running, so a second
// launch (`open -n -a Debrief`, or an "open at login" toggle left on next to
// the LaunchAgent) would otherwise mean two tray icons fighting over the
// mic. The newcomer exits here, before the logger or config even load; the
// running copy hears about it in 'second-instance' further down.
if (!app.requestSingleInstanceLock()) app.exit(0)

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const configLib = require('./lib/config')
const audio = require('./lib/audio')
const transcribeLib = require('./lib/transcribe')
const summarizeLib = require('./lib/summarize')
const localllm = require('./lib/localllm')
const parakeet = require('./lib/parakeet')
const { progressLabel } = require('./lib/localengine')
const note = require('./lib/note')
const bridge = require('./lib/bridge')
const appleNotes = require('./lib/apple-notes')

// ── Logging ─────────────────────────────────────────────────────────────────
// Launched from Finder there is no terminal to print to, so everything goes to
// a file as well. This is the first thing to read when something misbehaves.
const LOG_FILE = path.join(os.homedir(), 'Library', 'Logs', 'Debrief.log')
;(function installLogger () {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    // Keep the log from growing without bound.
    try {
      if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.truncateSync(LOG_FILE, 0)
    } catch { /* no log yet */ }
    const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
    const write = (level, args) => {
      const line = `${new Date().toISOString()} [${level}] ` +
        args.map(a => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      stream.write(line + '\n')
    }
    for (const level of ['log', 'warn', 'error']) {
      const original = console[level].bind(console)
      console[level] = (...args) => { original(...args); write(level, args) }
    }
    process.on('uncaughtException', (e) => console.error('uncaughtException:', e))
    process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e))
  } catch { /* logging must never take the app down */ }
})()

let cfg = configLib.load()
let tray = null
let recorderWindow = null

// `electron . --selftest[=seconds]` records for a few seconds, runs the whole
// pipeline, prints what happened, and quits. Used to prove capture works
// without anyone touching the menu. A running app can be asked for the same
// test (`echo "selftest 12" > ~/.config/debrief/command`, or
// `open -n -a Debrief --args --selftest=12`); it then logs the result and
// stays up. One token (`--selftest=12`) because a second launch arrives with
// Electron's own switches spliced into argv.
function selftestDuration (token) {
  const n = parseInt(token, 10)
  return n > 0 ? n : 12
}
function selftestSecondsFrom (argv) {
  const flag = argv.find(a => /^--selftest(=|$)/.test(a))
  return flag ? selftestDuration(flag.split('=')[1]) : null
}
let selftestSeconds = selftestSecondsFrom(process.argv)
const quitAfterSelftest = selftestSeconds !== null // launched just for the test

function startSelftest (n) {
  if (state.phase !== 'idle') {
    console.log(`[selftest] ignored — app is ${state.phase}`)
    return
  }
  selftestSeconds = n
  console.log(`[selftest] recording for ${n}s…`)
  startRecording()
}

function finishSelftest (code) {
  if (quitAfterSelftest) setTimeout(() => app.exit(code), 300)
  else selftestSeconds = null
}

const state = {
  phase: 'idle',        // idle | recording | processing
  detail: '',           // extra text for the menu, e.g. "Transcribing 40%"
  startedAt: null,
  tempDir: null,
  webmPath: null,
  writeStream: null,
  sources: { mic: false, system: false },
  discard: false,       // stop was a "throw it away" — skip the whole pipeline
  lastNote: null,
  lastAudio: null,
  lastError: null,
  install: ''           // "Downloading AI model 43%" while the local LLM sets itself up
}

// "Open Last Note" was dead after every restart because lastNote only got set
// by a run in this session. Pick up the newest note on disk instead.
function seedLastNote () {
  try {
    const notes = fs.readdirSync(cfg.notesDir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(cfg.notesDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    if (!notes.length) return
    state.lastNote = notes[0]
    const audio = notes[0].replace(/\.md$/, '.m4a')
    if (fs.existsSync(audio)) state.lastAudio = audio
    console.log(`[main] last note on disk: ${path.basename(state.lastNote)}`)
  } catch { /* folder may not exist yet - nothing to seed */ }
}

// ── Opening a note ──────────────────────────────────────────────────────────
// shell.openPath() hands the file to whatever macOS has registered for .md,
// which is a code editor here - it shows the raw `## Decisions` text instead of
// a formatted note. MARKDOWN_APP names a reader to use instead.
function openNote (file) {
  if (!file || !fs.existsSync(file)) return
  if (!cfg.markdownApp) { shell.openPath(file); return }

  // `open -a` rather than launching the binary: it goes through LaunchServices,
  // so the app gets focus properly and macOS credits it, not us.
  execFile('/usr/bin/open', ['-a', cfg.markdownApp, file], (err) => {
    if (!err) return
    console.error(`[main] ${cfg.markdownApp} could not open the note (${err.message}); falling back to the default app`)
    shell.openPath(file)
  })
}

// The submenu routes: Obsidian and Postit both open the .md file itself;
// Apple Notes can't, so the note is converted and pushed in as a new note.
function openNoteWith (appName) {
  if (!state.lastNote || !fs.existsSync(state.lastNote)) return
  execFile('/usr/bin/open', ['-a', appName, state.lastNote], (err) => {
    if (err) notify('Debrief', `${appName} could not open the note: ${err.message}`)
  })
}

function sendToAppleNotes (file) {
  if (!file || !fs.existsSync(file)) return
  appleNotes.send(file, (err) => {
    if (err) {
      console.error('[notes] export failed:', err.message)
      notify('Debrief', `Apple Notes export failed: ${err.message}`)
    } else {
      notify('Sent to Apple Notes', path.basename(file))
    }
  })
}

const ICONS = {}
function icon (name) {
  if (!ICONS[name]) ICONS[name] = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', name))
  return ICONS[name]
}

// ── Menu bar ────────────────────────────────────────────────────────────────
function elapsedLabel () {
  if (!state.startedAt) return ''
  const s = Math.floor((Date.now() - state.startedAt) / 1000)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function statusLine () {
  if (state.phase === 'recording') {
    const which = state.sources.system
      ? (state.sources.mic ? 'mic + system audio' : 'system audio only')
      : (cfg.systemAudio ? 'microphone only' : 'microphone')
    return `Recording ${elapsedLabel()} — ${which}`
  }
  if (state.phase === 'processing') return state.detail || 'Working…'
  if (state.install) return state.install
  if (state.lastError) return `Last run failed: ${state.lastError}`
  if (state.lastNote) return `Last note: ${path.basename(state.lastNote)}`
  return 'Ready'
}

function buildMenu () {
  const recording = state.phase === 'recording'
  const busy = state.phase === 'processing'

  return Menu.buildFromTemplate([
    { label: statusLine(), enabled: false },
    { type: 'separator' },
    {
      label: recording ? 'Stop Recording' : 'Start Recording',
      accelerator: cfg.globalShortcut || undefined,
      enabled: !busy,
      click: () => (recording ? stopRecording() : startRecording())
    },
    {
      label: 'Stop & Discard Recording',
      visible: recording,
      click: () => discardRecording({ confirm: true })
    },
    { type: 'separator' },
    {
      label: 'Open Last Note',
      enabled: Boolean(state.lastNote && fs.existsSync(state.lastNote)),
      click: () => openNote(state.lastNote)
    },
    {
      label: 'Open Last Note With',
      enabled: Boolean(state.lastNote && fs.existsSync(state.lastNote)),
      submenu: [
        { label: 'Obsidian', click: () => openNoteWith('Obsidian') },
        { label: 'Postit', click: () => openNoteWith('Postit') },
        { label: 'Apple Notes', click: () => sendToAppleNotes(state.lastNote) }
      ]
    },
    {
      label: 'Show Last Recording in Finder',
      enabled: Boolean(state.lastAudio && fs.existsSync(state.lastAudio)),
      click: () => shell.showItemInFolder(state.lastAudio)
    },
    {
      label: 'Open Notes Folder',
      click: () => { fs.mkdirSync(cfg.notesDir, { recursive: true }); shell.openPath(cfg.notesDir) }
    },
    { type: 'separator' },
    { label: 'Check Setup…', click: showSetup },
    { label: 'Open Log', click: () => shell.openPath(LOG_FILE) },
    {
      label: 'Edit Configuration (.env)',
      click: () => { shell.openPath(ensureEnvFile()) }
    },
    { label: 'Reload Configuration', click: () => { cfg = configLib.load(); refresh() } },
    { type: 'separator' },
    { label: 'Quit Debrief', enabled: !recording && !busy, click: () => app.quit() }
  ])
}

function refresh () {
  // State goes out even with the tray hidden (HIDE_TRAY=1) — the bridge and
  // any bar that mirrors state.json still need it.
  publishState()
  if (!tray) return
  if (state.phase === 'recording') {
    tray.setImage(icon('iconRecording.png'))
    tray.setTitle(` ${elapsedLabel()}`)
  } else if (state.phase === 'processing') {
    tray.setImage(icon('iconBusyTemplate.png'))
    tray.setTitle(state.detail ? ` ${state.detail}` : ' …')
  } else {
    tray.setImage(icon('iconTemplate.png'))
    tray.setTitle(state.install ? ` ${state.install}` : (cfg.trayLabel ? ` ${cfg.trayLabel}` : ''))
  }
  tray.setToolTip(`Debrief — ${statusLine()}`)
  tray.setContextMenu(buildMenu())
}

// Mirror the tray into ~/.config/debrief/state.json so SketchyBar (which
// is the bar Max actually sees) can render the same thing.
function publishState () {
  bridge.publish({
    phase: state.phase,
    label: state.phase === 'recording'
      ? elapsedLabel()
      : state.phase === 'processing'
        ? (state.detail || 'Working…')
        : (state.install || cfg.trayLabel || 'Notes'),
    status: statusLine(),
    detail: state.detail,
    sources: state.sources,
    lastNote: state.lastNote,
    lastError: state.lastError
  })
}

function setPhase (phase, detail = '') {
  if (phase !== state.phase || detail !== state.detail) {
    console.log(`[phase] ${phase}${detail ? ' — ' + detail : ''}`)
  }
  state.phase = phase
  state.detail = detail
  // Keep the visualizer card in step: it shows the breathing spindle plus
  // live progress text ("Transcribing 40%") for as long as it's on screen.
  if (phase === 'processing' && panelWindow && panelWindow.isVisible()) {
    setPanelUi('busy', { detail })
  }
  refresh()
}

function showSetup () {
  const yes = (v) => (v ? '✓' : '✗')
  const llm = localllm.status(cfg)
  const pk = parakeet.status(cfg)
  const lines = [
    `Config file:         ${cfg.envFile}`,
    `Notes folder:        ${cfg.notesDir}`,
    '',
    `${yes(cfg.ffmpeg)} ffmpeg:            ${cfg.ffmpeg || 'not installed (only needed for cloud transcription)'}`,
    `${yes(pk.runtime)} speech engine:     ${pk.runtime ? `sherpa-onnx (${pk.runtime})` : 'downloads itself on launch'}`,
    `${yes(pk.model)} speech model:      ${pk.model ? `${pk.label} (${pk.model.dir})` : 'downloads itself on launch'}`,
    '',
    `Transcription:       ${cfg.resolvedTranscriber === 'local'
      ? 'Parakeet on this Mac (works offline)'
      : cfg.resolvedTranscriber === 'api'
        ? (cfg.openaiKey ? 'OpenAI Whisper API' : 'Groq Whisper API')
        : 'NOT CONFIGURED'}`,
    `${yes(llm.haveServer)} AI engine:         ${llm.haveServer ? `llama.cpp ${localllm.LLAMA_BUILD}` : 'downloads itself on launch'}`,
    `${yes(llm.haveModel)} AI model:          ${llm.haveModel ? `${llm.model.label} (${llm.model.file})` : `${llm.model.label} — downloads itself on launch`}`,
    '',
    `Summary:             ${{
      local: 'local model on this Mac (no account, nothing uploaded)',
      'claude-cli': 'Claude Code CLI (your subscription — no API charges)',
      anthropic: 'Anthropic API key',
      openai: 'OpenAI API key',
      groq: 'Groq API key',
      none: 'none — notes will contain the transcript only'
    }[cfg.resolvedSummarizer]}`,
    '',
    'Keys are read from .env; nothing is ever uploaded except the audio or',
    'transcript you explicitly route to an API.'
  ]
  dialog.showMessageBox({
    type: 'info',
    title: 'Debrief — Setup',
    message: 'Current configuration',
    detail: lines.join('\n'),
    buttons: ['OK', 'Open .env'],
    defaultId: 0
  }).then(({ response }) => {
    if (response === 1) shell.openPath(ensureEnvFile())
  })
}

// Seed the editable config from the bundled example the first time it's opened.
function ensureEnvFile () {
  try {
    fs.mkdirSync(path.dirname(cfg.envFile), { recursive: true })
    if (!fs.existsSync(cfg.envFile)) {
      fs.copyFileSync(path.join(__dirname, '..', '.env.example'), cfg.envFile)
    }
  } catch (e) {
    console.error('[config] could not create env file:', e.message)
  }
  return cfg.envFile
}

function notify (title, body, onClick) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, silent: false })
  if (onClick) n.on('click', onClick)
  n.show()
}

// ── Local AI first-run install ──────────────────────────────────────────────
// The speech engine + model (~520 MB) and the summary engine + model
// (~2.5 GB) download themselves the first time the app runs, with progress
// in the menu bar. If a meeting gets recorded before that finishes, the
// pipeline just waits for the same download.
function prepareLocalLlm () {
  const pk = parakeet.status(cfg)
  const s = localllm.status(cfg)
  const needParakeet = !pk.ready && cfg.transcribeBackend !== 'api'
  const needLlm = cfg.resolvedSummarizer === 'local' && !s.ready
  if (!needParakeet && !needLlm) { console.log(`[localllm] ready — ${pk.label} + ${s.model.label}`); return }
  console.log(`[localllm] first run: fetching ${needParakeet ? 'speech engine + model' : ''}${needParakeet && needLlm ? ' + ' : ''}${needLlm ? `engine + ${s.model.label}` : ''}`)

  let lastLogged = -10
  const onProgress = (prog) => {
    state.install = progressLabel(prog)
    if (prog.pct - lastLogged >= 10 || prog.pct < lastLogged) { lastLogged = prog.pct; console.log(`[localllm] ${state.install}`) }
    if (state.phase === 'idle') refresh()
  }

  ;(async () => {
    if (needParakeet) {
      const done = await parakeet.ensure(cfg, onProgress)
      cfg = configLib.load() // re-resolve the transcription route now that local exists
      console.log(`[localllm] speech engine ready — ${done.label}`)
    }
    if (needLlm) await localllm.ensure(cfg, onProgress)
  })().then(() => {
    state.install = ''
    refresh()
    notify('Debrief is ready', 'The local AI models are installed. Nothing about your meetings leaves this Mac.')
  }).catch((e) => {
    state.install = ''
    state.lastError = `local AI setup failed: ${e.message}`
    console.error('[localllm] setup failed:', e)
    refresh()
  })
}

// ── Recording ───────────────────────────────────────────────────────────────
function startRecording () {
  if (state.phase !== 'idle') return

  state.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrief-'))
  state.webmPath = path.join(state.tempDir, 'raw.m4a')
  state.writeStream = fs.createWriteStream(state.webmPath)
  state.startedAt = Date.now()
  state.lastError = null
  state.discard = false
  state.sources = { mic: false, system: false }

  setPhase('recording')
  recorderWindow.webContents.send('recorder:start', {
    micGain: cfg.micGain,
    systemGain: cfg.systemGain,
    systemAudio: cfg.systemAudio,
    keepVideoTrack: cfg.keepVideoTrack
  })
}

function stopRecording () {
  if (state.phase !== 'recording') return
  setPhase('processing', 'Finishing…')
  recorderWindow.webContents.send('recorder:stop')
}

// Stop and throw the recording away: no transcription, no summary, no note,
// no audio kept. `confirm: true` (the menu path) asks first, because this is
// the one button in the app that can lose a meeting. The recording keeps
// running while the dialog is up, so Cancel costs nothing.
function discardRecording ({ confirm = false } = {}) {
  if (state.phase !== 'recording') return
  const go = () => {
    if (state.phase !== 'recording') return // stopped some other way meanwhile
    state.discard = true
    hidePanel()
    setPhase('processing', 'Discarding…')
    recorderWindow.webContents.send('recorder:stop')
  }
  if (!confirm) return go()
  dialog.showMessageBox({
    type: 'warning',
    title: 'Debrief',
    message: 'Discard this recording?',
    detail: `${elapsedLabel()} of audio will be deleted without being transcribed or saved. This cannot be undone.`,
    buttons: ['Cancel', 'Discard'],
    defaultId: 0,
    cancelId: 0
  }).then(({ response }) => { if (response === 1) go() })
}

function cleanupRecordingState () {
  if (state.writeStream) { try { state.writeStream.end() } catch { /* ignore */ } }
  state.writeStream = null
  state.startedAt = null
}

// Everything from "stop" to "note on disk".
async function processRecording () {
  const startedAt = new Date(state.startedAtSnapshot || Date.now())
  const tempDir = state.tempDir
  const webmPath = state.webmPath

  try {
    if (!fs.existsSync(webmPath) || fs.statSync(webmPath).size < 1024) {
      throw new Error('The recording came out empty — nothing was captured.')
    }

    fs.mkdirSync(cfg.notesDir, { recursive: true })
    const slot = note.slotFor(cfg.notesDir, startedAt)

    setPhase('processing', 'Converting…')
    const wavPath = path.join(tempDir, 'audio16k.wav')
    await audio.to16kWav(webmPath, wavPath)
    audio.toArchiveM4a(webmPath, slot.audio) // moves the recording into place
    const seconds = await audio.durationSeconds(wavPath)

    // On a first launch this also waits for the speech model download.
    setPhase('processing', 'Transcribing…')
    const { segments, engine } = await transcribeLib.transcribe(
      cfg, { wavPath, webmPath: slot.audio },
      (text) => setPhase('processing', text)
    )

    // Only trust the left/right speaker split when both sides were actually live.
    const me = cfg.yourName
    const them = cfg.theirName
    const speakerNames = (state.sources.mic && state.sources.system)
      ? { 0: me, 1: them }
      : (state.sources.mic ? { 0: me, 1: me } : { 0: them, 1: them })
    const rendered = transcribeLib.render(segments, { speakerNames })

    let summary = null
    let summaryError = null
    if (rendered.plain.trim()) {
      if (cfg.resolvedSummarizer !== 'none') {
        setPhase('processing', 'Summarizing…')
        try {
          summary = await summarizeLib.summarize(cfg, rendered.plain, {
            date: startedAt.toDateString(),
            duration: note.humanDuration(seconds),
            diarized: state.sources.mic && state.sources.system,
            me, them
          }, (text) => setPhase('processing', text))
        } catch (e) {
          summaryError = e.message
        }
      }
    } else {
      summaryError = 'the transcript was empty, so there was nothing to summarise'
    }

    const markdown = note.build({
      when: startedAt,
      durationSeconds: seconds,
      summary,
      summaryError,
      transcriptMarkdown: rendered.markdown,
      engine,
      audioFile: slot.audio
    })
    note.write(slot.markdown, markdown)

    state.lastNote = slot.markdown
    state.lastAudio = slot.audio
    state.lastError = summaryError || null
    if (panelWindow && panelWindow.isVisible()) {
      setPanelUi('done', { text: `✓ ${path.basename(slot.markdown)} — ${note.humanDuration(seconds)}` })
      setTimeout(hidePanel, 2500)
    }
    setPhase('idle')

    notify(
      summaryError ? 'Meeting saved (summary failed)' : 'Debrief ready',
      `${path.basename(slot.markdown)} — ${note.humanDuration(seconds)}`,
      () => openNote(slot.markdown)
    )

    if (selftestSeconds) {
      console.log('SELFTEST_RESULT ' + JSON.stringify({
        ok: true,
        mic: state.sources.mic,
        system: state.sources.system,
        seconds: Math.round(seconds),
        engine,
        segments: segments.length,
        speakers: [...new Set(segments.map(s => s.speaker))],
        note: slot.markdown,
        audio: slot.audio,
        summaryError
      }))
      finishSelftest(0)
    }
  } catch (e) {
    console.error('[pipeline] failed:', e)
    state.lastError = e.message
    hidePanel()
    setPhase('idle')
    if (selftestSeconds) {
      console.log('SELFTEST_RESULT ' + JSON.stringify({ ok: false, error: e.message, raw: webmPath }))
      finishSelftest(1)
      return
    }
    notify('Debrief failed', e.message)
    dialog.showMessageBox({
      type: 'error',
      title: 'Debrief',
      message: 'That recording could not be processed.',
      detail: `${e.message}\n\nThe raw audio is still here:\n${webmPath}`,
      buttons: ['OK', 'Show Raw Audio'],
      defaultId: 0
    }).then(({ response }) => { if (response === 1) shell.showItemInFolder(webmPath) })
    return // keep tempDir so the audio isn't lost
  }

  // Only the app's own scratch copy is removed, and only after the note is safe.
  try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ── Visualizer card ─────────────────────────────────────────────────────────
// The floating waveform card (same look as UltraWhisper): live bars while
// recording, a breathing spindle while the pipeline works, and an inline
// "Discard recording?" prompt on Esc/Cancel. Drag it anywhere; it remembers.
const PANEL_W = 428
const PANEL_H = 120
const PANEL_POS_FILE = path.join(os.homedir(), '.config', 'debrief', 'panel.json')
let panelWindow = null
let panelUi = 'hidden' // hidden | wave | discard | busy | done

function createPanelWindow () {
  panelWindow = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    type: 'panel',
    roundedCorners: false, // we draw a 32px pill; system corners are ~10px
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true, // follows the masked opaque pill, same as UltraWhisper
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'panel-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  panelWindow.setAlwaysOnTop(true, 'status')
  panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  panelWindow.loadFile('src/visualizer.html')
  panelWindow.webContents.on('did-finish-load', () => {
    shapePanelWindow()
  })
  panelWindow.on('moved', () => {
    try {
      fs.mkdirSync(path.dirname(PANEL_POS_FILE), { recursive: true })
      fs.writeFileSync(PANEL_POS_FILE, JSON.stringify(panelWindow.getBounds()))
    } catch { /* remembering the spot is best-effort */ }
  })
}

// Preferred spot: wherever it was dragged last (if that's still on a screen),
// else bottom-center of the display with the mouse.
function placePanel () {
  try {
    const saved = JSON.parse(fs.readFileSync(PANEL_POS_FILE, 'utf8'))
    const onScreen = screen.getAllDisplays().some(d =>
      saved.x < d.workArea.x + d.workArea.width && saved.x + PANEL_W > d.workArea.x &&
      saved.y < d.workArea.y + d.workArea.height && saved.y + PANEL_H > d.workArea.y)
    if (onScreen) { panelWindow.setPosition(saved.x, saved.y); return }
  } catch { /* no saved spot yet */ }
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  panelWindow.setPosition(
    Math.round(wa.x + (wa.width - PANEL_W) / 2),
    Math.round(wa.y + wa.height - PANEL_H - 66))
}

function panelSend (s) {
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('panel:state', s)
}

// CSS cannot clip the NSWindow. Without this the window is a rectangle and
// macOS draws a low-opacity square border around the 32px pill.
function shapePanelWindow () {
  if (process.platform !== 'darwin' || !panelWindow || panelWindow.isDestroyed()) return
  try {
    const addon = require('./native/shapewindow.node')
    const ok = addon.shape(panelWindow.getNativeWindowHandle(), 32)
    panelWindow.setHasShadow(false)
    panelWindow.setHasShadow(true)
    console.log(`[main] panel window shaped: ${ok}`)
  } catch (e) {
    console.warn('[main] could not shape panel window:', e.message)
  }
}

function setPanelUi (mode, extra = {}) {
  panelUi = mode
  if (mode !== 'hidden') panelSend({ mode, hotkey: cfg.globalShortcut, ...extra })
  syncPanelKeys()
}

function syncPanelKeys () {
  // Esc/Enter have to live in the main process: the card is a nonactivating
  // panel shown with showInactive(), so renderer keydown never fires.
  for (const k of ['Esc', 'Enter']) {
    try { globalShortcut.unregister(k) } catch { /* not registered */ }
  }
  if (panelUi === 'hidden') return
  if (!globalShortcut.register('Esc', onPanelEsc)) {
    console.warn('[main] could not register Esc while the card is up')
  }
  if (panelUi === 'discard' && !globalShortcut.register('Enter', onPanelEnter)) {
    console.warn('[main] could not register Enter while the discard prompt is up')
  }
}

function onPanelEsc () {
  if (panelUi === 'wave') setPanelUi('discard')
  else if (panelUi === 'discard') setPanelUi('wave')
  else hidePanel()
}

function onPanelEnter () {
  if (panelUi === 'discard') discardRecording()
}

function showPanel () {
  if (!panelWindow || panelWindow.isDestroyed()) return
  placePanel()
  panelWindow.showInactive() // never steal focus when a meeting starts
  shapePanelWindow()
  setPanelUi('wave')
}

function hidePanel () {
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) panelWindow.hide()
  panelUi = 'hidden'
  syncPanelKeys()
}

ipcMain.on('panel:stop', () => stopRecording())
ipcMain.on('panel:discard', () => discardRecording())
ipcMain.on('panel:hide', () => hidePanel())
ipcMain.on('panel:ask-discard', () => {
  if (state.phase === 'recording') setPanelUi('discard')
})
ipcMain.on('panel:keep', () => {
  if (panelUi === 'discard') setPanelUi('wave')
})

// ── Wiring ──────────────────────────────────────────────────────────────────
function createRecorderWindow () {
  recorderWindow = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // a hidden window must keep recording
    }
  })
  recorderWindow.loadFile('src/recorder.html')
}

ipcMain.handle('recorder:chunk', (_e, bytes) => {
  if (state.writeStream) state.writeStream.write(Buffer.from(bytes))
})

ipcMain.on('recorder:log', (_e, msg) => console.log('[recorder]', msg))

ipcMain.on('recorder:level', (_e, level) => {
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) {
    panelWindow.webContents.send('panel:level', level)
  }
})

ipcMain.on('recorder:started', (_e, info) => {
  if (state.phase !== 'recording') {
    console.log('[recorder] started after stop — ignoring')
    return
  }
  state.sources = { mic: info.mic, system: info.system }
  // Granting screen capture can take a few seconds, so the real clock starts
  // here — otherwise the menu bar timer counts time nothing was recorded.
  state.startedAt = Date.now()
  showPanel() // the waveform card appears once audio is actually flowing
  refresh()
  if (selftestSeconds) setTimeout(() => stopRecording(), selftestSeconds * 1000)
  console.log(`[recorder] started — mic:${info.mic} system:${info.system}`)
  if (info.warnings && info.warnings.length) {
    console.warn('[recorder] warnings:', info.warnings.join(' | '))
    // Only complain about missing system audio when it was asked for —
    // mic-only is the deliberate default, not a failure.
    if (!info.system && cfg.systemAudio) {
      notify('Recording microphone only',
        'System audio was not captured — grant Screen Recording in System Settings.')
    }
  }
})

ipcMain.on('recorder:stopped', () => {
  state.startedAtSnapshot = state.startedAt
  cleanupRecordingState()
  if (state.discard) {
    state.discard = false
    // Deleting the scratch audio is the point of a discard — this is the only
    // path in the app that removes a recording, and it only runs on an
    // explicit "discard" from the user.
    try { fs.rmSync(state.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    state.tempDir = null
    state.webmPath = null
    hidePanel()
    setPhase('idle')
    console.log('[pipeline] recording discarded — nothing transcribed or saved')
    notify('Recording discarded', 'Nothing was saved or transcribed.')
    return
  }
  processRecording()
})

ipcMain.on('recorder:error', (_e, msg) => {
  state.lastError = msg
  state.discard = false
  hidePanel()
  cleanupRecordingState()
  setPhase('idle')
  if (selftestSeconds) {
    console.log('SELFTEST_RESULT ' + JSON.stringify({ ok: false, error: msg }))
    finishSelftest(1)
    return
  }
  dialog.showMessageBox({
    type: 'error',
    title: 'Debrief',
    message: 'Recording could not start.',
    detail: `${msg}\n\nIf this mentions screen capture, grant Screen Recording to Electron in\nSystem Settings → Privacy & Security → Screen & System Audio Recording,\nthen quit and relaunch.`,
    buttons: ['OK']
  })
})

// A second launch handed us its argv (see the single-instance lock at the top).
app.on('second-instance', (_e, argv) => {
  console.log(`[main] second launch — argv: ${argv.slice(1).join(' ')}`)
  const n = selftestSecondsFrom(argv)
  if (n) startSelftest(n)
})

function onRecordHotkey () {
  if (state.phase === 'idle') {
    startRecording()
    return
  }
  if (state.phase === 'recording') {
    // The card only appears once audio is flowing. A second press (or key
    // repeat) before that would stop an empty take and look like "the hotkey
    // does nothing."
    if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible()) {
      console.log('[main] hotkey ignored — recording is still starting')
      return
    }
    stopRecording()
  }
}

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide() // menu bar only, no Dock icon

  // Electron's default menu binds Cmd+Shift+R to Force Reload, which is our
  // record hotkey. A tray app doesn't need that menu.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }
  ]))

  // Answer the renderer's getDisplayMedia call with the whole screen plus the
  // system audio loopback. Nothing is written from the video side.
  console.log(`[main] Debrief starting — argv: ${process.argv.slice(1).join(' ')}`)
  console.log(`[main] transcriber: ${cfg.resolvedTranscriber} | model: ${parakeet.status(cfg).label || 'not installed yet'} | summarizer: ${cfg.resolvedSummarizer}`)
  console.log('[main] screen access:', systemPreferences.getMediaAccessStatus('screen'),
              '| mic access:', systemPreferences.getMediaAccessStatus('microphone'))

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 }
      })
      console.log('[main] desktopCapturer returned', sources.length, 'source(s)')
      if (!sources.length) return callback({})
      callback({ video: sources[0], audio: 'loopback' })
    } catch (e) {
      console.error('[main] desktopCapturer.getSources failed:', e && (e.message || e))
      callback({})
    }
  }, { useSystemPicker: false })

  try { await systemPreferences.askForMediaAccess('microphone') } catch { /* ignore */ }

  createRecorderWindow()
  createPanelWindow()

  seedLastNote()

  if (!cfg.hideTray) tray = new Tray(icon('iconTemplate.png'))
  refresh()
  prepareLocalLlm()
  setInterval(() => { if (state.phase === 'recording') refresh() }, 1000)

  // The stop timer is armed by the recorder:started handler, so a slow
  // permission grant doesn't eat into the test window.
  if (selftestSeconds) setTimeout(() => startSelftest(selftestSeconds), 1200)

  if (cfg.globalShortcut) {
    const ok = globalShortcut.register(cfg.globalShortcut, onRecordHotkey)
    console.log(`[main] ${cfg.globalShortcut}: ${ok ? 'registered' : 'FAILED — already in use'}`)
  }

  // Same actions the tray menu offers, reachable from a shell script.
  bridge.listen((cmd) => {
    console.log(`[bridge] command: ${cmd}`)
    if (cmd === 'toggle') {
      if (state.phase === 'recording') stopRecording()
      else if (state.phase === 'idle') startRecording()
    } else if (cmd === 'start') {
      if (state.phase === 'idle') startRecording()
    } else if (cmd === 'stop') {
      if (state.phase === 'recording') stopRecording()
    } else if (/^selftest(\s|$)/.test(cmd)) {
      startSelftest(selftestDuration(cmd.split(/\s+/)[1]))
    } else if (cmd === 'discard') {
      // Scripted callers are deliberate — no confirmation dialog here.
      if (state.phase === 'recording') discardRecording()
    } else if (cmd === 'open-note') {
      if (state.lastNote && fs.existsSync(state.lastNote)) openNote(state.lastNote)
      else { fs.mkdirSync(cfg.notesDir, { recursive: true }); shell.openPath(cfg.notesDir) }
    } else if (cmd === 'open-folder') {
      fs.mkdirSync(cfg.notesDir, { recursive: true })
      shell.openPath(cfg.notesDir)
    }
  })
})

app.on('window-all-closed', (e) => e.preventDefault()) // tray app: never quit on window close
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  // Leave a dead-man's marker so the SketchyBar item doesn't keep showing a
  // live-looking state for an app that isn't running.
  bridge.publish({ phase: 'off', label: '', status: 'Not running' })
})
