import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Board, Checkpoint, Fact, Hint, Intent, NextTask, ReasonLease } from './types.ts'
import {
  BOARD_RELATIVE_PATH,
  BOOTSTRAP_DESCRIPTION,
  GOAL_ID,
  MAX_INTENTS,
  ORIGIN_ID,
} from './types.ts'
import { nextNumericId } from './ids.ts'

const BOOTSTRAP_CREATOR = 'dispatcher.bootstrap'
const HINT_INIT_CREATOR = 'init'

function nowIso(): string {
  return new Date().toISOString()
}

function openIntents(board: Board): Intent[] {
  return board.intents.filter((intent) => intent.to === null)
}

function isReservedBootstrap(intent: Intent): boolean {
  return (
    intent.from.length === 1 &&
    intent.from[0] === ORIGIN_ID &&
    intent.description === BOOTSTRAP_DESCRIPTION
  )
}

function isInitial(board: Board): boolean {
  if (board.facts.length !== 2) return false
  const ids = new Set(board.facts.map((fact) => fact.id))
  if (!ids.has(ORIGIN_ID) || !ids.has(GOAL_ID)) return false
  return board.intents.every(isReservedBootstrap)
}

function bootstrapInProgress(board: Board): boolean {
  return board.intents.some(
    (intent) => isReservedBootstrap(intent) && intent.to === null && intent.worker !== null,
  )
}

function factDescription(board: Board, id: string): string {
  const fact = board.facts.find((item) => item.id === id)
  if (!fact) throw new Error('unknown fact')
  return fact.description
}

function nextFactId(board: Board): string {
  return nextNumericId('f', board.facts.map((fact) => fact.id))
}

function nextIntentId(board: Board): string {
  return nextNumericId('i', board.intents.map((intent) => intent.id))
}

function nextHintId(board: Board): string {
  return nextNumericId('h', board.hints.map((hint) => hint.id))
}

function factIds(board: Board): string[] {
  return board.facts.map((fact) => fact.id)
}

function snapshotCheckpoint(board: Board): Checkpoint {
  return {
    factCount: board.facts.length,
    hintCount: board.hints.length,
    hadOpenIntents: openIntents(board).length > 0,
  }
}

function situationTrigger(board: Board): Exclude<ReasonLease['trigger'], 'initial'> | null {
  if (board.facts.length > board.checkpoint.factCount) return 'new-fact'
  if (board.hints.length > board.checkpoint.hintCount) return 'new-hint'
  if (board.checkpoint.hadOpenIntents && openIntents(board).length === 0) return 'intents-empty'
  return null
}

function reasonTriggerForStart(board: Board): ReasonLease['trigger'] | null {
  if (isInitial(board)) return 'initial'
  return situationTrigger(board)
}

function reasonTask(board: Board, trigger: ReasonLease['trigger']): NextTask {
  return {
    kind: 'reason',
    trigger,
    factIds: factIds(board),
    openIntents: openIntents(board),
  }
}

function unclaimedExplorable(board: Board): Intent[] {
  return board.intents.filter(
    (intent) => intent.to === null && intent.worker === null && !isReservedBootstrap(intent),
  )
}

function newestUnclaimed(board: Board): Intent | null {
  let newest: Intent | null = null
  for (const intent of unclaimedExplorable(board)) {
    if (!newest || intent.createdAt >= newest.createdAt) newest = intent
  }
  return newest
}

function requireWorker(worker: string): string {
  if (!worker) throw new Error('empty worker')
  return worker
}

function requireActive(board: Board): void {
  if (board.status !== 'active') throw new Error('not active')
}

function requireIntent(board: Board, intentId: string): Intent {
  const intent = board.intents.find((item) => item.id === intentId)
  if (!intent) throw new Error('intent not found')
  return intent
}

function replaceIntent(board: Board, intentId: string, next: Intent): Board {
  return {
    ...board,
    intents: board.intents.map((intent) => (intent.id === intentId ? next : intent)),
  }
}

function assertFrom(board: Board, from: readonly string[]): string[] {
  if (from.length === 0) throw new Error('empty from')
  const ids = new Set(factIds(board))
  for (const id of from) {
    if (id === GOAL_ID) throw new Error('goal in from')
    if (!ids.has(id)) throw new Error('unknown fact')
  }
  return [...from]
}

function idle(reason: string): NextTask {
  return { kind: 'idle', reason }
}

export function boardPath(cwd: string): string {
  return join(cwd, BOARD_RELATIVE_PATH)
}

export function emptyBoard(title: string, origin: string, goal: string, hints?: string[]): Board {
  const createdAt = nowIso()
  const hintList: Hint[] = (hints ?? []).map((content, index) => ({
    id: `h${String(index + 1).padStart(3, '0')}`,
    content,
    creator: HINT_INIT_CREATOR,
    createdAt,
  }))
  return {
    title,
    status: 'active',
    bootstrapEnabled: true,
    facts: [
      { id: ORIGIN_ID, description: origin },
      { id: GOAL_ID, description: goal },
    ],
    intents: [],
    hints: hintList,
    reason: null,
    checkpoint: {
      factCount: 2,
      hintCount: hintList.length,
      hadOpenIntents: false,
    },
  }
}

export async function loadBoard(cwd: string): Promise<Board | null> {
  try {
    const raw = await readFile(boardPath(cwd), 'utf8')
    return JSON.parse(raw) as Board
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    if (error.code === 'ENOENT') return null
    throw err
  }
}

export async function saveBoard(cwd: string, board: Board): Promise<void> {
  const dest = boardPath(cwd)
  await mkdir(dirname(dest), { recursive: true })
  const tmp = join(dirname(dest), `.blackboard.${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify(board, null, 2), 'utf8')
  await rename(tmp, dest)
}

export function nextTask(board: Board): NextTask {
  if (board.status !== 'active') return idle(board.status)

  if (isInitial(board)) {
    if (board.bootstrapEnabled && !bootstrapInProgress(board)) {
      return {
        kind: 'bootstrap',
        origin: factDescription(board, ORIGIN_ID),
        goal: factDescription(board, GOAL_ID),
        hints: board.hints,
      }
    }
    if (board.reason === null) return reasonTask(board, 'initial')
    return idle('no task')
  }

  if (board.reason === null) {
    const trigger = situationTrigger(board)
    if (trigger) return reasonTask(board, trigger)
  }

  const intent = newestUnclaimed(board)
  if (intent) return { kind: 'explore', intent }
  return idle('no task')
}

export function claimIntent(board: Board, intentId: string, worker: string): Board {
  requireActive(board)
  requireWorker(worker)
  const intent = requireIntent(board, intentId)
  if (intent.to !== null) throw new Error('already concluded')
  if (intent.worker !== null && intent.worker !== worker) throw new Error('already claimed')
  if (intent.worker === worker) return board
  return replaceIntent(board, intentId, { ...intent, worker })
}

export function releaseIntent(board: Board, intentId: string): Board {
  requireActive(board)
  const intent = requireIntent(board, intentId)
  if (intent.to !== null) throw new Error('already concluded')
  return replaceIntent(board, intentId, { ...intent, worker: null })
}

export function concludeIntent(
  board: Board,
  intentId: string,
  description: string,
  worker: string,
): { board: Board; fact: Fact } {
  requireActive(board)
  requireWorker(worker)
  const intent = requireIntent(board, intentId)
  if (intent.to !== null) throw new Error('already concluded')
  if (intent.worker === null) throw new Error('not claimed')
  if (intent.worker !== worker) throw new Error('not claimed')
  const trimmed = description.trim()
  if (!trimmed) throw new Error('empty description')
  const fact: Fact = { id: nextFactId(board), description: trimmed }
  const concluded: Intent = {
    ...intent,
    to: fact.id,
    worker,
    concludedAt: nowIso(),
  }
  return {
    board: {
      ...board,
      facts: [...board.facts, fact],
      intents: board.intents.map((item) => (item.id === intentId ? concluded : item)),
    },
    fact,
  }
}

export function startReason(
  board: Board,
  worker: string,
): { board: Board; trigger: ReasonLease['trigger'] } {
  requireActive(board)
  requireWorker(worker)
  if (board.reason) {
    if (board.reason.worker !== worker) throw new Error('reason held')
    return { board, trigger: board.reason.trigger }
  }
  const trigger = reasonTriggerForStart(board)
  if (!trigger) throw new Error('no reason trigger')
  const lease: ReasonLease = {
    worker,
    trigger,
    startedAt: nowIso(),
  }
  return {
    board: {
      ...board,
      reason: lease,
      checkpoint: snapshotCheckpoint(board),
    },
    trigger,
  }
}

export function finishReason(
  board: Board,
  worker: string,
  result: { complete?: { from: string[]; description: string }; intents?: { from: string[]; description: string }[] },
): Board {
  requireWorker(worker)
  if (!board.reason || board.reason.worker !== worker) throw new Error('reason not held')

  const completing = result.complete !== undefined
  const declaring = result.intents !== undefined
  if (completing && declaring) throw new Error('complete XOR intents')
  if (board.status !== 'active' && !completing) throw new Error('not active')
  if (board.status === 'completed') throw new Error('not active')

  if (completing) {
    const complete = result.complete!
    const from = assertFrom(board, complete.from)
    const description = complete.description.trim()
    if (!description) throw new Error('empty description')
    const createdAt = nowIso()
    const intent: Intent = {
      id: nextIntentId(board),
      from,
      to: GOAL_ID,
      description,
      creator: worker,
      worker,
      createdAt,
      concludedAt: createdAt,
    }
    return {
      ...board,
      status: 'completed',
      reason: null,
      intents: [...board.intents, intent],
    }
  }

  const incoming = (result.intents ?? []).slice(0, MAX_INTENTS)
  if (incoming.length === 0 && openIntents(board).length === 0) {
    throw new Error('intents required')
  }

  const createdAt = nowIso()
  const declared: Intent[] = []
  for (const item of incoming) {
    const from = assertFrom(board, item.from)
    const description = item.description.trim()
    if (!description) throw new Error('empty description')
    declared.push({
      id: nextIntentId({ ...board, intents: [...board.intents, ...declared] }),
      from,
      to: null,
      description,
      creator: worker,
      worker: null,
      createdAt,
      concludedAt: null,
    })
  }

  return {
    ...board,
    reason: null,
    intents: [...board.intents, ...declared],
  }
}

export function addHint(board: Board, content: string, creator: string): { board: Board; hint: Hint } {
  const trimmed = content.trim()
  if (!trimmed) throw new Error('empty content')
  const hint: Hint = {
    id: nextHintId(board),
    content: trimmed,
    creator,
    createdAt: nowIso(),
  }
  return {
    board: {
      ...board,
      hints: [...board.hints, hint],
    },
    hint,
  }
}

export function stopBoard(board: Board): Board {
  return {
    ...board,
    status: 'stopped',
    reason: null,
    intents: board.intents.map((intent) =>
      intent.to === null ? { ...intent, worker: null } : intent,
    ),
  }
}

export function reopenBoard(board: Board): Board {
  return { ...board, status: 'active' }
}

export function ensureBootstrapIntent(board: Board): Board {
  if (!isInitial(board)) return board
  if (board.intents.some(isReservedBootstrap)) return board
  requireActive(board)
  const intent: Intent = {
    id: nextIntentId(board),
    from: [ORIGIN_ID],
    to: null,
    description: BOOTSTRAP_DESCRIPTION,
    creator: BOOTSTRAP_CREATOR,
    worker: null,
    createdAt: nowIso(),
    concludedAt: null,
  }
  return { ...board, intents: [...board.intents, intent] }
}
