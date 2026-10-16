import type { Board } from './types.ts'
import { invalidFactIds } from './evidence.ts'

/** Check historical completion too: a restored legacy board may already carry
 * a completion whose evidence was later replaced or is missing. */
export function completionEvidenceIssues(board: Board): string[] {
  if (board.status !== 'completed') return ['blackboard is not completed']
  const completions = board.intents.filter(i => i.to === 'goal' && !i.closed && !i.invalidated)
  if (!completions.length) return ['completed blackboard has no current completion proof']
  const invalid = invalidFactIds(board)
  const observed = new Set(board.facts.filter(f => f.id !== 'origin' && f.id !== 'goal').map(f => f.id))
  return completions.flatMap(i => !i.from.length || i.from.some(id => !observed.has(id) || invalid.has(id))
    ? [`${i.id}: completion uses missing or invalid evidence; reopen and revalidate the goal`] : [])
}

/** Advisory quality checks; causal redundancy is not proof of irrelevance. */
export function auditBoard(board: Board): string[] {
  const warnings: string[] = board.workerStatusWarning ? [board.workerStatusWarning] : []
  if (board.status === 'completed') warnings.push(...completionEvidenceIssues(board))
  const superseded = invalidFactIds(board)
  const active = board.facts.filter(f => f.id !== 'goal' && !superseded.has(f.id))
  for (const intent of board.intents.filter(i => !i.closed && i.to === null)) {
    if (!intent.target && intent.description !== 'bootstrap') warnings.push(`${intent.id}: missing single subgoal target; do not use a queue as an intent`)
    if (active.length > 2 && active.every(f => intent.from.includes(f.id))) warnings.push(`${intent.id}: depends on every current fact; select only direct premises`)
    if (intent.from.some(id => superseded.has(id))) warnings.push(`${intent.id}: uses superseded facts; close and redeclare from current evidence`)
    if (intent.pendingReturn) warnings.push(`${intent.id}: worker return or status observation needs review; inspect the actual outcome before concluding, releasing, or closing`)
  }
  if (board.status === 'active' && board.facts.length > board.checkpoint.factCount) warnings.push('New facts await reason; checkpoint is the last reason-start snapshot, not a live count')
  return warnings
}
