import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBoardFacts } from '../src/board-facts.ts'
import { createHash } from 'node:crypto'

test('fact receipts stream through boards larger than the old one MiB cap', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'finding-board-')))
  try {
    await mkdir(join(root, '.dsh/blackboards'), { recursive: true })
    const path = '.dsh/blackboards/p.json'
    await writeFile(join(root, path), JSON.stringify({ facts: [{ id: 'f001', description: 'verified' }], workerReturns: [{ content: 'x'.repeat(2 * 1024 * 1024) }] }))
    assert.deepEqual(await readBoardFacts(root, path, ['f001']), [{ id: 'f001', description: 'verified' }])
    await assert.rejects(() => readBoardFacts(root, path, ['missing']), /事实不存在/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('fact receipts follow immutable segments and reject changed evidence', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'finding-segment-')))
  try {
    await mkdir(join(root, '.dsh/blackboards'), { recursive: true })
    await mkdir(join(root, '.dsh/blackboard-segments'), { recursive: true })
    const content = JSON.stringify([{ id: 'f001', description: 'segmented evidence' }])
    const ref = `.dsh/blackboard-segments/${createHash('sha256').update(content).digest('hex')}.json`
    await writeFile(join(root, ref), content)
    await writeFile(join(root, '.dsh/blackboards/p.json'), JSON.stringify({ storageFormat: 'cairn-segments-v1', segments: { facts: [{ path: ref, count: 1 }] } }))
    assert.deepEqual(await readBoardFacts(root, '.dsh/blackboards/p.json', ['f001']), [{ id: 'f001', description: 'segmented evidence' }])
    await writeFile(join(root, ref), JSON.stringify([{ id: 'f001', description: 'modified evidence' }]))
    await assert.rejects(() => readBoardFacts(root, '.dsh/blackboards/p.json', ['f001']), /integrity/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
