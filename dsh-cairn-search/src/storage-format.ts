import type { Board } from './types.ts'

export const STORAGE_FORMAT = 'cairn-segments-v1'
export const SEGMENT_FIELDS = ['facts', 'intents', 'hints', 'workerReturns'] as const
export const SEGMENT_PATH = /^\.dsh\/blackboard-segments\/[a-f0-9]{64}\.json$/
export interface Segment { path: string; count: number }
export type Manifest = Omit<Board, typeof SEGMENT_FIELDS[number]> & {
  storageFormat: typeof STORAGE_FORMAT
  storageRevision?: string
  storageEndRevision?: string
  segments: Record<typeof SEGMENT_FIELDS[number], Segment[]>
}

/** One atomic manifest fixes every referenced version for a multi-page reader. */
export async function hydrateBoard(document: (Board | Manifest) & { storageRevision?: string; storageEndRevision?: string }, read: (path: string) => Promise<string>): Promise<Board> {
  if (document.storageRevision !== document.storageEndRevision) throw new Error('blackboard changed during paginated read; retry the snapshot')
  if (!('storageFormat' in document)) {
    const { storageRevision, storageEndRevision, ...board } = document
    return board
  }
  if (document.storageFormat !== STORAGE_FORMAT) throw new Error('unsupported blackboard storage format')
  const { storageFormat, storageRevision, storageEndRevision, segments, ...metadata } = document
  const board = { ...metadata } as Board
  for (const field of SEGMENT_FIELDS) {
    if (!Array.isArray(segments?.[field])) throw new Error('invalid blackboard segment index')
    const records: unknown[] = []
    for (const ref of segments[field]) {
      if (!SEGMENT_PATH.test(ref.path) || !Number.isSafeInteger(ref.count) || ref.count < 1 || ref.count > 256) throw new Error('invalid blackboard segment reference')
      const values = JSON.parse(await read(ref.path))
      if (!Array.isArray(values) || values.length !== ref.count) throw new Error('blackboard segment count mismatch')
      records.push(...values)
    }
    ;(board[field] as unknown[]) = records
  }
  return board
}
