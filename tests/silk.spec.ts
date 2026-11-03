/** The silk Source: translation of group messages, a poll round with per-group cursors, the Channel, and the plugin entry. */
import { describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { apply as applySilk, pollGroups, sendSilk, silkKind, silkTrigger, SOURCE } from '../src/sources/silk.ts'
import { KV } from '../src/kv.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BOT = 'dsh_ai_agent'

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'silk-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    policy: { sources: { silk: { allowed: [{ id: 'alice', name: 'Alice' }] } } },
    eval: { mode: 'auto' },
    sources: { silk: { enabled: true, config: { groups: [{ groupId: 'g1', listen: 'mentions' }, { groupId: 'g2', listen: 'all' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(silkKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox, commands, sources, deployment: testDeployment(),
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  return { ...value, ...sourceContextOf(parts, silkKind), store, engine, commands: parts.commands, receive,
    health: overrides.sources ? healthOf.get(overrides.sources)!.all : board.all }
}
const healthOf = new WeakMap<SourceRegistry, HealthBoard>()

/** A registry with no kind registered yet, for the plugin entry's registration. */
function emptyRegistry(): SourceRegistry {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  healthOf.set(sources, board)
  return sources
}

/** One message as silk-cli prints it in `pull`. */
const item = (id: string, fields: Record<string, unknown> = {}) => ({
  id, groupId: 'g1', sender: { id: 'alice', bot: false }, mentions_me: false, text: 'please fix the login flow',
  at: '2026-11-03T00:00:00Z', type: 'TEXT', ...fields,
})
const page = (items: unknown[], next: number) => JSON.stringify({ me: BOT, items, next })
const reply = (id: string, group = 'g1'): OutboundMessage =>
  ({ id, channel: { source: SOURCE, thread: `silk:${group}`, address: { group } }, text: 'done', kind: 'reply' })

describe('silk translation', () => {
  it('maps one group message onto one Thread, keeps the sender native, and drops the bot own messages', () => {
    const trigger = silkTrigger(item('m1'), BOT)!
    expect(trigger).toMatchObject({
      id: key(SOURCE, 'm1'), source: SOURCE,
      threads: [{ source: SOURCE, id: 'g1' }],
      actor: { source: SOURCE, id: 'alice' }, human: true,
      at: '2026-11-03T00:00:00Z', text: 'please fix the login flow',
      channel: { source: SOURCE, thread: 'silk:g1', address: { group: 'g1' } },
      meta: { groupId: 'g1', messageId: 'm1' },
    })
    expect(trigger).not.toHaveProperty('addressed')
    expect(silkTrigger(item('m2', { mentions_me: true, text: '@DSH take a look' }), BOT)!.addressed).toBe('mention')
    expect(silkTrigger(item('m3', { sender: { id: 'other_bot', bot: true } }), BOT)!.human).toBe(false)
    expect(silkTrigger(item('m4', { sender: { id: BOT, bot: true } }), BOT)).toBeUndefined()
    expect(silkTrigger(item('m5', { text: '   ' }), BOT)).toBeUndefined()
  })

  it('listens only to listed groups, and observes all messages only where configured', () => {
    const config = { groups: [{ groupId: 'g1', listen: 'mentions' as const }, { groupId: 'g2', listen: 'all' as const }], pollSeconds: 30 }
    expect(silkKind.scope!({ meta: { groupId: 'g1' } }, config)).toEqual({ listened: true, observed: false, row: 'g1' })
    expect(silkKind.scope!({ meta: { groupId: 'g2' } }, config)).toEqual({ listened: true, observed: true, row: 'g2' })
    expect(silkKind.scope!({ meta: { groupId: 'g9' } }, config)).toEqual({ listened: false, reason: 'group_not_listed' })
    expect(silkKind.channel!.allowed!({ group: 'g9' }, config)).toBe(false)
    expect(silkKind.channel!.allowed!({ group: 'g1' }, config)).toBe(true)
  })

  it('derives admission rows from the groups, offering unaddressed cells only where all messages arrive', () => {
    const rows = silkKind.policy!.rows!({ groups: [{ groupId: 'g1', listen: 'mentions' }, { groupId: 'g2', listen: 'all' }] })
    expect(rows.map(row => [row.id, row.cells])).toEqual([
      ['g1', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ['g2', { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }],
    ])
  })
})

describe('silk polling', () => {
  it('takes in what the cli holds after the cursor, once, and moves the cursor after it', async () => {
    const h = host()
    h.store.set(KV.silk.cursor('g1'), 1_000)
    h.store.set(KV.silk.cursor('g2'), 2_000)
    const seen: string[] = []
    const pull = vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      if (args[0] !== 'pull') return JSON.stringify({ userId: BOT, groups: [] })
      seen.push(`${args[2]}@${args[4]}`)
      return args[2] === 'g1'
        ? page([item('m1'), { id: 'broken' }, item('m2', { groupId: 'g9' })], 1_500)
        : page([], 2_000)
    })
    expect(await pollGroups(h, new AbortController().signal)).toBe('2 groups, 3 messages, 1 unreadable')
    expect(seen).toEqual(['g1@1000', 'g2@2000'])
    // Stored once; the message of an unlisted group is filtered by scope; a malformed item is skipped, not fatal.
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(await h.receive.mock.results[1]!.value).toBe('filtered')
    expect(h.store.get(KV.silk.cursor('g1'))).toBe(1_500)
    // Replaying the same page stores no duplicate Trigger.
    expect(await pollGroups(h, new AbortController().signal)).toContain('2 groups')
    expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
    expect(h.store.get(KV.silk.cursor('g1'))).toBe(1_500)
    pull.mockRestore()
  })

  it('answers sent, gone only for a missing group, and throws for other failures', async () => {
    const h = host()
    const run = vi.spyOn(h.commands, 'run')
    run.mockResolvedValue(JSON.stringify({ success: true, status: 'sent' }))
    await expect(sendSilk(h, reply('reply-1'))).resolves.toBe('sent')
    expect(run.mock.calls[0]).toEqual(['silk-cli', ['reply', '--group', 'g1', '--key', 'reply-1', '--text', 'done']])
    run.mockRejectedValue(new CliError('silk group gone', 410, 1))
    await expect(sendSilk(h, reply('reply-1'))).resolves.toBe('gone')
    run.mockRejectedValue(new CliError('HTTP 403', 403, 1))
    await expect(sendSilk(h, reply('reply-1'))).rejects.toBeInstanceOf(CliError)
    const noTarget = { ...reply('reply-2'), channel: { source: SOURCE, thread: 'silk:g1', address: {} } }
    await expect(sendSilk(h, noTarget)).rejects.toThrow('Missing silk reply target')
  })
})

describe('silk plugin entry', () => {
  it('registers the kind, waits for setup before reading, and unregisters on disposal', async () => {
    const sources = emptyRegistry()
    const h = host({ sources, configured: () => false })
    const disposers: (() => unknown)[] = []
    applySilk({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(sources.kind(SOURCE)).toBe(silkKind)
    await vi.waitFor(() => expect(h.health[SOURCE]).toMatchObject({ state: 'paused', code: 'setupPending' }))
    for (const dispose of disposers) await dispose()
    expect(sources.kind(SOURCE)).toBeUndefined()
  })
})
