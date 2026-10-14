import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addHint, bindDispatch, claimIntent, closeIntent, concludeIntent, emptyBoard, ensureBootstrapIntent, finishReason, loadBoard, nextTask, recordWorkerReturn, releaseIntent, reopenBoard, reserveDispatch, saveBoard, startReason, stopBoard } from '../src/board.ts'
import { installRuntime, reconcileWorkers } from '../src/runtime.ts'
import { layoutBoard, parseBoard } from '../src/view.ts'

function observed() {
  const board = claimIntent(ensureBootstrapIntent(emptyBoard('t', 'o', 'g')), 'i001', 'p')
  return concludeIntent(board, 'i001', 'baseline', 'p').board
}
function dispatched() {
  const board = finishReason(startReason(observed(), 'p').board, 'p', { intents: [{ from: ['f001'], description: 'check', target: 'check' }] })
  return bindDispatch(reserveDispatch(claimIntent(board, 'i002', 'p'), 'i002', 'call'), 'i002', 'call', 'child')
}
const returned = (board = dispatched()) => recordWorkerReturn(board, { kind: 'return', content: 'Background subagent child finished\nresult', messageId: 'message', subagentId: 'child' })

test('returns are separate, idempotent, review-first and resolved atomically', () => {
  const b = returned()
  assert.equal(b.hints.length, 0)
  assert.equal(b.workerReturns?.length, 1)
  assert.equal(returned(b), b)
  assert.equal(nextTask(addHint(b, 'user update', 'user').board).kind, 'review')
  assert.throws(() => reserveDispatch(b, 'i001', 'other'))
  const concluded = concludeIntent(b, 'i002', 'verified finding', 'p').board
  assert.equal(concluded.workerReturns?.[0].resolution?.action, 'conclude')
  assert.equal(concluded.intents[1].pendingReturn, false)
  assert.deepEqual(nextTask(concluded).kind, 'reason')
  const released = releaseIntent(b, 'i002')
  assert.equal(released.workerReturns?.[0].resolution?.action, 'release')
  assert.equal(nextTask(released).kind, 'explore')
  const closed = closeIntent(b, 'i002', 'no further work')
  assert.equal(closed.workerReturns?.[0].resolution?.action, 'close')
  assert.equal(closed.hints.length, 0)
  assert.equal(nextTask(closed).kind, 'reason')
})

test('old hints and files are preserved; replayed legacy notifications are not copied', () => {
  const b = dispatched()
  b.hints.push({ id: 'h001', content: 'old notification', creator: 'dispatcher.worker-return', createdAt: 'old', messageId: 'message' })
  assert.equal(returned(b), b)
  const parsed = parseBoard(JSON.stringify(b))!
  assert.deepEqual(parsed.hints, b.hints)
  assert.deepEqual(parsed.workerReturns, [])
  assert.equal(parseBoard(JSON.stringify({ ...b, workerReturns: [{ kind: 'return' }] })), null)
})

test('unlinked, closed, stopped and old-dispatch late returns only archive', () => {
  for (const board of [releaseIntent(dispatched(), 'i002'), closeIntent(dispatched(), 'i002', 'done'), stopBoard(dispatched())]) {
    const b = returned(board)
    assert.equal(b.workerReturns?.[0].resolution?.action, 'archived')
    assert.ok(!b.intents[1].pendingReturn)
    assert.equal(b.facts.length, board.facts.length)
  }
  let b = releaseIntent(dispatched(), 'i002')
  b = bindDispatch(reserveDispatch(claimIntent(b, 'i002', 'p'), 'i002', 'new-call'), 'i002', 'new-call', 'new-child')
  b = returned(b)
  assert.equal(b.workerReturns?.[0].intentId, undefined)
  assert.ok(!b.intents[1].pendingReturn)
})

test('completion feedback preserves history, requires feedback, and permits re-completion', () => {
  const completed = finishReason(startReason(observed(), 'p').board, 'p', { complete: { from: ['f001'], description: 'proved' } })
  assert.throws(() => reopenBoard(completed), /feedback/)
  assert.throws(() => reopenBoard({ ...completed, intents: [] }, 'correction'), /completion/)
  const late = returned(completed)
  assert.equal(late.workerReturns?.[0].resolution?.action, 'archived')
  const b = reopenBoard(completed, 'Acceptance check failed')
  assert.equal(b.status, 'active')
  assert.equal(b.hints[0].content, 'Acceptance check failed')
  assert.deepEqual(b.facts, completed.facts)
  assert.equal(nextTask(b).kind, 'reason')
  assert.equal(reopenBoard(b, 'repeat'), b)
  const parsed = parseBoard(JSON.stringify(b))!
  assert.equal(layoutBoard(parsed).edges.at(-1)?.status, 'invalidated')
  assert.equal(parsed.intents.at(-1)?.invalidated?.hintId, b.hints[0].id)
  const again = finishReason(startReason(b, 'p').board, 'p', { complete: { from: ['f001'], description: 'reverified' } })
  assert.equal(again.status, 'completed')
  assert.equal(again.intents.filter(i => i.to === 'goal' && !i.invalidated).length, 1)
  assert.equal(again.intents.filter(i => i.to === 'goal').length, 2)
})

async function workspace(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'cairn-returns-'))
  try { await run(cwd) } finally { await rm(cwd, { recursive: true, force: true }) }
}

test('status reconciliation deduplicates observations and clears only recovered anomalies', async () => workspace(async cwd => {
  const target = { cwd, ownerId: 'p' }
  let rows: any[] = [{ kind: 'child', id: 'child', activity: 'inactive' }]
  const ctx = { get: () => ({ listChildren: async () => rows }) } as any
  await saveBoard(cwd, 'p', dispatched())
  await reconcileWorkers(ctx, target)
  let b = (await loadBoard(cwd, 'p'))!
  assert.equal(nextTask(b).kind, 'review')
  assert.equal(b.intents[1].worker, 'p')
  await reconcileWorkers(ctx, target)
  assert.equal((await loadBoard(cwd, 'p'))!.workerReturns?.length, 1)
  rows = [{ kind: 'child', id: 'child', activity: 'running' }]
  await reconcileWorkers(ctx, target)
  b = (await loadBoard(cwd, 'p'))!
  assert.equal(b.intents[1].pendingReturn, false)
  assert.equal(b.workerReturns?.[0].resolution?.action, 'recovered')
  await saveBoard(cwd, 'p', returned(b))
  await reconcileWorkers(ctx, target)
  assert.equal((await loadBoard(cwd, 'p'))!.intents[1].pendingReturn, true)
  for (const entries of [[], [{ kind: 'diagnostic', id: 'child', reason: 'corrupt' }]]) {
    rows = entries
    await saveBoard(cwd, 'p', dispatched())
    await reconcileWorkers(ctx, target)
    assert.equal(nextTask((await loadBoard(cwd, 'p'))!).kind, 'review')
  }
  const { subagentId, ...unbound } = dispatched().intents[1]
  await saveBoard(cwd, 'p', { ...dispatched(), intents: [dispatched().intents[0], unbound] })
  await reconcileWorkers(ctx, target)
  assert.match((await loadBoard(cwd, 'p'))!.workerReturns![0].content, /no bound child/)
}))

test('query failures retain claims, return diagnostics and recover on subsequent reads', async () => workspace(async cwd => {
  const target = { cwd, ownerId: 'p' }
  await saveBoard(cwd, 'p', dispatched())
  const warnings = await reconcileWorkers({ get: () => { throw new Error('offline') } } as any, target)
  assert.match(warnings[0], /offline/)
  let b = (await loadBoard(cwd, 'p'))!
  assert.equal(b.intents[1].worker, 'p')
  assert.ok(!b.intents[1].pendingReturn)
  await reconcileWorkers({ get: () => ({ listChildren: async () => [{ kind: 'child', id: 'child', activity: 'running' }] }) } as any, target)
  b = (await loadBoard(cwd, 'p'))!
  assert.equal(b.workerStatusWarning, undefined)
}))

test('status lookup cannot overwrite a concurrent release and replacement dispatch', async () => workspace(async cwd => {
  await saveBoard(cwd, 'p', dispatched())
  const ctx = { get: () => ({ listChildren: async () => {
    let b = releaseIntent((await loadBoard(cwd, 'p'))!, 'i002')
    b = bindDispatch(reserveDispatch(claimIntent(b, 'i002', 'p'), 'i002', 'replacement'), 'i002', 'replacement', 'new-child')
    await saveBoard(cwd, 'p', b)
    return []
  } }) } as any
  await reconcileWorkers(ctx, { cwd, ownerId: 'p' })
  const b = (await loadBoard(cwd, 'p'))!
  assert.equal(b.intents[1].dispatchId, 'replacement')
  assert.ok(!b.intents[1].pendingReturn)
  assert.equal(b.workerReturns?.length, 0)
}))

test('foreground returns use review records, including returns after stop', async () => workspace(async cwd => {
  const listeners = new Map<string, Function>()
  const target = { cwd, ownerId: 'p' }
  installRuntime({ on: (name: string, fn: Function) => listeners.set(name, fn) } as any, () => target)
  const initial = releaseIntent(dispatched(), 'i002')
  const exec = { name: 'subagent', callId: 'fg', agent: { session: { id: 'p', header: { cwd } } }, arguments: { prompt: 'blackboard_intent: i002\nCheck' } }
  for (const stop of [false, true]) {
    await saveBoard(cwd, 'p', claimIntent(initial, 'i002', 'p'))
    await listeners.get('tools/execute')!(exec, async () => {
      // A concurrent lookup must not report the live foreground spawn as stranded.
      await reconcileWorkers({ get: () => ({ listChildren: async () => [] }) } as any, target)
      assert.equal((await loadBoard(cwd, 'p'))!.workerReturns?.length, 0)
      if (stop) await saveBoard(cwd, 'p', stopBoard((await loadBoard(cwd, 'p'))!))
      return { isError: false, value: { kind: 'foreground', runId: 'run', output: [{ type: 'text', text: 'result' }] } }
    })
    const b = (await loadBoard(cwd, 'p'))!
    assert.equal(b.hints.length, 0)
    assert.equal(b.workerReturns?.length, 1)
    assert.equal(nextTask(b).kind, stop ? 'idle' : 'review')
    assert.match(b.workerReturns![0].content, /result/)
  }
}))

test('public snapshot/next reconcile status; reopen accepts feedback through the tool API', async () => workspace(async cwd => {
  const { apply } = await import('../src/index.ts')
  let definition: any
  let reads = 0
  const ctx = {
    fiber: {}, on: () => undefined, effect: (fn: Function) => fn(),
    tools: { register: (tool: unknown) => { definition = tool; return () => undefined } },
    get: (name: string) => name === 'subagents' ? { listChildren: async () => { reads++; return [{ kind: 'child', id: 'child', activity: 'inactive' }] } } : undefined,
  }
  apply(ctx as any)
  const exec = { agent: { session: { id: 'p', header: { cwd } } } }
  await saveBoard(cwd, 'p', dispatched())
  for (const op of ['snapshot', 'next']) {
    const result = await definition.execute({ op }, exec)
    assert.equal(result.next.kind, 'review')
    assert.equal(result.next.records.length, 1)
  }
  assert.equal(reads, 2)
  const completed = finishReason(startReason(observed(), 'p').board, 'p', { complete: { from: ['f001'], description: 'proof' } })
  await saveBoard(cwd, 'p', completed)
  await assert.rejects(() => definition.execute({ op: 'reopen' }, exec), /feedback/)
  const result = await definition.execute({ op: 'reopen', description: 'verify again' }, exec)
  assert.equal(result.next.kind, 'reason')
  assert.equal(result.board.intents.at(-1).invalidated.hintId, result.board.hints[0].id)
}))
