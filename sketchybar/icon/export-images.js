#!/usr/bin/env node
'use strict'
// grid.txt -> SVG + PNGs, black-on-white and the inverted version.
// Hand-rolls the PNG with node's built-in zlib so this needs no dependencies.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const HERE = __dirname
const rows = fs.readFileSync(path.join(HERE, 'grid.txt'), 'utf8')
  .split('\n')
  .filter(l => l.length && /^[#.]+$/.test(l))
if (rows.length !== 16 || rows.some(r => r.length !== 16)) {
  throw new Error('grid must be 16x16')
}

// ── SVG: one rect per horizontal run, so runs stay seamless ────────────────
function svg (color) {
  let d = ''
  rows.forEach((row, y) => {
    let run = 0
    for (let x = 0; x <= 16; x++) {
      if (x < 16 && row[x] === '#') { run++; continue }
      if (run) { d += `<rect x="${x - run}" y="${y}" width="${run}" height="1"/>`; run = 0 }
    }
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" ` +
         `shape-rendering="crispEdges" fill="${color}">${d}</svg>\n`
}

// ── PNG: 16x16 scaled by whole-pixel repeat (nearest neighbour, no blur) ───
function crc32 (buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = c ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png (scale, ink, bg) {
  const size = 16 * scale
  // one filter byte (0 = none) + RGBA per pixel, per scanline
  const raw = Buffer.alloc(size * (1 + size * 4))
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0
    const row = rows[Math.floor(y / scale)]
    for (let x = 0; x < size; x++) {
      const c = row[Math.floor(x / scale)] === '#' ? ink : bg
      raw[p++] = c[0]; raw[p++] = c[1]; raw[p++] = c[2]; raw[p++] = c[3]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 6    // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const BLACK = [0, 0, 0, 255]
const WHITE = [255, 255, 255, 255]
const CLEAR = [0, 0, 0, 0]

const out = []
fs.writeFileSync(path.join(HERE, 'icon-black.svg'), svg('#000000')); out.push('icon-black.svg')
fs.writeFileSync(path.join(HERE, 'icon-white.svg'), svg('#ffffff')); out.push('icon-white.svg')

for (const scale of [1, 2, 4]) {
  const sfx = scale === 1 ? '' : `@${scale}x`
  const files = [
    [`icon-black${sfx}.png`, BLACK, WHITE], // black on solid white
    [`icon-white${sfx}.png`, WHITE, BLACK], // inverted: white on solid black
    [`iconTemplate${sfx}.png`, BLACK, CLEAR] // transparent, for macOS tray tinting
  ]
  for (const [name, ink, bg] of files) {
    fs.writeFileSync(path.join(HERE, name), png(scale, ink, bg))
    out.push(name)
  }
}
console.log('wrote:\n  ' + out.join('\n  '))
