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
  closeIntent,
  withBoardLock,
  claimIntent,
  concludeIntent,
  emptyBoard,
  finishReason,
  loadBoard,
  readReturnContent,
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
import { modelBoard, modelNext, lookupBoard, budgetResult } from './model-view.ts'
import { auditBoard } from './audit.ts'
import { installRuntime, interruptWorkers, reconcileWorkers } from './runtime.ts'
import { searchPolicy, upgradeBoard } from './protocol.ts'
import type { SearchPolicy } from './types.ts'
import type { Board, Intent } from './types.ts'

export const name = 'dsh-cairn-search'
export const inject = ['tools']

const OPS = [
  'init',
  'snapshot',
  'lookup',
  'next',
  'claim',
  'conclude',
  'reason_start',
  'reason_finish',
  'hint',
  'release',
  'close',
  'stop',
  'reopen',
] as const

const DESCRIPTION =
  'Read and update the origin→goal fact-intent blackboard at .dsh/blackboards/<main-session-id>.json. '
  + 'This tool is the only writer of that file. Subagent sessions share the main session\'s board; '
  + 'a forked conversation gets its own copy of the source snapshot. '
  + 'Call op=init once per main session (title, origin, goal, optional hints), then op=next to learn the next task '
  + '(review, reason, explore, or idle). Initialization decomposes; the parent never performs bootstrap exploration. Snapshots are bounded views; use lookup for omitted history and full item text. '
  + 'Claim an intent (op=claim) before exploring it; conclude with exactly one new fact (op=conclude) or release it (op=release). '
  + 'Reason with op=reason_start then op=reason_finish (exactly one of complete, intents, or {}). '
  + 'Human judgment is op=hint. op=stop freezes writes except hints; op=reopen resumes. '
  + 'Use op=close with intentId and description to abandon or replace work without a fact. Use one target per intent and minimal direct from dependencies. '
  + 'Spawn prompts must begin with blackboard_intent: iNNN after claim. Record one distilled conclusion, including negative findings; use supersedes for corrections. '
  + 'Review pending worker returns before other work; inspect unknown outcomes, then conclude, release or close. Returns are not hints or facts. Completed boards require feedback description to reopen; old completion stays as invalidated history. '
  + 'Every mutation returns next; execute it before starting more exploration. Complete requires observed facts and no open intents. '
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
    skills: { type: 'array', items: { type: 'string' }, description: 'Exact execution skill names the explorer must load before acting.' },
    target: { type: 'string', required: true, description: 'One stable subgoal key. Open intents with the same target are rejected.' },
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
export function apply(ctx: Context, config: Partial<SearchPolicy> = {}): void {
  const policy = searchPolicy(config)
  if (isHostUiInsert(ctx)) return
  installRuntime(ctx, exec => boardTarget(ctx, exec))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'blackboard',
    description: DESCRIPTION,
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: [...OPS],
        description: 'Blackboard operation.',
      },
      section: { type: 'string', enum: ['facts', 'intents', 'hints', 'workerReturns', 'criteria', 'state'], description: 'History collection for lookup; state contains current metadata and the complete reasoning lease.' },
      offset: { type: 'number', description: 'Lookup item offset, default 0.' },
      limit: { type: 'number', description: 'Lookup page size 1..10, default 5.' },
      id: { type: 'string', description: 'Lookup one complete item, in text chunks.' },
      contentOffset: { type: 'number', description: 'Offset within a lookup item text, default 0.' },
      title: { type: 'string', description: 'Board title (op=init).' },
      origin: { type: 'string', description: 'Known starting state (op=init).' },
      goal: { type: 'string', description: 'Desired end state (op=init).' },
      criteria: { type: 'array', items: { type: 'string' }, description: 'Explicit acceptance criteria for init; defaults to the goal.' },
      hints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional starting hints (op=init).',
      },
      intentId: { type: 'string', description: 'Intent id (op=claim, conclude, release, close).' },
      worker: { type: 'string', description: 'Worker label (op=claim, conclude, reason_start, reason_finish).' },
      reasonId: { type: 'string', description: 'Required for reason_finish: current board.reason.id from reason_start or snapshot.' },
      description: { type: 'string', description: 'Fact text (conclude), closure reason (close), or required feedback when reopening a completed board (reopen).' },
      supersedes: { type: 'array', items: { type: 'string' }, description: 'Prior fact IDs replaced by this conclusion; preserve their history.' },
      content: { type: 'string', description: 'Hint text (op=hint).' },
      creator: { type: 'string', description: 'Hint author; defaults to user (op=hint).' },
      complete: {
        type: 'object',
        additionalProperties: false,
        description: 'Goal proof (op=reason_finish). Mutually exclusive with intents.',
        properties: {
          proofs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { criterionId: { type: 'string', required: true }, from: { type: 'array', items: { type: 'string' }, required: true }, description: { type: 'string', required: true } } }, description: 'Exactly one observed-evidence proof for every acceptance criterion.' },
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
          page: { type: 'json', description: 'Paginated history or item text.' },
          board: { type: 'json', description: 'Current board snapshot.' },
          warnings: { type: 'json', description: 'Quality and recovery diagnostics.' },
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
      if ((args.op === 'snapshot' || args.op === 'next') && exec.agent?.session.header.origin !== 'subagent') {
        await reconcileWorkers(ctx, target)
      }
      const result = await withBoardLock(cwd, ownerId, async () => {
        if (exec.agent?.session.header.origin === 'subagent') {
          throw new Error('only the parent session may write the blackboard')
        }
        switch (args.op) {
          case 'init': {
            const existing = await loadBoard(cwd, ownerId)
            if (existing) throw new Error('board already exists; use snapshot or reopen')
            const board = upgradeBoard(emptyBoard(
              required(args.title, 'title'),
              required(args.origin, 'origin'),
              required(args.goal, 'goal'),
              args.hints,
            ), policy)
            if (args.criteria) {
              if (!args.criteria.length || args.criteria.length > 20 || args.criteria.some(c => !c.trim())) throw new Error('criteria must contain 1..20 nonempty acceptance conditions')
              board.criteria = args.criteria.map((description, n) => ({ id: `c${String(n + 1).padStart(3, '0')}`, description: description.trim() }))
            }
            await saveBoard(cwd, ownerId, board)
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) }
          }
          case 'lookup': {
            let board = await requireBoard(target, policy)
            if (args.section === 'workerReturns' && args.id) {
              const record = board.workerReturns?.find(r => r.id === args.id)
              if (record?.contentRef) board = { ...board, workerReturns: [{ ...record, content: await readReturnContent(cwd, record) }] }
            }
            return { ok: true, op: args.op, page: lookupBoard(board, args.section ?? 'facts', args.offset, args.limit, args.id, args.contentOffset) }
          }
          case 'snapshot': {
            const board = await requireBoard(target, policy)
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) }
          }
          case 'next': {
            const board = await requireBoard(target, policy)
            return { ok: true, op: args.op, next: nextTask(board), warnings: auditBoard(board) }
          }
          case 'claim': {
            const intentId = required(args.intentId, 'intentId')
            const board = claimIntent(await requireBoard(target, policy), intentId, required(args.worker, 'worker'))
            await saveBoard(cwd, ownerId, board)
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), intent: intentOf(board, intentId) }
          }
          case 'conclude': {
            const intentId = required(args.intentId, 'intentId')
            const { board, fact } = concludeIntent(
              await requireBoard(target, policy),
              intentId,
              required(args.description, 'description'),
              required(args.worker, 'worker'),
              args.supersedes,
            )
            await saveBoard(cwd, ownerId, board)
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), fact, intent: intentOf(board, intentId) }
          }
          case 'reason_start': {
            const { board, trigger } = startReason(await requireBoard(target, policy), required(args.worker, 'worker'))
            await saveBoard(cwd, ownerId, board)
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), trigger }
          }
          case 'reason_finish': {
            const board = finishReason(await requireBoard(target, policy), required(args.worker, 'worker'), {
              ...args.complete !== undefined ? { complete: args.complete } : {},
              ...args.intents !== undefined ? { intents: args.intents } : {},
            }, args.reasonId)
            await saveBoard(cwd, ownerId, board)
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) }
          }
          case 'hint': {
            const { board, hint } = addHint(
              await requireBoard(target, policy),
              required(args.content, 'content'),
              args.creator?.trim() || 'user',
            )
            await saveBoard(cwd, ownerId, board)
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), hint }
          }
          case 'close': {
            const intentId = required(args.intentId, 'intentId')
            const current = await requireBoard(target, policy)
            const board = closeIntent(current, intentId, required(args.description, 'description'))
            interruptWorkers(ctx, exec.agent, current, intentId)
            await saveBoard(cwd, ownerId, board)
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) }
          }
          case 'release': {
            const intentId = required(args.intentId, 'intentId')
            const current = await requireBoard(target, policy)
            const board = releaseIntent(current, intentId)
            interruptWorkers(ctx, exec.agent, current, intentId)
            await saveBoard(cwd, ownerId, board)
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), intent: intentOf(board, intentId) }
          }
          case 'stop': {
            const current = await requireBoard(target, policy)
            interruptWorkers(ctx, exec.agent, current)
            const board = stopBoard(current)
            await saveBoard(cwd, ownerId, board)
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) }
          }
          case 'reopen': {
            const board = reopenBoard(await requireBoard(target, policy), args.description)
            await saveBoard(cwd, ownerId, board)
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) }
          }
          default: {
            const unsupported: never = args.op
            throw new Error(`unsupported op: ${String(unsupported)}`)
          }
        }
      })
      // Materialize optional fields exactly as they are persisted at the JSON boundary.
      return JSON.parse(JSON.stringify(budgetResult({ ...result,
        ...('board' in result && result.board ? { board: modelBoard(result.board) } : {}),
        ...('next' in result && result.next ? { next: modelNext(result.next) } : {}),
        ...('warnings' in result ? { warnings: result.warnings?.slice(0, 12) } : {}),
      })))
    },
    presentCall: args => ({ card: 'generic', title: `blackboard ${args.op}`, kind: 'search' }),
  })))
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

async function requireBoard(target: BoardTarget, policy: SearchPolicy): Promise<Board> {
  await seedBoard(target.cwd, target.ownerId, target.sourceOwnerId)
  const board = await loadBoard(target.cwd, target.ownerId)
  if (board === null) throw new Error('no blackboard; call op=init')
  const upgraded = upgradeBoard(board, policy)
  if (upgraded !== board) await saveBoard(target.cwd, target.ownerId, upgraded)
  return upgraded
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
