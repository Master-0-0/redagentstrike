import assert from 'node:assert/strict'
import test from 'node:test'
import { boardRelativePath } from '../src/owner.ts'
import { loadBoardSnapshot, type WorkspaceFilesReadRemote } from '../src/client/rpc.ts'
import { emptyBoard, ensureBootstrapIntent } from '../src/board.ts'

test('loadBoardSnapshot pages until eof and lays out a valid board', async () => {
  const board = ensureBootstrapIntent(emptyBoard('t', 'o', 'g'))
  const json = JSON.stringify(board, null, 2)
  const lines = json.split('\n')
  const split = Math.max(1, Math.floor(lines.length / 2))
  const remote = fakeRead([
    { text: lines.slice(0, split).join('\n'), offset: 1, lines: split, eof: false },
    {
      text: lines.slice(split).join('\n'),
      offset: split + 1,
      lines: lines.length - split,
      eof: true,
    },
  ])
  const result = await loadBoardSnapshot(remote, 'sess', 'main-a', new AbortController().signal)
  assert.equal(result.kind, 'ready')
  if (result.kind === 'ready') assert.equal(result.view.title, 't')
})

test('loadBoardSnapshot treats not-found as missing', async () => {
  const remote: WorkspaceFilesReadRemote = {
    workspaceFiles: {
      async read() {
        return { ok: false, error: { code: 'workspace-file/not-found', message: 'no entry' } }
      },
    },
  }
  assert.deepEqual(
    await loadBoardSnapshot(remote, 'sess', 'main-a', new AbortController().signal),
    { kind: 'missing' },
  )
})

test('loadBoardSnapshot reads the owner-scoped board path', async () => {
  const paths: string[] = []
  const remote: WorkspaceFilesReadRemote = {
    workspaceFiles: {
      async read(_sessionId, path) {
        paths.push(path)
        return { ok: false, error: { code: 'workspace-file/not-found', message: 'no entry' } }
      },
    },
  }
  await loadBoardSnapshot(remote, 'sess', 'main-a', new AbortController().signal)
  assert.deepEqual(paths, [boardRelativePath('main-a')])
})

function fakeRead(
  pages: Array<{ text: string; offset: number; lines: number; eof: boolean }>,
): WorkspaceFilesReadRemote {
  return {
    workspaceFiles: {
      async read(_sessionId, _path, range) {
        const offset = range.offset ?? 1
        const page = pages.find((item) => item.offset === offset)
        if (page === undefined) return { ok: false, error: { code: 'missing-page', message: String(offset) } }
        return { ok: true, value: page }
      },
    },
  }
}
