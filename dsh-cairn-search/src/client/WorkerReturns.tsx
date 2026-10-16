import type { BoardView } from '../view.ts'
import type { WorkerReturn } from '../types.ts'
import { useState } from 'react'

export function WorkerReturns({ view, selectedId, t, loadReturn }: {
  view: BoardView; selectedId?: string; t: (key: string) => string
  loadReturn?: (record: WorkerReturn) => Promise<string>
}) {
  const intentId = view.intents.find(i => i.id === selectedId)?.intentId
  const records = view.workerReturns.filter(r => !intentId || r.intentId === intentId)
  if (!records.length) return null
  return <section className="dsh-bb-returns">
    <p className="dsh-bb-hints-title">{t('returns.title')}</p>
    {records.map(record => <details key={record.id}>
      <summary>{record.intentId ?? t('returns.unlinked')} · {t(`returns.${record.resolution?.action ?? 'pending'}`)} · {record.createdAt}</summary>
      {record.subagentId && <p>{record.subagentId}</p>}
      <ReturnContent record={record} loadReturn={loadReturn} t={t} />
    </details>)}
  </section>
}

function ReturnContent({ record, loadReturn, t }: { record: WorkerReturn; loadReturn?: (record: WorkerReturn) => Promise<string>; t: (key: string) => string }) {
  const [content, setContent] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [limit, setLimit] = useState(6000)
  const text = content ?? record.content
  return <>
    <pre>{text.slice(0, limit)}</pre>
    {text.length > limit && <button onClick={() => setLimit(limit + 6000)}>{t('returns.more')}</button>}
    {record.contentRef && content === undefined && loadReturn && <button disabled={busy} onClick={() => {
      setBusy(true); setError(undefined)
      void loadReturn(record).then(setContent).catch(e => setError(String(e))).finally(() => setBusy(false))
    }}>{t('returns.load')}</button>}
    {error && <p role="alert">{error}</p>}
  </>
}
