/** Silk Source kind definition, translation, polling, and Cordis plugin entry: one Thread per silk group, polled through silk-cli. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const SOURCE = 'silk'
/** The silk-cli command the Source runs; put scripts/silk-cli.mjs on PATH or point a `silk-cli` wrapper at it. */
const CLI = 'silk-cli'
/** A group joined later starts reading from the moment it was first polled, so old history never replays as Triggers. */
const INITIAL_CURSOR = () => Date.now()

const ConfigSchema = z.object({
  groups: z.array(z.object({
    groupId: z.string().regex(/^[a-zA-Z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type SilkConfig = z.infer<typeof ConfigSchema>

/** One message as `silk-cli pull` prints it. */
const ItemSchema = z.looseObject({
  id: z.string().min(1),
  groupId: z.string().min(1),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }),
  mentions_me: z.boolean().default(false),
  text: z.string(),
  at: z.string(),
  type: z.string().optional(),
})
export type SilkItem = z.infer<typeof ItemSchema>

/** The answer of `silk-cli pull`. */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.number() })
const MeSchema = z.looseObject({ userId: z.string(), userName: z.string().optional(),
  groups: z.array(z.looseObject({ id: z.string(), name: z.string().optional() })).default([]) })

/** The Trigger of one silk group message; the bot's own messages produce none. */
export function silkTrigger(item: SilkItem, me: string): Trigger | undefined {
  if (!item.text.trim() || item.sender.id === me) return undefined
  return {
    id: key(SOURCE, item.id),
    source: SOURCE,
    // v1 mapping: one silk group is one Thread; the group's whole history is its context.
    threads: [{ source: SOURCE, id: item.groupId }],
    actor: { source: SOURCE, id: item.sender.id },
    human: !item.sender.bot,
    ...(item.mentions_me ? { addressed: 'mention' as const } : {}),
    at: item.at,
    text: item.text,
    channel: { source: SOURCE, thread: threadKey({ source: SOURCE, id: item.groupId }), address: { group: item.groupId } },
    meta: { groupId: item.groupId, messageId: item.id },
  }
}

export async function sendSilk(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const group = message.channel.address.group
  if (!group) throw new Error('Missing silk reply target')
  try {
    await host.commands.run(CLI, ['reply', '--group', group, '--key', message.id, '--text', message.text])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}

export const silkKind: SourceKind<SilkConfig> = {
  kind: SOURCE,
  title: { zh: 'Silk', en: 'Silk' },
  description: {
    zh: '接收下列 Silk 群里的消息。一个群即一个线程；@DSH 视为点名，其余消息按策略研判。',
    en: 'Receives messages from these Silk groups. One group is one Thread; @DSH addresses the agent, and the Policy assesses the rest.',
  },
  schema: ConfigSchema,
  fields: [
    { key: 'groups', type: 'rows', label: { zh: '接收的群', en: 'Groups' },
      hint: {
        zh: '先用 silk-cli join --code <邀请码> 让 bot 入群，再把群 ID 列在这里。“仅 @”只接收 @DSH 的消息和已有工单的群；“全部消息”也接收其余消息，评估可以按规则从中推断工作。',
        en: 'Join the bot first with silk-cli join --code <code>, then list the group ID here. "@ only" receives @DSH messages and groups that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules.',
      },
      columns: [
        { key: 'groupId', type: 'text', label: { zh: '群', en: 'Group' }, pattern: '[a-zA-Z0-9-]+',
          choose: { zh: '选择 bot 已加入的群', en: 'Choose a group the bot has joined' }, refresh: { zh: '刷新群列表', en: 'Refresh groups' } },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
          { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / s' } },
  ],
  health: [SOURCE],
  refreshLabels: (host, signal) => refreshGroupNames(sourceContext(host, silkKind), signal),
  scope({ meta }, config) {
    const group = config.groups.find(item => item.groupId === meta.groupId)
    if (!group) return { listened: false, reason: 'group_not_listed' }
    return { listened: true, observed: group.listen === 'all', row: group.groupId }
  },
  // A reply goes only to a group the Source still receives.
  channel: {
    allowed: (address, config) => config.groups.some(item => item.groupId === address.group),
    send: sendSilk,
    link: address => ({ url: '', label: { zh: `Silk 群 ${address.group ?? ''}`, en: `Silk group ${address.group ?? ''}` } }),
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
        .default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Silk 用户', en: 'Silk users who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在消息里 @DSH。', en: 'Someone on the list writes @DSH in a message.' },
    rows: stored => ConfigSchema.parse(stored).groups.map(group => {
      const all = group.listen === 'all'
      return { id: group.groupId, label: group.groupId, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_SILK_GROUP', description: {
      zh: '接下工单的 Silk 群；工单不是从这个来源来的时为空',
      en: 'The Silk group that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_SILK_GROUP: trigger?.source === SOURCE ? String(trigger.meta.groupId ?? '') : '' }),
  },
}

/** Resolves group IDs to names for the settings form. */
export async function refreshGroupNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const me = MeSchema.parse(JSON.parse(await ctx.commands.withSignal(signal).run(CLI, ['me'])))
  return Object.fromEntries(me.groups.map(group => [group.id, group.name ?? group.id]))
}

/**
 * Polls every listed group once, takes in each message, then moves that group's cursor past them.
 * A round cut short by the abort signal leaves the cursor unchanged; stable Trigger ids make replay safe.
 */
export async function pollGroups(ctx: SourceContext, signal: AbortSignal): Promise<string> {
  const config = ctx.config<SilkConfig>(SOURCE)
  if (!config) return 'off'
  let read = 0
  let unreadable = 0
  const names = ctx.state.get(KV.sources.labels(SOURCE)) ?? {}
  for (const group of config.groups) {
    if (signal.aborted) throw new Error('The silk Source stopped during the read')
    const after = ctx.state.get(KV.silk.cursor(group.groupId)) ?? INITIAL_CURSOR()
    const output = await ctx.commands.withSignal(signal)
      .run(CLI, ['pull', '--group', group.groupId, '--after', String(after), '--json'])
    const page = PageSchema.parse(JSON.parse(output))
    for (const value of page.items) {
      if (signal.aborted) throw new Error('The silk Source stopped during the read')
      const item = ItemSchema.safeParse(value)
      if (!item.success) { unreadable += 1; continue }
      const trigger = silkTrigger(item.data, page.me)
      if (!trigger) continue
      await ctx.receive(trigger)
      const name = names[group.groupId] ?? group.groupId
      ctx.threads.describe(threadKey({ source: SOURCE, id: group.groupId }), { label: name, facts: { group: { value: name } } })
    }
    // Advance the cursor only after every covered Trigger has been stored.
    ctx.state.set(KV.silk.cursor(group.groupId), page.next)
    read += page.items.length
  }
  return `${config.groups.length} groups, ${read} messages, ${unreadable} unreadable`
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<SilkConfig>(SOURCE)
    if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const detail = await pollGroups(ctx, signal)
        failures = 0
        ctx.report(SOURCE, { state: 'ready', detail, at })
      } catch (error) {
        if (signal.aborted) break
        failures += 1
        // One network failure is retried on the next round; three in a row need a person.
        if (failures >= 3) ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

export const name = 'dsh-superagent-silk'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(silkKind), 'silk: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const source = sourceContext(ctx.orchestrator, silkKind)
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
