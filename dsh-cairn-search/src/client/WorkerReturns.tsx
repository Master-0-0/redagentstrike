import type { BoardView } from '../view.ts'

export function WorkerReturns({ view, selectedId, t }: {
  view: BoardView; selectedId?: string; t: (key: string) => string
}) {
  const intentId = view.intents.find(i => i.id === selectedId)?.intentId
  const records = view.workerReturns.filter(r => !intentId || r.intentId === intentId)
  if (!records.length) return null
  return <section className="dsh-bb-returns">
    <p className="dsh-bb-hints-title">{t('returns.title')}</p>
    {records.map(record => <details key={record.id}>
      <summary>{record.intentId ?? t('returns.unlinked')} · {t(`returns.${record.resolution?.action ?? 'pending'}`)} · {record.createdAt}</summary>
      {record.subagentId && <p>{record.subagentId}</p>}
      <pre>{record.content}</pre>
    </details>)}
  </section>
}
