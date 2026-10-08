import { useRef, useState } from 'react'
import { prepare, submit, type Prepared } from './api'
import {
  kinds,
  severities,
  type Draft,
  type FindingInput,
  type Gap,
  type Upload,
  type Receipt,
} from './types'
const blank: FindingInput = {
  title: '',
  target: '',
  summary: '',
  severity: 'unknown',
  preconditions: '尚未确认',
  steps: [{ id: 'step-1', description: '查看已有材料' }],
  expected_result: '尚未确认',
  actual_result: '尚未确认',
  agent_assessment: 'suspected',
}
const categories: Record<string, string> = {
  poc: 'PoC',
  http: 'HTTP',
  screenshot: '截图',
  tool_output: '工具输出',
}

export function ArchiveForm({
  draft = {},
  onClose,
  onSaved,
  findingId,
}: {
  draft?: Draft
  onClose: () => void
  onSaved: (r: Receipt) => void
  findingId?: string
}) {
  const [finding, setFinding] = useState<FindingInput>({ ...blank, ...draft.finding })
  const [uploads, setUploads] = useState<Upload[]>(draft.uploads ?? [])
  const [note, setNote] = useState('')
  const [gaps, setGaps] = useState<Record<string, { status: string; reason: string }>>(
    Object.fromEntries(
      Object.keys(categories).map((c) => [c, { status: 'missing', reason: '尚未采集，待补充' }]),
    ),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const prepared = useRef<Prepared | null>(null)
  const [frozen, setFrozen] = useState(false)
  const [networkText, setNetworkText] = useState(
    (draft.network_refs ?? []).map((r) => `${r.event_id} ${r.run_id}`).join('\n'),
  )
  const [resolved, setResolved] = useState('')
  const present = (category: string) =>
    uploads.some((u) =>
      category === 'http'
        ? u.kind.startsWith('http_')
        : category === 'screenshot'
          ? u.kind.endsWith('_screenshot')
          : u.kind === category,
    ) ||
    (category === 'http' && !!networkText.trim())
  function field(key: keyof FindingInput, label: string, multi = true) {
    return (
      <label>
        {label}
        {multi ? (
          <textarea
            aria-label={label}
            required
            value={String(finding[key])}
            onChange={(e) => setFinding({ ...finding, [key]: e.target.value })}
          />
        ) : (
          <input
            aria-label={label}
            required
            value={String(finding[key])}
            onChange={(e) => setFinding({ ...finding, [key]: e.target.value })}
          />
        )}
      </label>
    )
  }
  async function save() {
    setBusy(true)
    setError('')
    try {
      if (!prepared.current) {
        const evidence_gaps: Gap[] = Object.entries(gaps)
          .filter(([c]) => !present(c))
          .map(([category, g]) => ({ category, ...g }))
        const network_refs = networkText.trim()
          ? networkText
              .trim()
              .split('\n')
              .map((line) => {
                const [event_id, run_id, extra] = line.trim().split(/\s+/)
                if (!event_id || !run_id || extra)
                  throw new Error('网络引用每行必须是 event_id run_id。')
                return { event_id, run_id }
              })
          : []
        prepared.current = await prepare(
          {
            op: findingId ? 'append' : 'create',
            ...(findingId
              ? {
                  finding_id: findingId,
                  note,
                  resolved_gap_ids: resolved.split(/\s+/).filter(Boolean),
                }
              : { finding }),
            source: draft.source ?? { source_type: 'manual' },
            evidence_gaps: findingId ? [] : evidence_gaps,
            network_refs,
          },
          uploads,
        )
        setFrozen(true)
      }
      const result = await submit(prepared.current)
      setReceipt(result)
      onSaved(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : '归档失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="findings-overlay">
      <section
        className="findings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={findingId ? '追加证据' : '保存到漏洞成果库'}
      >
        <header>
          <h2>{findingId ? '追加证据' : '保存到漏洞成果库'}</h2>
          <button disabled={busy} onClick={onClose} aria-label="关闭归档表单">
            关闭
          </button>
        </header>
        {receipt ? (
          <div role="status">
            <h3>{findingId ? '追加成功 · 人工状态保持不变' : '归档成功 · 待人工核对'}</h3>
            <p className="mono">{receipt.finding_id}</p>
            {receipt.warnings?.map((w) => (
              <p key={w}>{w}</p>
            ))}
            <button onClick={onClose}>完成</button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <p>只保存已有材料。模板命中和 Agent 判断均不等于人工确认。</p>
            <fieldset disabled={busy || frozen}>
              {!findingId ? (
                <>
                  <div className="findings-fields">
                    {field('title', '漏洞标题', false)}
                    {field('target', '目标', false)}
                    <label>
                      风险
                      <select
                        value={finding.severity}
                        onChange={(e) => setFinding({ ...finding, severity: e.target.value })}
                      >
                        {Object.entries(severities).map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      提交方判断
                      <select
                        value={finding.agent_assessment}
                        onChange={(e) =>
                          setFinding({ ...finding, agent_assessment: e.target.value })
                        }
                      >
                        <option value="suspected">疑似</option>
                        <option value="reproduced">报告已复现（仍待复核）</option>
                      </select>
                    </label>
                  </div>
                  {field('summary', '漏洞摘要')}
                  {field('preconditions', '利用前提')}
                  <label>
                    复现步骤（每行一步）
                    <textarea
                      required
                      value={finding.steps.map((s) => s.description).join('\n')}
                      onChange={(e) =>
                        setFinding({
                          ...finding,
                          steps: e.target.value
                            .split('\n')
                            .map((description, i) => ({ id: `step-${i + 1}`, description })),
                        })
                      }
                    />
                  </label>
                  {field('expected_result', '预期结果')}
                  {field('actual_result', '实际结果')}
                </>
              ) : (
                <>
                  <label>
                    补充说明
                    <textarea required value={note} onChange={(e) => setNote(e.target.value)} />
                  </label>
                  <label>
                    解决的缺口 ID（空格分隔，可选）
                    <input value={resolved} onChange={(e) => setResolved(e.target.value)} />
                  </label>
                </>
              )}
              <h3>证据附件</h3>
              <p>20 个文件以内，每文件 20 MiB；附件将保存原始内容。</p>
              <input
                aria-label="添加证据文件"
                type="file"
                multiple
                onChange={(e) => {
                  setUploads([
                    ...uploads,
                    ...Array.from(e.target.files ?? []).map((file) => ({
                      file,
                      kind: 'attachment' as const,
                    })),
                  ])
                  e.target.value = ''
                }}
              />
              {uploads.map((u, i) => (
                <div className="findings-upload" key={i}>
                  <strong>{u.file.name}</strong>
                  <span>{u.file.size} B</span>
                  <select
                    aria-label={`${u.file.name} 证据类型`}
                    value={u.kind}
                    onChange={(e) =>
                      setUploads(
                        uploads.map((item, n) =>
                          n === i ? { ...item, kind: e.target.value as Upload['kind'] } : item,
                        ),
                      )
                    }
                  >
                    {Object.entries(kinds)
                      .filter(([k]) => k !== 'http_snapshot')
                      .map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                  </select>
                  <input
                    aria-label={`${u.file.name} 关联步骤`}
                    placeholder="关联步骤 ID，如 step-1"
                    value={u.step_ids?.join(' ') ?? ''}
                    onChange={(e) =>
                      setUploads(
                        uploads.map((item, n) =>
                          n === i
                            ? { ...item, step_ids: e.target.value.split(/\s+/).filter(Boolean) }
                            : item,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() => setUploads(uploads.filter((_, n) => n !== i))}
                  >
                    移除
                  </button>
                </div>
              ))}
              <label>
                网络引用（每行 event_id run_id，可选）
                <textarea value={networkText} onChange={(e) => setNetworkText(e.target.value)} />
              </label>
              {!findingId && (
                <>
                  <h3>材料缺口</h3>
                  {Object.entries(categories)
                    .filter(([c]) => !present(c))
                    .map(([c, label]) => (
                      <div className="findings-gap" key={c}>
                        <span>{label}</span>
                        <select
                          aria-label={`${label}缺口状态`}
                          value={gaps[c].status}
                          onChange={(e) =>
                            setGaps({ ...gaps, [c]: { ...gaps[c], status: e.target.value } })
                          }
                        >
                          <option value="missing">未采集</option>
                          <option value="not_applicable">不适用</option>
                        </select>
                        <input
                          required
                          aria-label={`${label}缺口原因`}
                          value={gaps[c].reason}
                          onChange={(e) =>
                            setGaps({ ...gaps, [c]: { ...gaps[c], reason: e.target.value } })
                          }
                        />
                      </div>
                    ))}
                </>
              )}
              {draft.source?.fact_snapshots?.map((f) => (
                <blockquote key={f.id}>
                  {f.id} · {f.description}
                </blockquote>
              ))}
            </fieldset>
            {error && (
              <p className="findings-error" role="alert">
                {error}。
                {frozen &&
                  '待提交材料已保留在此表单，可重试同一提交；关闭页面会丢失未完成的本地表单。'}
              </p>
            )}
            <footer>
              <button type="submit" disabled={busy}>
                {busy
                  ? '上传并归档中…'
                  : frozen
                    ? '重试同一提交'
                    : findingId
                      ? '追加材料'
                      : '保存为待复核成果'}
              </button>
              {frozen && !busy && (
                <button
                  type="button"
                  onClick={() => {
                    prepared.current = null
                    setFrozen(false)
                  }}
                >
                  修改输入，创建新提交
                </button>
              )}
            </footer>
          </form>
        )}
      </section>
    </div>
  )
}
