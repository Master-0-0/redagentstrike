/** Bind workspace file reads used by the blackboard sidebar entry. */

import { boardRelativePath } from '../owner.ts'
import { readBoardText, type BoardRead } from '../view.ts'
import { hydrateBoard } from '../storage-format.ts'

const segmentCache = new Map<string, string>()
let segmentCacheSize = 0
function cacheSegment(key: string, text: string) {
  if (segmentCache.has(key) || text.length > 8 * 1024 * 1024) return
  segmentCache.set(key, text); segmentCacheSize += text.length
  while (segmentCacheSize > 8 * 1024 * 1024 || segmentCache.size > 512) {
    const oldest = segmentCache.keys().next().value!
    segmentCacheSize -= segmentCache.get(oldest)!.length
    segmentCache.delete(oldest)
  }
}

/** One page of a workspace text file as `workspaceFiles.read` returns it. */
export interface WorkspaceFileText {
  readonly text: string
  readonly offset: number
  readonly lines: number
  readonly eof: boolean
}

export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** The slice of the Client Remote this panel calls. */
export interface WorkspaceFilesReadRemote {
  readonly workspaceFiles: {
    read(
      sessionId: string,
      path: string,
      range: { offset?: number; limit?: number },
      signal?: AbortSignal,
    ): Promise<RemoteResult<WorkspaceFileText>>
  }
}

export type BoardSnapshot =
  | BoardRead
  | { readonly kind: 'error'; readonly message: string }

/**
 * Read `.dsh/blackboards/<ownerId>.json` for one session, paging until EOF.
 * @param remote - Client Remote carrying `workspaceFiles.read`.
 * @param sessionId - session whose workspace root resolves the path.
 * @param ownerId - main-session (or fork) id that owns the board file.
 * @param signal - cancels the in-flight read.
 * @returns missing, invalid, ready, or a transport failure.
 */
export async function loadBoardSnapshot(
  remote: WorkspaceFilesReadRemote,
  sessionId: string,
  ownerId: string,
  signal: AbortSignal,
): Promise<BoardSnapshot> {
  let path: string
  try {
    path = boardRelativePath(ownerId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', message }
  }
  const chunks: string[] = []
  let offset = 1
  for (;;) {
    const result = await remote.workspaceFiles.read(
      sessionId,
      path,
      { offset },
      signal,
    )
    if (!result.ok) {
      if (result.error?.code === 'workspace-file/not-found') return { kind: 'missing' }
      return { kind: 'error', message: result.error?.message ?? 'read failed' }
    }
    if (result.value.lines > 0) chunks.push(result.value.text)
    if (result.value.eof) break
    if (!Number.isSafeInteger(result.value.lines) || result.value.lines <= 0 || result.value.offset !== offset) {
      return { kind: 'error', message: 'blackboard reader made no progress or returned an unexpected page' }
    }
    offset += result.value.lines
    if (offset > 1_000_000) return { kind: 'error', message: 'blackboard is too large to display' }
  }
  const text = chunks.join('\n')
  try {
    const document = JSON.parse(text)
    if (document?.storageRevision !== document?.storageEndRevision) throw new Error('blackboard changed during paginated read; retry the snapshot')
    if (!document?.storageFormat) return readBoardText(text)
    const board = await hydrateBoard(document, async reference => {
      const key = `${sessionId}:${reference}`
      const cached = segmentCache.get(key)
      if (cached !== undefined) return cached
      const parts: string[] = []
      let position = 1
      for (;;) {
        const result = await remote.workspaceFiles.read(sessionId, reference, { offset: position }, signal)
        if (!result.ok) throw new Error(result.error.message)
        if (result.value.offset !== position) throw new Error('unexpected segment page')
        parts.push(result.value.text)
        if (result.value.eof) {
          const content = parts.join('\n')
          const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
          const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')
          if (!reference.endsWith(`/${hash}.json`)) throw new Error('blackboard segment failed integrity check')
          cacheSegment(key, content)
          return content
        }
        if (result.value.lines <= 0) throw new Error('segment reader made no progress')
        position += result.value.lines
      }
    })
    return readBoardText(JSON.stringify(board))
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

/** Fetch archived content only on an explicit detail request. */
export async function loadReturnText(remote: WorkspaceFilesReadRemote, sessionId: string, path: string): Promise<string> {
  if (!/^\.dsh\/blackboard-content\/[a-f0-9]{64}\.txt$/.test(path)) throw new Error('invalid return reference')
  const chunks: string[] = []
  let offset = 1
  for (;;) {
    const result = await remote.workspaceFiles.read(sessionId, path, { offset })
    if (!result.ok) throw new Error(result.error.message)
    chunks.push(result.value.text)
    if (result.value.eof) return chunks.join('\n')
    if (!result.value.lines) throw new Error('return reader made no progress')
    offset += result.value.lines
  }
}
