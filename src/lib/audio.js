'use strict'
// Audio plumbing with nothing to install: macOS ships afconvert/afinfo, and
// the recorder writes AAC-in-MP4 directly, so ffmpeg is no longer required.
// (It's still used, if present, for the optional cloud-transcription path,
// which needs the audio sliced into 25 MB uploads.)
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const AFCONVERT = '/usr/bin/afconvert'
const AFINFO = '/usr/bin/afinfo'

function run (bin, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d; if (onStderr) onStderr(d.toString()) })
    p.on('error', reject)
    p.on('close', code => {
      if (code === 0) resolve({ stdout: out, stderr: err })
      else reject(new Error(`${path.basename(bin)} exited ${code}\n${err.slice(-4000)}`))
    })
  })
}

// MediaRecorder writes fragmented MP4: a header, then one complete fragment
// every few seconds. If the app died mid-write, the file ends in a partial
// fragment and CoreAudio refuses to open it at all. Walking the top-level
// boxes and cutting at the last complete one recovers everything but the
// final few seconds.
function repairFragmentedMp4 (file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const head = Buffer.alloc(16)
    let pos = 0
    let lastGood = 0
    while (pos + 8 <= size) {
      if (fs.readSync(fd, head, 0, 16, pos) < 8) break
      let boxSize = head.readUInt32BE(0)
      if (boxSize === 1) {
        if (pos + 16 > size) break
        boxSize = Number(head.readBigUInt64BE(8))
      } else if (boxSize === 0) {
        boxSize = size - pos // "to end of file"
      }
      if (boxSize < 8 || pos + boxSize > size) break
      pos += boxSize
      lastGood = pos
    }
    if (lastGood > 0 && lastGood < size) {
      fs.ftruncateSync(fd, lastGood)
      return { repaired: true, dropped: size - lastGood }
    }
    return { repaired: false, dropped: 0 }
  } finally {
    fs.closeSync(fd)
  }
}

// whisper.cpp wants 16 kHz 16-bit PCM. Both channels are kept: left = your
// mic, right = everything the Mac played, which is how it tells you apart.
async function toWhisperWav (input, output) {
  try {
    await run(AFCONVERT, ['-f', 'WAVE', '-d', 'LEI16@16000', input, output])
  } catch (e) {
    const fix = repairFragmentedMp4(input)
    if (!fix.repaired) throw e
    console.warn(`[audio] recording was cut mid-chunk; dropped ${fix.dropped} trailing bytes and retried`)
    await run(AFCONVERT, ['-f', 'WAVE', '-d', 'LEI16@16000', input, output])
  }
  return output
}

// The keeper copy next to the note is the recording itself: it's already AAC
// in an .m4a container, so it just gets moved into place. Stereo, mic left
// and the call right, so you can hear who said what.
function toArchiveM4a (input, output) {
  try { fs.renameSync(input, output) } catch { fs.copyFileSync(input, output) }
  return output
}

async function durationSeconds (input) {
  try {
    const { stdout } = await run(AFINFO, [input])
    const m = stdout.match(/estimated duration:\s*([\d.]+)\s*sec/)
    return m ? parseFloat(m[1]) : 0
  } catch { return 0 }
}

// Whisper APIs cap uploads at 25 MB, so long meetings get sliced into
// segments first and stitched back together after. This is the one job that
// still needs ffmpeg; the local path never calls it.
async function splitForUpload (ffmpeg, input, dir, segmentSeconds = 600) {
  if (!ffmpeg || !fs.existsSync(ffmpeg)) {
    throw new Error('Cloud transcription needs ffmpeg installed (brew install ffmpeg). Local transcription does not.')
  }
  const pattern = path.join(dir, 'part-%03d.m4a')
  await run(ffmpeg, [
    '-y', '-i', input,
    '-f', 'segment', '-segment_time', String(segmentSeconds),
    '-reset_timestamps', '1',
    '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '32k',
    pattern
  ])
  return fs.readdirSync(dir)
    .filter(f => /^part-\d+\.m4a$/.test(f))
    .sort()
    .map(f => path.join(dir, f))
}

module.exports = { run, repairFragmentedMp4, toWhisperWav, toArchiveM4a, durationSeconds, splitForUpload }
