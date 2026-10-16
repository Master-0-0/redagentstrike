import type { Board, SearchPolicy } from './types.ts'
import { randomUUID } from 'node:crypto'

/** Validate deployment limits before admitting any work. */
export function searchPolicy(input: Partial<SearchPolicy> = {}): SearchPolicy {
  const policy = { maxOpenIntents: 6, maxConcurrent: 3, maxAttempts: 3, maxExplorations: 128, ...input }
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`)
  }
  if (policy.maxConcurrent > policy.maxOpenIntents) throw new Error('maxConcurrent exceeds maxOpenIntents')
  return policy
}

/** Upgrade scheduling, without manufacturing facts or rewriting finished history.
 * Legacy bootstrap work becomes explicitly closed; new exploration is delegated.
 */
export function upgradeBoard(board: Board, policy: SearchPolicy): Board {
  if (board.protocolVersion === 2) return board
  const at = new Date().toISOString()
  return { ...board, protocolVersion: 2, policy, bootstrapEnabled: false,
    reason: board.reason ? { ...board.reason, id: board.reason.id ?? randomUUID() } : null,
    criteria: board.criteria ?? [{ id: 'c001', description: board.facts.find(f => f.id === 'goal')?.description ?? board.title }],
    pendingIntentsEmpty: board.status === 'active' || board.pendingIntentsEmpty,
    intents: board.intents.map(i => i.to === null && !i.closed && i.creator === 'dispatcher.bootstrap'
      ? { ...i, worker: null, closed: { reason: 'Bootstrap migrated to delegated exploration; no result inferred.', at } }
      : i),
  }
}
