import type { Board } from './types.ts'

/** Advisory quality checks; causal redundancy is not proof of irrelevance. */
export function auditBoard(board: Board): string[] {
  const warnings: string[] = board.workerStatusWarning ? [board.workerStatusWarning] : []
  const superseded = new Set(board.facts.flatMap(f => f.supersedes ?? []))
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
