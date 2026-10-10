/** SVG origin→goal graph for one blackboard snapshot. */

import { useEffect, useId, useRef, useState } from 'react'
import type { BoardView, GraphEdge, GraphNode, GraphIntent } from '../view.ts'
import { edgePath } from '../view.ts'


export interface BlackboardGraphProps {
  readonly view: BoardView
  readonly selectedId: string | undefined
  readonly onSelect: (id: string) => void
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

/**
 * Render the fact-intent graph. Facts and all intents are selectable.
 * @param props - laid-out board plus selection.
 */
export function BlackboardGraph({ view, selectedId, onSelect, t }: BlackboardGraphProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<number | null>(1)
  const [availableWidth, setAvailableWidth] = useState(560)
  const markerId = useId().replace(/:/g, '')
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const scale = zoom ?? Math.min(1, Math.max(0.2, availableWidth / view.width))
  const byId = new Map(view.nodes.map((node) => [node.id, node]))
  const cardByIntent = new Map(view.intents.map((stub) => [stub.intentId, stub]))
  return (
    <div className="dsh-bb-graph">
      <div className="dsh-bb-toolbar">
        <span>{t('canvas.hint')}</span>
        <div className="dsh-bb-zoom">
          <button type="button" aria-label={t('canvas.zoomOut')} disabled={scale <= 0.2} onClick={() => setZoom(Math.max(0.2, scale - 0.15))}>−</button>
          <button type="button" aria-label={t('canvas.actualSize')} onClick={() => setZoom(1)}>{Math.round(scale * 100)}%</button>
          <button type="button" aria-label={t('canvas.zoomIn')} disabled={scale >= 2} onClick={() => setZoom(Math.min(2, scale + 0.15))}>+</button>
          <button type="button" onClick={() => setZoom(null)}>{t('canvas.fit')}</button>
        </div>
      </div>
      <div className="dsh-bb-canvas" ref={viewport}>

      <svg
        width={view.width * scale}
        height={view.height * scale}
        viewBox={`0 0 ${view.width} ${view.height}`}
        role="group"
        aria-label={view.title}
      >
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="context-stroke" strokeWidth="1.5" />
          </marker>
        </defs>
        {view.edges.flatMap((edge) => {
          const intent = cardByIntent.get(edge.id)
          if (intent === undefined) return []
          const highlighted = edge.from.includes(selectedId ?? '') || edge.to === selectedId || intent.id === selectedId
          const segments = edge.from.flatMap((fromId) => {
            const source = byId.get(fromId)
            return source ? [{ key: fromId, source, dest: intent, kind: 'source' }] : []
          })
          const output = edge.to === null ? undefined : byId.get(edge.to)
          return [
            ...segments.map(({ key, source, dest, kind }) => (
              <path key={`${edge.id}:${key}`} className="dsh-bb-edge" data-status={edge.status}
                data-relation={kind} data-highlighted={highlighted || undefined}
                markerEnd={`url(#${markerId})`} d={edgePath(source, dest)} />
            )),
            output && <path key={`${edge.id}:output`} className="dsh-bb-edge" data-status={edge.status}
              data-relation="output" data-highlighted={highlighted || undefined}
              markerEnd={`url(#${markerId})`} d={edgePath(intent, output)} />,
          ]
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
        {view.intents.map((stub) => (
          <IntentCard
            key={stub.id}
            stub={stub}
            selected={selectedId === stub.id}
            onSelect={onSelect}
            kicker={t('kind.intent')}
            statusLabel={t(`intent.${stub.status}`)}
          />
        ))}
      </svg>
      </div>
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
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${kicker}: ${node.description}`}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id) } }}
      onClick={() => { onSelect(node.id) }}
    >
      <title>{`${kicker} ${node.id}: ${node.description}`}</title>
      <rect
        className="dsh-bb-node-card"
        width={node.width}
        height={node.height}
        rx={12}
      />
      <CardContent width={node.width} height={node.height} kicker={kicker} id={node.id} description={node.description} />
    </g>
  )
}

function IntentCard({
  stub, selected, onSelect, kicker, statusLabel,
}: {
  stub: GraphIntent
  statusLabel: string
  kicker: string
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <g
      className="dsh-bb-node dsh-bb-intent"
      data-kind="intent"
      data-status={stub.status}
      data-selected={selected || undefined}
      data-closed={stub.status === 'closed' || undefined}
      transform={`translate(${stub.x} ${stub.y})`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${kicker} ${stub.intentId} · ${statusLabel}: ${stub.description}`}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(stub.id) } }}
      onClick={() => { onSelect(stub.id) }}
    >
      <title>{stub.description}</title>
      <rect
        className="dsh-bb-node-card"
        width={stub.width}
        height={stub.height}
        rx={12}
      />
      <CardContent width={stub.width} height={stub.height} kicker={kicker} id={stub.intentId} description={stub.description} statusLabel={statusLabel} />
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
  const stub = view.intents.find((item) => item.id === selectedId)
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

function CardContent({ width, height, kicker, id, description, statusLabel }: {
  width: number; height: number; kicker: string; id: string; description: string; statusLabel?: string
}) {
  return (
    <foreignObject width={width} height={height}>
      <div className="dsh-bb-card-content">
        <div className="dsh-bb-card-heading"><span>{kicker}</span><code>{id}</code></div>
        <div className="dsh-bb-card-description">{description}</div>
        {statusLabel && <span className="dsh-bb-intent-status">{statusLabel}</span>}
      </div>
    </foreignObject>
  )
}
