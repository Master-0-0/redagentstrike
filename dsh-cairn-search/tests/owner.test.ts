import assert from 'node:assert/strict'
import test from 'node:test'
import {
  boardOwnerId,
  boardOwnerFromList,
  boardRelativePath,
  encodeBoardOwnerId,
  forkSourceOwnerId,
  isConversationFork,
  type SessionLineage,
} from '../src/owner.ts'

function lookup(rows: SessionLineage[]): (id: string) => SessionLineage | undefined {
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
  return (id) => byId[id]
}

test('boardRelativePath uses the encoded main-session id', () => {
  assert.equal(boardRelativePath('abc-123'), '.dsh/blackboards/abc-123.json')
  assert.equal(encodeBoardOwnerId('a/b'), 'a~002Fb')
})

test('a new or restored main session owns its own board', () => {
  const main: SessionLineage = { id: 'main-a' }
  assert.equal(boardOwnerId(main, lookup([main])), 'main-a')
})

test('subagents including nested children share the main session board', () => {
  const main: SessionLineage = { id: 'main-a' }
  const child: SessionLineage = { id: 'child-1', parentId: 'main-a', origin: 'subagent' }
  const nested: SessionLineage = { id: 'child-2', parentId: 'child-1', origin: 'subagent' }
  const get = lookup([main, child, nested])
  assert.equal(boardOwnerId(child, get), 'main-a')
  assert.equal(boardOwnerId(nested, get), 'main-a')
})

test('a conversation fork is its own owner and copies from the source owner', () => {
  const main: SessionLineage = { id: 'main-a' }
  const fork: SessionLineage = { id: 'fork-b', parentId: 'main-a', isSeeded: true }
  const get = lookup([main, fork])
  assert.equal(isConversationFork(fork), true)
  assert.equal(isConversationFork({ id: 'child', parentId: 'main-a', origin: 'subagent' }), false)
  assert.equal(boardOwnerId(fork, get), 'fork-b')
  assert.equal(forkSourceOwnerId(fork, get), 'main-a')
})

test('fork of a subagent copies the main session board, not the child id', () => {
  const main: SessionLineage = { id: 'main-a' }
  const child: SessionLineage = { id: 'child-1', parentId: 'main-a', origin: 'subagent' }
  const fork: SessionLineage = { id: 'fork-c', parentId: 'child-1', isSeeded: true }
  const get = lookup([main, child, fork])
  assert.equal(boardOwnerId(fork, get), 'fork-c')
  assert.equal(forkSourceOwnerId(fork, get), 'main-a')
})

test('missing parent of a subagent is treated as the owner', () => {
  const child: SessionLineage = { id: 'child-1', parentId: 'main-a', origin: 'subagent' }
  assert.equal(boardOwnerId(child, () => undefined), 'main-a')
})

test('boardOwnerFromList follows the selected sidebar session', () => {
  const mainA: SessionLineage = { id: 'main-a' }
  const mainB: SessionLineage = { id: 'main-b' }
  const fork: SessionLineage = { id: 'fork-c', parentId: 'main-a', isSeeded: true }
  assert.equal(boardOwnerFromList({ current: 'main-a', byId: { 'main-a': mainA, 'main-b': mainB } }), 'main-a')
  assert.equal(boardOwnerFromList({ current: 'main-b', byId: { 'main-a': mainA, 'main-b': mainB } }), 'main-b')
  assert.equal(boardOwnerFromList({ current: 'fork-c', byId: { 'main-a': mainA, 'fork-c': fork } }), 'fork-c')
})

test('boardOwnerFromList uses the subagent catalog when the child is not a list row', () => {
  const main: SessionLineage = { id: 'main-a' }
  assert.equal(
    boardOwnerFromList({
      current: 'child-1',
      byId: { 'main-a': main },
      subagentsByParent: {
        'main-a': { entries: [{ kind: 'child', id: 'child-1' }] },
      },
    }),
    'main-a',
  )
})
