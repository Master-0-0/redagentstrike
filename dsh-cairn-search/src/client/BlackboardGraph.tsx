/** SVG origin→goal graph for one blackboard snapshot. */

import type { BoardView, GraphEdge, GraphNode, GraphStub } from '../view.ts'
import { edgePath } from '../view.ts'

const ELLIPSIS = '…'

export interface BlackboardGraphProps {
  readonly view: BoardView
  readonly selectedId: string | undefined
  readonly onSelect: (id: string) => void
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

/**
 * Render the fact-intent graph. Nodes and open stubs are selectable.
 * @param props - laid-out board plus selection.
 */
export function BlackboardGraph({ view, selectedId, onSelect, t }: BlackboardGraphProps) {
  const byId = new Map(view.nodes.map((node) => [node.id, node]))
  const stubByIntent = new Map(view.stubs.map((stub) => [stub.intentId, stub]))
  return (
    <div className="dsh-bb-canvas">
      <svg
        width={view.width}
        height={view.height}
        viewBox={`0 0 ${view.width} ${view.height}`}
        role="img"
        aria-label={view.title}
      >
        {view.edges.flatMap((edge) => {
          const dest = edge.to === null ? stubByIntent.get(edge.id) : byId.get(edge.to)
          if (dest === undefined) return []
          return edge.from.flatMap((fromId) => {
            const source = byId.get(fromId)
            if (source === undefined) return []
            return [
              <path
                key={`${edge.id}:${fromId}`}
                className="dsh-bb-edge"
                data-status={edge.status}
                d={edgePath(source, dest)}
              />,
            ]
          })
        })}
        {view.nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            selected={selectedId === node.id}
            kicker={node.supersededBy?.length ? t('kind.superseded') : t(`kind.${node.kind}`)}
            onSelect={onSelect}
          />
        ))}
        {view.stubs.map((stub) => (
          <StubCard
            key={stub.id}
            stub={stub}
            selected={selectedId === stub.id}
            onSelect={onSelect}
          />
        ))}
      </svg>
    </div>
  )
}

function NodeCard({
  node, selected, kicker, onSelect,
}: {
  node: GraphNode
  selected: boolean
  kicker: string
  onSelect: (id: string) => void
}) {
  return (
    <g
      className="dsh-bb-node"
      data-kind={node.kind}
      data-superseded={!!node.supersededBy?.length || undefined}
      data-selected={selected || undefined}
      transform={`translate(${node.x} ${node.y})`}
      onClick={() => { onSelect(node.id) }}
    >
      <title>{`${kicker} ${node.id}: ${node.description}`}</title>
      <rect
        className="dsh-bb-node-card"
        width={node.width}
        height={node.height}
        rx={8}
      />
      <text className="dsh-bb-node-id" x={10} y={18}>{truncate(`${kicker} · ${node.id}`, 22)}</text>
      <text className="dsh-bb-node-text" x={10} y={36}>{truncate(node.description, 22)}</text>
    </g>
  )
}

function StubCard({
  stub, selected, onSelect,
}: {
  stub: GraphStub
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <g
      className="dsh-bb-node dsh-bb-stub"
      data-selected={selected || undefined}
      data-closed={stub.closed || undefined}
      transform={`translate(${stub.x} ${stub.y})`}
      onClick={() => { onSelect(stub.id) }}
    >
      <title>{stub.description}</title>
      <rect
        className="dsh-bb-node-card"
        width={stub.width}
        height={stub.height}
        rx={8}
      />
      <text className="dsh-bb-node-id" x={10} y={16}>{truncate(stub.intentId, 22)}</text>
      <text className="dsh-bb-node-text" x={10} y={32}>{truncate(stub.description, 22)}</text>
    </g>
  )
}

/**
 * Describe the selected graph element for the detail pane.
 * @param view - laid-out board.
 * @param selectedId - node id, stub id, or undefined.
 */
export function selectedDetail(
  view: BoardView,
  selectedId: string | undefined,
): { kicker: string; body: string } | undefined {
  if (selectedId === undefined) return undefined
  const node = view.nodes.find((item) => item.id === selectedId)
  if (node !== undefined) {
    return { kicker: node.id, body: node.supersededBy?.length ? `${node.description}\n\nSuperseded by: ${node.supersededBy.join(', ')}` : node.description }
  }
  const stub = view.stubs.find((item) => item.id === selectedId)
  if (stub !== undefined) {
    const edge = view.edges.find((item) => item.id === stub.intentId)
    return {
      kicker: stub.intentId,
      body: edge === undefined ? stub.description : describeEdge(edge),
    }
  }
  return undefined
}

function describeEdge(edge: GraphEdge): string {
  const lines = [edge.description, `from ${edge.from.join(', ')}`]
  if (edge.to !== null) lines.push(`to ${edge.to}`)
  if (edge.worker !== null) lines.push(`worker ${edge.worker}`)
  return lines.join('\n')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`
}
