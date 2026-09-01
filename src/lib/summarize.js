'use strict'
const fs = require('fs')
const path = require('path')

const SYSTEM_PROMPT = `You turn a rough speech-to-text transcript of a meeting into short, plain notes. Write like a person jotting notes for themselves, not like a corporate memo.

The transcript is automatic, so expect misheard words, missing punctuation, and unreliable speaker names. Use your best reading of garbled names and never invent people, decisions, tasks, or dates. Stick close to what was actually said.

Length matches the meeting. A one-sentence meeting gets one or two lines. A ten-minute chat gets a handful of bullets. An hour-long meeting can get more. Never pad to hit a length.

Reply in GitHub-flavoured Markdown with no preamble and no closing remarks:

## Notes

- Short bullets, casual and direct, in everyday words. Say what was talked about and what came of it. No buzzwords, no "stakeholders", "alignment", "leverage", "synergy", or anything that sounds like a press release.

Only add these sections if there is something real to put in them. Leave them out entirely otherwise. Don't repeat a point that already appears in another section: if a task is in To do, it doesn't need to be in Notes or Decisions too.

## Decisions

- One line per thing that was actually settled.

## To do

- [ ] **Name** - the task, plus the due date if one was said. Use **Unassigned** only if an owner really wasn't clear.`

function userPrompt (transcript, meta) {
  const head = [
    meta.date ? `Meeting date: ${meta.date}` : null,
    meta.duration ? `Duration: ${meta.duration}` : null,
    meta.diarized
      ? `Speaker labels: "${meta.me || 'You'}" is the person recording; ` +
        `"${meta.them || 'Them'}" is everyone coming through the computer speakers ` +
        '(that label may cover several different people).'
      : 'Speaker labels are not available in this transcript.'
  ].filter(Boolean).join('\n')

  return `${head}\n\nTranscript:\n\n${transcript}`
}

// ── Anthropic (official SDK) ────────────────────────────────────────────────
async function viaAnthropic (cfg, transcript, meta) {
  const mod = require('@anthropic-ai/sdk')
  const Anthropic = mod.default || mod
  const client = new Anthropic({ apiKey: cfg.anthropicKey })
  const model = cfg.summaryModel || 'claude-opus-5'

  const base = {
    model,
    max_tokens: 8000,
    output_config: { effort: 'medium' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt(transcript, meta) }]
  }

  // Server-side fallback rescues the rare transcript a safety classifier
  // declines. If the account doesn't have that beta, retry plainly.
  let response
  try {
    response = await client.beta.messages.create({
      ...base,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    })
  } catch (e) {
    const status = e && e.status
    if (status !== 400 && status !== 404) throw e
    response = await client.messages.create(base)
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined to summarise this transcript.')
  }
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim()
  if (!text) throw new Error('Anthropic returned an empty summary.')
  return { text, model: response.model || model, provider: 'Anthropic' }
}

// ── OpenAI / Groq (same chat-completions shape) ─────────────────────────────
async function viaOpenAICompatible (cfg, transcript, meta, which) {
  const conf = which === 'groq'
    ? { url: 'https://api.groq.com/openai/v1/chat/completions', key: cfg.groqKey, model: cfg.summaryModel || 'llama-3.3-70b-versatile', label: 'Groq' }
    : { url: 'https://api.openai.com/v1/chat/completions', key: cfg.openaiKey, model: cfg.summaryModel || 'gpt-4o', label: 'OpenAI' }

  const res = await fetch(conf.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conf.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: conf.model,
      max_tokens: 4000,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt(transcript, meta) }
      ]
    })
  })
  if (!res.ok) throw new Error(`${conf.label} returned ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const json = await res.json()
  const text = (json.choices?.[0]?.message?.content || '').trim()
  if (!text) throw new Error(`${conf.label} returned an empty summary.`)
  return { text, model: conf.model, provider: conf.label }
}

// ── Claude Code CLI (uses the existing subscription, no API billing) ────────
function viaClaudeCli (cfg, transcript, meta) {
  const { spawn } = require('child_process')
  const os = require('os')

  return new Promise((resolve, reject) => {
    const args = ['-p', SYSTEM_PROMPT]
    if (cfg.summaryModel) args.push('--model', cfg.summaryModel)

    // Run from a scratch directory so Claude Code doesn't load a project's
    // CLAUDE.md, skills, or MCP servers just to summarise a transcript.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-claude-'))

    // Launched from Finder the environment is minimal, and without USER/LOGNAME
    // the CLI can't reach its keychain credentials and reports "Not logged in".
    const child = spawn(cfg.claudeBin, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: process.env.HOME || os.homedir(),
        USER: process.env.USER || os.userInfo().username,
        LOGNAME: process.env.LOGNAME || os.userInfo().username,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
      }
    })

    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Claude Code timed out after 10 minutes.'))
    }, 10 * 60 * 1000)

    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); cleanup(); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      cleanup()
      if (code !== 0) return reject(new Error(`Claude Code exited ${code}: ${err.slice(-500)}`))
      const text = out.trim()
      if (!text) return reject(new Error('Claude Code returned an empty summary.'))
      resolve({ text, model: cfg.summaryModel || 'subscription', provider: 'Claude Code' })
    })

    function cleanup () { try { fs.rmSync(cwd, { recursive: true, force: true }) } catch { /* ignore */ } }

    child.stdin.write(userPrompt(transcript, meta))
    child.stdin.end()
  })
}

// ── Local llama.cpp (default: no account, nothing leaves the Mac) ───────────
function viaLocal (cfg, transcript, meta, onStatus) {
  const localllm = require('./localllm')
  return localllm.chat(cfg, SYSTEM_PROMPT, userPrompt(transcript, meta), onStatus)
}

// onStatus(text) is optional: the local route uses it to report a first-time
// model download and the "Loading model…" pause in the menu bar.
async function summarize (cfg, transcript, meta, onStatus) {
  switch (cfg.resolvedSummarizer) {
    case 'local': return viaLocal(cfg, transcript, meta, onStatus)
    case 'claude-cli': return viaClaudeCli(cfg, transcript, meta)
    case 'anthropic': return viaAnthropic(cfg, transcript, meta)
    case 'openai': return viaOpenAICompatible(cfg, transcript, meta, 'openai')
    case 'groq': return viaOpenAICompatible(cfg, transcript, meta, 'groq')
    default: return null // no key configured — the note still gets a transcript
  }
}

module.exports = { summarize, SYSTEM_PROMPT }
