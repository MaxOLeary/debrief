'use strict'
// Sends a finished note into the Apple Notes app. Notes can't open markdown
// files, but it happily accepts HTML as a new note's body — so we convert the
// markdown and hand it over with one AppleScript. The first time this runs,
// macOS asks "Debrief wants access to control Notes" (Allow/Deny, no password).
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

// Just enough markdown for Debrief's own notes: headings, bold, bullet and
// checkbox lists, horizontal rules, plain paragraphs. Not a general parser.
function markdownToHtml (md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')

  const out = []
  let inList = false
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false } }

  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    const li = line.match(/^[-*]\s+(?:\[([ xX])\]\s+)?(.*)$/)
    if (h) {
      closeList()
      const tag = `h${h[1].length}`
      out.push(`<${tag}>${inline(h[2])}</${tag}>`)
    } else if (li) {
      if (!inList) { out.push('<ul>'); inList = true }
      const box = li[1] === undefined ? '' : (li[1] === ' ' ? '☐ ' : '☑ ')
      out.push(`<li>${box}${inline(li[2])}</li>`)
    } else if (/^---+$/.test(line)) {
      closeList()
      out.push('<hr>')
    } else if (line === '') {
      closeList()
      out.push('<br>')
    } else {
      closeList()
      out.push(`<div>${inline(line)}</div>`)
    }
  }
  closeList()
  return out.join('\n')
}

// The body goes through a temp file, not a command-line argument — a
// one-hour transcript is far too big for argv.
function send (markdownFile, cb) {
  let md
  try {
    md = fs.readFileSync(markdownFile, 'utf8')
  } catch (e) { return cb(e) }

  const title = path.basename(markdownFile, '.md')
  const html = `<h1>${title}</h1>\n` + markdownToHtml(md)
  const tmp = path.join(os.tmpdir(), `debrief-note-${Date.now()}.html`)
  try {
    fs.writeFileSync(tmp, html)
  } catch (e) { return cb(e) }

  const script = [
    'on run argv',
    '  set f to POSIX file (item 1 of argv)',
    '  set body to read f as «class utf8»',
    '  tell application "Notes"',
    '    make new note at folder "Notes" of default account with properties {body:body}',
    '  end tell',
    'end run'
  ].join('\n')

  execFile('/usr/bin/osascript', ['-e', script, tmp], (err, _out, stderr) => {
    try { fs.rmSync(tmp) } catch { /* ignore */ }
    if (err) return cb(new Error((stderr || err.message).trim()))
    cb(null)
  })
}

module.exports = { send, markdownToHtml }
