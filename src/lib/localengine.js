'use strict'
// Plumbing shared by the two local engines (llama.cpp for summaries,
// sherpa-onnx for transcription): downloading and unpacking a release,
// running one install at a time, and driving a server child on localhost.
const fs = require('fs')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')

// ── Installing ──────────────────────────────────────────────────────────────
// Streams to a .part file and renames on success, so a killed download never
// leaves a half-model that looks complete.
async function download (url, dest, expectedBytes, onProgress) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const part = dest + '.part'
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`)
  const total = parseInt(res.headers.get('content-length') || '0', 10) || expectedBytes || 0

  const out = fs.createWriteStream(part)
  let got = 0
  let lastPct = -1
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.length
      if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r))
      if (onProgress && total) {
        const pct = Math.floor(got * 100 / total)
        if (pct !== lastPct) { lastPct = pct; onProgress(pct, got, total) }
      }
    }
    await new Promise((resolve, reject) => { out.end(); out.on('finish', resolve); out.on('error', reject) })
  } catch (e) {
    try { out.destroy() } catch { /* ignore */ }
    try { fs.unlinkSync(part) } catch { /* ignore */ }
    throw e
  }
  if (total && got < total) {
    try { fs.unlinkSync(part) } catch { /* ignore */ }
    throw new Error(`Download of ${path.basename(dest)} stopped early (${got} of ${total} bytes)`)
  }
  fs.renameSync(part, dest)
}

function run (cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let err = ''
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`)))
  })
}

// Download a release tarball (.tar.gz or .tar.bz2, tar works it out) and
// unpack it so `dest` holds the archive's contents directly, without the
// single top-level folder these releases all wrap themselves in.
async function fetchArchive (url, dest, onProgress) {
  const tar = path.join(dest, '.download.tar')
  fs.mkdirSync(dest, { recursive: true })
  await download(url, tar, 0, onProgress)
  await run('/usr/bin/tar', ['-xf', tar, '--strip-components=1', '-C', dest])
  fs.unlinkSync(tar)
  // Strip the quarantine flag so Gatekeeper doesn't block binaries we fetched ourselves.
  await run('/usr/bin/xattr', ['-cr', dest]).catch(() => {})
}

// One in-flight install per engine: the app kicks it off at launch, and a
// meeting that lands mid-download simply awaits the same promise.
function singleflight (fn) {
  let inflight = null
  return (...args) => {
    if (inflight) return inflight
    inflight = Promise.resolve().then(() => fn(...args)).finally(() => { inflight = null })
    return inflight
  }
}

// Installers report { noun, pct, got?, total? }; this turns that into the
// text shown in the menu bar and the terminal.
function progressLabel (prog) {
  if (!prog) return 'Preparing local AI…'
  const gb = prog.total ? ` of ${(prog.total / 1e9).toFixed(1)} GB` : ''
  return `Downloading ${prog.noun} ${prog.pct}%${gb}`
}

// ── Serving ─────────────────────────────────────────────────────────────────
function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function tcpOpen (port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => { sock.destroy(); resolve(false) })
  })
}

async function httpOk (url) {
  try { return (await fetch(url)).ok } catch { return false }
}

// sherpa-onnx's websocket server has no --host flag and binds 0.0.0.0.
// localhostOnly puts a 127.0.0.1 proxy in front and sandboxes the child so
// inbound from the LAN is denied. llama.cpp passes --host itself and leaves this off.
const LOCALHOST_INBOUND = `(version 1)
(allow default)
(deny network-inbound)
(allow network-inbound (local ip "localhost:*"))
`

function listenLocal (port, childPort) {
  const proxy = net.createServer((down) => {
    const up = net.connect(childPort, '127.0.0.1')
    const fail = () => { down.destroy(); up.destroy() }
    down.on('error', fail)
    up.on('error', fail)
    down.pipe(up)
    up.pipe(down)
  })
  return new Promise((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(port, '127.0.0.1', () => resolve(proxy))
  })
}

// Spawn a server on a free localhost port. `args(port)` builds its argv,
// `libDir` goes on DYLD_LIBRARY_PATH for builds that ship their dylibs
// beside the binary. The last few KB of stderr are kept for the error log.
async function startServer ({ name, bin, args, libDir, localhostOnly, readyFromStderr }) {
  const port = await freePort()
  const childPort = localhostOnly ? await freePort() : port
  const env = { ...process.env }
  if (libDir) env.DYLD_LIBRARY_PATH = libDir

  let proxy = null
  if (localhostOnly) proxy = await listenLocal(port, childPort)

  const argv = args(childPort)
  const spawnOpts = { stdio: ['ignore', 'pipe', 'pipe'], env }
  const child = localhostOnly
    ? spawn('/usr/bin/sandbox-exec', ['-p', LOCALHOST_INBOUND, bin, ...argv], spawnOpts)
    : spawn(bin, argv, spawnOpts)
  let stderr = ''
  const collect = d => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000) }
  child.stderr.on('data', collect)
  child.stdout.on('data', collect)
  let exited = null
  child.once('error', err => { exited = -1; collect(String(err.message || err)) })
  child.once('exit', code => { exited = code; if (proxy) proxy.close() })

  return {
    port,
    // Poll until the child is actually serving. For sherpa, that is "Listening on"
    // in its log (a TCP open is a failed websocket handshake). Probe the child,
    // not the proxy: the proxy is listening before the model is loaded.
    async ready (probe, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (exited !== null) throw new Error(`${name} exited (${exited}) before it was ready`)
        if (readyFromStderr ? readyFromStderr.test(stderr) : await probe(childPort)) return
        await new Promise(r => setTimeout(r, 200))
      }
      throw new Error(`${name} did not become ready in time`)
    },
    logStderr (tag) {
      if (stderr.trim()) console.error(`${tag} ${name} stderr:`, stderr.trim().split('\n').slice(-5).join(' | '))
    },
    stop () {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      if (proxy) try { proxy.close() } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 3000).unref()
    }
  }
}

module.exports = { download, fetchArchive, singleflight, progressLabel, startServer, tcpOpen, httpOk }
