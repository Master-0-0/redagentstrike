/**
 * Cordis function plugin: registers the model-facing `blackboard` tool.
 * Domain mutations live in `board.ts`; this module is a thin op switch.
 * @module dsh-cairn-search
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  addHint,
  claimIntent,
  concludeIntent,
  emptyBoard,
  ensureBootstrapIntent,
  finishReason,
  loadBoard,
  nextTask,
  releaseIntent,
  reopenBoard,
  saveBoard,
  seedBoard,
  startReason,
  stopBoard,
} from './board.ts'
import {
  boardOwnerId,
  forkSourceOwnerId,
  isConversationFork,
  type SessionLineage,
} from './owner.ts'
import type { Board, Intent } from './types.ts'

export const name = 'dsh-cairn-search'
export const inject = ['tools']

const OPS = [
  'init',
  'snapshot',
  'next',
  'claim',
  'conclude',
  'reason_start',
  'reason_finish',
  'hint',
  'release',
  'stop',
  'reopen',
] as const

const DESCRIPTION =
  'Read and update the origin→goal fact-intent blackboard at .dsh/blackboards/<main-session-id>.json. '
  + 'This tool is the only writer of that file. Subagent sessions share the main session\'s board; '
  + 'a forked conversation gets its own copy of the source snapshot. '
  + 'Call op=init once per main session (title, origin, goal, optional hints), then op=next to learn the next task '
  + '(bootstrap, reason, explore, or idle). '
  + 'Claim an intent (op=claim) before exploring it; conclude with exactly one new fact (op=conclude) or release it (op=release). '
  + 'Reason with op=reason_start then op=reason_finish (exactly one of complete, intents, or {}). '
  + 'Human judgment is op=hint. op=stop freezes writes except hints; op=reopen resumes. '
  + 'Do not hand-edit the board file. Policy refusals are not facts.'

const INTENT_DRAFT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Fact ids this intent explores from. Must be non-empty and must not include goal.',
    },
    description: {
      type: 'string',
      required: true,
      description: 'Independent parallelizable direction.',
    },
  },
} as const

/** Loader entry id for the host-plane insert that serves the browser half. */
const HOST_UI_ENTRY_ID = 'cairn-search-ui'

/**
 * Register the `blackboard` tool on `ctx.tools`.
 * The same package is also inserted on the host plane (`cairn-search-ui`) so the
 * web client bundle is served; that insert must not publish the tool globally.
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx: Context): void {
  if (isHostUiInsert(ctx)) return
  ctx.tools.register(defineTool({
    name: 'blackboard',
    description: DESCRIPTION,
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: [...OPS],
        description: 'Blackboard operation.',
      },
      title: { type: 'string', description: 'Board title (op=init).' },
      origin: { type: 'string', description: 'Known starting state (op=init).' },
      goal: { type: 'string', description: 'Desired end state (op=init).' },
      hints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional starting hints (op=init).',
      },
      intentId: { type: 'string', description: 'Intent id (op=claim, conclude, release).' },
      worker: { type: 'string', description: 'Worker label (op=claim, conclude, reason_start, reason_finish).' },
      description: { type: 'string', description: 'Fact text (op=conclude).' },
      content: { type: 'string', description: 'Hint text (op=hint).' },
      creator: { type: 'string', description: 'Hint author; defaults to user (op=hint).' },
      complete: {
        type: 'object',
        additionalProperties: false,
        description: 'Goal proof (op=reason_finish). Mutually exclusive with intents.',
        properties: {
          from: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Fact ids that jointly prove the goal. Must not include goal.',
          },
          description: {
            type: 'string',
            required: true,
            description: 'Why these facts meet the goal.',
          },
        },
      },
      intents: {
        type: 'array',
        items: INTENT_DRAFT,
        description: 'Declared explores (op=reason_finish). Mutually exclusive with complete.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          op: { type: 'string', required: true },
          board: { type: 'json', description: 'Current board snapshot.' },
          next: { type: 'json', description: 'Next dispatcher task.' },
          fact: { type: 'json', description: 'Fact written by conclude.' },
          hint: { type: 'json', description: 'Hint written by hint.' },
          intent: { type: 'json', description: 'Intent after claim, conclude, or release.' },
          trigger: { type: 'string', description: 'Reason-lease trigger from reason_start.' },
          error: { type: 'string', description: 'Unused on success; domain failures throw.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const target = boardTarget(ctx, exec)
      const { cwd, ownerId } = target
      switch (args.op) {
        case 'init': {
          const board = ensureBootstrapIntent(emptyBoard(
            required(args.title, 'title'),
            required(args.origin, 'origin'),
            required(args.goal, 'goal'),
            args.hints,
          ))
          await saveBoard(cwd, ownerId, board)
          return { ok: true, op: args.op, board, next: nextTask(board) }
        }
        case 'snapshot': {
          const board = await requireBoard(target)
          return { ok: true, op: args.op, board }
        }
        case 'next': {
          const board = await requireBoard(target)
          return { ok: true, op: args.op, next: nextTask(board) }
        }
        case 'claim': {
          const intentId = required(args.intentId, 'intentId')
          const board = claimIntent(await requireBoard(target), intentId, required(args.worker, 'worker'))
          await saveBoard(cwd, ownerId, board)
          return { ok: true, op: args.op, board, intent: intentOf(board, intentId) }
        }
        case 'conclude': {
          const intentId = required(args.intentId, 'intentId')
          const { board, fact } = concludeIntent(
            await requireBoard(target),
            intentId,
            required(args.description, 'description'),
            required(args.worker, 'worker'),
          )
          await saveBoard(cwd, ownerId, board)
          return { ok: true, op: args.op, board, fact, intent: intentOf(board, intentId) }
        }
        case 'reason_start': {
          const { board, trigger } = startReason(await requireBoard(target), required(args.worker, 'worker'))
          await saveBoard(cwd, ownerId, board)
          return { ok: true, op: args.op, board, trigger }
        }
        case 'reason_finish': {
          const board = finishReason(await requireBoard(target), required(args.worker, 'worker'), {
            ...args.complete !== undefined ? { complete: args.complete } : {},
            ...args.intents !== undefined ? { intents: args.intents } : {},
          })
          await saveBoard(cwd, ownerId, board)
          return { ok: true, op: args.op, board, next: nextTask(board) }
        }
        case 'hint': {
          const { board, hint } = addHint(
            await requireBoard(target),
            required(args.content, 'content'),
            args.creator?.trim() || 'user',
          )
          await saveBoard(cwd, ownerId, board)
          return { ok: true, op: args.op, board, hint }
        }
        case 'release': {
          const intentId = required(args.intentId, 'intentId')
          const board = releaseIntent(await requireBoard(target), intentId)
          await saveBoard(cwd, ownerId, board)
          return { ok: true, op: args.op, board, intent: intentOf(board, intentId) }
        }
        case 'stop': {
          const board = stopBoard(await requireBoard(target))
          await saveBoard(cwd, ownerId, board)
          return { ok: true, op: args.op, board }
        }
        case 'reopen': {
          const board = reopenBoard(await requireBoard(target))
          await saveBoard(cwd, ownerId, board)
          return { ok: true, op: args.op, board }
        }
        default: {
          const unsupported: never = args.op
          throw new Error(`unsupported op: ${String(unsupported)}`)
        }
      }
    },
    presentCall: args => ({ card: 'generic', title: `blackboard ${args.op}`, kind: 'search' }),
  }))
}

function isHostUiInsert(ctx: Context): boolean {
  const fiber = ctx.fiber as { entry?: { options?: { id?: string } } }
  return fiber.entry?.options?.id === HOST_UI_ENTRY_ID
}

interface SessionHeaderLike {
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
  readonly isSeeded?: boolean
}

interface SessionLike {
  readonly id: string
  readonly header?: SessionHeaderLike
}

interface SessionsLike {
  get(id: string): SessionLike | undefined
}

interface BoardTarget {
  readonly cwd: string
  readonly ownerId: string
  readonly sourceOwnerId?: string
}

function sessionsOf(ctx: Context): SessionsLike | undefined {
  // Cordis's property proxy throws `cannot get property "sessions" without inject`.
  // Agent-plane tools must use `ctx.get`, matching subagent/list-children.
  const get = (ctx as { get?: (name: string, strict?: boolean) => SessionsLike | undefined }).get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, 'sessions', false)
  } catch {
    return undefined
  }
}

function lineageOf(session: SessionLike): SessionLineage {
  const header = session.header
  return {
    id: session.id,
    ...header?.parentSession !== undefined ? { parentId: header.parentSession } : {},
    ...header?.origin !== undefined ? { origin: header.origin } : {},
    ...header?.isSeeded !== undefined ? { isSeeded: header.isSeeded } : {},
  }
}

function lookupOf(sessions: SessionsLike | undefined): (id: string) => SessionLineage | undefined {
  return (id) => {
    const found = sessions?.get(id)
    return found === undefined ? undefined : lineageOf(found)
  }
}

function boardTarget(ctx: Context, exec: ToolExecution): BoardTarget {
  const session = exec.agent?.session as SessionLike | undefined
  const cwd = session?.header?.cwd
  if (session === undefined || cwd === undefined || cwd.trim() === '') {
    throw new Error('blackboard requires a session workspace')
  }
  const lookup = lookupOf(sessionsOf(ctx))
  const lineage = lineageOf(session)
  return {
    cwd,
    ownerId: boardOwnerId(lineage, lookup),
    ...isConversationFork(lineage) ? { sourceOwnerId: forkSourceOwnerId(lineage, lookup) } : {},
  }
}

async function requireBoard(target: BoardTarget): Promise<Board> {
  await seedBoard(target.cwd, target.ownerId, target.sourceOwnerId)
  const board = await loadBoard(target.cwd, target.ownerId)
  if (board === null) throw new Error('no blackboard; call op=init')
  return board
}

function required(value: string | undefined, field: string): string {
  const text = value?.trim() ?? ''
  if (text === '') throw new Error(`${field} is required`)
  return text
}

function intentOf(board: Board, intentId: string): Intent {
  const intent = board.intents.find(item => item.id === intentId)
  if (intent === undefined) throw new Error(`unknown intent ${intentId}`)
  return intent
}
