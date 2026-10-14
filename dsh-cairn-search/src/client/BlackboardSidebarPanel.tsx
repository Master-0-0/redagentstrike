import { WorkerReturns } from './WorkerReturns.tsx'
/**
 * Sidebar-foot blackboard entry: opens a graph of the selected session's
 * owned board (`.dsh/blackboards/<main-session-id>.json`), stacked above 子代理.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Tooltip,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { boardOwnerFromList, type SessionLineage } from '../owner.ts'
import type { BoardView } from '../view.ts'
import { BlackboardGraph, selectedDetail } from './BlackboardGraph.tsx'
import type { BoardSnapshot } from './rpc.ts'

const PANEL_GAP = 8
const POLL_MS = 1500

export interface SessionListSlice {
  current?: string
  byId: Record<string, SessionLineage & { displayTitle?: string }>
  subagentsByParent?: Record<string, { entries: readonly { kind: string; id: string }[] }>
}

export interface BlackboardSidebarPanelFace {
  readBoard(sessionId: string, ownerId: string, signal: AbortSignal): Promise<BoardSnapshot>
}

export interface BlackboardSidebarPanelProps {
  wide: boolean
  useSessions: <T>(selector: (state: SessionListSlice) => T) => T
  t: (key: string, params?: Record<string, unknown>) => string
  readBoard: (sessionId: string, ownerId: string, signal: AbortSignal) => Promise<BoardSnapshot>
}

/**
 * Render the blackboard footer control and the graph it opens above itself.
 * @param props - column geometry, session selector, copy, and the bound read.
 */
export function BlackboardSidebarPanel({
  wide, useSessions, t, readBoard,
}: BlackboardSidebarPanelProps) {
  const current = useSessions((state) => state.current)
  const byId = useSessions((state) => state.byId) ?? {}
  const catalogs = useSessions((state) => state.subagentsByParent)
  const ownerId = useMemo(() => {
    try {
      return boardOwnerFromList({
        current,
        byId,
        ...catalogs !== undefined ? { subagentsByParent: catalogs } : {},
      })
    } catch {
      return current
    }
  }, [byId, catalogs, current])
  const ownerTitle = ownerId === undefined ? undefined : byId[ownerId]?.displayTitle
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number }>()
  const [snapshot, setSnapshot] = useState<BoardSnapshot>()
  const [selectedId, setSelectedId] = useState<string>()
  const rootRef = useRef<HTMLDivElement>(null)
  const readRef = useRef(readBoard)
  readRef.current = readBoard

  useEffect(() => {
    setSelectedId(undefined)
    if (!open || current === undefined || ownerId === undefined) {
      setSnapshot(undefined)
      return
    }
    setSnapshot(undefined)
    const controller = new AbortController()
    const pull = (): void => {
      void readRef.current(current, ownerId, controller.signal).then((next) => {
        if (!controller.signal.aborted) setSnapshot(next)
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        setSnapshot({ kind: 'error', message })
      })
    }
    pull()
    const timer = window.setInterval(pull, POLL_MS)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [current, ownerId, open])

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + PANEL_GAP })
    }
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [open])

  useDismissOnOutsidePointer(rootRef, open, setOpen)

  const view = snapshot?.kind === 'ready' ? snapshot.view : undefined
  const statusKey = view === undefined ? 'status.active' : `status.${view.status}`
  const statusLabel = t(statusKey)
  const detail = view === undefined ? undefined : selectedDetail(view, selectedId)

  return (
    <div ref={rootRef} className={wide ? 'dsh-bb-layer' : 'dsh-bb-layer dsh-bb-rail'}>
      {open && anchor !== undefined && (
        <section
          className="dsh-bb-panel"
          style={anchor}
          data-blackboard-panel
          data-blackboard-owner={ownerId}
          aria-label={t('panel.title')}
        >
          <header className="dsh-bb-header">
            <div className="dsh-bb-title-row">
              <span className="dsh-bb-title">{view?.title ?? t('panel.title')}</span>
              {view !== undefined && <span className="dsh-bb-status">{statusLabel}</span>}
            </div>
            {ownerTitle !== undefined && (
              <div className="dsh-bb-owner">{t('panel.owner', { title: ownerTitle })}</div>
            )}
            {view !== undefined && (
              <div className="dsh-bb-meta">
                <span>{t('meta.facts', { count: view.factCount })}</span>
                <span>{t('meta.open', { count: view.openCount })}</span>
                {view.reason !== null && (
                  <span>{t('meta.reasoning', { worker: view.reason.worker })}</span>
                )}
              </div>
            )}
          </header>
          <div className="dsh-bb-body">
            {panelBody({ current, snapshot, view, selectedId, setSelectedId, t, detail })}
          </div>
        </section>
      )}
      <Tooltip label={t('panel.trigger')} delayMs={500} disabled={wide}>
        <button
          type="button"
          className="dsh-bb-trigger"
          data-blackboard-open={open || undefined}
          data-active={open || undefined}
          aria-label={t('panel.aria', { status: statusLabel })}
          aria-expanded={open}
          onClick={() => { setOpen((value) => !value) }}
        >
          <BlackboardIcon size={wide ? 16 : 18} />
          {wide && (
            <>
              <span className="dsh-bb-trigger-label">{t('panel.trigger')}</span>
              {view !== undefined && (
                <span className="dsh-bb-trigger-meta">{view.factCount}</span>
              )}
            </>
          )}
          {!wide && view !== undefined && view.openCount > 0 && (
            <span className="dsh-bb-rail-dot" aria-hidden="true" />
          )}
        </button>
      </Tooltip>
    </div>
  )
}

function panelBody({
  current, snapshot, view, selectedId, setSelectedId, t, detail,
}: {
  current: string | undefined
  snapshot: BoardSnapshot | undefined
  view: BoardView | undefined
  selectedId: string | undefined
  setSelectedId: (id: string) => void
  t: BlackboardSidebarPanelProps['t']
  detail: { kicker: string; body: string } | undefined
}) {
  if (current === undefined) return <p className="dsh-bb-note">{t('panel.noSession')}</p>
  if (snapshot === undefined) return <p className="dsh-bb-note">{t('panel.loading')}</p>
  if (snapshot.kind === 'missing') return <p className="dsh-bb-note">{t('panel.empty')}</p>
  if (snapshot.kind === 'invalid') {
    return <p className="dsh-bb-error" role="alert">{t('panel.invalid', { message: snapshot.message })}</p>
  }
  if (snapshot.kind === 'error') {
    return <p className="dsh-bb-error" role="alert">{t('panel.load.error', { message: snapshot.message })}</p>
  }
  if (view === undefined) return null
  return (
    <>
      <BlackboardGraph view={view} selectedId={selectedId} onSelect={setSelectedId} t={t} />
      <div className="dsh-bb-legend">
        <span><span className="dsh-bb-swatch origin" />{t('legend.origin')}</span>
        <span><span className="dsh-bb-swatch" />{t('legend.fact')}</span>
        <span><span className="dsh-bb-swatch goal" />{t('legend.goal')}</span>
        <span><span className="dsh-bb-swatch intent" />{t('kind.intent')}</span>
      </div>
      {detail !== undefined && (
        <div className="dsh-bb-detail">
          <p className="dsh-bb-detail-kicker">{detail.kicker}</p>
          <p className="dsh-bb-detail-body">{detail.body}</p>
        </div>
      )}
      <WorkerReturns view={view} selectedId={selectedId} t={t} />
      {view.hints.length > 0 && (
        <div className="dsh-bb-hints">
          <p className="dsh-bb-hints-title">{t('detail.hint')}</p>
          {view.hints.map((hint) => (
            <p key={hint.id} className="dsh-bb-hint">{hint.content}</p>
          ))}
        </div>
      )}
    </>
  )
}

function BlackboardIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M4 6.5h8M4 9.5h5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}
