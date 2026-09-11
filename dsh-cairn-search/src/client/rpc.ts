/** Bind workspace file reads used by the blackboard sidebar entry. */

import { boardRelativePath } from '../owner.ts'
import { readBoardText, type BoardRead } from '../view.ts'

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
    offset += result.value.lines
    if (offset > 1_000_000) return { kind: 'error', message: 'blackboard is too large to display' }
  }
  return readBoardText(chunks.join('\n'))
}
