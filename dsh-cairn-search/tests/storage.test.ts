import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyBoard, loadBoard, saveBoard, addHint, copyBoardIfAbsent } from '../src/board.ts'
import { loadBoardSnapshot } from '../src/client/rpc.ts'
import { hydrateBoard } from '../src/storage-format.ts'

test('long history writes only changed segments and forks retain a consistent revision', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cairn-segments-'))
  try {
    const original = emptyBoard('long history', 'start', 'goal')
    original.facts.push(...Array.from({ length: 1200 }, (_, n) => ({ id: `f${n + 1}`, description: `evidence ${n}` })))
    await saveBoard(cwd, 'parent', original)
    const root = join(cwd, '.dsh/blackboards/parent.json')
    const raw = await readFile(root, 'utf8')
    assert.ok(raw.length < 5000)
    assert.equal(JSON.parse(raw).storageFormat, 'cairn-segments-v1')
    const before = await readdir(join(cwd, '.dsh/blackboard-segments'))
    const loaded = (await loadBoard(cwd, 'parent'))!
    assert.deepEqual(loaded.facts, original.facts)
    await copyBoardIfAbsent(cwd, 'parent', 'fork')
    await saveBoard(cwd, 'parent', addHint(loaded, 'new feedback', 'user').board)
    const after = await readdir(join(cwd, '.dsh/blackboard-segments'))
    assert.equal(after.length - before.length, 1, 'a hint must not rewrite historical fact blocks')
    assert.equal((await loadBoard(cwd, 'fork'))!.hints.length, 0)
    assert.equal((await loadBoard(cwd, 'parent'))!.hints.length, 1)
    const snapshot = await loadBoardSnapshot({ workspaceFiles: { read: async (_session, path, range) => {
      const lines = (await readFile(join(cwd, path), 'utf8')).split('\n')
      const offset = range.offset ?? 1
      const page = lines.slice(offset - 1, offset - 1 + 100)
      return { ok: true, value: { text: page.join('\n'), offset, lines: page.length, eof: offset - 1 + page.length >= lines.length } }
    } } }, 'parent', 'parent', new AbortController().signal)
    assert.equal(snapshot.kind, 'ready')
    const manifest = JSON.parse(raw)
    await assert.rejects(() => hydrateBoard({ ...manifest, storageEndRevision: 'another-write' }, async () => '[]'), /changed during/)
    manifest.segments.facts[0].path = `.dsh/blackboard-segments/${'0'.repeat(64)}.json`
    await writeFile(root, JSON.stringify(manifest))
    await assert.rejects(() => loadBoard(cwd, 'parent'), /ENOENT/)
    await writeFile(join(cwd, manifest.segments.facts[0].path), '[]')
    await assert.rejects(() => loadBoard(cwd, 'parent'), /integrity/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
