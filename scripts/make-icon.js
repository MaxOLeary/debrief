'use strict'
// Draws the menu-bar icons from scratch so the repo carries no binary blobs.
// macOS "template" images are pure black + alpha; the system recolours them
// for the light or dark menu bar automatically.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng (size, pixels) { // pixels: Uint8Array RGBA, size*size*4
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // colour type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    pixels.copy
      ? pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
      : Buffer.from(pixels.slice(y * size * 4, (y + 1) * size * 4)).copy(raw, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// 4x supersampled coverage of a filled disc, so small icons stay smooth.
function discCoverage (size, cx, cy, r, x, y) {
  let hits = 0
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4
      const py = y + (sy + 0.5) / 4
      if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) hits++
    }
  }
  return hits / 16
}

// Max's pixel speech bubble - same 16x16 grid as sketchybar/icon/grid.txt,
// so the native tray and the SketchyBar item show the identical mark.
const BUBBLE = [
  '..############..',
  '.#............#.',
  '#..............#',
  '#..###########.#',
  '#..............#',
  '#..######......#',
  '#..............#',
  '#..#########...#',
  '#..............#',
  '#..............#',
  '.#............#.',
  '..###...######..',
  '....#..#........',
  '....#.#.........',
  '....##..........',
  '....#...........'
]

function drawBubble (size, colour) { // size must be a multiple of 16
  const buf = Buffer.alloc(size * size * 4)
  const scale = size / 16
  const [r, g, b] = colour
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ink = BUBBLE[Math.floor(y / scale)][Math.floor(x / scale)] === '#'
      const idx = (y * size + x) * 4
      buf[idx] = r
      buf[idx + 1] = g
      buf[idx + 2] = b
      buf[idx + 3] = ink ? 255 : 0
    }
  }
  return buf
}

function draw (size, { filled, colour }) {
  const buf = Buffer.alloc(size * size * 4)
  const c = size / 2
  const outer = size * 0.40
  const inner = size * 0.24
  const [r, g, b] = colour
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = discCoverage(size, c, c, outer, x, y)
      const i = discCoverage(size, c, c, inner, x, y)
      // Idle is a ring (hollow); recording is a solid dot.
      const a = filled ? o : Math.max(0, o - i)
      const idx = (y * size + x) * 4
      buf[idx] = r
      buf[idx + 1] = g
      buf[idx + 2] = b
      buf[idx + 3] = Math.round(a * 255)
    }
  }
  return buf
}

const assets = path.join(__dirname, '..', 'assets')
fs.mkdirSync(assets, { recursive: true })

const jobs = [
  ['iconRecording.png', 16, { filled: true, colour: [214, 46, 46] }],
  ['iconRecording@2x.png', 32, { filled: true, colour: [214, 46, 46] }],
  ['iconBusyTemplate.png', 16, { filled: true, colour: [0, 0, 0] }],
  ['iconBusyTemplate@2x.png', 32, { filled: true, colour: [0, 0, 0] }]
]

for (const [name, size, opts] of jobs) {
  fs.writeFileSync(path.join(assets, name), encodePng(size, draw(size, opts)))
}
// Idle icon: the speech bubble, as a black-and-alpha template.
for (const [name, size] of [['iconTemplate.png', 16], ['iconTemplate@2x.png', 32]]) {
  fs.writeFileSync(path.join(assets, name), encodePng(size, drawBubble(size, [0, 0, 0])))
}
console.log(`wrote ${jobs.length + 2} icons to assets/`)
