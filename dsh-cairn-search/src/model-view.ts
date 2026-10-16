import type { Board, NextTask } from './types.ts'
import { invalidFactIds } from './evidence.ts'

const PREVIEW_CHARS = 160
const preview = (text: string) => text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}… [use lookup for full text]`

/** Keep historical evidence on disk; model reads are bounded, explicit views. */
export function modelBoard(board: Board) {
  const invalid = invalidFactIds(board)
  const intents = board.intents.filter(i => i.to === null && !i.closed).slice(0, 6)
  const ids = new Set(['origin', 'goal', ...intents.flatMap(i => i.from).slice(0, 12), ...board.facts.slice(-8).map(f => f.id)])
  return {
    title: preview(board.title), status: board.status, reason: board.reason, policy: board.policy,
    criteria: board.criteria?.map(c => ({ ...c, description: preview(c.description) })),
    counts: { facts: board.facts.length, intents: board.intents.length, hints: board.hints.length, workerReturns: board.workerReturns?.length ?? 0 },
    facts: board.facts.filter(f => ids.has(f.id)).slice(0, 22).map(f => ({ ...f, description: preview(f.description), invalid: invalid.has(f.id) })),
    intents: intents.map(i => ({ ...i, from: i.from.slice(0, 12), description: preview(i.description) })),
    hints: board.hints.slice(-3).map(h => ({ ...h, content: preview(h.content) })),
    partial: true,
    history: 'Use lookup with section, offset, limit to browse history; id and contentOffset read complete item text. Omitted evidence is not absent or invalid.',
  }
}

export function modelNext(next: NextTask): unknown {
  if (next.kind === 'review') return { ...next,
    intents: next.intents.slice(0, 3).map(i => ({ ...i, from: i.from.slice(0, 12), description: preview(i.description) })),
    records: next.records.slice(0, 3).map(r => ({ ...r, content: preview(r.content) })),
    remaining: Math.max(0, next.intents.length - 3),
  }
  if (next.kind === 'reason') return { ...next, factIds: next.factIds.slice(-12),
    openIntents: next.openIntents.slice(0, 6).map(i => ({ ...i, from: i.from.slice(0, 12), description: preview(i.description) })), partial: true }
  if (next.kind === 'explore') return { ...next, intent: { ...next.intent, from: next.intent.from.slice(0, 12), description: preview(next.intent.description) } }
  return next
}

export function lookupBoard(board: Board, section: string, offset = 0, limit = 5, id?: string, contentOffset = 0) {
  if (![offset, contentOffset].every(n => Number.isSafeInteger(n) && n >= 0) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('invalid pagination; limit must be 1..10')
  const values = section === 'state' ? [{ id: 'state', title: board.title, status: board.status, reason: board.reason, policy: board.policy, checkpoint: board.checkpoint }] : section === 'criteria' ? board.criteria ?? [] : section === 'facts' ? board.facts : section === 'intents' ? board.intents : section === 'hints' ? board.hints : section === 'workerReturns' ? board.workerReturns ?? [] : undefined
  if (!values) throw new Error('unknown lookup section')
  if (id) {
    const item = values.find(v => v.id === id)
    if (!item) throw new Error('lookup item not found')
    const text = JSON.stringify(item)
    return { id, contentOffset, text: text.slice(contentOffset, contentOffset + 6000), nextContentOffset: contentOffset + 6000 < text.length ? contentOffset + 6000 : null }
  }
  const items = values.slice(offset, offset + limit).map(item => ({ id: item.id, preview: JSON.stringify(item).slice(0, PREVIEW_CHARS) }))
  return { section, total: values.length, offset, items, nextOffset: offset + items.length < values.length ? offset + items.length : null }
}

/** Bound the complete rendered result, including duplicated operation fields
 * and JSON formatting, below the preset's tool-result pruning threshold.
 */
export function budgetResult(value: Record<string, any>): Record<string, any> {
  // The heterogeneous tool union is already validated at its own schema.
  const size = () => JSON.stringify(value, null, 2).length
  for (const key of ['fact', 'intent', 'hint']) {
    if (!value[key]) continue
    value[key] = { id: value[key].id, description: preview(value[key].description ?? value[key].content ?? '') }
  }
  if (value.page?.text) {
    while (size() > 7500 && value.page.text.length > 1) {
      value.page.text = value.page.text.slice(0, Math.floor(value.page.text.length / 2))
      value.page.nextContentOffset = value.page.contentOffset + value.page.text.length
    }
  }
  if (size() <= 7500) return value
  const board = value.board
  return { ok: value.ok, op: value.op,
    board: board ? { status: board.status, counts: board.counts, reason: board.reason ? { id: board.reason.id, trigger: board.reason.trigger, partial: true } : null, partial: true } : undefined,
    next: value.next ? { kind: value.next.kind, intentId: value.next.intent?.id, trigger: value.next.trigger } : undefined,
    warnings: ['Result exceeded the view budget. Use lookup to inspect complete records and acceptance criteria before acting; section=state, id=state retrieves the full reasoning lease.'],
  }
}
