import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addHint, claimIntent, closeIntent, concludeIntent, emptyBoard, ensureBootstrapIntent, finishReason, loadBoard, nextTask, reserveDispatch, saveBoard, startReason, stopBoard, withBoardLock } from '../src/board.ts'
import { parseBoard, layoutBoard } from '../src/view.ts'
import { installRuntime } from '../src/runtime.ts'
import { auditBoard } from '../src/audit.ts'

function observed() {
  let b = ensureBootstrapIntent(emptyBoard('t', 'o', 'g'))
  b = claimIntent(b, 'i001', 'p')
  return concludeIntent(b, 'i001', 'observed baseline', 'p').board
}
function work() {
  return finishReason(startReason(observed(), 'p').board, 'p', { intents: [{ from: ['f001'], target: 'parser', description: 'check parser' }] })
}

test('reject origin-only proof and completion with unfinished work', () => {
  const initial = startReason(emptyBoard('t', 'o', 'g'), 'p').board
  assert.throws(() => finishReason(initial, 'p', { complete: { from: ['origin'], description: 'assertion' } }), /observed facts/)
  const b = startReason(addHint(work(), 'review', 'user').board, 'p').board
  assert.throws(() => finishReason(b, 'p', { complete: { from: ['f001'], description: 'assertion' } }), /open intents/)
})

test('duplicate dependencies and overlapping targets are rejected atomically', () => {
  const b = startReason(observed(), 'p').board
  assert.throws(() => finishReason(b, 'p', { intents: [{ from: ['f001', 'f001'], description: 'x' }] }), /duplicate from/)
  assert.throws(() => finishReason(b, 'p', { intents: [
    { from: ['origin'], target: 'same', description: 'first' },
    { from: ['f001'], target: 'same', description: 'second' },
  ] }), /overlapping/)
  assert.equal(b.intents.length, 1)
})

test('closing abandoned work removes it from scheduling and enables reasoning', () => {
  const b = closeIntent(work(), 'i002', 'replaced by narrower investigation')
  assert.equal(nextTask(b).kind, 'reason')
  assert.throws(() => claimIntent(b, 'i002', 'p'), /closed/)
  assert.equal(layoutBoard(b).openCount, 0)
  const parsed = parseBoard(JSON.stringify(b))!
  assert.equal(parsed.intents[1].closed?.reason, 'replaced by narrower investigation')
  assert.equal(layoutBoard(parsed).edges[1].status, 'closed')
})

test('supersession preserves history but prevents stale proof and stale exploration', () => {
  let b = claimIntent(work(), 'i002', 'p')
  b = concludeIntent(b, 'i002', 'updated finding', 'p', ['f001']).board
  const parsed = parseBoard(JSON.stringify(b))!
  assert.deepEqual(parsed.facts[3].supersedes, ['f001'])
  assert.deepEqual(layoutBoard(parsed).nodes.find(n => n.id === 'f001')?.supersededBy, ['f002'])
  b = startReason(b, 'p').board
  assert.throws(() => finishReason(b, 'p', { complete: { from: ['f001'], description: 'old' } }), /superseded/)
  assert.throws(() => finishReason(b, 'p', { intents: [{ from: ['f001'], description: 'old' }] }), /superseded/)
  assert.equal(finishReason(b, 'p', { complete: { from: ['f002'], description: 'new' } }).status, 'completed')
})

test('dispatch requires claim, unique reservation and processed returns', () => {
  assert.throws(() => reserveDispatch(work(), 'i002', 'call'), /claim/)
  let b = claimIntent(work(), 'i002', 'p')
  b = reserveDispatch(b, 'i002', 'call')
  assert.throws(() => reserveDispatch(b, 'i002', 'call2'), /dispatched/)
  assert.throws(() => reserveDispatch(stopBoard(b), 'i002', 'call2'), /active/)
})

test('concurrent board writes retain both hints', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cairn-lock-'))
  try {
    await saveBoard(cwd, 'p', observed())
    await Promise.all(['one', 'two'].map(content => withBoardLock(cwd, 'p', async () => {
      const b = (await loadBoard(cwd, 'p'))!
      await saveBoard(cwd, 'p', addHint(b, content, 'user').board)
    })))
    // Concurrent callers have no promised arrival order; both writes must survive.
    assert.deepEqual((await loadBoard(cwd, 'p'))!.hints.map(h => h.content).sort(), ['one', 'two'])
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('runtime gates spawn, binds child, captures inbox once and recovers failed spawn', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cairn-runtime-'))
  const listeners = new Map<string, Function>()
  installRuntime({ on: (name: string, fn: Function) => listeners.set(name, fn) } as any, () => ({ cwd, ownerId: 'p' }))
  const agent = { session: { id: 'p', header: { cwd } } }
  const exec = { name: 'subagent', callId: 'call1', agent, arguments: { prompt: 'blackboard_intent: i002\nCheck parser' } }
  const spawn = listeners.get('tools/execute')!
  let calls = 0
  const succeed = async () => { calls++; return { isError: false, value: { kind: 'continuable', subagentId: 'child1' }, content: [] } }
  try {
    await saveBoard(cwd, 'p', work())
    await assert.rejects(() => spawn(exec, succeed), /claim/)
    assert.equal(calls, 0)
    await saveBoard(cwd, 'p', claimIntent(work(), 'i002', 'p'))
    await spawn(exec, succeed)
    assert.equal((await loadBoard(cwd, 'p'))!.intents[1].subagentId, 'child1')
    await assert.rejects(() => spawn(exec, succeed), /dispatched/)
    const messages = [
      { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'check missing results' }] },
      { id: 'm2', source: { kind: 'subagent-settled', senderSessionId: 'child1' }, content: [{ type: 'text', text: 'worker returned' }] },
    ]
    const step = listeners.get('agent/pre-step')!
    await step({ agent, messages }, async () => ({ kind: 'enter', messages }))
    await step({ agent, messages }, async () => ({ kind: 'enter', messages }))
    const b = (await loadBoard(cwd, 'p'))!
    assert.equal(b.hints.length, 1)
    assert.equal(b.workerReturns?.length, 1)
    assert.equal(b.intents[1].pendingReturn, true)
    assert.ok(auditBoard(b).some(w => w.includes('needs review')))
    await saveBoard(cwd, 'p', claimIntent(work(), 'i002', 'p'))
    await spawn(exec, async () => ({ isError: true, error: { message: 'failed' }, content: [] }))
    assert.equal((await loadBoard(cwd, 'p'))!.intents[1].worker, null)
    assert.equal((await loadBoard(cwd, 'p'))!.intents[1].dispatchId, undefined)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('stop during spawn cancels the late child instead of orphaning it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cairn-race-'))
  const listeners = new Map<string, Function>()
  const interrupted: string[] = []
  installRuntime({
    on: (name: string, fn: Function) => listeners.set(name, fn),
    get: () => ({ interrupt: (id: string) => interrupted.push(id) }),
  } as any, () => ({ cwd, ownerId: 'p' }))
  try {
    await saveBoard(cwd, 'p', claimIntent(work(), 'i002', 'p'))
    const exec = { name: 'subagent', callId: 'call1', agent: { session: { id: 'p', header: { cwd } } }, arguments: { prompt: 'blackboard_intent: i002\nCheck parser' } }
    await listeners.get('tools/execute')!(exec, async () => {
      await withBoardLock(cwd, 'p', async () => saveBoard(cwd, 'p', stopBoard((await loadBoard(cwd, 'p'))!)))
      return { isError: false, value: { kind: 'continuable', subagentId: 'late-child' }, content: [] }
    })
    assert.deepEqual(interrupted, ['late-child'])
    assert.equal((await loadBoard(cwd, 'p'))!.status, 'stopped')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('goal completion requires proof; successful goal pause freezes the board', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cairn-goal-'))
  const listeners = new Map<string, Function>()
  installRuntime({ on: (name: string, fn: Function) => listeners.set(name, fn) } as any, () => ({ cwd, ownerId: 'p' }))
  try {
    await saveBoard(cwd, 'p', observed())
    const exec = { name: 'update_goal', agent: { session: { id: 'p', header: { cwd } } }, arguments: { action: 'complete' } }
    let called = false
    const next = async () => { called = true; return { isError: false, value: {}, content: [] } }
    await assert.rejects(() => listeners.get('tools/execute')!(exec, next), /prove blackboard/)
    assert.equal(called, false)
    await listeners.get('tools/execute')!({ ...exec, arguments: { action: 'pause' } }, next)
    assert.equal((await loadBoard(cwd, 'p'))!.status, 'stopped')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('closed bootstrap is not offered again', () => {
  const b = closeIntent(ensureBootstrapIntent(emptyBoard('t', 'o', 'g')), 'i001', 'bootstrap abandoned')
  assert.equal(nextTask(b).kind, 'reason')
})

test('tool API protects existing boards, returns next and forbids child writes', async () => {
  const { apply } = await import('../src/index.ts')
  const cwd = await mkdtemp(join(tmpdir(), 'cairn-api-'))
  let definition: any
  const interrupted: string[] = []
  const ctx = {
    fiber: {}, on: () => undefined, effect: (fn: Function) => fn(),
    tools: { register: (tool: unknown) => { definition = tool; return () => undefined } },
    get: (name: string) => name === 'subagents' ? { interrupt: (id: string) => interrupted.push(id) } : undefined,
  }
  apply(ctx as any)
  const exec = { agent: { session: { id: 'p', header: { cwd } } } }
  try {
    const first = await definition.execute({ op: 'init', title: 't', origin: 'o', goal: 'g' }, exec)
    assert.equal(first.next.kind, 'reason')
    await assert.rejects(() => definition.execute({ op: 'init', title: 'overwrite', origin: 'o', goal: 'g' }, exec), /already exists/)
    const child = { agent: { session: { id: 'child', header: { cwd, origin: 'subagent', parentSession: 'p' } } } }
    await assert.rejects(() => definition.execute({ op: 'hint', content: 'child write' }, child), /only the parent/)
    let b = reserveDispatch(claimIntent(work(), 'i002', 'p'), 'i002', 'spawn')
    b = { ...b, intents: b.intents.map(i => i.id === 'i002' ? { ...i, subagentId: 'child' } : i) }
    await saveBoard(cwd, 'p', b)
    const stopped = await definition.execute({ op: 'stop' }, exec)
    assert.equal(stopped.board.status, 'stopped')
    assert.equal(stopped.next.kind, 'idle')
    assert.deepEqual(interrupted, ['child'])
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
