import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { emptyBoard, ensureBootstrapIntent } from '../src/board.ts'
import { GOAL_ID, ORIGIN_ID } from '../src/types.ts'
import { edgePath, layoutBoard, parseBoard, readBoardText } from '../src/view.ts'

const examplePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../preset/skills/state-space-search/references/board.example.json',
)

test('parseBoard accepts the skill example and layoutBoard places origin → f001 → open stub, goal on the right', async () => {
  const text = await readFile(examplePath, 'utf8')
  const board = parseBoard(text)
  assert.ok(board)
  assert.equal(board.title, 'Find why parseDuration rejects 1.5h')
  const view = layoutBoard(board)
  const origin = view.nodes.find((node) => node.id === ORIGIN_ID)
  const fact = view.nodes.find((node) => node.id === 'f001')
  const goal = view.nodes.find((node) => node.id === GOAL_ID)
  assert.ok(origin && fact && goal)
  assert.equal(origin.kind, 'origin')
  assert.equal(fact.kind, 'fact')
  assert.equal(goal.kind, 'goal')
  assert.ok(origin.x < fact.x)
  assert.ok(fact.x < goal.x)
  assert.equal(view.intents.length, 2)
  assert.equal(view.intents[1].intentId, 'i002')
  assert.ok(view.intents[1].x > fact.x)
  assert.equal(view.openCount, 1)
  assert.equal(view.claimedCount, 1)
  const concluded = view.edges.find((edge) => edge.id === 'i001')
  const claimed = view.edges.find((edge) => edge.id === 'i002')
  assert.equal(concluded?.status, 'concluded')
  assert.equal(claimed?.status, 'claimed')
})

test('parseBoard rejects non-JSON and incomplete objects', () => {
  assert.equal(parseBoard('{'), null)
  assert.equal(parseBoard('[]'), null)
  assert.equal(parseBoard('{"title":"x"}'), null)
})

test('readBoardText maps empty, invalid, and ready bodies', () => {
  assert.deepEqual(readBoardText('  '), { kind: 'missing' })
  const invalid = readBoardText('{"title":"x"}')
  assert.equal(invalid.kind, 'invalid')
  const ready = readBoardText(JSON.stringify(ensureBootstrapIntent(emptyBoard('t', 'o', 'g'))))
  assert.equal(ready.kind, 'ready')
  if (ready.kind === 'ready') {
    assert.equal(ready.view.title, 't')
    assert.equal(ready.view.nodes.length, 2)
  }
})

test('complete intents (to=goal) are status complete, and edgePath runs left to right', () => {
  const board = ensureBootstrapIntent(emptyBoard('t', 'from', 'to'))
  board.facts.push({ id: 'f001', description: 'a fact' })
  board.intents.push({
    id: 'i002',
    from: ['f001'],
    to: GOAL_ID,
    description: 'proves the goal',
    creator: 'parent',
    worker: null,
    createdAt: '2026-09-11T00:00:00.000Z',
    concludedAt: '2026-09-11T00:01:00.000Z',
  })
  const view = layoutBoard(board)
  assert.equal(view.edges.find((edge) => edge.id === 'i002')?.status, 'complete')
  const origin = view.nodes.find((node) => node.id === ORIGIN_ID)!
  const goal = view.nodes.find((node) => node.id === GOAL_ID)!
  const d = edgePath(origin, goal)
  assert.match(d, /^M /)
  assert.ok(origin.x < goal.x)
})

test('goal follows the final fact column and centered branches do not overlap', () => {
  const board = emptyBoard('branch layout', 'start', 'finish')
  board.facts.push({ id: 'f001', description: 'first' }, { id: 'f002', description: 'second' })
  for (const [id, from, to] of [
    ['i001', ['origin'], 'f001'],
    ['i002', ['origin'], 'f002'],
    ['i003', ['f001', 'f002'], 'goal'],
  ] as const) {
    board.intents.push({ id, from: [...from], to, description: id, creator: 'test', worker: null, createdAt: '2026-10-10', concludedAt: '2026-10-10' })
  }
  const view = layoutBoard(board)
  const origin = view.nodes.find(n => n.id === 'origin')!
  const first = view.nodes.find(n => n.id === 'f001')!
  const second = view.nodes.find(n => n.id === 'f002')!
  const goal = view.nodes.find(n => n.id === 'goal')!
  assert.equal(goal.x - first.x, first.x - origin.x)
  assert.equal(origin.y, goal.y)
  assert.equal(origin.y, (first.y + second.y) / 2)
  assert.ok(first.y + first.height < second.y)
  for (const node of view.nodes) {
    assert.ok(node.x >= 0 && node.y >= 0)
    assert.ok(node.x + node.width <= view.width && node.y + node.height <= view.height)
  }
})

test('every intent remains a separate card after completion with a stable selection id', () => {
  const board = ensureBootstrapIntent(emptyBoard('lifecycle', 'start', 'finish'))
  const pending = layoutBoard(board)
  const intent = board.intents[0]
  const cardId = pending.intents[0].id
  assert.equal(pending.intents[0].status, 'open')
  intent.worker = 'explorer'
  assert.equal(layoutBoard(board).intents[0].status, 'claimed')
  board.facts.push({ id: 'f001', description: 'result' })
  intent.to = 'f001'
  intent.concludedAt = '2026-10-10T00:00:00Z'
  board.intents.push({ ...intent, id: 'i002', from: ['f001'], to: 'goal' })
  board.intents.push({ ...intent, id: 'i003', from: ['f001'], to: null, worker: null, concludedAt: null, closed: { reason: 'no longer needed', at: '2026-10-10T00:00:00Z' } })
  const view = layoutBoard(board)
  assert.equal(view.intents.length, board.intents.length)
  assert.equal(view.intents[0].id, cardId)
  assert.deepEqual(view.intents.map(card => card.status), ['concluded', 'complete', 'closed'])
  assert.equal(view.openCount, 0)
  for (const edge of view.edges) {
    const card = view.intents.find(item => item.intentId === edge.id)!
    for (const from of edge.from) {
      const source = view.nodes.find(item => item.id === from)!
      assert.ok(source.x + source.width < card.x)
    }
    if (edge.to) {
      const output = view.nodes.find(item => item.id === edge.to)!
      assert.ok(card.x + card.width < output.x)
    }
  }
  const cards = [...view.nodes, ...view.intents]
  for (const card of cards) {
    assert.ok(card.x + card.width <= view.width && card.y + card.height <= view.height)
    for (const other of cards.filter(other => other.id !== card.id)) {
      assert.ok(card.x + card.width <= other.x || other.x + other.width <= card.x || card.y + card.height <= other.y || other.y + other.height <= card.y)
    }
  }
})
