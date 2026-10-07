import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { reviews, severities, type FindingCard } from './types'

export function ExportReport({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ items: FindingCard[]; total: number } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState('docx')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void api<{ items: FindingCard[]; total: number }>(
      '/findings?' + new URLSearchParams({ q: query, page: String(page) }),
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) setData(value)
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [query, page, retry])
  function toggle(id: string) {
    setSelected((old) => {
      const next = new Set(old)
      if (next.has(id)) next.delete(id)
      else if (next.size < 100) next.add(id)
      return next
    })
  }
  async function download() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/findings/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ finding_ids: [...selected], format }),
        signal: AbortSignal.timeout(120000),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.message ?? body.detail ?? `导出失败（HTTP ${response.status}）`)
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `漏洞成果报告-${new Date().toISOString().slice(0, 10)}.${format}`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败，请重试')
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="findings-dialog findings-export"
      aria-labelledby="export-title"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onClose()
      }}
    >
      <header>
        <h2 id="export-title">导出报告</h2>
        <button disabled={busy} onClick={onClose} aria-label="关闭导出报告">
          关闭
        </button>
      </header>
      <p>
        勾选要导出的成果，合并为一份报告。包含漏洞说明、复现步骤、状态、文本和图片证据。超长文本展示前 64 KiB，其他附件可在成果详情中下载。
      </p>
      <input
        aria-label="搜索导出成果"
        placeholder="搜索标题、目标或摘要…"
        value={query}
        disabled={busy}
        onChange={(e) => {
          setQuery(e.target.value)
          setPage(1)
        }}
      />
      <div className="findings-actions">
        <button
          disabled={loading || busy || !data?.items.length}
          onClick={() =>
            setSelected((old) => new Set([...old, ...data!.items.map((f) => f.id)].slice(0, 100)))
          }
        >
          全选本页
        </button>
        <button disabled={busy || !selected.size} onClick={() => setSelected(new Set())}>
          清空选择
        </button>
        <span role="status">已选 {selected.size} 项 / 最多 100 项（跨页保留）</span>
      </div>
      {loading ? (
        <p role="status">正在加载成果…</p>
      ) : (
        <div className="findings-export-list">
          {data?.items.map((f) => (
            <label key={f.id} className="findings-export-row">
              <input
                type="checkbox"
                aria-label={`选择 ${f.title}`}
                checked={selected.has(f.id)}
                disabled={busy || (!selected.has(f.id) && selected.size >= 100)}
                onChange={() => toggle(f.id)}
              />
              <span>
                <strong>{f.title}</strong>
                <span>{f.target}</span>
                <small>
                  {severities[f.severity]} · {reviews[f.review_status]}
                </small>
              </span>
            </label>
          ))}
          {data?.items.length === 0 && <p>暂无符合条件的成果</p>}
        </div>
      )}
      <nav className="findings-pagination" aria-label="导出成果分页">
        <button disabled={loading || busy || page === 1} onClick={() => setPage(page - 1)}>
          上一页
        </button>
        <span>
          第 {page} / {Math.max(1, Math.ceil((data?.total ?? 0) / 20))} 页
        </span>
        <button
          disabled={loading || busy || page * 20 >= (data?.total ?? 0)}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </button>
      </nav>
      {error && (
        <p className="findings-error" role="alert">
          {error}{' '}
          <button disabled={busy} onClick={() => setRetry(retry + 1)}>
            重新加载列表
          </button>
        </p>
      )}
      <footer className="findings-actions">
        <label>
          报告格式{' '}
          <select
            aria-label="报告格式"
            value={format}
            disabled={busy}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="docx">Word 文档（DOCX）</option>
            <option value="pdf">PDF 文档</option>
          </select>
        </label>
        <button
          className="findings-primary"
          disabled={busy || !selected.size}
          onClick={() => void download()}
        >
          {busy ? '正在生成…' : `导出 ${selected.size} 项成果`}
        </button>
      </footer>
    </dialog>
  )
}
