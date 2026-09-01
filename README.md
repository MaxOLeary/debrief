# Debrief

A macOS menu bar app that records a meeting, then writes you a Markdown note:
a summary, the decisions, the action items, and the full transcript, with the
audio saved next to it.

Everything runs on your Mac. No account, no API key, no cloud, no telemetry.
Transcription is whisper.cpp; the summary is a small open-source model
(Qwen3 4B via llama.cpp). Both download themselves the first time the app runs.

```
~/Debrief/
  2026-08-21-1430.md     summary on top, transcript below
  2026-08-21-1430.m4a    the recording, right next to it
```

## What it records

The microphone. Capturing what the Mac itself is playing (the far side of a
call) is **off by default**: the only route macOS offers is the screen-capture
API, and the macOS 26 permission dialog for it is genuinely alarming
("bypass the private window picker and access your screen"). If you're fine
with that dialog, set `SYSTEM_AUDIO=1` in the config - then your mic goes on
the left channel, the Mac's audio on the right, and the transcript comes back
labelled:

```
**[00:00:00] You:** I ran the CFD last night and we're 8% over target.
**[00:00:10] Them:** So do we grow the wing or cut weight?
```

"You" is you. "Them" is everyone coming through the speakers.

## Install

On an Apple Silicon Mac the only thing you need first is [Node.js](https://nodejs.org):

```bash
git clone git@github.com:MaxOLeary/debrief.git
cd debrief
npm run setup                        # npm modules + AI models (~4 GB, one time)
./scripts/build-app.sh --install     # -> /Applications/Debrief.app
open -a "Debrief"
```

A hollow circle appears in the menu bar. That icon is the whole app: no Dock
icon, no window. Build the app rather than using `npm start` - macOS ties
recording permissions to the app's signature, and a built app keeps them.

The first time you record, macOS asks for one permission: **Microphone**.
Plain Allow button, no password. (With `SYSTEM_AUDIO=1` it also asks for
Screen & System Audio Recording - grant that one, then quit and reopen the
app; macOS only hands it to a freshly launched app.)

Always start the app from Finder or `open -a "Debrief"`, never by running
the binary from a terminal, or the permission prompts get credited to the
terminal instead.

## Using it

**Start**: click the menu bar icon and choose Start Recording, or press
⌘⇧R anywhere.

A small dark card appears at the bottom of the screen with a live waveform
(the same visualizer as UltraWhisper). Drag it wherever you like; it
remembers. While recording:

- **Stop** (click it on the card, the menu, or ⌘⇧R) - the card shows a
  breathing pulse with live progress while the note is transcribed and
  summarized, then fades away when it's done.
- **Cancel** (or Esc with the card focused) - the card asks
  "Discard recording?". Confirm and the recording is deleted on the spot:
  nothing transcribed, nothing summarized, nothing saved.

When the note is ready you get a notification; click it to open the note.

**Opening notes**: the menu's *Open Last Note With* offers three homes:

- **Obsidian** - opens the Markdown file (set `MARKDOWN_APP=Obsidian` to make
  this the default everywhere)
- **Postit** - the note pops up as a Postit sticky
- **Apple Notes** - the note is converted and added to your Notes
  (first time, macOS asks you to allow Debrief to control Notes)

## Configuration

Config lives at `~/.config/debrief/.env` (the menu's *Edit Configuration*
opens it). Every line is optional. The ones that matter:

| Variable | What it does |
|---|---|
| `NOTES_DIR` | Where notes land. Default `~/Debrief`. |
| `YOUR_NAME` | Your label in the transcript (action items get assigned to it). |
| `THEIR_NAME` | The far side's label. Default `Them`. |
| `MARKDOWN_APP` | App that opens finished notes, e.g. `Obsidian`. |
| `TRAY_LABEL` | Text next to the menu bar icon. Empty = icon only. |
| `GLOBAL_SHORTCUT` | Default `Command+Shift+R`. Empty to disable. |
| `SYSTEM_AUDIO` | `1` also captures what the Mac plays (see above). Default `0`. |
| `MIC_GAIN` / `SYSTEM_GAIN` | Turn a quiet side up (try `1.6`). |
| `SUMMARY_PROVIDER` | `auto` (default), `local`, `claude-cli`, `anthropic`, `openai`, `groq`, `none`. |
| `LLM_MODEL` | `qwen3-4b` (default) or a path to any `.gguf`. |
| `WHISPER_MODEL` | Path to a whisper model. `npm run fetch-model -- small` is ~3x faster. |

`SUMMARY_PROVIDER=auto` means: an API key if you typed one in, otherwise the
local model, otherwise the Claude Code CLI, otherwise transcript only. Do
nothing and everything stays on this Mac.

*Check Setup…* in the menu shows exactly which routes are live.

## SketchyBar

If your menu bar is hidden or replaced, mirror the app into SketchyBar. The
app writes its state to `~/.config/debrief/state.json` and takes one-word
commands from `~/.config/debrief/command`:

```bash
echo toggle > ~/.config/debrief/command    # also: start, stop, discard,
                                           # open-note, open-folder
```

A ready-made item lives in `sketchybar/` - copy the two plugins into
`~/.config/sketchybar/plugins/`, add the block from `sketchybar/item.sh` to
your sketchybarrc, and run `sketchybar/icon/install.sh` once for the icon font.

## Start at login

```bash
./scripts/install-launchagent.sh
```

That writes and loads `~/Library/LaunchAgents/com.maxoleary.debrief.plist`.
Don't also turn on an "open at login" toggle anywhere - you'd get two copies.

## If something goes wrong

- **"Recording microphone only"** (with `SYSTEM_AUDIO=1`) - Screen Recording
  isn't granted, or was granted after launch. Grant it, quit, reopen.
- **Everyone is labelled "You"** - the far side is only captured (and
  labelled "Them") with `SYSTEM_AUDIO=1`.
- **The far side is quiet** - set `SYSTEM_GAIN=1.6` and reload configuration.
- **Summary says "Not logged in"** - run `claude` once in a terminal and
  check you're signed in.
- The log is at `~/Library/Logs/Debrief.log` (menu: *Open Log*).
- If processing ever fails, the raw audio is kept and the error dialog has a
  "Show Raw Audio" button. A bad run can never cost you the recording.

**Self test** - records 12 seconds, runs the whole pipeline, reports:

```bash
open -a "Debrief" --args --selftest 12
tail -f ~/Library/Logs/Debrief.log
```

**Test processing alone** against any audio file you already have:

```bash
node scripts/test-pipeline.js /path/to/audio.m4a /tmp/NotesTest
```
