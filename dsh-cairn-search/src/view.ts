/**
 * Parse a blackboard JSON snapshot and place origin → fact → goal nodes for the sidebar graph.
 * Domain mutations stay in `board.ts`; this module is read-only presentation.
 */

import type { Board, Fact, Hint, Intent, ProjectStatus, ReasonLease } from './types.ts'
import { GOAL_ID, ORIGIN_ID } from './types.ts'

const NODE_WIDTH = 168
const NODE_HEIGHT = 56
const OPEN_WIDTH = 168
const OPEN_HEIGHT = 44
const COLUMN_GAP = 64
const ROW_GAP = 20
const PAD = 28

/** One fact or origin/goal node on the canvas. */
export interface GraphNode {
  readonly id: string
  readonly supersededBy?: readonly string[]
  readonly kind: 'origin' | 'goal' | 'fact'
  readonly description: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One intent drawn as a path; `to` is null while the intent is still open. */
export interface GraphEdge {
  readonly id: string
  readonly from: readonly string[]
  readonly to: string | null
  readonly description: string
  readonly status: 'open' | 'claimed' | 'concluded' | 'complete' | 'closed'
  readonly worker: string | null
  readonly creator: string
}

/** Open-intent stub sitting to the right of its sources until `to` is written. */
export interface GraphStub {
  readonly closed?: boolean
  readonly id: string
  readonly intentId: string
  readonly description: string
  readonly worker: string | null
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Geometry plus the board facts the panel header and detail pane read. */
export interface BoardView {
  readonly title: string
  readonly status: ProjectStatus
  readonly bootstrapEnabled: boolean
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly stubs: readonly GraphStub[]
  readonly hints: readonly Hint[]
  readonly reason: ReasonLease | null
  readonly factCount: number
  readonly openCount: number
  readonly claimedCount: number
  readonly width: number
  readonly height: number
}

export type BoardRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'ready'; readonly view: BoardView }

/**
 * Parse a workspace file body into a board. Unknown extra keys are ignored.
 * @param text - file contents of `.dsh/blackboards/<main-session-id>.json`.
 * @returns the board, or null when the JSON is not a board object.
 */
export function parseBoard(text: string): Board | null {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (typeof value.title !== 'string' || !isStatus(value.status)) return null
  if (typeof value.bootstrapEnabled !== 'boolean') return null
  if (!Array.isArray(value.facts) || !Array.isArray(value.intents) || !Array.isArray(value.hints)) return null
  const facts: Fact[] = []
  for (const item of value.facts) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.description !== 'string') return null
    if (item.supersedes !== undefined && (!Array.isArray(item.supersedes) || item.supersedes.some(id => typeof id !== 'string'))) return null
    facts.push({ id: item.id, description: item.description, ...(Array.isArray(item.supersedes) ? { supersedes: item.supersedes as string[] } : {}) })
  }
  const intents: Intent[] = []
  for (const item of value.intents) {
    const intent = parseIntent(item)
    if (intent === null) return null
    intents.push(intent)
  }
  const hints: Hint[] = []
  for (const item of value.hints) {
    if (
      !isRecord(item)
      || typeof item.id !== 'string'
      || typeof item.content !== 'string'
      || typeof item.creator !== 'string'
      || typeof item.createdAt !== 'string'
    ) return null
    hints.push({
      id: item.id,
      content: item.content,
      creator: item.creator,
      createdAt: item.createdAt,
      ...(typeof item.messageId === 'string' ? { messageId: item.messageId } : {}),
    })
  }
  const reason = parseReason(value.reason)
  if (reason === undefined) return null
  if (!isRecord(value.checkpoint)) return null
  const { factCount, hintCount, hadOpenIntents } = value.checkpoint
  if (typeof factCount !== 'number' || typeof hintCount !== 'number' || typeof hadOpenIntents !== 'boolean') {
    return null
  }
  return {
    title: value.title,
    status: value.status,
    bootstrapEnabled: value.bootstrapEnabled,
    facts,
    intents,
    hints,
    reason,
    checkpoint: { factCount, hintCount, hadOpenIntents },
  }
}

/**
 * Place facts in columns by concluded-intent distance from origin.
 * @param board - a parsed blackboard snapshot.
 * @returns pixel positions for the SVG canvas.
 */
export function layoutBoard(board: Board): BoardView {
  const columns = new Map<string, number>()
  columns.set(ORIGIN_ID, 0)
  const visiting = new Set<string>()
  const columnOf = (id: string): number => {
    const held = columns.get(id)
    if (held !== undefined) return held
    if (visiting.has(id)) return 1
    visiting.add(id)
    const incoming = board.intents.filter((intent) => intent.to === id)
    const col = incoming.length === 0
      ? 1
      : 1 + Math.max(0, ...incoming.flatMap((intent) => intent.from.map((from) => columnOf(from))))
    visiting.delete(id)
    columns.set(id, col)
    return col
  }
  for (const fact of board.facts) columnOf(fact.id)
  const factColumns = board.facts.map((fact) => columns.get(fact.id) ?? 1)
  const maxFactCol = factColumns.length === 0 ? 0 : Math.max(...factColumns)
  columns.set(GOAL_ID, Math.max(columns.get(GOAL_ID) ?? 1, maxFactCol + 1))

  const byColumn = new Map<number, string[]>()
  for (const fact of board.facts) {
    const col = columns.get(fact.id) ?? 1
    const row = byColumn.get(col) ?? []
    row.push(fact.id)
    byColumn.set(col, row)
  }

  const factById = new Map(board.facts.map((fact) => [fact.id, fact]))
  const nodes: GraphNode[] = []
  const nodeAt = new Map<string, GraphNode>()
  let maxCol = 0
  let maxBottom = 0
  for (const [col, ids] of [...byColumn.entries()].sort((a, b) => a[0] - b[0])) {
    maxCol = Math.max(maxCol, col)
    ids.forEach((id, index) => {
      const fact = factById.get(id)
      if (fact === undefined) return
      const node: GraphNode = {
        id,
        kind: id === ORIGIN_ID ? 'origin' : id === GOAL_ID ? 'goal' : 'fact',
        description: fact.description,
        supersededBy: board.facts.filter(f => f.supersedes?.includes(id)).map(f => f.id),
        x: PAD + col * (NODE_WIDTH + COLUMN_GAP),
        y: PAD + index * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      }
      nodes.push(node)
      nodeAt.set(id, node)
      maxBottom = Math.max(maxBottom, node.y + node.height)
    })
  }

  const edges: GraphEdge[] = board.intents.map((intent) => ({
    id: intent.id,
    from: intent.from,
    to: intent.to,
    description: intent.closed ? `${intent.description}\nClosed: ${intent.closed.reason}` : intent.description,
    status: edgeStatus(intent),
    worker: intent.worker,
    creator: intent.creator,
  }))

  const stubs: GraphStub[] = []
  const openByColumn = new Map<number, GraphEdge[]>()
  for (const edge of edges) {
    if (edge.to !== null) continue
    const fromCols = edge.from.map((id) => columns.get(id) ?? 0)
    const col = (fromCols.length === 0 ? 0 : Math.max(...fromCols)) + 1
    const list = openByColumn.get(col) ?? []
    list.push(edge)
    openByColumn.set(col, list)
  }
  for (const [col, list] of openByColumn) {
    maxCol = Math.max(maxCol, col)
    const occupied = (byColumn.get(col) ?? []).length
    list.forEach((edge, index) => {
      const stub: GraphStub = {
        id: `open:${edge.id}`,
        intentId: edge.id,
        closed: edge.status === 'closed',
        description: edge.description,
        worker: edge.worker,
        x: PAD + col * (NODE_WIDTH + COLUMN_GAP),
        y: PAD + (occupied + index) * (NODE_HEIGHT + ROW_GAP),
        width: OPEN_WIDTH,
        height: OPEN_HEIGHT,
      }
      stubs.push(stub)
      maxBottom = Math.max(maxBottom, stub.y + stub.height)
    })
  }

  const openCount = board.intents.filter((intent) => intent.to === null && !intent.closed).length
  const claimedCount = board.intents.filter((intent) => intent.to === null && !intent.closed && intent.worker !== null).length
  return {
    title: board.title,
    status: board.status,
    bootstrapEnabled: board.bootstrapEnabled,
    nodes,
    edges,
    stubs,
    hints: board.hints,
    reason: board.reason,
    factCount: board.facts.length,
    openCount,
    claimedCount,
    width: PAD * 2 + (maxCol + 1) * NODE_WIDTH + maxCol * COLUMN_GAP,
    height: PAD * 2 + Math.max(NODE_HEIGHT, maxBottom - PAD),
  }
}

/**
 * Classify a file body as missing-equivalent empty, invalid JSON, or a laid-out board.
 * @param text - workspace file contents; empty string is treated as missing.
 * @returns the panel's read result.
 */
export function readBoardText(text: string): BoardRead {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'missing' }
  const board = parseBoard(trimmed)
  if (board === null) return { kind: 'invalid', message: 'blackboard.json is not a valid board' }
  return { kind: 'ready', view: layoutBoard(board) }
}

/**
 * Anchor of an edge endpoint in canvas space.
 * @param node - a placed fact node.
 * @param side - which edge of the card to attach.
 * @returns the attachment point.
 */
export function nodeAnchor(
  node: { x: number; y: number; width: number; height: number },
  side: 'left' | 'right',
): { x: number; y: number } {
  return {
    x: side === 'left' ? node.x : node.x + node.width,
    y: node.y + node.height / 2,
  }
}

/**
 * Cubic path from one card's right edge to another's left edge.
 * @param from - source card.
 * @param to - destination card.
 * @returns an SVG `d` string.
 */
export function edgePath(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
): string {
  const start = nodeAnchor(from, 'right')
  const end = nodeAnchor(to, 'left')
  const mid = (start.x + end.x) / 2
  return `M ${start.x} ${start.y} C ${mid} ${start.y}, ${mid} ${end.y}, ${end.x} ${end.y}`
}

function edgeStatus(intent: Intent): GraphEdge['status'] {
  if (intent.closed) return 'closed'
  if (intent.to === GOAL_ID) return 'complete'
  if (intent.to !== null) return 'concluded'
  if (intent.worker !== null) return 'claimed'
  return 'open'
}

function parseIntent(item: unknown): Intent | null {
  if (!isRecord(item)) return null
  if (typeof item.id !== 'string' || typeof item.description !== 'string') return null
  if (typeof item.creator !== 'string' || typeof item.createdAt !== 'string') return null
  if (!Array.isArray(item.from) || item.from.some((id) => typeof id !== 'string')) return null
  if (item.to !== null && typeof item.to !== 'string') return null
  if (item.worker !== null && typeof item.worker !== 'string') return null
  if (item.concludedAt !== null && typeof item.concludedAt !== 'string') return null
  if (item.closed !== undefined && (!isRecord(item.closed) || typeof item.closed.reason !== 'string' || typeof item.closed.at !== 'string')) return null
  return {
    ...(isRecord(item.closed) ? { closed: { reason: item.closed.reason as string, at: item.closed.at as string } } : {}),
    ...(typeof item.target === 'string' ? { target: item.target } : {}),
    ...(typeof item.dispatchId === 'string' ? { dispatchId: item.dispatchId } : {}),
    ...(typeof item.subagentId === 'string' ? { subagentId: item.subagentId } : {}),
    ...(item.pendingReturn === true ? { pendingReturn: true } : {}),
    id: item.id,
    from: item.from as string[],
    to: item.to,
    description: item.description,
    creator: item.creator,
    worker: item.worker,
    createdAt: item.createdAt,
    concludedAt: item.concludedAt,
  }
}

function parseReason(value: unknown): ReasonLease | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  if (typeof value.worker !== 'string' || typeof value.startedAt !== 'string') return undefined
  if (
    value.trigger !== 'initial'
    && value.trigger !== 'new-fact'
    && value.trigger !== 'new-hint'
    && value.trigger !== 'intents-empty'
  ) return undefined
  return { worker: value.worker, trigger: value.trigger, startedAt: value.startedAt }
}

function isStatus(value: unknown): value is ProjectStatus {
  return value === 'active' || value === 'stopped' || value === 'completed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
