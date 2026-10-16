import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Board } from './types.ts'
import { hydrateBoard, SEGMENT_FIELDS, STORAGE_FORMAT, type Manifest, type Segment } from './storage-format.ts'

// Immutable blocks are shared by revisions and forks. Keep a bounded hot cache;
// cold reads verify their names against their actual bytes before using them.
const cache = new Map<string, string>()
let cacheBytes = 0
function remember(path: string, text: string) {
  if (cache.has(path)) return
  if (text.length > 8 * 1024 * 1024) return
  cache.set(path, text); cacheBytes += text.length
  while (cacheBytes > 8 * 1024 * 1024 || cache.size > 512) {
    const key = cache.keys().next().value!
    cacheBytes -= cache.get(key)!.length; cache.delete(key)
  }
}

export async function readStoredBoard(cwd: string, text: string): Promise<Board> {
  return hydrateBoard(JSON.parse(text), async path => {
    const full = join(cwd, path)
    let content = cache.get(full)
    if (content === undefined) {
      content = await readFile(full, 'utf8')
      if (!path.endsWith(`/${createHash('sha256').update(content).digest('hex')}.json`)) throw new Error('blackboard segment failed integrity check')
      remember(full, content)
    }
    return content
  })
}

/** Small boards remain ordinary JSON. Large boards publish immutable blocks
 * before the atomic manifest; interruption can leave unused blocks, never a
 * manifest pointing at a partially written block. No automatic block deletion:
 * older revisions and fork snapshots may still reference the same evidence.
 */
export async function serializeStoredBoard(cwd: string, board: Board): Promise<string> {
  const revision = randomUUID()
  if (SEGMENT_FIELDS.reduce((n, field) => n + (board[field]?.length ?? 0), 0) < 512) return JSON.stringify({ storageRevision: revision, ...board, storageEndRevision: revision }, null, 2)
  const { facts, intents, hints, workerReturns, ...metadata } = board
  const segments = {} as Manifest['segments']
  for (const field of SEGMENT_FIELDS) {
    const values = board[field] ?? []
    const refs: Segment[] = []
    for (let offset = 0; offset < values.length; offset += 256) {
      const chunk = values.slice(offset, offset + 256)
      const content = JSON.stringify(chunk, null, 2)
      const hash = createHash('sha256').update(content).digest('hex')
      const path = `.dsh/blackboard-segments/${hash}.json`
      const full = join(cwd, path)
      if (!cache.has(full)) {
        try {
          if (await readFile(full, 'utf8') !== content) throw new Error('existing blackboard segment failed integrity check')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          await mkdir(dirname(full), { recursive: true })
          const temp = `${full}.${randomUUID()}.tmp`
          await writeFile(temp, content, 'utf8')
          await rename(temp, full)
        }
        remember(full, content)
      }
      refs.push({ path, count: chunk.length })
    }
    segments[field] = refs
  }
  // Matching first/last markers detect a workspace RPC reader crossing an
  // atomic manifest replacement between its pages.
  return JSON.stringify({ storageRevision: revision, ...metadata, storageFormat: STORAGE_FORMAT, segments, storageEndRevision: revision }, null, 2)
}
