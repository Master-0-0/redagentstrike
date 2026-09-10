/**
 * Cairn fact-intent blackboard. Pure protocol: no I/O, no tools.
 * Facts are append-only. Intents are hyperedges. Hints are off-graph.
 * @module cairn-mode/board
 */

const ORIGIN = 'origin'
const GOAL = 'goal'
const BOOTSTRAP_DESCRIPTION = 'bootstrap'

/** @typedef {'active' | 'stopped' | 'completed'} BoardStatus */

/**
 * @typedef {object} Fact
 * @property {string} id
 * @property {string} description
 */

/**
 * @typedef {object} Intent
 * @property {string} id
 * @property {string[]} from
 * @property {string | null} to
 * @property {string} description
 * @property {string} creator
 * @property {string | null} worker
 * @property {string} created_at
 * @property {string | null} concluded_at
 */

/**
 * @typedef {object} Hint
 * @property {string} id
 * @property {string} content
 * @property {string} creator
 * @property {string} created_at
 */

/**
 * @typedef {object} ReasonLease
 * @property {string} worker
 * @property {string} trigger
 * @property {string} started_at
 */

/**
 * @typedef {object} Checkpoint
 * @property {number} fact_count
 * @property {number} hint_count
 * @property {boolean} had_open_intents
 */

/**
 * @typedef {object} Board
 * @property {string} title
 * @property {BoardStatus} status
 * @property {boolean} bootstrap_enabled
 * @property {Fact[]} facts
 * @property {Intent[]} intents
 * @property {Hint[]} hints
 * @property {ReasonLease | null} reason
 * @property {Checkpoint} checkpoint
 */

/**
 * @param {string} [now]
 * @returns {Board}
 */
export function emptyBoard(now = timestamp()) {
  return {
    title: '',
    status: 'active',
    bootstrap_enabled: true,
    facts: [
      { id: ORIGIN, description: '' },
      { id: GOAL, description: '' },
    ],
    intents: [],
    hints: [],
    reason: null,
    checkpoint: { fact_count: 2, hint_count: 0, had_open_intents: false },
  }
}

/**
 * @param {string} text
 * @returns {Board}
 */
export function parseBoard(text) {
  const raw = JSON.parse(text)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('blackboard must be a JSON object')
  }
  return /** @type {Board} */ (raw)
}

/**
 * @param {Board} board
 * @returns {string}
 */
export function serializeBoard(board) {
  return `${JSON.stringify(board, null, 2)}\n`
}

/**
 * @param {Board} board
 * @returns {boolean}
 */
export function isInitial(board) {
  const ids = new Set(board.facts.map((f) => f.id))
  if (ids.size !== 2 || !ids.has(ORIGIN) || !ids.has(GOAL)) return false
  return board.intents.every(isBootstrapIntent)
}

/**
 * @param {Intent} intent
 * @returns {boolean}
 */
export function isBootstrapIntent(intent) {
  return intent.description === BOOTSTRAP_DESCRIPTION
    && intent.creator === 'dispatcher.bootstrap'
    && intent.from.length === 1
    && intent.from[0] === ORIGIN
    && intent.to === null
}

/**
 * @param {Intent} intent
 * @returns {boolean}
 */
export function isOpen(intent) {
  return intent.to === null
}

/**
 * @param {Intent} intent
 * @returns {boolean}
 */
export function isUnclaimed(intent) {
  return intent.to === null && intent.worker === null
}

/**
 * Newest unclaimed non-bootstrap open intent, or null.
 * @param {Board} board
 * @returns {Intent | null}
 */
export function newestUnclaimedExplore(board) {
  const open = board.intents.filter((intent) => isUnclaimed(intent) && !isBootstrapIntent(intent))
  if (open.length === 0) return null
  return open.reduce((best, intent) => (intent.created_at >= best.created_at ? intent : best))
}

/**
 * @param {Board} board
 * @returns {string | null} reason trigger, or null if reason should not run
 */
export function reasonTrigger(board) {
  if (board.status !== 'active') return null
  if (board.reason !== null) return null
  const open = board.intents.some(isOpen)
  const facts = board.facts.length
  const hints = board.hints.length
  const cp = board.checkpoint
  if (facts > cp.fact_count) return 'new-fact'
  if (hints > cp.hint_count) return 'new-hint'
  if (cp.had_open_intents && !open) return 'intents-empty'
  if (!open && facts === cp.fact_count && hints === cp.hint_count) {
    // First look: empty opens, no checkpoint movement. Treat as initial reason
    // only when we have never recorded a successful reason that left opens empty
    // on a non-initial graph. After a successful reason, checkpoint is updated
    // at START so creating intents does not retrigger; when those complete,
    // intents-empty fires. For a graph that has left initial with no opens yet
    // (bootstrap conclude, no intents), fact_count already exceeded 2 so
    // new-fact fired. Remaining case: still initial and bootstrap skipped.
    if (isInitial(board)) return 'initial'
  }
  return null
}

/**
 * Scheduler: implemented loop, not the stricter design-doc wording.
 * @param {Board} board
 * @returns {{ task: 'bootstrap' | 'reason' | 'explore' | 'idle'; trigger?: string; intent?: Intent }}
 */
export function nextTask(board) {
  if (board.status !== 'active') return { task: 'idle' }
  if (isInitial(board)) {
    const runningBootstrap = board.intents.some(
      (intent) => isBootstrapIntent(intent) && isOpen(intent) && intent.worker !== null,
    )
    if (runningBootstrap) return { task: 'idle' }
    if (board.bootstrap_enabled) return { task: 'bootstrap' }
    const trigger = reasonTrigger(board)
    if (trigger) return { task: 'reason', trigger }
    return { task: 'idle' }
  }
  const trigger = reasonTrigger(board)
  if (trigger) return { task: 'reason', trigger }
  const intent = newestUnclaimedExplore(board)
  if (intent) return { task: 'explore', intent }
  return { task: 'idle' }
}

/**
 * @typedef {object} InitOp
 * @property {'init'} type
 * @property {string} origin
 * @property {string} goal
 * @property {string} [title]
 * @property {string[]} [hints]
 * @property {string} [creator]
 * @property {string} [now]
 */

/**
 * @typedef {object} HintOp
 * @property {'hint'} type
 * @property {string} content
 * @property {string} [creator]
 * @property {string} [now]
 */

/**
 * @typedef {object} BootstrapOp
 * @property {'bootstrap'} type
 * @property {string} fact
 * @property {string} [complete]
 * @property {string} [worker]
 * @property {string} [now]
 */

/**
 * @typedef {{ from: string[], description: string }} IntentDraft
 *
 * @typedef {object} ReasonOp
 * @property {'reason'} type
 * @property {string} [worker]
 * @property {string} [trigger]
 * @property {{ from: string[], description: string }} [complete]
 * @property {IntentDraft[]} [intents]
 * @property {string} [now]
 */

/**
 * @typedef {object} ClaimOp
 * @property {'claim'} type
 * @property {string} worker
 * @property {string} [intentId]
 * @property {string} [now]
 */

/**
 * @typedef {object} ConcludeOp
 * @property {'conclude'} type
 * @property {string} intentId
 * @property {string} description
 * @property {string} worker
 * @property {string} [now]
 */

/**
 * @typedef {object} ReleaseOp
 * @property {'release'} type
 * @property {string} intentId
 * @property {string} worker
 */

/**
 * @typedef {object} CompleteOp
 * @property {'complete'} type
 * @property {string[]} from
 * @property {string} description
 * @property {string} [worker]
 * @property {string} [now]
 */

/**
 * @typedef {object} StopOp
 * @property {'stop'} type
 */

/**
 * @typedef {object} ReopenOp
 * @property {'reopen'} type
 * @property {string} [description]
 * @property {string} [now]
 */

/** @typedef {InitOp | HintOp | BootstrapOp | ReasonOp | ClaimOp | ConcludeOp | ReleaseOp | CompleteOp | StopOp | ReopenOp} Op */

/**
 * Apply one protocol mutation. Returns a new board; never mutates the input.
 * @param {Board} board
 * @param {Op} op
 * @returns {{ board: Board, result: Record<string, unknown> }}
 */
export function apply(board, op) {
  switch (op.type) {
    case 'init':
      return init(board, op)
    case 'hint':
      return addHint(board, op)
    case 'bootstrap':
      return bootstrap(board, op)
    case 'reason':
      return reason(board, op)
    case 'claim':
      return claim(board, op)
    case 'conclude':
      return conclude(board, op)
    case 'release':
      return release(board, op)
    case 'complete':
      return complete(board, op)
    case 'stop':
      return stop(board)
    case 'reopen':
      return reopen(board, op)
    default:
      throw new Error(`unknown op ${(/** @type {{ type: string }} */ (op)).type}`)
  }
}

/**
 * @param {Board} board
 * @returns {Board}
 */
function clone(board) {
  return structuredClone(board)
}

function timestamp() {
  return new Date().toISOString()
}

function requireText(value, field) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${field} must be a non-empty string`)
  return text
}

function requireActive(board) {
  if (board.status !== 'active') throw new Error(`board is ${board.status}; write ops require active`)
}

function nextFactId(board) {
  const n = board.facts.filter((f) => /^f\d+$/.test(f.id)).length + 1
  return `f${String(n).padStart(3, '0')}`
}

function nextIntentId(board) {
  const n = board.intents.length + 1
  return `i${String(n).padStart(3, '0')}`
}

function nextHintId(board) {
  const n = board.hints.length + 1
  return `h${String(n).padStart(3, '0')}`
}

function factIds(board) {
  return new Set(board.facts.map((f) => f.id))
}

function assertFrom(board, from, { allowGoal = false } = {}) {
  if (!Array.isArray(from) || from.length === 0) {
    throw new Error('from must be a non-empty array of fact ids')
  }
  const ids = factIds(board)
  const cleaned = []
  for (const raw of from) {
    const id = requireText(raw, 'fact id')
    if (id === GOAL && !allowGoal) throw new Error('goal cannot appear in Intent.from')
    if (!ids.has(id)) throw new Error(`unknown fact ${id}`)
    cleaned.push(id)
  }
  return cleaned
}

function snapshotCheckpoint(board) {
  return {
    fact_count: board.facts.length,
    hint_count: board.hints.length,
    had_open_intents: board.intents.some(isOpen),
  }
}

/** @param {Board} _board @param {InitOp} op */
function init(_board, op) {
  const now = op.now ?? timestamp()
  const next = emptyBoard(now)
  next.title = typeof op.title === 'string' ? op.title.trim() : ''
  next.facts = [
    { id: ORIGIN, description: requireText(op.origin, 'origin') },
    { id: GOAL, description: requireText(op.goal, 'goal') },
  ]
  const creator = (op.creator ?? 'user').trim() || 'user'
  next.hints = (op.hints ?? []).map((content, i) => ({
    id: `h${String(i + 1).padStart(3, '0')}`,
    content: requireText(content, 'hint'),
    creator,
    created_at: now,
  }))
  next.checkpoint = snapshotCheckpoint(next)
  return { board: next, result: { task: nextTask(next) } }
}

/** @param {Board} board @param {HintOp} op */
function addHint(board, op) {
  // Hints are allowed on stopped/completed (Cairn protocol).
  const next = clone(board)
  const now = op.now ?? timestamp()
  const hint = {
    id: nextHintId(next),
    content: requireText(op.content, 'content'),
    creator: (op.creator ?? 'user').trim() || 'user',
    created_at: now,
  }
  next.hints.push(hint)
  return { board: next, result: { hint, task: nextTask(next) } }
}

/** @param {Board} board @param {BootstrapOp} op */
function bootstrap(board, op) {
  requireActive(board)
  if (!isInitial(board)) throw new Error('bootstrap only runs in the initial state')
  const next = clone(board)
  const now = op.now ?? timestamp()
  const worker = (op.worker ?? 'parent').trim() || 'parent'
  const factText = requireText(op.fact, 'fact')
  let reserved = next.intents.find((intent) => isBootstrapIntent(intent) && isOpen(intent))
  if (!reserved) {
    reserved = {
      id: nextIntentId(next),
      from: [ORIGIN],
      to: null,
      description: BOOTSTRAP_DESCRIPTION,
      creator: 'dispatcher.bootstrap',
      worker,
      created_at: now,
      concluded_at: null,
    }
    next.intents.push(reserved)
  } else {
    reserved.worker = worker
  }
  const fact = { id: nextFactId(next), description: factText }
  next.facts.push(fact)
  reserved.to = fact.id
  reserved.concluded_at = now
  reserved.worker = worker
  const completeText = typeof op.complete === 'string' ? op.complete.trim() : ''
  if (completeText) {
    const done = {
      id: nextIntentId(next),
      from: [fact.id],
      to: GOAL,
      description: completeText,
      creator: worker,
      worker,
      created_at: now,
      concluded_at: now,
    }
    next.intents.push(done)
    next.status = 'completed'
    next.reason = null
  }
  return {
    board: next,
    result: {
      fact,
      completed: next.status === 'completed',
      task: nextTask(next),
    },
  }
}

/** @param {Board} board @param {ReasonOp} op */
function reason(board, op) {
  requireActive(board)
  // Ignore caller-supplied trigger. Echoing a previous nextTask.trigger would
  // bypass checkpoint-at-start and let reason run again immediately.
  const trigger = reasonTrigger(board)
  if (!trigger) throw new Error('reason has no new situation to judge')
  const worker = (op.worker ?? 'parent').trim() || 'parent'
  const next = clone(board)
  const now = op.now ?? timestamp()
  next.checkpoint = snapshotCheckpoint(next)
  next.reason = { worker, trigger, started_at: now }

  const completeSpec = op.complete
  const drafts = op.intents
  if (completeSpec && drafts && drafts.length > 0) {
    throw new Error('reason cannot return both complete and intents')
  }

  const open = next.intents.filter(isOpen)

  if (completeSpec) {
    const from = assertFrom(next, completeSpec.from)
    const description = requireText(completeSpec.description, 'complete.description')
    const done = {
      id: nextIntentId(next),
      from,
      to: GOAL,
      description,
      creator: worker,
      worker,
      created_at: now,
      concluded_at: now,
    }
    next.intents.push(done)
    next.status = 'completed'
    next.reason = null
    return { board: next, result: { complete: done, task: nextTask(next) } }
  }

  if (drafts && drafts.length > 0) {
    if (drafts.length > 3) throw new Error('reason may propose at most 3 intents')
    const created = []
    for (const draft of drafts) {
      const intent = {
        id: nextIntentId(next),
        from: assertFrom(next, draft.from),
        to: null,
        description: requireText(draft.description, 'intent.description'),
        creator: worker,
        worker: null,
        created_at: now,
        concluded_at: null,
      }
      next.intents.push(intent)
      created.push(intent)
    }
    next.reason = null
    return { board: next, result: { intents: created, task: nextTask(next) } }
  }

  if (open.length === 0) {
    throw new Error('reason must propose intents when none are open and goal is unmet')
  }
  next.reason = null
  return { board: next, result: { intents: [], task: nextTask(next) } }
}

/** @param {Board} board @param {ClaimOp} op */
function claim(board, op) {
  requireActive(board)
  const worker = requireText(op.worker, 'worker')
  const next = clone(board)
  let intent
  if (op.intentId) {
    intent = next.intents.find((item) => item.id === op.intentId)
    if (!intent) throw new Error(`unknown intent ${op.intentId}`)
    if (!isOpen(intent)) throw new Error(`intent ${intent.id} is already concluded`)
    if (intent.worker && intent.worker !== worker) {
      throw new Error(`intent ${intent.id} is claimed by ${intent.worker}`)
    }
  } else {
    const found = newestUnclaimedExplore(next)
    if (!found) throw new Error('no unclaimed explore intent')
    intent = next.intents.find((item) => item.id === found.id)
  }
  intent.worker = worker
  return { board: next, result: { intent, task: nextTask(next) } }
}

/** @param {Board} board @param {ConcludeOp} op */
function conclude(board, op) {
  requireActive(board)
  const worker = requireText(op.worker, 'worker')
  const next = clone(board)
  const intent = next.intents.find((item) => item.id === op.intentId)
  if (!intent) throw new Error(`unknown intent ${op.intentId}`)
  if (!isOpen(intent)) throw new Error(`intent ${intent.id} is already concluded`)
  if (intent.worker && intent.worker !== worker) {
    throw new Error(`intent ${intent.id} is claimed by ${intent.worker}`)
  }
  const now = op.now ?? timestamp()
  const fact = { id: nextFactId(next), description: requireText(op.description, 'description') }
  next.facts.push(fact)
  intent.to = fact.id
  intent.worker = worker
  intent.concluded_at = now
  return { board: next, result: { fact, intent, task: nextTask(next) } }
}

/** @param {Board} board @param {ReleaseOp} op */
function release(board, op) {
  requireActive(board)
  const worker = requireText(op.worker, 'worker')
  const next = clone(board)
  const intent = next.intents.find((item) => item.id === op.intentId)
  if (!intent) throw new Error(`unknown intent ${op.intentId}`)
  if (!isOpen(intent)) throw new Error(`intent ${intent.id} is already concluded`)
  if (intent.worker && intent.worker !== worker) {
    throw new Error(`intent ${intent.id} is claimed by ${intent.worker}`)
  }
  intent.worker = null
  return { board: next, result: { intent, task: nextTask(next) } }
}

/** @param {Board} board @param {CompleteOp} op */
function complete(board, op) {
  requireActive(board)
  const next = clone(board)
  const now = op.now ?? timestamp()
  const worker = (op.worker ?? 'parent').trim() || 'parent'
  const done = {
    id: nextIntentId(next),
    from: assertFrom(next, op.from),
    to: GOAL,
    description: requireText(op.description, 'description'),
    creator: worker,
    worker,
    created_at: now,
    concluded_at: now,
  }
  next.intents.push(done)
  next.status = 'completed'
  next.reason = null
  return { board: next, result: { complete: done, task: nextTask(next) } }
}

/** @param {Board} board */
function stop(board) {
  const next = clone(board)
  if (next.status !== 'active') return { board: next, result: { status: next.status } }
  next.status = 'stopped'
  next.reason = null
  for (const intent of next.intents) {
    if (isOpen(intent)) intent.worker = null
  }
  return { board: next, result: { status: 'stopped', task: nextTask(next) } }
}

/** @param {Board} board @param {ReopenOp} op */
function reopen(board, op) {
  if (board.status === 'active') throw new Error('board is already active')
  const next = clone(board)
  const wasCompleted = board.status === 'completed'
  const now = op.now ?? timestamp()
  next.status = 'active'
  next.reason = null
  // Snapshot before the optional correction fact so it can trigger reason
  // (new-fact). Checkpoint is otherwise only written by init and reason start.
  next.checkpoint = snapshotCheckpoint(next)
  const description = typeof op.description === 'string' ? op.description.trim() : ''
  const completions = wasCompleted ? next.intents.filter((intent) => intent.to === GOAL) : []
  if (wasCompleted) {
    next.intents = next.intents.filter((intent) => intent.to !== GOAL)
  }
  if (description) {
    const fact = { id: nextFactId(next), description }
    next.facts.push(fact)
    if (wasCompleted) {
      const from = completions.at(-1)?.from ?? []
      if (from.length > 0) {
        next.intents.push({
          id: nextIntentId(next),
          from,
          to: fact.id,
          description: 'external_feedback',
          creator: 'user',
          worker: 'user',
          created_at: now,
          concluded_at: now,
        })
      }
    }
  }
  return { board: next, result: { status: 'active', task: nextTask(next) } }
}
