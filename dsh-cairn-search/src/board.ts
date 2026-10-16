import { access, mkdir, readFile, rename, writeFile, realpath } from 'node:fs/promises'
import lockfile from 'proper-lockfile'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { Board, Checkpoint, Fact, Hint, Intent, NextTask, ReasonLease, WorkerReturn } from './types.ts'
import {
  BOOTSTRAP_DESCRIPTION,
  GOAL_ID,
  MAX_INTENTS,
  ORIGIN_ID,
} from './types.ts'
import { nextNumericId } from './ids.ts'
import { invalidFactIds } from './evidence.ts'
import { readStoredBoard, serializeStoredBoard } from './storage.ts'
import { boardRelativePath, LEGACY_BOARD_RELATIVE_PATH } from './owner.ts'

const BOOTSTRAP_CREATOR = 'dispatcher.bootstrap'
const HINT_INIT_CREATOR = 'init'

function nowIso(): string {
  return new Date().toISOString()
}

function openIntents(board: Board): Intent[] {
  return board.intents.filter((intent) => intent.to === null && !intent.closed)
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
  return board.intents.every(intent => isReservedBootstrap(intent) && !intent.closed)
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
  if ((board.pendingIntentsEmpty || board.checkpoint.hadOpenIntents) && openIntents(board).length === 0) return 'intents-empty'
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
    (intent) => intent.to === null && !intent.closed && (intent.worker === null || !intent.dispatchId) && !isReservedBootstrap(intent),
  )
}

function newestUnclaimed(board: Board): Intent | null {
  let newest: Intent | null = null
  for (const intent of unclaimedExplorable(board)) {
    if (!newest || (board.protocolVersion === 2
      ? intent.createdAt < newest.createdAt || (intent.createdAt === newest.createdAt && (intent.attempts ?? 0) < (newest.attempts ?? 0))
      : intent.createdAt >= newest.createdAt)) newest = intent
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
  if (new Set(from).size !== from.length) throw new Error('duplicate from')
  const superseded = invalidFactIds(board)
  if (from.some(id => superseded.has(id))) throw new Error('superseded fact in from')
  return [...from]
}

function idle(reason: string): NextTask {
  return { kind: 'idle', reason }
}

export function boardPath(cwd: string, ownerId: string): string {
  return join(cwd, boardRelativePath(ownerId))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function writeAtomic(dest: string, body: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const tmp = join(dirname(dest), `.blackboard.${randomUUID()}.tmp`)
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, dest)
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

export async function loadBoard(cwd: string, ownerId: string): Promise<Board | null> {
  let raw: string
  try {
    raw = await readFile(boardPath(cwd, ownerId), 'utf8')
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    if (error.code === 'ENOENT') return null
    throw err
  }
  const board = await readStoredBoard(cwd, raw)
  return { ...board, workerReturns: board.workerReturns ?? [] }
}

export async function saveBoard(cwd: string, ownerId: string, board: Board): Promise<void> {
  const records = await Promise.all((board.workerReturns ?? []).map(async record => {
    if (record.contentRef || record.content.length <= 2048) return record
    const hash = createHash('sha256').update(record.content).digest('hex')
    const contentRef = `.dsh/blackboard-content/${hash}.txt`
    const path = join(cwd, contentRef)
    // Publish content before its reference. A crash cannot leave a partial
    // content file that a later retry mistakes for an existing complete blob.
    await writeAtomic(path, record.content)
    return { ...record, content: `${record.content.slice(0, 600)}\n[Full return available through lookup]`, contentRef, contentLength: record.content.length }
  }))
  await writeAtomic(boardPath(cwd, ownerId), await serializeStoredBoard(cwd, { ...board, workerReturns: records }))
}

/** Immutable content-addressed returns remain reachable across board forks. */
export async function readReturnContent(cwd: string, record: WorkerReturn): Promise<string> {
  if (!record.contentRef) return record.content
  if (!/^\.dsh\/blackboard-content\/[a-f0-9]{64}\.txt$/.test(record.contentRef)) throw new Error('invalid return content reference')
  const content = await readFile(join(cwd, record.contentRef), 'utf8')
  const hash = createHash('sha256').update(content).digest('hex')
  if (!record.contentRef.endsWith(`/${hash}.txt`)) throw new Error('archived worker return failed integrity check')
  return content
}

/**
 * Copy one owner's board onto another when the destination file is missing.
 * @returns true when a file was written.
 */
export async function copyBoardIfAbsent(
  cwd: string,
  fromOwnerId: string,
  toOwnerId: string,
): Promise<boolean> {
  if (fromOwnerId === toOwnerId) return false
  const dest = boardPath(cwd, toOwnerId)
  if (await pathExists(dest)) return false
  const src = boardPath(cwd, fromOwnerId)
  if (!(await pathExists(src))) return false
  await writeAtomic(dest, await readFile(src, 'utf8'))
  return true
}

/**
 * Promote the workspace-scoped legacy file into a per-session board when needed.
 * @returns true when a file was written.
 */
export async function adoptLegacyIfAbsent(cwd: string, ownerId: string): Promise<boolean> {
  const dest = boardPath(cwd, ownerId)
  if (await pathExists(dest)) return false
  const legacy = join(cwd, LEGACY_BOARD_RELATIVE_PATH)
  if (!(await pathExists(legacy))) return false
  await writeAtomic(dest, await readFile(legacy, 'utf8'))
  return true
}

/**
 * Ensure `ownerId` has a board file: fork snapshot, then legacy workspace file.
 */
export async function seedBoard(
  cwd: string,
  ownerId: string,
  sourceOwnerId?: string,
): Promise<void> {
  if (await pathExists(boardPath(cwd, ownerId))) return
  if (sourceOwnerId !== undefined) {
    const copied = await copyBoardIfAbsent(cwd, sourceOwnerId, ownerId)
    if (copied) return
  }
  await adoptLegacyIfAbsent(cwd, ownerId)
}

export function nextTask(board: Board): NextTask {
  if (board.status !== 'active') return idle(board.status)

  const pending = openIntents(board).filter(i => i.pendingReturn)
  if (pending.length) return { kind: 'review', intents: pending, records: (board.workerReturns ?? []).filter(r => !r.resolution && pending.some(i => i.id === r.intentId && i.dispatchId === r.dispatchId)) }

  if (board.reason !== null) return reasonTask(board, board.reason.trigger)

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

  if (board.policy && openIntents(board).filter(i => i.dispatchId && !i.pendingReturn).length >= board.policy.maxConcurrent) return idle('workers running; await their returns')
  const intent = newestUnclaimed(board)
  if (intent) return { kind: 'explore', intent }
  return idle('no task')
}

export function claimIntent(board: Board, intentId: string, worker: string): Board {
  requireActive(board)
  requireWorker(worker)
  const intent = requireIntent(board, intentId)
  if (intent.to !== null || intent.closed) throw new Error('already concluded or closed')
  if (intent.worker !== null && intent.worker !== worker) throw new Error('already claimed')
  if (intent.worker === worker) return board
  return replaceIntent(board, intentId, { ...intent, worker })
}

function clearClaim(intent: Intent): Intent {
  const { dispatchId, subagentId, pendingReturn, ...rest } = intent
  return { ...rest, worker: null }
}

export function releaseIntent(board: Board, intentId: string): Board {
  requireActive(board)
  const intent = requireIntent(board, intentId)
  if (intent.to !== null || intent.closed) throw new Error('already concluded or closed')
  const attempts = (intent.attempts ?? 0) + 1
  if (board.policy && attempts >= board.policy.maxAttempts) return closeIntent(board, intentId, `Attempt budget exhausted (${attempts}); replan or request new evidence before retrying.`)
  return resolveReturns(replaceIntent(board, intentId, { ...clearClaim(intent), attempts, createdAt: nowIso() }), intent, 'release')
}

export function concludeIntent(
  board: Board,
  intentId: string,
  description: string,
  worker: string,
  supersedes: readonly string[] = [],
): { board: Board; fact: Fact } {
  requireActive(board)
  requireWorker(worker)
  const intent = requireIntent(board, intentId)
  if (intent.to !== null || intent.closed) throw new Error('already concluded or closed')
  if (intent.worker === null) throw new Error('not claimed')
  if (intent.worker !== worker) throw new Error('not claimed')
  // A correction may replace its old premise, but unrelated stale premises
  // cannot support a new observation.
  const invalid = invalidFactIds(board)
  if (intent.from.some(id => invalid.has(id) && !supersedes.includes(id))) throw new Error('intent premises are no longer valid; close and redeclare')
  if (board.protocolVersion === 2 && (!intent.dispatchId || !(board.workerReturns ?? []).some(r => r.intentId === intent.id && r.dispatchId === intent.dispatchId && r.kind === 'return' && !r.resolution))) throw new Error('review an actual dispatched worker return before concluding')
  const trimmed = description.trim()
  if (!trimmed) throw new Error('empty description')
  if (supersedes.length) {
    assertFrom(board, supersedes)
    if (supersedes.includes(ORIGIN_ID)) throw new Error('cannot supersede origin')
  }
  const fact: Fact = { id: nextFactId(board), description: trimmed, ...(supersedes.length ? { supersedes: [...supersedes] } : {}) }
  const concluded: Intent = {
    ...intent,
    pendingReturn: false,
    to: fact.id,
    worker,
    concludedAt: nowIso(),
  }
  return {
    board: resolveReturns({
      ...board,
      facts: [...board.facts, fact],
      intents: board.intents.map((item) => (item.id === intentId ? concluded : item)),
    }, intent, 'conclude'),
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
    id: randomUUID(),
    worker,
    trigger,
    startedAt: nowIso(),
  }
  return {
    board: {
      ...board,
      reason: lease,
      pendingIntentsEmpty: false,
      checkpoint: snapshotCheckpoint(board),
    },
    trigger,
  }
}

export function finishReason(
  board: Board,
  worker: string,
  result: { complete?: { from: string[]; description: string; proofs?: { criterionId: string; from: string[]; description: string }[] }; intents?: { from: string[]; description: string; target?: string; skills?: string[] }[] },
  reasonId?: string,
): Board {
  requireWorker(worker)
  if (!board.reason || board.reason.worker !== worker) throw new Error('reason not held')
  if (board.protocolVersion === 2 && (!reasonId || reasonId !== board.reason.id)) throw new Error('reasonId does not match the current reason; reload before submitting')

  const completing = result.complete !== undefined
  const declaring = result.intents !== undefined
  if (completing && declaring) throw new Error('complete XOR intents')
  requireActive(board)

  if (completing) {
    const complete = result.complete!
    if (board.protocolVersion === 2) {
      const criteria = board.criteria ?? []
      const proofs = complete.proofs ?? []
      if (!criteria.length || proofs.length !== criteria.length || new Set(proofs.map(p => p.criterionId)).size !== criteria.length) throw new Error('provide one evidence proof per acceptance criterion')
      for (const criterion of criteria) {
        const proof = proofs.find(p => p.criterionId === criterion.id)
        if (!proof || !proof.description.trim() || !proof.from.some(id => id !== ORIGIN_ID)) throw new Error(`missing observed proof for ${criterion.id}`)
        assertFrom(board, proof.from)
        if (proof.from.some(id => !complete.from.includes(id))) throw new Error('criterion proof facts must be included in completion from')
      }
    }
    const from = assertFrom(board, complete.from)
    if (!from.some(id => id !== ORIGIN_ID)) throw new Error('completion requires observed facts')
    if (openIntents(board).length) throw new Error('close or conclude open intents before completion')
    const description = complete.description.trim()
    if (!description) throw new Error('empty description')
    const createdAt = nowIso()
    const intent: Intent = {
      id: nextIntentId(board),
      from,
      to: GOAL_ID,
      description: complete.proofs ? `${description}\n\nAcceptance proofs: ${JSON.stringify(complete.proofs)}` : description,
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
  // Only runtime-stamped user messages reset exploration. A coordinator can
  // write hints (including a claimed author) but cannot mint messageId values.
  const feedbackRevision = board.hints.filter(h => h.creator === 'user' && h.messageId).length
  if (board.policy && incoming.length && board.intents.filter(i => i.feedbackRevision === feedbackRevision).length + incoming.length > board.policy.maxExplorations) {
    throw new Error('exploration budget exhausted for this feedback revision; review progress and stop or request explicit feedback, do not continue generating directions')
  }
  if (incoming.length === 0 && openIntents(board).length === 0) {
    throw new Error('intents required')
  }

  if (board.policy && openIntents(board).length + incoming.length > board.policy.maxOpenIntents) throw new Error('open intent budget exceeded; resolve existing work first')
  const createdAt = nowIso()
  const declared: Intent[] = []
  for (const item of incoming) {
    const from = assertFrom(board, item.from)
    const description = item.description.trim()
    if (!description) throw new Error('empty description')
    const target = item.target?.trim()
    if (item.target !== undefined && !target) throw new Error('empty target')
    const peers = [...openIntents(board), ...declared]
    if (board.protocolVersion === 2 && board.intents.some(i => (i.feedbackRevision ?? -1) === feedbackRevision && (i.target === target && !!target || i.description.trim() === description) && i.from.length === from.length && i.from.every(id => from.includes(id)))) throw new Error('direction already attempted with the same evidence; use new evidence or explicit feedback')
    if (peers.some(i => i.description.trim() === description || (target && i.target === target))) {
      throw new Error('overlapping open intent; conclude or close it first')
    }
    declared.push({
      ...(target ? { target } : {}),
      ...(board.protocolVersion === 2 ? { feedbackRevision, skills: [...new Set(item.skills ?? [])] } : {}),
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
  if (board.status === 'completed') return board
  return {
    ...board,
    status: 'stopped',
    reason: null,
    workerReturns: (board.workerReturns ?? []).map(r => r.resolution ? r : { ...r, resolution: { action: 'archived', at: nowIso() } }),
    intents: board.intents.map((intent) =>
      intent.to === null ? clearClaim(intent) : intent,
    ),
  }
}

export function reopenBoard(board: Board, description?: string): Board {
  if (board.status === 'active') return board
  if (board.status === 'stopped') return { ...board, status: 'active' }
  if (!description?.trim()) throw new Error('completed board requires feedback description')
  const completions = board.intents.filter(i => i.to === GOAL_ID && !i.invalidated)
  if (completions.length !== 1) throw new Error('expected one valid completion intent')
  const added = addHint(board, description, 'user.feedback')
  return { ...added.board, status: 'active', reason: null,
    intents: board.intents.map(i => i.id === completions[0].id ? { ...i, invalidated: { at: nowIso(), hintId: added.hint.id } } : i) }
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

/** Close abandoned/replaced work without inventing a fact. */
export function closeIntent(board: Board, intentId: string, reason: string): Board {
  requireActive(board)
  const intent = requireIntent(board, intentId)
  if (intent.to !== null || intent.closed) throw new Error('already concluded or closed')
  if (!reason.trim()) throw new Error('empty close reason')
  const closed = replaceIntent(board, intentId, { ...clearClaim(intent), closed: { reason: reason.trim(), at: nowIso() } })
  return resolveReturns({ ...closed, pendingIntentsEmpty: openIntents(closed).length === 0 || board.pendingIntentsEmpty }, intent, 'close')
}

/** Serialize read-modify-write, including different plugin instances sharing an owner. */
const transactions = new Map<string, Promise<unknown>>()
export async function withBoardLock<T>(cwd: string, ownerId: string, run: () => Promise<T>): Promise<T> {
  const key = boardPath(await realpath(cwd), ownerId)
  const prior = transactions.get(key) ?? Promise.resolve()
  const current = prior.catch(() => undefined).then(async () => {
    await mkdir(dirname(key), { recursive: true })
    // The heartbeat covers the complete transaction; atomic rename alone does
    // not serialize competing readers in separate hosts.
    const release = await lockfile.lock(key, { realpath: false, retries: { retries: 60, minTimeout: 25, maxTimeout: 250 } })
    try { return await run() } finally { await release() }
  })
  transactions.set(key, current)
  try { return await current } finally {
    if (transactions.get(key) === current) transactions.delete(key)
  }
}

/** Reserve one claimed intent for one spawn call; a repeated spawn cannot reuse it. */
export function reserveDispatch(board: Board, intentId: string, dispatchId: string): Board {
  requireActive(board)
  const intent = requireIntent(board, intentId)
  if (intent.to !== null || intent.closed || !intent.worker) throw new Error('claim intent before spawn')
  if (intent.dispatchId) throw new Error('intent already dispatched')
  assertFrom(board, intent.from)
  if (board.policy && openIntents(board).filter(i => i.dispatchId && !i.pendingReturn).length >= board.policy.maxConcurrent) throw new Error('concurrent worker budget exceeded; await returns')
  if (openIntents(board).some(i => i.pendingReturn)) throw new Error('conclude, release or close returned workers before spawn')
  if (nextTask(board).kind === 'reason' || board.reason) throw new Error('finish pending reason before spawn')
  return replaceIntent(board, intentId, { ...intent, dispatchId })
}

export function bindDispatch(board: Board, intentId: string, dispatchId: string, subagentId: string): Board {
  const intent = requireIntent(board, intentId)
  if (intent.dispatchId !== dispatchId || intent.closed || intent.to !== null || board.status !== 'active') return board
  return replaceIntent(board, intentId, { ...intent, subagentId })
}

/** Keep raw returns independently of human hints, including late and unlinked messages. */
export function recordWorkerReturn(board: Board, input: Omit<WorkerReturn, 'id' | 'createdAt' | 'resolution'>): Board {
  const records = board.workerReturns ?? []
  if (input.messageId && (board.hints.some(h => h.messageId === input.messageId) || records.some(r => r.messageId === input.messageId))) return board
  const intent = board.intents.find(i => input.dispatchId
    ? i.dispatchId === input.dispatchId && (!input.intentId || i.id === input.intentId)
    : !!input.subagentId && i.subagentId === input.subagentId)
  const active = board.status === 'active' && intent && intent.to === null && !intent.closed
  const record: WorkerReturn = { ...input, id: nextNumericId('r', records.map(r => r.id)), createdAt: nowIso(),
    ...(intent ? { intentId: intent.id, dispatchId: intent.dispatchId } : {}),
    ...(!active ? { resolution: { action: 'archived' as const, at: nowIso() } } : {}) }
  return { ...board, workerReturns: [...records, record],
    intents: board.intents.map(i => active && i.id === intent.id ? { ...i, pendingReturn: true } : i) }
}

function resolveReturns(board: Board, intent: Intent, action: 'conclude' | 'release' | 'close'): Board {
  return { ...board, workerReturns: (board.workerReturns ?? []).map(r =>
    r.intentId === intent.id && r.dispatchId === intent.dispatchId && !r.resolution
      ? { ...r, resolution: { action, at: nowIso() } } : r) }
}

/** Replace a current observation without accumulating identical polling messages. */
export function observeWorker(board: Board, intent: Intent, observation?: string): Board {
  const records = board.workerReturns ?? []
  const related = records.filter(r => r.intentId === intent.id && r.dispatchId === intent.dispatchId && !r.resolution)
  if (related.some(r => r.kind === 'return')) return board
  if (!observation && !related.some(r => r.kind === 'observation')) return board
  if (observation && related.some(r => r.observation === observation)) return board
  const updated = { ...board, workerReturns: records.map(r => related.includes(r) && r.kind === 'observation'
    ? { ...r, resolution: { action: 'recovered' as const, at: nowIso() } } : r),
    intents: board.intents.map(i => i.id === intent.id ? { ...i, pendingReturn: false } : i) }
  return observation ? recordWorkerReturn(updated, { kind: 'observation', content: observation, observation,
    intentId: intent.id, dispatchId: intent.dispatchId, subagentId: intent.subagentId }) : updated
}
