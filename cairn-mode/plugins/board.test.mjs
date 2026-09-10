import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  emptyBoard,
  isBootstrapIntent,
  isInitial,
  isOpen,
  newestUnclaimedExplore,
  nextTask,
  parseBoard,
  serializeBoard,
} from './board.mjs'

const ORIGIN = 'tests fail'
const GOAL = 'tests pass'

/** Deterministic ISO timestamps (`now` on every timed op). */
function at(sec) {
  return `2026-09-10T12:00:${String(sec).padStart(2, '0')}.000Z`
}

function initBoard(extra = {}) {
  return apply(emptyBoard(at(0)), {
    type: 'init',
    origin: ORIGIN,
    goal: GOAL,
    now: at(0),
    ...extra,
  })
}

function bootstrapOnce(board, extra = {}) {
  return apply(board, {
    type: 'bootstrap',
    fact: 'suite is red',
    now: at(1),
    worker: 'parent',
    ...extra,
  })
}

function proposeExplores(board, drafts, now = at(2)) {
  return apply(board, {
    type: 'reason',
    worker: 'parent',
    now,
    intents: drafts,
  })
}

function snapshot(board) {
  return structuredClone(board)
}

describe('init', () => {
  it('writes origin+goal facts, optional hints, and nextTask bootstrap when enabled', () => {
    const { board, result } = initBoard({
      title: 'suite',
      hints: ['start from the failing assertion'],
      creator: 'user',
    })

    assert.equal(board.status, 'active')
    assert.equal(board.bootstrap_enabled, true)
    assert.equal(board.title, 'suite')
    assert.deepEqual(board.facts, [
      { id: 'origin', description: ORIGIN },
      { id: 'goal', description: GOAL },
    ])
    assert.equal(board.intents.length, 0)
    assert.equal(board.hints.length, 1)
    assert.equal(board.hints[0].id, 'h001')
    assert.equal(board.hints[0].content, 'start from the failing assertion')
    assert.equal(board.hints[0].creator, 'user')
    assert.equal(board.hints[0].created_at, at(0))
    assert.deepEqual(board.checkpoint, {
      fact_count: 2,
      hint_count: 1,
      had_open_intents: false,
    })
    assert.deepEqual(result.task, { task: 'bootstrap' })
    assert.deepEqual(nextTask(board), { task: 'bootstrap' })
  })

  it('init without hints still schedules bootstrap when bootstrap_enabled', () => {
    const { board, result } = initBoard()
    assert.equal(board.hints.length, 0)
    assert.deepEqual(board.checkpoint, {
      fact_count: 2,
      hint_count: 0,
      had_open_intents: false,
    })
    assert.deepEqual(result.task, { task: 'bootstrap' })
  })

  it('init always starts a fresh board, even if one already exists', () => {
    const { board: grown } = bootstrapOnce(initBoard({ title: 'old', hints: ['keep me'] }).board)
    assert.equal(grown.facts.length, 3)
    assert.equal(grown.intents.length, 1)
    const before = snapshot(grown)
    const { board, result } = apply(grown, {
      type: 'init',
      origin: 'new origin',
      goal: 'new goal',
      title: 'fresh',
      now: at(9),
    })
    assert.deepEqual(grown, before)
    assert.equal(board.title, 'fresh')
    assert.deepEqual(board.facts, [
      { id: 'origin', description: 'new origin' },
      { id: 'goal', description: 'new goal' },
    ])
    assert.equal(board.intents.length, 0)
    assert.equal(board.hints.length, 0)
    assert.deepEqual(result.task, { task: 'bootstrap' })
  })
})

describe('isInitial', () => {
  it('is true for origin+goal with empty intents', () => {
    const { board } = initBoard()
    assert.equal(isInitial(board), true)
  })

  it('is true when the only intents are reserved bootstrap', () => {
    const { board } = initBoard()
    const reserved = {
      ...board,
      intents: [{
        id: 'i001',
        from: ['origin'],
        to: null,
        description: 'bootstrap',
        creator: 'dispatcher.bootstrap',
        worker: null,
        created_at: at(0),
        concluded_at: null,
      }],
    }
    assert.equal(isInitial(reserved), true)
  })

  it('is false after an extra fact or a non-bootstrap intent', () => {
    const { board } = initBoard()
    assert.equal(isInitial({
      ...board,
      facts: [...board.facts, { id: 'f001', description: 'suite is red' }],
    }), false)
    assert.equal(isInitial({
      ...board,
      intents: [{
        id: 'i001',
        from: ['origin'],
        to: null,
        description: 'run the suite',
        creator: 'parent',
        worker: null,
        created_at: at(0),
        concluded_at: null,
      }],
    }), false)
  })
})

describe('bootstrap', () => {
  it('without complete: appends a fact, concludes reserved bootstrap, leaves initial, nextTask reason', () => {
    const { board: initial } = initBoard()
    const checkpointBefore = structuredClone(initial.checkpoint)
    const { board, result } = bootstrapOnce(initial)

    assert.equal(isInitial(board), false)
    assert.equal(board.status, 'active')
    assert.deepEqual(result.fact, { id: 'f001', description: 'suite is red' })
    assert.equal(board.facts.at(-1).id, 'f001')
    assert.equal(board.intents.length, 1)

    const reserved = board.intents[0]
    assert.equal(reserved.description, 'bootstrap')
    assert.deepEqual(reserved.from, ['origin'])
    assert.equal(reserved.to, 'f001')
    assert.equal(reserved.concluded_at, at(1))
    assert.equal(reserved.worker, 'parent')
    assert.equal(isOpen(reserved), false)

    assert.deepEqual(board.checkpoint, checkpointBefore)
    assert.deepEqual(result.task, { task: 'reason', trigger: 'new-fact' })
    assert.deepEqual(nextTask(board), { task: 'reason', trigger: 'new-fact' })
  })

  it('with complete: status completed, concluded intent to=goal, nextTask idle', () => {
    const { board: initial } = initBoard()
    const { board, result } = bootstrapOnce(initial, {
      complete: 'suite already green',
    })

    assert.equal(board.status, 'completed')
    assert.equal(result.completed, true)
    assert.deepEqual(result.task, { task: 'idle' })
    assert.deepEqual(nextTask(board), { task: 'idle' })

    const done = board.intents.find((intent) => intent.to === 'goal')
    assert.ok(done)
    assert.deepEqual(done.from, ['f001'])
    assert.equal(done.description, 'suite already green')
    assert.equal(done.concluded_at, at(1))
    assert.equal(isOpen(done), false)
  })

  it('is rejected when the board is not initial', () => {
    const { board: initial } = initBoard()
    const { board } = bootstrapOnce(initial)
    assert.equal(isInitial(board), false)
    assert.throws(
      () => apply(board, { type: 'bootstrap', fact: 'again', now: at(2) }),
      { message: 'bootstrap only runs in the initial state' },
    )
  })
})

describe('reason', () => {
  it('after a new fact may propose up to 3 intents with worker=null', () => {
    const { board: seeded } = bootstrapOnce(initBoard().board)
    const drafts = [
      { from: ['origin', 'f001'], description: 'run the failing suite' },
      { from: ['f001'], description: 'read the first assertion' },
      { from: ['origin'], description: 'list related cases' },
    ]
    const { board, result } = proposeExplores(seeded, drafts)

    assert.equal(result.intents.length, 3)
    for (const intent of result.intents) {
      assert.equal(intent.worker, null)
      assert.equal(intent.to, null)
      assert.equal(intent.concluded_at, null)
      assert.equal(intent.created_at, at(2))
      assert.ok(!intent.from.includes('goal'))
    }
    assert.equal(board.intents.filter((intent) => intent.worker === null && isOpen(intent)).length, 3)
  })

  it('rejects a fourth intent, unknown fact ids, and from including goal', () => {
    const { board: seeded } = bootstrapOnce(initBoard().board)
    const base = { from: ['f001'], description: 'work' }

    assert.throws(
      () => proposeExplores(seeded, [base, base, base, base]),
      { message: 'reason may propose at most 3 intents' },
    )
    assert.throws(
      () => proposeExplores(seeded, [{ from: ['f999'], description: 'missing' }]),
      { message: 'unknown fact f999' },
    )
    assert.throws(
      () => proposeExplores(seeded, [{ from: ['goal'], description: 'from goal' }]),
      { message: 'goal cannot appear in Intent.from' },
    )
    assert.throws(
      () => proposeExplores(seeded, [{ from: ['origin', 'goal'], description: 'mixed' }]),
      { message: 'goal cannot appear in Intent.from' },
    )
  })

  it('creating intents does not immediately retrigger reason (checkpoint at reason start)', () => {
    const { board: seeded } = bootstrapOnce(initBoard().board)
    assert.deepEqual(seeded.checkpoint, {
      fact_count: 2,
      hint_count: 0,
      had_open_intents: false,
    })

    const { board, result } = proposeExplores(seeded, [
      { from: ['f001'], description: 'run the failing suite' },
    ])

    assert.deepEqual(board.checkpoint, {
      fact_count: 3,
      hint_count: 0,
      had_open_intents: false,
    })
    assert.equal(result.task.task, 'explore')
    assert.notEqual(result.task.task, 'reason')
    assert.equal(nextTask(board).task, 'explore')
  })

  it('must propose intents if none are open and the goal is unmet', () => {
    const { board: seeded } = bootstrapOnce(initBoard().board)
    assert.equal(seeded.intents.every((intent) => !isOpen(intent)), true)

    assert.throws(
      () => apply(seeded, { type: 'reason', worker: 'parent', now: at(2) }),
      { message: 'reason must propose intents when none are open and goal is unmet' },
    )
    assert.throws(
      () => apply(seeded, { type: 'reason', worker: 'parent', now: at(2), intents: [] }),
      { message: 'reason must propose intents when none are open and goal is unmet' },
    )
  })

  it('may run while unclaimed intents exist if a new fact or hint arrived', () => {
    const { board: withOpens } = proposeExplores(
      bootstrapOnce(initBoard().board).board,
      [{ from: ['f001'], description: 'run the failing suite' }],
    )
    assert.ok(newestUnclaimedExplore(withOpens))
    assert.equal(nextTask(withOpens).task, 'explore')

    const { board: hinted, result: hintResult } = apply(withOpens, {
      type: 'hint',
      content: 'the assertion names a missing fixture',
      now: at(3),
    })
    assert.equal(hintResult.task.task, 'reason')
    assert.equal(hintResult.task.trigger, 'new-hint')
    assert.ok(newestUnclaimedExplore(hinted))

    const { board: judged, result } = apply(hinted, {
      type: 'reason',
      worker: 'parent',
      now: at(4),
    })
    assert.deepEqual(result.intents, [])
    assert.equal(judged.status, 'active')
    assert.ok(newestUnclaimedExplore(judged))
    assert.equal(nextTask(judged).task, 'explore')
  })

  it('complete writes intent to=goal and status completed', () => {
    const { board: seeded } = bootstrapOnce(initBoard().board)
    const { board, result } = apply(seeded, {
      type: 'reason',
      worker: 'parent',
      now: at(2),
      complete: { from: ['origin', 'f001'], description: 'suite is green' },
    })

    assert.equal(board.status, 'completed')
    assert.equal(result.complete.to, 'goal')
    assert.deepEqual(result.complete.from, ['origin', 'f001'])
    assert.equal(result.complete.description, 'suite is green')
    assert.equal(result.complete.concluded_at, at(2))
    assert.deepEqual(result.task, { task: 'idle' })
    assert.deepEqual(nextTask(board), { task: 'idle' })
  })

  it('ignores a stale caller trigger after checkpoint-at-start', () => {
    const { board } = proposeExplores(
      bootstrapOnce(initBoard().board).board,
      [{ from: ['f001'], description: 'run the failing suite' }],
    )
    assert.equal(nextTask(board).task, 'explore')
    assert.throws(
      () => apply(board, {
        type: 'reason',
        worker: 'parent',
        trigger: 'new-fact',
        now: at(3),
        intents: [{ from: ['f001'], description: 'another direction' }],
      }),
      { message: 'reason has no new situation to judge' },
    )
    assert.equal(board.intents.filter(isOpen).length, 1)
  })

  it('treats a reason-declared bootstrap-looking intent as a normal explore', () => {
    const { board: seeded } = bootstrapOnce(initBoard().board)
    const { board } = apply(seeded, {
      type: 'reason',
      worker: 'parent',
      now: at(2),
      intents: [{ from: ['origin'], description: 'bootstrap' }],
    })
    const fake = board.intents.find((intent) => intent.description === 'bootstrap' && intent.creator === 'parent')
    assert.ok(fake)
    assert.equal(isBootstrapIntent(fake), false)
    assert.equal(newestUnclaimedExplore(board)?.id, fake.id)
    assert.equal(nextTask(board).task, 'explore')
  })
})

describe('claim', () => {
  it('without intentId takes newest unclaimed non-bootstrap; sets worker; renew vs other worker', () => {
    const { board: first } = proposeExplores(
      bootstrapOnce(initBoard().board).board,
      [{ from: ['f001'], description: 'older explore' }],
      at(2),
    )
    const { board: hinted } = apply(first, {
      type: 'hint',
      content: 'try a second path',
      now: at(3),
    })
    const { board: two } = proposeExplores(
      hinted,
      [{ from: ['f001'], description: 'newer explore' }],
      at(4),
    )

    const newest = newestUnclaimedExplore(two)
    assert.equal(newest.description, 'newer explore')

    const { board: claimed, result } = apply(two, {
      type: 'claim',
      worker: 'child-a',
      now: at(5),
    })
    assert.equal(result.intent.id, newest.id)
    assert.equal(result.intent.worker, 'child-a')
    assert.equal(claimed.intents.find((intent) => intent.id === newest.id).worker, 'child-a')

    const { board: renewed } = apply(claimed, {
      type: 'claim',
      worker: 'child-a',
      intentId: newest.id,
      now: at(6),
    })
    assert.equal(renewed.intents.find((intent) => intent.id === newest.id).worker, 'child-a')

    assert.throws(
      () => apply(renewed, { type: 'claim', worker: 'child-b', intentId: newest.id, now: at(7) }),
      { message: `intent ${newest.id} is claimed by child-a` },
    )
  })
})

describe('conclude and release', () => {
  it('conclude is atomic: new fact + intent.to + concluded_at', () => {
    const { board: opens } = proposeExplores(
      bootstrapOnce(initBoard().board).board,
      [{ from: ['f001'], description: 'run the failing suite' }],
    )
    const intentId = newestUnclaimedExplore(opens).id
    const before = snapshot(opens)

    const { board, result } = apply(opens, {
      type: 'conclude',
      intentId,
      description: 'suite still red',
      worker: 'child-a',
      now: at(5),
    })

    assert.deepEqual(opens, before)
    assert.equal(result.fact.id, 'f002')
    assert.equal(result.fact.description, 'suite still red')
    assert.equal(result.intent.to, 'f002')
    assert.equal(result.intent.concluded_at, at(5))
    assert.equal(result.intent.worker, 'child-a')
    assert.equal(board.facts.at(-1).id, 'f002')
    assert.equal(board.intents.find((intent) => intent.id === intentId).to, 'f002')
  })

  it('failed conclude does not mutate the board', () => {
    const { board: claimed } = apply(
      proposeExplores(
        bootstrapOnce(initBoard().board).board,
        [{ from: ['f001'], description: 'run the failing suite' }],
      ).board,
      { type: 'claim', worker: 'child-a', now: at(5) },
    )
    const intentId = claimed.intents.find((intent) => intent.worker === 'child-a').id
    const before = snapshot(claimed)

    assert.throws(
      () => apply(claimed, {
        type: 'conclude',
        intentId,
        description: 'other worker',
        worker: 'child-b',
        now: at(6),
      }),
      { message: `intent ${intentId} is claimed by child-a` },
    )
    assert.deepEqual(claimed, before)
  })

  it('release clears worker, leaves to null, and does not retrigger reason', () => {
    const { board: claimed } = apply(
      proposeExplores(
        bootstrapOnce(initBoard().board).board,
        [{ from: ['f001'], description: 'run the failing suite' }],
      ).board,
      { type: 'claim', worker: 'child-a', now: at(5) },
    )
    const intentId = claimed.intents.find((intent) => intent.worker === 'child-a').id
    const checkpoint = structuredClone(claimed.checkpoint)

    const { board, result } = apply(claimed, {
      type: 'release',
      intentId,
      worker: 'child-a',
    })

    const intent = board.intents.find((item) => item.id === intentId)
    assert.equal(intent.worker, null)
    assert.equal(intent.to, null)
    assert.equal(intent.concluded_at, null)
    assert.deepEqual(board.checkpoint, checkpoint)
    assert.equal(result.task.task, 'explore')
    assert.notEqual(result.task.task, 'reason')
    assert.equal(nextTask(board).task, 'explore')
  })
})

describe('explore path', () => {
  it('after reason creates intents, nextTask is explore (newest), not reason', () => {
    const { board: first } = proposeExplores(
      bootstrapOnce(initBoard().board).board,
      [{ from: ['f001'], description: 'older explore' }],
      at(2),
    )
    const { board: hinted } = apply(first, {
      type: 'hint',
      content: 'second path',
      now: at(3),
    })
    const { board, result } = proposeExplores(
      hinted,
      [{ from: ['f001'], description: 'newer explore' }],
      at(4),
    )

    assert.equal(result.task.task, 'explore')
    assert.equal(result.task.intent.description, 'newer explore')
    assert.equal(nextTask(board).task, 'explore')
    assert.equal(nextTask(board).intent.description, 'newer explore')
  })

  it('after conclude of an explore, nextTask is reason (new-fact)', () => {
    const { board: opens } = proposeExplores(
      bootstrapOnce(initBoard().board).board,
      [
        { from: ['f001'], description: 'run the failing suite' },
        { from: ['origin'], description: 'still-open sibling' },
      ],
    )
    const intentId = newestUnclaimedExplore(opens).id
    const { board, result } = apply(opens, {
      type: 'conclude',
      intentId,
      description: 'suite still red',
      worker: 'child-a',
      now: at(5),
    })

    assert.deepEqual(result.task, { task: 'reason', trigger: 'new-fact' })
    assert.deepEqual(nextTask(board), { task: 'reason', trigger: 'new-fact' })
  })
})

describe('stop and reopen', () => {
  it('stop: status stopped, clears workers, no conclude-write; active writes fail; hints allowed', () => {
    const { board: opens } = proposeExplores(
      bootstrapOnce(initBoard().board).board,
      [{ from: ['f001'], description: 'run the failing suite' }],
    )
    const { board: claimed } = apply(opens, {
      type: 'claim',
      worker: 'child-a',
      now: at(5),
    })
    const intentId = claimed.intents.find((intent) => intent.worker === 'child-a').id
    const beforeFacts = claimed.facts.length
    const beforeTos = claimed.intents.map((intent) => intent.to)

    const { board: stopped, result } = apply(claimed, { type: 'stop' })
    assert.equal(stopped.status, 'stopped')
    assert.equal(result.status, 'stopped')
    assert.deepEqual(result.task, { task: 'idle' })
    assert.equal(stopped.facts.length, beforeFacts)
    assert.deepEqual(stopped.intents.map((intent) => intent.to), beforeTos)
    assert.equal(stopped.intents.find((intent) => intent.id === intentId).worker, null)
    assert.equal(stopped.reason, null)

    assert.throws(
      () => apply(stopped, { type: 'reason', worker: 'parent', now: at(6), intents: [{ from: ['f001'], description: 'x' }] }),
      { message: /board is stopped; write ops require active/ },
    )
    assert.throws(
      () => apply(stopped, { type: 'claim', worker: 'child-b', now: at(6) }),
      { message: /board is stopped; write ops require active/ },
    )
    assert.throws(
      () => apply(stopped, {
        type: 'conclude',
        intentId,
        description: 'should not write',
        worker: 'child-a',
        now: at(6),
      }),
      { message: /board is stopped; write ops require active/ },
    )

    const { board: hinted, result: hintResult } = apply(stopped, {
      type: 'hint',
      content: 'note for later',
      now: at(7),
    })
    assert.equal(hinted.status, 'stopped')
    assert.equal(hinted.hints.at(-1).content, 'note for later')
    assert.deepEqual(hintResult.task, { task: 'idle' })
  })

  it('reopen from completed/stopped returns active; optional correction fact', () => {
    const completed = bootstrapOnce(initBoard().board, {
      complete: 'suite already green',
    }).board
    assert.equal(completed.status, 'completed')

    const { board: reopened, result } = apply(completed, { type: 'reopen', now: at(8) })
    assert.equal(reopened.status, 'active')
    assert.equal(result.status, 'active')
    assert.equal(reopened.facts.length, completed.facts.length)
    assert.equal(reopened.intents.some((intent) => intent.to === 'goal'), false)
    assert.deepEqual(reopened.checkpoint, {
      fact_count: completed.facts.length,
      hint_count: completed.hints.length,
      had_open_intents: false,
    })
    assert.deepEqual(result.task, { task: 'idle' })

    const { board: correctedComplete, result: fromCompleted } = apply(completed, {
      type: 'reopen',
      description: 'the green run was a false pass',
      now: at(8),
    })
    assert.equal(correctedComplete.status, 'active')
    assert.equal(correctedComplete.intents.some((intent) => intent.to === 'goal'), false)
    assert.equal(correctedComplete.facts.at(-1).description, 'the green run was a false pass')
    assert.deepEqual(fromCompleted.task, { task: 'reason', trigger: 'new-fact' })

    const stopped = apply(proposeExplores(
      bootstrapOnce(initBoard().board).board,
      [{ from: ['f001'], description: 'run the failing suite' }],
    ).board, { type: 'stop' }).board

    const { board: corrected, result: correctedResult } = apply(stopped, {
      type: 'reopen',
      description: 'previous stop was premature',
      now: at(9),
    })
    assert.equal(corrected.status, 'active')
    assert.equal(corrected.facts.at(-1).description, 'previous stop was premature')
    assert.deepEqual(correctedResult.task, { task: 'reason', trigger: 'new-fact' })
  })

  it('stop then hint then reopen rewrites checkpoint and does not reason', () => {
    const { board: seeded } = bootstrapOnce(initBoard().board)
    const { board: stopped } = apply(seeded, { type: 'stop' })
    const { board: hinted } = apply(stopped, {
      type: 'hint',
      content: 'look at the fixture',
      now: at(3),
    })
    const { board, result } = apply(hinted, { type: 'reopen', now: at(4) })

    assert.equal(board.status, 'active')
    assert.equal(board.hints.at(-1).content, 'look at the fixture')
    assert.deepEqual(board.checkpoint, {
      fact_count: hinted.facts.length,
      hint_count: hinted.hints.length,
      had_open_intents: false,
    })
    assert.deepEqual(result.task, { task: 'idle' })
    assert.deepEqual(nextTask(board), { task: 'idle' })
  })

  it('stop then hint then reopen with open intents resumes explore, not reason', () => {
    const { board: opens } = proposeExplores(
      bootstrapOnce(initBoard().board).board,
      [{ from: ['f001'], description: 'run the failing suite' }],
    )
    const { board: stopped } = apply(opens, { type: 'stop' })
    const { board: hinted } = apply(stopped, {
      type: 'hint',
      content: 'try a different fixture',
      now: at(3),
    })
    const { board, result } = apply(hinted, { type: 'reopen', now: at(4) })

    assert.equal(board.status, 'active')
    assert.ok(newestUnclaimedExplore(board))
    assert.equal(result.task.task, 'explore')
    assert.deepEqual(nextTask(board).task, 'explore')
    assert.notEqual(result.task.task, 'reason')
  })

  it('bootstrap then stop then reopen is idle after checkpoint rewrite', () => {
    const { board: seeded } = bootstrapOnce(initBoard().board)
    assert.equal(seeded.intents.every((intent) => !isOpen(intent)), true)
    const { board: stopped } = apply(seeded, { type: 'stop' })
    const { board, result } = apply(stopped, { type: 'reopen', now: at(3) })

    assert.equal(board.status, 'active')
    assert.deepEqual(board.checkpoint, {
      fact_count: seeded.facts.length,
      hint_count: seeded.hints.length,
      had_open_intents: false,
    })
    assert.equal(board.intents.every((intent) => !isOpen(intent)), true)
    assert.deepEqual(result.task, { task: 'idle' })
    assert.deepEqual(nextTask(board), { task: 'idle' })
  })

  it('completed reopen with description schedules reason new-fact', () => {
    const completed = bootstrapOnce(initBoard().board, {
      complete: 'suite already green',
    }).board
    const { board, result } = apply(completed, {
      type: 'reopen',
      description: 'the green run was a false pass',
      now: at(8),
    })

    assert.equal(board.status, 'active')
    assert.deepEqual(board.checkpoint, {
      fact_count: completed.facts.length,
      hint_count: completed.hints.length,
      had_open_intents: false,
    })
    assert.equal(board.facts.at(-1).description, 'the green run was a false pass')
    assert.equal(board.intents.some((intent) => intent.to === 'goal'), false)
    const feedback = board.intents.find((intent) => intent.description === 'external_feedback')
    assert.ok(feedback)
    assert.equal(feedback.to, board.facts.at(-1).id)
    assert.deepEqual(result.task, { task: 'reason', trigger: 'new-fact' })
    assert.deepEqual(nextTask(board), { task: 'reason', trigger: 'new-fact' })
  })
})

describe('goal cannot appear in Intent.from', () => {
  it('is rejected on reason complete as well as explore drafts', () => {
    const { board: seeded } = bootstrapOnce(initBoard().board)
    assert.throws(
      () => apply(seeded, {
        type: 'reason',
        worker: 'parent',
        now: at(2),
        complete: { from: ['goal'], description: 'done' },
      }),
      { message: 'goal cannot appear in Intent.from' },
    )
  })
})

describe('serialize/parse', () => {
  it('roundtrips a board with facts, intents, and hints', () => {
    const { board } = proposeExplores(
      bootstrapOnce(initBoard({ hints: ['start here'] }).board).board,
      [{ from: ['origin', 'f001'], description: 'run the failing suite' }],
    )
    const text = serializeBoard(board)
    assert.equal(text.endsWith('\n'), true)
    assert.deepEqual(parseBoard(text), board)
  })
})
