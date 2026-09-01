# Debrief extras

Everything that isn't needed to install and use the app. The short version of
all of this is in [README.md](README.md).

## Configuration

Config lives at `~/.config/debrief/.env` (the menu's **Edit Configuration**
opens it, **Reload Configuration** applies it). Every line is optional.

| Variable | What it does |
|---|---|
| `NOTES_DIR` | Where notes land. Default `~/Debrief`. |
| `YOUR_NAME` | Your label in the transcript (action items get assigned to it). |
| `THEIR_NAME` | The far side's label. Default `Them`. |
| `MARKDOWN_APP` | App that opens finished notes, e.g. `Obsidian`. |
| `TRAY_LABEL` | Text next to the menu bar icon. Empty = icon only. |
| `GLOBAL_SHORTCUT` | Default `Command+Shift+R`. Empty to disable. |
| `SYSTEM_AUDIO` | `1` also captures what the Mac plays (see below). Default `0`. |
| `MIC_GAIN` / `SYSTEM_GAIN` | Turn a quiet side up (try `1.6`). |
| `SUMMARY_PROVIDER` | `auto` (default), `local`, `claude-cli`, `anthropic`, `openai`, `groq`, `none`. |
| `LLM_MODEL` | `qwen3-4b` (default), `qwen2.5-3b`, `llama3.2-3b`, or a path to any `.gguf`. |
| `WHISPER_MODEL` | Path to a whisper model. The `small` model is ~3x faster than `medium`. |

`SUMMARY_PROVIDER=auto` means: an API key if you typed one in, otherwise the
local model, otherwise the Claude Code CLI, otherwise transcript only. Do
nothing and everything stays on this Mac.

**Check Setup…** in the menu shows exactly which routes are live.

## Recording the far side of a call

By default Debrief records the microphone only. Capturing what the Mac itself
plays is off because the only route macOS offers is the screen-capture API,
and the macOS 26 permission dialog for it is genuinely alarming ("bypass the
private window picker and access your screen").

If you're fine with that dialog, set `SYSTEM_AUDIO=1`. Your mic then goes on
the left audio channel and the Mac's audio on the right, and the transcript
comes back labelled:

```
**[00:00:00] You:** I ran the CFD last night and we're 8% over target.
**[00:00:10] Them:** So do we grow the wing or cut weight?
```

Grant **Screen & System Audio Recording** when asked, then quit and reopen
the app - macOS only hands that permission to a freshly launched process.
Nothing from the screen image is ever kept.

## Opening notes in other apps

The menu's **Open Last Note With** offers three homes:

- **Obsidian** - opens the Markdown file. Set `MARKDOWN_APP=Obsidian` to make
  it the default everywhere. Obsidian only opens files inside a vault, so
  either point `NOTES_DIR` into your vault or open the notes folder once with
  "Open folder as vault".
- **Postit** - the note pops up as a Postit sticky.
- **Apple Notes** - the note is converted to HTML and added to Notes. The
  first time, macOS asks you to allow Debrief to control Notes.

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
your sketchybarrc, and run `sketchybar/icon/install.sh` once for the icon
font.

## Start at login

```bash
./scripts/install-launchagent.sh
```

That writes and loads `~/Library/LaunchAgents/com.maxoleary.debrief.plist`.
Don't also turn on an "open at login" toggle anywhere - you'd get two copies.

## Where things go

| Thing | Where |
|---|---|
| Note + audio | `~/Debrief/` |
| AI models | `~/.config/debrief/models/` and `~/.config/debrief/llama/` |
| Config | `~/.config/debrief/.env` |
| Audio while recording | a scratch folder in `/tmp`, deleted only after the note is safely written |
| Log | `~/Library/Logs/Debrief.log` |

## Testing

**Self test** - records 12 seconds, runs the whole pipeline, reports:

```bash
open -a Debrief --args --selftest 12
tail -f ~/Library/Logs/Debrief.log
```

**Test processing alone** against any audio file you already have (fastest
way to tell a capture problem from a processing one):

```bash
node scripts/test-pipeline.js /path/to/audio.m4a /tmp/NotesTest
```

## More troubleshooting

- **"Recording microphone only"** (with `SYSTEM_AUDIO=1`) - Screen Recording
  isn't granted, or was granted after launch. Grant it, quit, reopen.
- **Everyone is labelled "You"** - the far side is only captured (and
  labelled "Them") with `SYSTEM_AUDIO=1`.
- **The far side is quiet** - set `SYSTEM_GAIN=1.6` and reload configuration.
- **Summary says "Not logged in"** - the `claude-cli` route needs the Claude
  Code CLI signed in. Run `claude` once in a terminal and check.
- **Whisper invents a sentence during silence** - already handled three ways
  (non-speech suppression, Silero VAD, a junk filter). A genuinely silent
  recording produces an empty transcript and no summary, which is the honest
  answer.
