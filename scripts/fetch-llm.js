'use strict'
// Downloads the local AI engine (llama.cpp) and chat model ahead of time, so the
// first launch of the app doesn't have to. The app does exactly this on its own
// if you skip it. Usage: node scripts/fetch-llm.js [qwen3-4b|qwen2.5-3b|llama3.2-3b]
const cfgLib = require('../src/lib/config')
const localllm = require('../src/lib/localllm')
const { progressLabel } = require('../src/lib/localengine')

async function main () {
  const cfg = cfgLib.load()
  if (process.argv[2]) cfg.llmModel = process.argv[2]
  const s = localllm.status(cfg)
  if (s.ready) { console.log(`Already installed: ${s.model.label}\n  ${s.server}\n  ${s.model.path}`); return }
  let last = ''
  const done = await localllm.ensure(cfg, (prog) => {
    const label = progressLabel(prog)
    if (label !== last) { last = label; process.stdout.write(`\r  ${label}          `) }
  })
  console.log(`\nInstalled ${done.model.label}\n  ${done.server}\n  ${done.model.path}`)
}
main().catch(e => { console.error('\n' + e.message); process.exit(1) })
