import { WorkerReturns } from '@cairn/client/WorkerReturns.tsx'
import { ArchiveForm } from '../findings/ArchiveForm'
import '../findings/findings.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BlackboardGraph, selectedDetail } from '@cairn/client/BlackboardGraph.tsx'
import { zh, type BlackboardKey } from '@cairn/client/locales.ts'
import { ensureStyles } from '@cairn/client/styles.ts'
import type { BoardRead } from '@cairn/view.ts'
import { readBoardText } from '@cairn/view.ts'
import { fetchBlackboardFile, fetchBlackboards } from './api'
import type { BlackboardCatalog, BlackboardListItem, BlackboardWorkspace } from './types'

const POLL_MS = 3_000

type Selection = {
  workspaceId: string
  ownerId: string
}

function t(key: string, params?: Record<string, unknown>): string {
  const template = (zh as Record<BlackboardKey, string>)[key as BlackboardKey] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

function selectionKey(workspaceId: string, ownerId: string): string {
  return `${workspaceId}/${ownerId}`
}

function firstBoard(catalog: BlackboardCatalog): Selection | null {
  for (const workspace of catalog.workspaces) {
    const board = workspace.boards[0]
    if (board) return { workspaceId: workspace.id, ownerId: board.owner_id }
  }
  return null
}

function boardStillPresent(catalog: BlackboardCatalog, selected: Selection): boolean {
  return catalog.workspaces.some((workspace) => (
    workspace.id === selected.workspaceId
    && workspace.boards.some((board) => board.owner_id === selected.ownerId)
  ))
}

function findBoard(
  catalog: BlackboardCatalog,
  selected: Selection,
): { workspace: BlackboardWorkspace; board: BlackboardListItem } | null {
  const workspace = catalog.workspaces.find((item) => item.id === selected.workspaceId)
  const board = workspace?.boards.find((item) => item.owner_id === selected.ownerId)
  if (workspace === undefined || board === undefined) return null
  return { workspace, board }
}

function statusLabel(status: string | null): string {
  if (status === 'active' || status === 'stopped' || status === 'completed') {
    return t(`status.${status}`)
  }
  return status ?? '未知'
}

export function BlackboardPage({ initialSelection }: {initialSelection?: Selection | null}) {
  const [archiving, setArchiving] = useState(false)
  const [catalog, setCatalog] = useState<BlackboardCatalog | null>(null)
  const [selected, setSelected] = useState<Selection | null>(initialSelection ?? null)
  const [snapshot, setSnapshot] = useState<BoardRead | { kind: 'error'; message: string }>()
  const [selectedId, setSelectedId] = useState<string>()
  const [loadingList, setLoadingList] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const refreshList = useCallback(async () => {
    try {
      const next = await fetchBlackboards()
      setCatalog(next)
      setListError(null)
      setSelected((current) => {
        if (current && boardStillPresent(next, current)) return current
        return firstBoard(next)
      })
    } catch (error: unknown) {
      setListError(error instanceof Error && error.message ? error.message : '读取画板列表失败')
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    ensureStyles()
  }, [])

  useEffect(() => {
    void refreshList()
    const timer = window.setInterval(() => { void refreshList() }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshList])

  useEffect(() => {
    if (selected === null) {
      setSnapshot(undefined)
      setSelectedId(undefined)
      return
    }
    setSelectedId(undefined)
    setSnapshot(undefined)
    const controller = new AbortController()
    const pull = (): void => {
      void fetchBlackboardFile(selected.workspaceId, selected.ownerId)
        .then((file) => {
          if (!controller.signal.aborted) setSnapshot(readBoardText(file.text))
        })
        .catch((error: unknown) => {
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
  }, [selected?.workspaceId, selected?.ownerId])

  const selectedMeta = catalog && selected ? findBoard(catalog, selected) : null
  const view = snapshot?.kind === 'ready' ? snapshot.view : undefined
  const detail = view === undefined ? undefined : selectedDetail(view, selectedId)
  const boardCount = useMemo(
    () => catalog?.workspaces.reduce((sum, workspace) => sum + workspace.boards.length, 0) ?? 0,
    [catalog],
  )

  return (
    <section className="page page-blackboard">
      <header className="page-head blackboard-head">
        <div>
          <h1>画板展示</h1>
          <p>追踪每一次探索，串联事实与目标。</p>
        </div>
        <div className="blackboard-head-meta">
          <span>{catalog ? `${boardCount} 份画板` : loadingList ? '正在读取…' : '未连接'}</span>
          {catalog && <span className="blackboard-home" title={catalog.dsh_home}>{catalog.dsh_home}</span>}
        </div>
      </header>

      {listError && (
        <div className="blackboard-alert" role="alert">
          <strong>无法读取工作区画板</strong>
          <span>{listError}</span>
        </div>
      )}

      <div className="blackboard-layout">
        <aside className="blackboard-list" aria-label="会话画板">
          {loadingList && catalog === null && <p className="blackboard-empty">正在扫描工作区…</p>}
          {catalog && catalog.workspaces.length === 0 && (
            <p className="blackboard-empty">
              还没有 DeepSeek Harness 工作区。在 Agent 工作台里添加项目后，注册表会出现在
              {' '}<code>{catalog.dsh_home}/storages/workspace.json</code>。
            </p>
          )}
          {catalog?.workspaces.map((workspace) => (
            <section key={workspace.id} className="blackboard-workspace">
              <header>
                <h2>{workspace.title}</h2>
                <p title={workspace.path}>{workspace.path}</p>
              </header>
              {workspace.boards.length === 0 ? (
                <p className="blackboard-empty">该工作区还没有 <code>.dsh/blackboards</code> 文件。</p>
              ) : workspace.boards.map((board) => {
                const active = selected !== null
                  && selectionKey(workspace.id, board.owner_id) === selectionKey(selected.workspaceId, selected.ownerId)
                return (
                  <button
                    key={board.owner_id}
                    type="button"
                    className={active ? 'blackboard-item is-active' : 'blackboard-item'}
                    onClick={() => setSelected({ workspaceId: workspace.id, ownerId: board.owner_id })}
                  >
                    <span className="blackboard-item-title">{board.title || board.owner_id}</span>
                    <span className="blackboard-item-meta">
                      <span>{statusLabel(board.status)}</span>
                      <span>{board.owner_id}</span>
                    </span>
                  </button>
                )
              })}
            </section>
          ))}
        </aside>

        <div className="blackboard-stage">
          {selected === null && (
            <p className="blackboard-empty">{t('panel.noSession')}</p>
          )}
          {selected !== null && snapshot === undefined && (
            <p className="blackboard-empty">{t('panel.loading')}</p>
          )}
          {snapshot?.kind === 'missing' && <p className="blackboard-empty">{t('panel.empty')}</p>}
          {snapshot?.kind === 'invalid' && (
            <p className="blackboard-alert" role="alert">{t('panel.invalid', { message: snapshot.message })}</p>
          )}
          {snapshot?.kind === 'error' && (
            <p className="blackboard-alert" role="alert">{t('panel.load.error', { message: snapshot.message })}</p>
          )}
          {view !== undefined && (
            <>
              <header className="dsh-bb-header">
                <div className="dsh-bb-title-row">
                  <span className="dsh-bb-title">{view.title}</span>
                  <span className="dsh-bb-status">{t(`status.${view.status}`)}</span>
                </div>
                {selectedMeta && (
                  <div className="dsh-bb-owner">{t('panel.owner', { title: selectedMeta.board.owner_id })}</div>
                )}
                <div className="dsh-bb-meta">
                  <span>{t('meta.facts', { count: view.factCount })}</span>
                  <span>{t('meta.open', { count: view.openCount })}</span>
                  {view.reason !== null && (
                    <span>{t('meta.reasoning', { worker: view.reason.worker })}</span>
                  )}
                </div>
              </header>
              <div className="dsh-bb-body">
                <BlackboardGraph
                  key={selected ? selectionKey(selected.workspaceId, selected.ownerId) : "empty"}
                  view={view}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  t={t}
                />
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
                    {view.nodes.some(n => n.id === selectedId && n.kind === 'fact') && <button onClick={() => setArchiving(true)}>保存到漏洞成果库</button>}
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
              </div>
            </>
          )}
        </div>
      </div>
      {archiving && detail && selectedMeta && selected && selectedId && <ArchiveForm draft={{finding:{title:'',summary:detail.body},source:{source_type:'manual',workspace_id:selected.workspaceId,workspace_path:selectedMeta.workspace.path,owner_session_id:selected.ownerId.replace(/~([0-9A-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),owner_resolution:'resolved',fact_snapshots:[{id:selectedId,description:detail.body}]}}} onClose={() => setArchiving(false)} onSaved={() => {}} />}
    </section>
  )
}
