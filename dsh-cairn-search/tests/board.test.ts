import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  addHint,
  boardPath,
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
  startReason,
  stopBoard,
} from '../src/board.ts'
import { BOARD_RELATIVE_PATH, GOAL_ID, MAX_INTENTS, ORIGIN_ID } from '../src/types.ts'
import type { Board, Intent } from '../src/types.ts'

const ORIGIN = 'repo tests failing'
const GOAL = 'tests pass'
const WORKER = 'worker-a'
const WORKER_B = 'worker-b'

function fresh(hints?: string[]): Board {
  return emptyBoard('repo tests', ORIGIN, GOAL, hints)
}

function mustExplore(board: Board): Intent {
  const task = nextTask(board)
  assert.equal(task.kind, 'explore')
  if (task.kind !== 'explore') throw new Error('expected explore')
  return task.intent
}

function declare(board: Board, worker: string, descriptions: string[]): Board {
  const started = startReason(board, worker)
  return finishReason(started.board, worker, {
    intents: descriptions.map((description) => ({ from: [ORIGIN_ID], description })),
  })
}

test('init: origin, goal, checkpoint, bootstrap next', () => {
  const board = fresh(['run the suite'])
  assert.equal(board.status, 'active')
  assert.equal(board.bootstrapEnabled, true)
  assert.equal(board.reason, null)
  assert.deepEqual(
    board.facts.map((fact) => fact.id),
    [ORIGIN_ID, GOAL_ID],
  )
  assert.equal(board.facts[0].description, ORIGIN)
  assert.equal(board.facts[1].description, GOAL)
  assert.equal(board.intents.length, 0)
  assert.equal(board.hints.length, 1)
  assert.equal(board.hints[0].id, 'h001')
  assert.deepEqual(board.checkpoint, {
    factCount: 2,
    hintCount: 1,
    hadOpenIntents: false,
  })
  const task = nextTask(board)
  assert.equal(task.kind, 'bootstrap')
  if (task.kind === 'bootstrap') {
    assert.equal(task.origin, ORIGIN)
    assert.equal(task.goal, GOAL)
    assert.equal(task.hints.length, 1)
  }
})

test('loadBoard returns null when missing; saveBoard writes 2-space JSON atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-board-'))
  try {
    assert.equal(await loadBoard(dir), null)
    const board = fresh()
    await saveBoard(dir, board)
    assert.equal(boardPath(dir), join(dir, BOARD_RELATIVE_PATH))
    const raw = await readFile(boardPath(dir), 'utf8')
    assert.match(raw, /^\{\n  "/)
    const loaded = await loadBoard(dir)
    assert.equal(loaded?.title, board.title)
    assert.equal(loaded?.facts.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bootstrap path: reserved intent, claim, conclude fact', () => {
  let board = ensureBootstrapIntent(fresh())
  assert.equal(board.intents.length, 1)
  const boot = board.intents[0]
  assert.deepEqual(boot.from, [ORIGIN_ID])
  assert.equal(boot.description, 'bootstrap')
  assert.equal(boot.creator, 'dispatcher.bootstrap')
  assert.equal(boot.worker, null)
  assert.equal(boot.id, 'i001')
  assert.equal(nextTask(board).kind, 'bootstrap')

  board = claimIntent(board, boot.id, WORKER)
  assert.equal(board.intents[0].worker, WORKER)
  const concluded = concludeIntent(board, boot.id, 'failing tests live in the parser', WORKER)
  board = concluded.board
  assert.equal(concluded.fact.id, 'f001')
  assert.equal(concluded.fact.description, 'failing tests live in the parser')
  assert.equal(board.intents[0].to, 'f001')
  assert.ok(board.intents[0].concludedAt)
  assert.equal(board.intents[0].worker, WORKER)
})

test('reason after fact: conclude produces new-fact trigger', () => {
  let board = ensureBootstrapIntent(fresh())
  board = claimIntent(board, board.intents[0].id, WORKER)
  board = concludeIntent(board, board.intents[0].id, 'parser suite is red', WORKER).board
  const task = nextTask(board)
  assert.equal(task.kind, 'reason')
  if (task.kind === 'reason') {
    assert.equal(task.trigger, 'new-fact')
    assert.ok(task.factIds.includes('f001'))
  }
})

test('reason concurrent with open intents: new hint triggers reason', () => {
  let board = ensureBootstrapIntent(fresh())
  board = claimIntent(board, board.intents[0].id, WORKER)
  board = concludeIntent(board, board.intents[0].id, 'parser suite is red', WORKER).board
  board = declare(board, WORKER, ['isolate failing module'])
  assert.equal(nextTask(board).kind, 'explore')
  board = addHint(board, 'look at snapshot tests', 'reviewer').board
  const task = nextTask(board)
  assert.equal(task.kind, 'reason')
  if (task.kind === 'reason') assert.equal(task.trigger, 'new-hint')
})

test('declare intents does not retrigger reason', () => {
  let board = ensureBootstrapIntent(fresh())
  board = claimIntent(board, board.intents[0].id, WORKER)
  board = concludeIntent(board, board.intents[0].id, 'parser suite is red', WORKER).board
  board = declare(board, WORKER, ['isolate failing module', 'inspect test runner'])
  const task = nextTask(board)
  assert.equal(task.kind, 'explore')
})

test('explore newest unclaimed non-bootstrap intent', () => {
  let board = ensureBootstrapIntent(fresh())
  board = claimIntent(board, board.intents[0].id, WORKER)
  board = concludeIntent(board, board.intents[0].id, 'parser suite is red', WORKER).board
  board = declare(board, WORKER, ['isolate failing module'])
  board = addHint(board, 'also check fixtures', 'reviewer').board
  board = declare(board, WORKER, ['inspect test runner'])
  const intent = mustExplore(board)
  assert.equal(intent.description, 'inspect test runner')
})

test('claim-before-conclude', () => {
  let board = ensureBootstrapIntent(fresh())
  const id = board.intents[0].id
  assert.throws(() => concludeIntent(board, id, 'should fail', WORKER), /not claimed/)
  board = claimIntent(board, id, WORKER)
  const once = concludeIntent(board, id, 'bootstrap notes', WORKER)
  assert.equal(once.fact.id, 'f001')
  board = once.board
  board = declare(board, WORKER, ['isolate failing module'])
  const exploreId = mustExplore(board).id
  assert.throws(() => concludeIntent(board, exploreId, 'found a clue', WORKER), /not claimed/)
  board = claimIntent(board, exploreId, WORKER)
  const done = concludeIntent(board, exploreId, 'module isolated', WORKER)
  assert.equal(done.fact.id, 'f002')
  assert.equal(done.board.intents.find((intent) => intent.id === exploreId)?.to, 'f002')
})

test('same worker claim is heartbeat; other worker cannot steal', () => {
  let board = ensureBootstrapIntent(fresh())
  const id = board.intents[0].id
  board = claimIntent(board, id, WORKER)
  const again = claimIntent(board, id, WORKER)
  assert.equal(again.intents[0].worker, WORKER)
  assert.throws(() => claimIntent(board, id, WORKER_B), /already claimed/)
})

test('release is not a reason trigger', () => {
  let board = ensureBootstrapIntent(fresh())
  board = claimIntent(board, board.intents[0].id, WORKER)
  board = concludeIntent(board, board.intents[0].id, 'parser suite is red', WORKER).board
  board = declare(board, WORKER, ['isolate failing module'])
  const id = mustExplore(board).id
  board = claimIntent(board, id, WORKER)
  board = releaseIntent(board, id)
  assert.equal(board.intents.find((intent) => intent.id === id)?.worker, null)
  assert.equal(board.intents.find((intent) => intent.id === id)?.to, null)
  const task = nextTask(board)
  assert.equal(task.kind, 'explore')
  if (task.kind === 'explore') assert.equal(task.intent.id, id)
})

test('goal must not appear in from', () => {
  let board = ensureBootstrapIntent(fresh())
  board = claimIntent(board, board.intents[0].id, WORKER)
  board = concludeIntent(board, board.intents[0].id, 'parser suite is red', WORKER).board
  const started = startReason(board, WORKER)
  assert.throws(
    () =>
      finishReason(started.board, WORKER, {
        intents: [{ from: [GOAL_ID], description: 'isolate failing module' }],
      }),
    /goal in from/,
  )
  assert.throws(
    () =>
      finishReason(started.board, WORKER, {
        complete: { from: [GOAL_ID], description: 'done' },
      }),
    /goal in from/,
  )
  assert.equal(started.board.reason?.worker, WORKER)
})

test('complete to=goal marks board completed', () => {
  let board = ensureBootstrapIntent(fresh())
  board = claimIntent(board, board.intents[0].id, WORKER)
  board = concludeIntent(board, board.intents[0].id, 'parser suite is red', WORKER).board
  const started = startReason(board, WORKER)
  board = finishReason(started.board, WORKER, {
    complete: { from: [ORIGIN_ID, 'f001'], description: 'suite is green after the parser fix' },
  })
  assert.equal(board.status, 'completed')
  assert.equal(board.reason, null)
  const done = board.intents.find((intent) => intent.to === GOAL_ID)
  assert.ok(done)
  assert.deepEqual(done?.from, [ORIGIN_ID, 'f001'])
  assert.equal(done?.worker, WORKER)
  assert.ok(done?.concludedAt)
  assert.equal(nextTask(board).kind, 'idle')
})

test('stop blocks conclude; hint on stopped is ok', () => {
  let board = ensureBootstrapIntent(fresh())
  board = claimIntent(board, board.intents[0].id, WORKER)
  board = stopBoard(board)
  assert.equal(board.status, 'stopped')
  assert.equal(board.reason, null)
  assert.equal(board.intents[0].worker, null)
  assert.throws(() => concludeIntent(board, board.intents[0].id, 'nope', WORKER), /not active/)
  const hinted = addHint(board, 'pause and retry later', 'reviewer')
  assert.equal(hinted.hint.id, 'h001')
  assert.equal(hinted.board.status, 'stopped')
  board = reopenBoard(hinted.board)
  assert.equal(board.status, 'active')
  assert.equal(board.hints.length, 1)
})

test('finishReason truncates to MAX_INTENTS and empty requires open intents', () => {
  let board = ensureBootstrapIntent(fresh())
  board = claimIntent(board, board.intents[0].id, WORKER)
  board = concludeIntent(board, board.intents[0].id, 'parser suite is red', WORKER).board
  const started = startReason(board, WORKER)
  const descriptions = [
    'isolate failing module',
    'inspect test runner',
    'check fixture data',
    'rewrite the harness',
  ]
  board = finishReason(started.board, WORKER, {
    intents: descriptions.map((description) => ({ from: [ORIGIN_ID], description })),
  })
  const open = board.intents.filter((intent) => intent.to === null)
  assert.equal(open.length, MAX_INTENTS)
  assert.equal(open[2].description, 'check fixture data')

  const startedAgain = startReason(addHint(board, 'retry reason', 'reviewer').board, WORKER)
  assert.doesNotThrow(() => finishReason(startedAgain.board, WORKER, {}))
})

test('startReason same worker renews; other worker is rejected', () => {
  let board = ensureBootstrapIntent(fresh())
  board = claimIntent(board, board.intents[0].id, WORKER)
  board = concludeIntent(board, board.intents[0].id, 'parser suite is red', WORKER).board
  const first = startReason(board, WORKER)
  assert.equal(first.trigger, 'new-fact')
  const again = startReason(first.board, WORKER)
  assert.equal(again.trigger, 'new-fact')
  assert.throws(() => startReason(first.board, WORKER_B), /reason held/)
})

test('ensureBootstrapIntent is idempotent on initial boards', () => {
  const once = ensureBootstrapIntent(fresh())
  const twice = ensureBootstrapIntent(once)
  assert.equal(twice.intents.length, 1)
  assert.equal(twice.intents[0].id, once.intents[0].id)
})
