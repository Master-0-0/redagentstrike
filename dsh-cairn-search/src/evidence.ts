import type { Board } from './types.ts'

/** Invalid premises propagate to derived facts. An explicit replacement is a
 * new observation of the replaced premise, not a deduction from that premise.
 * Other invalid premises still invalidate that observation. History is retained.
 */
export function invalidFactIds(board: Board): Set<string> {
  const invalid = new Set(board.facts.flatMap(f => f.supersedes ?? []))
  const facts = new Map(board.facts.map(f => [f.id, f]))
  const dependents = new Map<string, string[]>()
  for (const intent of board.intents) {
    if (!intent.to || intent.to === 'goal') continue
    const replacement = new Set(facts.get(intent.to)?.supersedes ?? [])
    for (const premise of intent.from) {
      if (replacement.has(premise)) continue
      const outputs = dependents.get(premise) ?? []
      outputs.push(intent.to)
      dependents.set(premise, outputs)
    }
  }
  const queue = [...invalid]
  for (let index = 0; index < queue.length; index++) {
    for (const output of dependents.get(queue[index]) ?? []) {
      if (invalid.has(output)) continue
      invalid.add(output)
      queue.push(output)
    }
  }
  return invalid
}
