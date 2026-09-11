/**
 * Per-main-session blackboard ownership.
 * Subagents share the lineage root; a conversation fork is its own owner.
 */

export const BOARD_DIR_RELATIVE = '.dsh/blackboards'
export const LEGACY_BOARD_RELATIVE_PATH = '.dsh/blackboard.json'

/** One hop of session lineage used to resolve the board owner. */
export interface SessionLineage {
  readonly id: string
  readonly parentId?: string
  readonly origin?: 'subagent'
  readonly isSeeded?: boolean
}

/**
 * Encode a session id as a single path segment.
 * @param id - main-session id that owns the board file.
 */
export function encodeBoardOwnerId(id: string): string {
  const trimmed = id.trim()
  if (trimmed === '') throw new Error('empty board owner')
  if (trimmed === '.' || trimmed === '..') throw new Error('invalid board owner')
  let out = ''
  for (const ch of trimmed) {
    if (/^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Workspace-relative path of the board owned by one main session.
 * @param ownerId - lineage root (main session, or a conversation fork).
 */
export function boardRelativePath(ownerId: string): string {
  return `${BOARD_DIR_RELATIVE}/${encodeBoardOwnerId(ownerId)}.json`
}

/**
 * Walk subagent parent links to the session that owns the board.
 * A UI fork (`parentId` set, `origin` not `subagent`) is its own owner.
 * @param from - the selected or executing session.
 * @param lookup - resolve an ancestor by id; missing parent becomes the owner.
 */
export function boardOwnerId(
  from: SessionLineage,
  lookup: (id: string) => SessionLineage | undefined,
): string {
  const seen = new Set<string>()
  let current = from
  while (current.origin === 'subagent' && current.parentId !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    const parentId = current.parentId
    const parent = lookup(parentId)
    if (parent === undefined) return parentId
    current = parent
  }
  return current.id
}

/**
 * True when this session is a conversation fork that should snapshot the source board.
 * Subagent children (including seeded fork-provider children) share the parent board.
 */
export function isConversationFork(session: SessionLineage): boolean {
  return session.origin !== 'subagent' && session.parentId !== undefined && session.isSeeded === true
}

/**
 * Source board owner to copy when seeding a conversation fork.
 * @param session - the new fork.
 * @param lookup - resolve ancestors, including the fork's `parentId`.
 */
export function forkSourceOwnerId(
  session: SessionLineage,
  lookup: (id: string) => SessionLineage | undefined,
): string | undefined {
  if (!isConversationFork(session) || session.parentId === undefined) return undefined
  const parent = lookup(session.parentId)
  if (parent === undefined) return session.parentId
  return boardOwnerId(parent, lookup)
}

/** Sidebar session list facts needed to name the board owner. */
export interface SessionListLineage {
  readonly current?: string
  readonly byId: Readonly<Record<string, SessionLineage>>
  readonly subagentsByParent?: Readonly<Record<string, {
    readonly entries: readonly { readonly kind: string; readonly id: string }[]
  }>>
}

/**
 * Board owner for the selected sidebar session.
 * Subagent rows may only appear in a parent catalog; those still share the main board.
 */
export function boardOwnerFromList(list: SessionListLineage): string | undefined {
  if (list.current === undefined) return undefined
  const lookup = (id: string): SessionLineage | undefined => {
    const row = list.byId[id]
    const catalogParent = parentFromCatalog(id, list.subagentsByParent)
    if (row === undefined && catalogParent === undefined) return undefined
    return lineageFromList(id, list)
  }
  return boardOwnerId(lineageFromList(list.current, list), lookup)
}

function parentFromCatalog(
  childId: string,
  catalogs: SessionListLineage['subagentsByParent'],
): string | undefined {
  if (catalogs === undefined) return undefined
  for (const [parentId, snapshot] of Object.entries(catalogs)) {
    if (snapshot.entries.some((entry) => entry.kind === 'child' && entry.id === childId)) {
      return parentId
    }
  }
  return undefined
}

function lineageFromList(id: string, list: SessionListLineage): SessionLineage {
  const row = list.byId[id]
  const catalogParent = parentFromCatalog(id, list.subagentsByParent)
  return {
    id,
    ...row?.parentId !== undefined ? { parentId: row.parentId } : catalogParent !== undefined ? { parentId: catalogParent } : {},
    ...row?.origin !== undefined ? { origin: row.origin } : catalogParent !== undefined ? { origin: 'subagent' } : {},
    ...row?.isSeeded !== undefined ? { isSeeded: row.isSeeded } : {},
  }
}
