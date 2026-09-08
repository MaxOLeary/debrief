'use strict'
// Downloads the speech engine (sherpa-onnx runtime) and the Parakeet TDT 0.6B
// v3 int8 model ahead of time, so the first launch of the app doesn't have to.
// The app does exactly this on its own if you skip it. Nothing downloads if
// UltraWhisper already installed the same files in ~/.config/ultrawhisper.
// Usage: node scripts/fetch-model.js
const cfgLib = require('../src/lib/config')
const parakeet = require('../src/lib/parakeet')
const { progressLabel } = require('../src/lib/localengine')

async function main () {
  const cfg = cfgLib.load()
  const s = parakeet.status(cfg)
  if (s.ready) { console.log(`Already installed: ${s.label}\n  ${s.runtime}\n  ${s.model.dir}`); return }
  let last = ''
  const done = await parakeet.ensure(cfg, (prog) => {
    const label = progressLabel(prog)
    if (label !== last) { last = label; process.stdout.write(`\r  ${label}          `) }
  })
  console.log(`\nInstalled ${done.label}\n  ${done.runtime}\n  ${done.model.dir}`)
}
main().catch(e => { console.error('\n' + e.message); process.exit(1) })
