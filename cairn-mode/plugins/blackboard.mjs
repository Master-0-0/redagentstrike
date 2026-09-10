/**
 * Cairn blackboard tools. Preset-local Cordis plugin: registers tools only.
 * @module cairn-mode/blackboard
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { apply as applyOp, emptyBoard, nextTask, parseBoard, serializeBoard } from './board.mjs'

export const name = 'cairn-blackboard'
export const inject = ['tools']

const BOARD_REL = join('.dsh', 'blackboard.json')

const ACTIONS = [
  'init',
  'hint',
  'bootstrap',
  'reason',
  'claim',
  'conclude',
  'release',
  'complete',
  'stop',
  'reopen',
]

const INTENT_DRAFT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: {
      type: 'array',
      items: { type: 'string' },
      description: 'Fact ids this intent explores from. Never include goal.',
    },
    description: { type: 'string', description: 'Independent parallelizable direction.' },
  },
  required: ['from', 'description'],
}

/**
 * @param {unknown} exec
 * @returns {string}
 */
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('blackboard tools require exec.agent.session.header.cwd')
  }
  return cwd
}

/**
 * @param {unknown} exec
 * @returns {string}
 */
function defaultWorker(exec) {
  const id = exec?.agent?.id
  return typeof id === 'string' && id.trim() !== '' ? id : 'parent'
}

/**
 * @param {string} cwd
 * @returns {string}
 */
function boardPath(cwd) {
  return join(cwd, BOARD_REL)
}

/**
 * @param {string} cwd
 * @returns {Promise<{ exists: boolean, board: object, path: string }>}
 */
async function loadBoard(cwd) {
  const path = boardPath(cwd)
  try {
    const text = await readFile(path, 'utf8')
    return { exists: true, board: parseBoard(text), path }
  } catch (error) {
    if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return { exists: false, board: emptyBoard(), path }
    }
    throw error
  }
}

/**
 * @param {string} path
 * @param {object} board
 */
async function persistBoard(path, board) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, serializeBoard(board), 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Compact YAML-like view of the board plus the scheduler's next task.
 * @param {object} board
 * @param {object} task
 * @returns {string}
 */
function summarize(board, task) {
  const facts = Array.isArray(board.facts) ? board.facts : []
  const intents = Array.isArray(board.intents) ? board.intents : []
  const hints = Array.isArray(board.hints) ? board.hints : []
  const lines = [
    `title: ${JSON.stringify(asString(board.title))}`,
    `status: ${asString(board.status) || 'unknown'}`,
    `bootstrap_enabled: ${board.bootstrap_enabled === true}`,
    'facts:',
  ]
  for (const fact of facts) {
    lines.push(`  - ${asString(fact.id)}: ${JSON.stringify(asString(fact.description))}`)
  }
  lines.push('intents:')
  if (intents.length === 0) lines.push('  []')
  for (const intent of intents) {
    const from = Array.isArray(intent.from) ? intent.from.join(', ') : ''
    lines.push(`  - ${asString(intent.id)}: from=[${from}] to=${JSON.stringify(intent.to ?? null)} worker=${JSON.stringify(intent.worker ?? null)} ${JSON.stringify(asString(intent.description))}`)
  }
  lines.push(`hints: ${hints.length}`)
  lines.push(`reason: ${board.reason == null ? 'null' : JSON.stringify(board.reason)}`)
  const taskName = asString(task?.task) || 'unknown'
  const extra = []
  if (task?.trigger) extra.push(`trigger=${task.trigger}`)
  if (task?.intent?.id) extra.push(`intent=${task.intent.id}`)
  lines.push(`next_task: ${taskName}${extra.length ? ` (${extra.join(' ')})` : ''}`)
  return lines.join('\n')
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} worker
 */
function toOp(args, worker) {
  const action = args.action
  switch (action) {
    case 'init': {
      const op = { type: 'init', origin: args.origin, goal: args.goal }
      if (args.title !== undefined) op.title = args.title
      if (args.hints !== undefined) op.hints = args.hints
      if (args.creator !== undefined) op.creator = args.creator
      return op
    }
    case 'hint': {
      const op = { type: 'hint', content: args.content }
      if (args.creator !== undefined) op.creator = args.creator
      return op
    }
    case 'bootstrap': {
      const op = { type: 'bootstrap', fact: args.fact, worker }
      if (args.complete !== undefined) op.complete = args.complete
      return op
    }
    case 'reason': {
      const op = { type: 'reason', worker }
      if (args.intents !== undefined) op.intents = args.intents
      if (args.complete_from !== undefined || args.complete_description !== undefined) {
        op.complete = {
          from: args.complete_from,
          description: args.complete_description,
        }
      }
      return op
    }
    case 'claim': {
      const op = { type: 'claim', worker }
      if (args.intent_id !== undefined) op.intentId = args.intent_id
      return op
    }
    case 'conclude':
      return {
        type: 'conclude',
        intentId: args.intent_id,
        description: args.description,
        worker,
      }
    case 'release':
      return { type: 'release', intentId: args.intent_id, worker }
    case 'complete': {
      const op = { type: 'complete', from: args.from, description: args.description, worker }
      return op
    }
    case 'stop':
      return { type: 'stop' }
    case 'reopen': {
      const op = { type: 'reopen' }
      if (args.description !== undefined) op.description = args.description
      return op
    }
    default:
      throw new Error(`unknown action ${action}`)
  }
}

/**
 * @param {unknown} value
 * @returns {[{ type: 'text', text: string }]}
 */
function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * @param {unknown} ctx
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'blackboard_read',
    description:
      'Load the Cairn fact-intent blackboard at `.dsh/blackboard.json` in the session workspace. '
      + 'If the file is missing, return an empty board. Use this instead of reading the file by hand. '
      + '`task` is the scheduler decision (bootstrap | reason | explore | idle).',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exists: { type: 'boolean', description: 'Whether `.dsh/blackboard.json` is already on disk.' },
          board: { description: 'Current blackboard object.' },
          task: { description: 'Scheduler decision from nextTask.' },
          summary: { type: 'string', description: 'YAML-like view of the board and next task.' },
        },
        required: ['exists', 'board', 'task', 'summary'],
      },
      render: renderValue,
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const loaded = await loadBoard(sessionCwd(exec))
      const task = nextTask(loaded.board)
      return {
        exists: loaded.exists,
        board: loaded.board,
        task,
        summary: summarize(loaded.board, task),
      }
    },
  })

  ctx.tools.register({
    name: 'blackboard_apply',
    description:
      'Apply one Cairn blackboard mutation and persist `.dsh/blackboard.json` atomically. '
      + 'The parent dispatcher MUST use this tool instead of writing the file. '
      + 'Explorers must not call it; they return one fact JSON and the parent conclude/release. '
      + 'On a protocol error the file is left unchanged and the tool fails. '
      + 'Actions: init, hint, bootstrap, reason, claim, conclude, release, complete, stop, reopen.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'Protocol op to apply.',
        },
        origin: { type: 'string', description: 'init: origin fact text.' },
        goal: { type: 'string', description: 'init: goal fact text.' },
        title: { type: 'string', description: 'init: optional board title.' },
        hints: {
          type: 'array',
          items: { type: 'string' },
          description: 'init: optional hint strings.',
        },
        content: { type: 'string', description: 'hint: hint body.' },
        creator: { type: 'string', description: 'init/hint: who authored the hints.' },
        fact: { type: 'string', description: 'bootstrap: confirmed fact text.' },
        complete: { type: 'string', description: 'bootstrap: optional complete description when the goal is proven in this attempt.' },
        complete_from: {
          type: 'array',
          items: { type: 'string' },
          description: 'reason: fact ids that jointly prove the goal.',
        },
        complete_description: { type: 'string', description: 'reason: why those facts meet the goal.' },
        intents: {
          type: 'array',
          items: INTENT_DRAFT,
          description: 'reason: at most 3 new unclaimed intents. Do not combine with complete_from.',
        },
        intent_id: { type: 'string', description: 'claim/conclude/release: intent id (claim may omit to take the newest explore).' },
        description: { type: 'string', description: 'conclude/complete/reopen: fact or complete text.' },
        worker: { type: 'string', description: 'Claim holder. Defaults to this agent id, or parent.' },
        from: {
          type: 'array',
          items: { type: 'string' },
          description: 'complete: fact ids that jointly prove the goal.',
        },
        trigger: {
          type: 'string',
          description: 'Ignored. The scheduler computes the reason trigger; echoing a previous value cannot bypass checkpoint-at-start.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          board: { description: 'Board after the op.' },
          result: { description: 'Protocol result payload.' },
          task: { description: 'Scheduler decision after the op.' },
        },
        required: ['board', 'result', 'task'],
      },
      render: renderValue,
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec)
      const loaded = await loadBoard(cwd)
      const worker = typeof args.worker === 'string' && args.worker.trim() !== ''
        ? args.worker
        : defaultWorker(exec)
      const { board, result } = applyOp(loaded.board, toOp(args, worker))
      await persistBoard(loaded.path, board)
      return {
        board,
        result,
        task: result.task ?? nextTask(board),
      }
    },
  })
}
