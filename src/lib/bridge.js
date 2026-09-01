// A tiny file-based control channel so an external menu bar (SketchyBar) can
// show what the app is doing and drive it.
//
// Max's real macOS menu bar is auto-hidden (_HIHideMenuBar = 1) and SketchyBar
// draws the bar he actually looks at, so the native Tray icon is invisible
// until he shoves the cursor to the top of the screen. This exposes the same
// state and the same start/stop action to a shell script instead.
//
//   ~/.config/debrief/state.json  <- written by the app on every refresh
//   ~/.config/debrief/command     <- written by anyone, consumed by the app
//
// Files, not a socket: no port to collide with, survives an app restart, and a
// SketchyBar plugin can read it with one `cat`.

const fs = require('fs')
const path = require('path')
const os = require('os')

const DIR = path.join(os.homedir(), '.config', 'debrief')
const STATE_FILE = path.join(DIR, 'state.json')
const COMMAND_FILE = path.join(DIR, 'command')

let lastWritten = ''

function publish (snapshot) {
  const json = JSON.stringify(snapshot)
  if (json === lastWritten) return // don't churn the disk every second when nothing moved
  lastWritten = json
  try {
    fs.mkdirSync(DIR, { recursive: true })
    // Write-then-rename so a reader never catches a half-written file.
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, json + '\n')
    fs.renameSync(tmp, STATE_FILE)
  } catch (e) {
    console.error('[bridge] could not write state:', e && (e.message || e))
  }
}

// Poll rather than fs.watch: watch on a file that gets deleted and recreated
// goes deaf after the first event, and 400ms is plenty for a button press.
function listen (handler) {
  try { fs.mkdirSync(DIR, { recursive: true }) } catch { /* ignore */ }
  try { fs.unlinkSync(COMMAND_FILE) } catch { /* nothing stale to clear */ }

  return setInterval(() => {
    let cmd
    try {
      cmd = fs.readFileSync(COMMAND_FILE, 'utf8').trim()
    } catch {
      return // no command waiting
    }
    try { fs.unlinkSync(COMMAND_FILE) } catch { /* ignore */ }
    if (cmd) handler(cmd)
  }, 400)
}

module.exports = { publish, listen, STATE_FILE, COMMAND_FILE }
