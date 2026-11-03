#!/usr/bin/env node
/**
 * Thin adapter between the dsh-superagent silk Source (src/sources/silk.ts) and a Silk IM
 * backend's bot HTTP face (backend `routes/DshBotRoutes.kt`).
 *
 * Configuration comes from the environment of the dsh-superagent process:
 *   SILK_URL        base URL of the silk backend, e.g. http://127.0.0.1:36796
 *   SILK_BOT_TOKEN  the token returned by POST /api/dsh-bot/token
 *
 * Commands:
 *   silk-cli me
 *   silk-cli join --code <invitationCode>
 *   silk-cli pull --group <groupId> --after <epochMs> --json
 *   silk-cli reply --group <groupId> --key <idempotencyKey> --text <text>
 *
 * Failures print {"error":{"code":N,"message":"…"}} on stderr and exit 1. `code` 410 means the
 * target group can never receive the message again; every other failure is retryable.
 */
'use strict'

const MENTION = /@dsh\b/i

function config(name) {
  const value = process.env[name]
  if (!value) {
    process.stderr.write(JSON.stringify({ error: { code: 2, message: `${name} is not set` } }) + '\n')
    process.exit(1)
  }
  return value
}

const base = () => config('SILK_URL').replace(/\/+$/, '')
const token = () => config('SILK_BOT_TOKEN')

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: { code, message: String(message).slice(0, 500) } }) + '\n')
  process.exit(1)
}

async function api(method, path, body) {
  let response
  try {
    response = await fetch(base() + path, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (error) {
    // Network failures stay non-JSON so the caller treats them as retryable.
    fail(0, error && error.message ? error.message : String(error))
  }
  if (response.status === 404) fail(410, `${method} ${path}: gone (404)`)
  if (!response.ok) fail(response.status, `${method} ${path}: HTTP ${response.status} ${await response.text().catch(() => '')}`)
  return response.json()
}

function args(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[name] = true
    else { flags[name] = next; i += 1 }
  }
  return flags
}

const groupOf = flags => {
  const group = flags.group
  if (!group || group === true) fail(2, 'missing --group')
  return group
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const flags = args(rest)
  if (command === 'me' || command === 'groups') {
    process.stdout.write(JSON.stringify(await api('GET', '/api/dsh-bot/me')) + '\n')
    return
  }
  if (command === 'join') {
    if (!flags.code || flags.code === true) fail(2, 'missing --code')
    process.stdout.write(JSON.stringify(await api('POST', '/api/dsh-bot/join', { invitationCode: flags.code })) + '\n')
    return
  }
  if (command === 'pull') {
    const group = groupOf(flags)
    const after = Number(flags.after) || 0
    const me = await api('GET', '/api/dsh-bot/me')
    const page = await api('GET', `/api/dsh-bot/messages?groupId=${encodeURIComponent(group)}&since=${after}&limit=500`)
    const messages = Array.isArray(page.messages) ? page.messages : []
    const items = messages
      .filter(message => message.type === 'TEXT' || message.type === 'FILE')
      .map(message => ({
        id: message.id,
        groupId: group,
        sender: { id: message.senderId, bot: message.bot === true },
        mentions_me: MENTION.test(String(message.content)),
        text: String(message.content),
        at: new Date(Number(message.timestamp) || 0).toISOString(),
        type: message.type,
      }))
    const next = messages.length ? Math.max(...messages.map(message => Number(message.timestamp) || 0)) : after
    process.stdout.write(JSON.stringify({ me: me.userId ?? '', items, next }) + '\n')
    return
  }
  if (command === 'reply') {
    const group = groupOf(flags)
    if (!flags.key || flags.key === true) fail(2, 'missing --key')
    if (flags.text === undefined || flags.text === true || String(flags.text).length === 0) fail(2, 'missing --text')
    process.stdout.write(JSON.stringify(
      await api('POST', '/api/dsh-bot/messages', { groupId: group, idempotencyKey: flags.key, text: flags.text })
    ) + '\n')
    return
  }
  fail(2, `unknown command: ${command ?? '(none)'}; expected me | join | pull | reply`)
}

main().catch(error => { fail(1, error && error.message ? error.message : String(error)) })
