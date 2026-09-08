# Debrief extras

Everything that isn't needed to install and use the app. Installing and using
it is in [README.md](README.md).

## Configuration

Config lives at `~/.config/debrief/.env` (the menu's **Edit Configuration
(.env)** opens it, **Reload Configuration** applies it). Every line is
optional, and `.env.example` in the repo lists all of them with comments;
the ones people actually change:

| Variable | What it does |
|---|---|
| `NOTES_DIR` | Where notes land. Default `~/Debrief`. |
| `YOUR_NAME` | Your label in the transcript (action items get assigned to it). |
| `THEIR_NAME` | The far side's label. Default `Them`. |
| `MARKDOWN_APP` | App that opens finished notes, e.g. `Obsidian`. |
| `TRAY_LABEL` | Text next to the menu bar icon. Empty = icon only. |
| `GLOBAL_SHORTCUT` | Default `Command+Shift+R`. `none` turns it off (empty means default). |
| `SYSTEM_AUDIO` | `1` also captures what the Mac plays (see below). Default `0`. |
| `MIC_GAIN` / `SYSTEM_GAIN` | Turn a quiet side up (try `1.6`). |
| `SUMMARY_PROVIDER` | `auto` (default), `local`, `claude-cli`, `anthropic`, `openai`, `groq`, `none`. |
| `LLM_MODEL` | `qwen3-4b` (default), `qwen2.5-3b`, `llama3.2-3b`, or a path to any `.gguf`. Switching to a model you don't have yet triggers a ~2 GB download on next launch. |
| `PARAKEET_MODEL` | A Parakeet build's folder name under `~/.config/debrief/models/` (or a path to one). Default is the v3 int8 build the app downloads. |

`SUMMARY_PROVIDER=auto` means: an API key if you typed one in, otherwise the
local model. Do nothing and everything stays on this Mac. The Claude Code CLI
is only used when you set `SUMMARY_PROVIDER=claude-cli` yourself.

**Check Setup…** in the menu shows exactly which routes are live.

## How transcription works

The engine is NVIDIA Parakeet TDT 0.6B v3 running through sherpa-onnx, the
same runtime, model and wire format UltraWhisper uses (if UltraWhisper is
installed, Debrief borrows its copies from `~/.config/ultrawhisper/` and
downloads nothing). A meeting is mostly silence, so Debrief first finds who
is talking when: each channel has its own energy gate, and where both are up
the louder one wins, which keeps the far side from showing up twice through
your mic. That speech is cut into chunks of at most 30 seconds at natural
pauses, pushed through a warm Parakeet server on localhost a couple at a
time, and Parakeet's word timestamps become the `[00:01:23]` stamps in the
note. On an M1 Air that is about 20x faster than real time.

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

A ready-made item lives in `sketchybar/`. It expects the usual SketchyBar
starter layout: a `colors.sh` in `~/.config/sketchybar/` that defines
`WHITE`, `RED`, `AMBER` and `DIM`, and `PLUGIN_DIR` and `FONT` set in your
sketchybarrc. Then:

1. Copy `sketchybar/debrief.sh` and `sketchybar/debrief_click.sh` into
   `~/.config/sketchybar/plugins/`.
2. Copy `sketchybar/icon/DebriefIcons.ttf` into `~/Library/Fonts/` and run
   `brew services restart sketchybar` - SketchyBar only reads the font list at
   launch, so a plain reload won't see it.
3. Paste the block from `sketchybar/item.sh` into your sketchybarrc after
   `colors.sh` is sourced.

`sketchybar/icon/install.sh` is only for editing the icon: it rebuilds the
font from `grid.txt` (needs python3 and node) and installs it.

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
| AI models | `~/.config/debrief/models/`, `~/.config/debrief/sherpa-onnx/` and `~/.config/debrief/llama/` |
| Config | `~/.config/debrief/.env` |
| Audio while recording | a `debrief-*` scratch folder under the per-user temp dir (`echo $TMPDIR`, under `/var/folders/`), deleted only after the note is safely written |
| Log | `~/Library/Logs/Debrief.log` |

## Testing

**Self test** - records 12 seconds, runs the whole pipeline, reports:

```bash
echo "selftest 12" > ~/.config/debrief/command     # asks the running app
tail -f ~/Library/Logs/Debrief.log                 # look for SELFTEST_RESULT
```

The app stays up afterwards. `open -n -a Debrief --args --selftest=12` does
the same through a second launch that hands the flag over and exits (the
`-n` matters: plain `open -a` only brings the running copy forward). Started
from scratch with the flag, the app quits when the test is done.

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
- **"No transcriber available"** - the speech engine hasn't downloaded yet.
  `npm run fetch-model` does it by hand; **Check Setup…** shows what's found.
- **A quiet recording comes back empty** - Debrief only transcribes audio that
  clears its speech gate, so a genuinely silent recording produces an empty
  transcript and no summary, which is the honest answer. Turn a quiet side up
  with `MIC_GAIN` / `SYSTEM_GAIN` if real speech is getting dropped.
