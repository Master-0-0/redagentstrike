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
  assert.equal(view.stubs.length, 1)
  assert.equal(view.stubs[0].intentId, 'i002')
  assert.ok(view.stubs[0].x > fact.x)
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
