import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyBoard, ensureBootstrapIntent, claimIntent, concludeIntent, startReason, finishReason as domainFinishReason, nextTask, reserveDispatch } from '../src/board.ts'
import { invalidFactIds } from '../src/evidence.ts'
import { auditBoard, completionEvidenceIssues } from '../src/audit.ts'

function finishReason(board: Parameters<typeof domainFinishReason>[0], worker: string, result: Parameters<typeof domainFinishReason>[2]) {
  return domainFinishReason(board, worker, result, board.reason?.id)
}

function observed() {
  const board = claimIntent(ensureBootstrapIntent(emptyBoard('t', 'o', 'g')), 'i001', 'parent')
  return concludeIntent(board, 'i001', 'baseline', 'parent').board
}

test('a persisted unfinished reason is returned again, including initial reasoning', () => {
  for (const initial of [emptyBoard('t', 'o', 'g'), observed()]) {
    const held = startReason(initial, 'parent').board
    const restored = JSON.parse(JSON.stringify(held))
    assert.equal(nextTask(restored).kind, 'reason')
    assert.deepEqual(startReason(restored, 'parent').board.checkpoint, held.checkpoint)
  }
})

test('claim before dispatch remains resumable without duplicating a dispatch', () => {
  let board = finishReason(startReason(observed(), 'parent').board, 'parent', {
    intents: [{ from: ['f001'], description: 'explore' }],
  })
  board = claimIntent(board, 'i002', 'parent')
  assert.equal(nextTask(JSON.parse(JSON.stringify(board))).kind, 'explore')
  board = reserveDispatch(board, 'i002', 'call')
  assert.equal(nextTask(board).kind, 'idle')
  assert.throws(() => reserveDispatch(board, 'i002', 'again'), /already dispatched/)
})

test('supersession invalidates descendants and blocks stale in-flight conclusions', () => {
  let board = finishReason(startReason(observed(), 'parent').board, 'parent', {
    intents: [{ from: ['f001'], description: 'derive' }, { from: ['f001'], description: 'refresh' }, { from: ['f001'], description: 'late' }],
  })
  for (const id of ['i002', 'i003', 'i004']) board = claimIntent(board, id, 'parent')
  board = concludeIntent(board, 'i002', 'derived', 'parent').board
  board = concludeIntent(board, 'i003', 'new observation', 'parent', ['f001']).board
  assert.deepEqual([...invalidFactIds(board)].sort(), ['f001', 'f002'])
  assert.throws(() => concludeIntent(board, 'i004', 'stale result', 'parent'), /premises/)
  board = startReason(board, 'parent').board
  assert.throws(() => finishReason(board, 'parent', { intents: [{ from: ['f002'], description: 'use stale descendant' }] }), /superseded/)
})

test('an explicit replacement stays usable while unrelated stale premises do not', () => {
  let board = finishReason(startReason(observed(), 'parent').board, 'parent', {
    intents: [{ from: ['f001'], description: 'recheck' }],
  })
  board = concludeIntent(claimIntent(board, 'i002', 'parent'), 'i002', 'corrected evidence', 'parent', ['f001']).board
  assert.equal(invalidFactIds(board).has('f002'), false)
  assert.equal(finishReason(startReason(board, 'parent').board, 'parent', {
    complete: { from: ['f002'], description: 'supported by new evidence' },
  }).status, 'completed')
})

import { searchPolicy, upgradeBoard } from '../src/protocol.ts'
import { recordWorkerReturn, releaseIntent, addHint } from '../src/board.ts'
import { modelBoard, lookupBoard, budgetResult } from '../src/model-view.ts'
import { layoutBoard } from '../src/view.ts'

function delegated() {
  return finishReason(startReason(upgradeBoard(emptyBoard('t', 'o', 'g'), searchPolicy()), 'parent').board, 'parent', {
    intents: [{ from: ['origin'], target: 'inspect', description: 'inspect environment', skills: ['execution-skill'] }],
  })
}

test('v2 initializes without parent execution and requires an actual worker return', () => {
  let board = delegated()
  assert.equal(board.intents.length, 1)
  board = claimIntent(board, 'i001', 'parent')
  assert.throws(() => concludeIntent(board, 'i001', 'self executed', 'parent'), /worker return/)
  board = reserveDispatch(board, 'i001', 'call')
  board = recordWorkerReturn(board, { kind: 'observation', content: 'inactive', intentId: 'i001', dispatchId: 'call' })
  assert.throws(() => concludeIntent(board, 'i001', 'status is not evidence', 'parent'), /worker return/)
  board = recordWorkerReturn(board, { kind: 'return', content: 'observed result', intentId: 'i001', dispatchId: 'call' })
  board = concludeIntent(board, 'i001', 'reviewed evidence', 'parent').board
  assert.equal(finishReason(startReason(board, 'parent').board, 'parent', { complete: { from: ['f001'], description: 'verified', proofs: [{ criterionId: 'c001', from: ['f001'], description: 'verified evidence' }] } }).status, 'completed')
})

test('migration closes only unfinished legacy bootstrap without inventing evidence', () => {
  const legacy = ensureBootstrapIntent(emptyBoard('t', 'o', 'g'))
  const migrated = upgradeBoard(legacy, searchPolicy())
  assert.equal(migrated.intents[0].closed !== undefined, true)
  assert.deepEqual(migrated.facts, legacy.facts)
  assert.equal(nextTask(migrated).kind, 'reason')
  assert.equal(upgradeBoard(migrated, searchPolicy()), migrated)
})

test('retry budget closes repeated failures and historical dedup needs new feedback', () => {
  let board = delegated()
  for (let n = 0; n < 3; n++) board = releaseIntent(claimIntent(board, 'i001', 'parent'), 'i001')
  assert.ok(board.intents[0].closed)
  assert.equal(nextTask(board).kind, 'reason')
  board = startReason(board, 'parent').board
  const draft = { intents: [{ from: ['origin'], target: 'inspect', description: 'inspect environment' }] }
  assert.throws(() => finishReason(board, 'parent', draft), /already attempted/)
  board = addHint(board, 'Environment fixed, retry explicitly', 'user').board
  assert.throws(() => finishReason(board, 'parent', draft), /already attempted/)
  board.hints = board.hints.map(h => ({ ...h, messageId: 'actual-user-feedback' }))
  assert.equal(finishReason(board, 'parent', draft).intents.length, 2)
})

test('self-authored hints cannot reset the total exploration budget', () => {
  let board = delegated()
  board.policy = searchPolicy({ maxExplorations: 1 })
  for (let n = 0; n < 3; n++) board = releaseIntent(claimIntent(board, 'i001', 'parent'), 'i001')
  board = addHint(board, 'try a completely different direction', 'user').board
  board = startReason(board, 'parent').board
  assert.throws(() => finishReason(board, 'parent', {
    intents: [{ from: ['origin'], target: 'different', description: 'new wording' }],
  }), /exploration budget exhausted/)
})

test('large escaped reasoning metadata stays bounded and remains fully recoverable', () => {
  const worker = '\\"\n'.repeat(5000)
  const board = startReason(upgradeBoard(emptyBoard('t', 'o', 'g'), searchPolicy()), worker).board
  const snapshot = budgetResult({ ok: true, op: 'snapshot', board: modelBoard(board) })
  assert.ok(JSON.stringify(snapshot, null, 2).length <= 7500)
  let offset = 0
  let text = ''
  for (;;) {
    const result = budgetResult({ ok: true, op: 'lookup', page: lookupBoard(board, 'state', 0, 1, 'state', offset) })
    assert.ok(JSON.stringify(result, null, 2).length <= 7500)
    text += result.page.text
    if (result.page.nextContentOffset === null) break
    assert.ok(result.page.nextContentOffset > offset)
    offset = result.page.nextContentOffset
  }
  assert.equal(JSON.parse(text).reason.worker, worker)
})

test('concurrency is enforced at dispatch admission, not just next-task selection', () => {
  let board = delegated()
  board.policy = searchPolicy({ maxConcurrent: 1 })
  board = addHint(board, 'another independent check', 'user').board
  board = finishReason(startReason(board, 'parent').board, 'parent', { intents: [{ from: ['origin'], target: 'other', description: 'other work' }] })
  board = reserveDispatch(claimIntent(board, 'i001', 'parent'), 'i001', 'a')
  board = claimIntent(board, 'i002', 'parent')
  assert.throws(() => reserveDispatch(board, 'i002', 'b'), /budget/)
})

test('model snapshot size does not grow with completed history and lookup retains it', () => {
  const board = emptyBoard('t', 'o', 'g')
  for (let n = 0; n < 10000; n++) board.facts.push({ id: `f${n}`, description: 'e'.repeat(1000) })
  assert.ok(JSON.stringify(modelBoard(board)).length < 12000)
  assert.equal(lookupBoard(board, 'facts', 0, 5, 'f5000').id, 'f5000')
  assert.throws(() => lookupBoard(board, 'facts', -1), /pagination/)
})

test('long completed chains lay out without recursive stack exhaustion', () => {
  const board = emptyBoard('t', 'o', 'g')
  for (let n = 1; n <= 10000; n++) {
    board.facts.push({ id: `f${n}`, description: 'observed' })
    board.intents.push({ id: `i${n}`, from: [n === 1 ? 'origin' : `f${n-1}`], to: `f${n}`, description: 'step', creator: 'p', worker: 'p', createdAt: '', concludedAt: '' })
  }
  board.intents.push({ id: 'completion', from: ['f10000'], to: 'goal', description: 'done', creator: 'p', worker: 'p', createdAt: '', concludedAt: '' })
  assert.equal(layoutBoard(board).nodes.length, 10002)
})

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveBoard, loadBoard, readReturnContent, copyBoardIfAbsent } from '../src/board.ts'

test('large worker returns are immutable external content and survive a board fork', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cairn-content-'))
  try {
    const board = emptyBoard('t', 'o', 'g')
    const content = '证据'.repeat(100000)
    board.workerReturns = [{ id: 'r001', kind: 'return', content, createdAt: '' }]
    await saveBoard(cwd, 'p', board)
    const disk = await readFile(join(cwd, '.dsh/blackboards/p.json'), 'utf8')
    assert.ok(disk.length < 3000)
    const saved = (await loadBoard(cwd, 'p'))!
    assert.equal(await readReturnContent(cwd, saved.workerReturns![0]), content)
    await copyBoardIfAbsent(cwd, 'p', 'fork')
    assert.equal(await readReturnContent(cwd, (await loadBoard(cwd, 'fork'))!.workerReturns![0]), content)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

import { installRuntime } from '../src/runtime.ts'

test('Cairn role enforcement denies parent execution but keeps explorer execution', async () => {
  const listeners = new Map<string, Function>()
  installRuntime({ on: (name: string, fn: Function) => listeners.set(name, fn) } as any, () => ({ cwd: '/unused', ownerId: 'p' }))
  const execute = listeners.get('tools/execute')!
  const parent = { session: { header: {} } }
  const child = { session: { header: { origin: 'subagent' } } }
  const next = async () => ({ value: 'executed' })
  await assert.rejects(() => execute({ name: 'bash', arguments: {}, agent: parent }, next), /delegate execution/)
  await assert.rejects(() => execute({ name: 'read', arguments: { path: 'source.ts' }, agent: parent }, next), /Bootstrap only/)
  assert.equal((await execute({ name: 'bash', arguments: {}, agent: child }, next)).value, 'executed')
  for (const agent of [parent, child]) for (const name of ['workflow', 'ralph']) {
    await assert.rejects(() => execute({ name, arguments: {}, agent }, next), /claimed blackboard/)
  }
  await assert.rejects(() => execute({ name: 'skill', arguments: { name: 'state-space-search' }, agent: child }, next), /coordinator skill/)
})

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('separate host processes serialize board updates without losing hints', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cairn-process-lock-'))
  try {
    await saveBoard(cwd, 'p', emptyBoard('t', 'o', 'g'))
    const modulePath = new URL('../src/board.ts', import.meta.url).href
    const childScript = `import {withBoardLock,loadBoard,saveBoard,addHint} from ${JSON.stringify(modulePath)}; for(let n=0;n<10;n++) await withBoardLock(process.argv[1],'p',async()=>{ const b=await loadBoard(process.argv[1],'p'); await saveBoard(process.argv[1],'p',addHint(b,process.argv[2]+n,'test').board); });`
    const run = (id: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childScript, cwd, id], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'ignore', 'pipe'] })
      let error = ''
      child.stderr.on('data', data => { error += data })
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve() : reject(new Error(error)))
    })
    await Promise.all([run('a'), run('b')])
    const board = (await loadBoard(cwd, 'p'))!
    assert.equal(board.hints.length, 20)
    assert.equal(new Set(board.hints.map(h => h.content)).size, 20)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('stale reason submissions cannot complete a later reason lease', () => {
  const board = startReason(upgradeBoard(emptyBoard('t', 'o', 'g'), searchPolicy()), 'parent').board
  assert.throws(() => domainFinishReason(board, 'parent', { intents: [{ from: ['origin'], description: 'work' }] }, 'previous-reason'), /reasonId/)
})

test('restored completed history cannot prove a goal with invalid or missing evidence', () => {
  const completed = finishReason(startReason(observed(), 'parent').board, 'parent', {
    complete: { from: ['f001'], description: 'verified' },
  })
  assert.deepEqual(completionEvidenceIssues(completed), [])
  for (const board of [
    { ...completed, facts: completed.facts.filter(f => f.id !== 'f001') },
    { ...completed, facts: [...completed.facts, { id: 'f002', description: 'correction', supersedes: ['f001'] }] },
    { ...completed, intents: completed.intents.filter(i => i.to !== 'goal') },
  ]) {
    assert.ok(completionEvidenceIssues(board).length)
    assert.ok(auditBoard(board).some(w => /completion/.test(w)))
  }
})

test('acceptance proofs must cover every criterion with current observed facts', () => {
  let board = delegated()
  board = reserveDispatch(claimIntent(board, 'i001', 'parent'), 'i001', 'call')
  board = recordWorkerReturn(board, { kind: 'return', content: 'evidence', intentId: 'i001', dispatchId: 'call' })
  board = concludeIntent(board, 'i001', 'evidence', 'parent').board
  board.criteria = [{ id: 'c001', description: 'first' }, { id: 'c002', description: 'second' }]
  board = startReason(board, 'parent').board
  const proof = { criterionId: 'c001', from: ['f001'], description: 'evidence' }
  const finish = (proofs: typeof proof[]) => finishReason(board, 'parent', { complete: { from: ['f001'], description: 'done', proofs } })
  assert.throws(() => finish([proof]), /acceptance criterion/)
  assert.throws(() => finish([proof, proof]), /acceptance criterion/)
  assert.equal(finish([proof, { ...proof, criterionId: 'c002' }]).status, 'completed')
})
