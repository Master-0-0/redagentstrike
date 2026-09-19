import { useCallback, useEffect, useRef, useState } from 'react'
import { decideApproval, fetchApprovalRules, putApprovalRules } from './api'
import type { ApprovalOutcome, ApprovalPayload, ApprovalRule } from './types'

type ApprovalPageProps = {
  payload: ApprovalPayload | null
  loading: boolean
  error: string | null
  onRefresh: () => Promise<void>
}

export function ApprovalPage(props: ApprovalPageProps) {
  const [now, setNow] = useState(Date.now())
  const [deciding, setDeciding] = useState<Set<string>>(() => new Set())
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const decidingRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const onDecision = async (eventId: string, outcome: ApprovalOutcome) => {
    if (decidingRef.current.has(eventId)) return
    decidingRef.current.add(eventId)
    setDeciding(new Set(decidingRef.current))
    setDecisionError(null)
    try {
      await decideApproval(eventId, outcome)
      await props.onRefresh()
    } catch (error) {
      setDecisionError(errorText(error, outcome === 'allowed-once' ? '单次放行失败' : '拒绝失败'))
    } finally {
      decidingRef.current.delete(eventId)
      setDeciding(new Set(decidingRef.current))
    }
  }

  const bridge = props.payload?.bridge
  const pending = props.payload?.pending ?? []

  return (
    <section className="page page-approval">
      <header className="approval-head">
        <div>
          <h1>Hook 审批</h1>
          <p>DeepSeek Harness 命中高危规则后会停在这里，等待单次放行或拒绝。</p>
        </div>
        <div className="approval-head-status">
          <span className={`approval-status ${bridge?.connected ? 'is-on' : 'is-off'}`}>
            <span className="approval-status-dot" />
            {bridge?.connected ? 'Hook 已连接' : props.loading ? '正在连接' : 'Hook 未连接'}
          </span>
          <span className="approval-count">等待 {props.payload?.pending_count ?? pending.length}</span>
        </div>
      </header>

      {props.error && (
        <div className="approval-alert is-error" role="alert">
          <div>
            <strong>{props.payload ? '审批服务连接中断' : '审批服务离线'}</strong>
            <span>{props.error}。{props.payload ? '保留上次队列，正在每秒重连。' : '正在每秒重连。'}</span>
          </div>
          <button type="button" className="btn-ghost" onClick={() => void props.onRefresh()}>立即重试</button>
        </div>
      )}

      {!props.error && bridge && !bridge.connected && (
        <div className="approval-alert is-warning" role="status">
          <div>
            <strong>Hook 桥未连接</strong>
            <span>{bridge.error || '前端服务在线，但还没有连上 DeepSeek Harness Hook。连接恢复后队列会自动刷新。'}</span>
          </div>
        </div>
      )}

      {decisionError && <p className="approval-notice is-error" role="alert">{decisionError}</p>}

      <div className="approval-layout">
        <div className="approval-queue">
          <div className="approval-section-title">
            <div>
              <h2>等待确认</h2>
              <p>放行只对当前工具调用生效，不会修改规则。</p>
            </div>
          </div>

          {props.loading && !props.payload ? (
            <ApprovalEmpty title="正在读取审批队列…" body="连接建立后，待审批调用会出现在这里。" busy />
          ) : pending.length === 0 ? (
            <ApprovalEmpty
              title={bridge?.connected ? '没有等待审批' : '队列暂不可用'}
              body={bridge?.connected
                ? '命中规则的工具调用会自动出现在这里。'
                : 'Hook 重连后会自动读取待审批调用。'}
            />
          ) : (
            <div className="approval-cards">
              {pending.map((item) => {
                const busy = deciding.has(item.event_id)
                return (
                  <article className="approval-card" key={item.event_id}>
                    <header className="approval-card-head">
                      <div>
                        <span className="approval-eyebrow">DeepSeek session</span>
                        <strong className="approval-session">{item.session_id}</strong>
                      </div>
                      <span className="approval-wait">{formatWait(item.created_at, now)}</span>
                    </header>

                    <dl className="approval-meta">
                      <div><dt>工具</dt><dd>{item.tool_name}</dd></div>
                      {item.call_id && <div><dt>Call ID</dt><dd className="mono">{item.call_id}</dd></div>}
                      <div><dt>提交时间</dt><dd>{formatCreatedAt(item.created_at)}</dd></div>
                    </dl>

                    <div className="approval-block">
                      <span>完整命令</span>
                      <pre>{item.command || '（空命令）'}</pre>
                    </div>

                    <div className="approval-block">
                      <span>匹配规则</span>
                      <div className="approval-rule-tags">
                        {item.matched_rules.length > 0
                          ? item.matched_rules.map((rule, index) => <code key={`${rule}-${index}`}>{rule}</code>)
                          : <em>后端未返回规则名</em>}
                      </div>
                    </div>

                    {item.reason && (
                      <div className="approval-reason">
                        <strong>拦截原因</strong>
                        <p>{item.reason}</p>
                      </div>
                    )}

                    <footer className="approval-card-actions">
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={busy}
                        onClick={() => void onDecision(item.event_id, 'allowed-once')}
                      >
                        {busy ? '正在提交…' : '单次放行'}
                      </button>
                      <button
                        type="button"
                        className="approval-reject"
                        disabled={busy}
                        onClick={() => void onDecision(item.event_id, 'rejected')}
                      >
                        拒绝
                      </button>
                    </footer>
                  </article>
                )
              })}
            </div>
          )}
        </div>

        <RuleEditor />
      </div>
    </section>
  )
}

function RuleEditor() {
  const [rules, setRules] = useState<ApprovalRule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchApprovalRules()
      setRules(result.rules)
    } catch (loadError) {
      setError(errorText(loadError, '读取规则失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const update = (index: number, patch: Partial<ApprovalRule>) => {
    setRules((current) => current.map((rule, ruleIndex) => (
      ruleIndex === index ? { ...rule, ...patch } : rule
    )))
    setNotice(null)
  }

  const add = () => {
    setRules((current) => [...current, {
      id: makeRuleId(),
      label: '新审批规则',
      kind: 'command',
      value: '',
      enabled: true,
    }])
    setNotice(null)
  }

  const remove = (index: number) => {
    setRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index))
    setNotice(null)
  }

  const save = async () => {
    const emptyIndex = rules.findIndex((rule) => !rule.value.trim())
    if (emptyIndex >= 0) {
      setError(`第 ${emptyIndex + 1} 条规则的匹配内容不能为空。`)
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const result = await putApprovalRules(rules.map((rule) => ({
        ...rule,
        label: rule.label.trim(),
        value: rule.value.trim(),
      })))
      setRules(result.rules)
      setNotice('规则已保存。后续工具调用会使用新规则。')
    } catch (saveError) {
      setError(errorText(saveError, '保存规则失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <aside className="approval-rules">
      <div className="approval-section-title">
        <div>
          <h2>审批规则</h2>
          <p>设置哪些命令需要停下来确认。</p>
        </div>
        <button type="button" className="btn-ghost" disabled={saving} onClick={add}>新增</button>
      </div>

      {error && (
        <div className="approval-rule-error" role="alert">
          <span>{error}</span>
          {!loading && rules.length === 0 && (
            <button type="button" onClick={() => void load()}>重试</button>
          )}
        </div>
      )}
      {notice && <p className="approval-notice is-ok" role="status">{notice}</p>}

      {loading ? (
        <div className="approval-rules-empty">正在读取规则…</div>
      ) : rules.length === 0 && error ? (
        <div className="approval-rules-empty">规则服务暂不可用。</div>
      ) : rules.length === 0 ? (
        <div className="approval-rules-empty">还没有规则。新增后填写匹配内容并保存。</div>
      ) : (
        <div className="approval-rule-list">
          {rules.map((rule, index) => (
            <div className="approval-rule-row" key={`${rule.id}-${index}`}>
              <div className="approval-rule-top">
                <label className="approval-switch">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(event) => update(index, { enabled: event.target.checked })}
                  />
                  <span>{rule.enabled ? '启用' : '停用'}</span>
                </label>
                <button type="button" className="approval-delete" onClick={() => remove(index)}>删除</button>
              </div>
              <label>
                <span>名称</span>
                <input
                  value={rule.label}
                  onChange={(event) => update(index, { label: event.target.value })}
                  placeholder="例如：删除命令"
                />
              </label>
              <div className="approval-rule-match">
                <label>
                  <span>类型</span>
                  <select
                    value={rule.kind}
                    onChange={(event) => update(index, { kind: event.target.value as ApprovalRule['kind'] })}
                  >
                    <option value="command">命令</option>
                    <option value="regex">正则</option>
                  </select>
                </label>
                <label className="approval-rule-value">
                  <span>{rule.kind === 'regex' ? '正则表达式' : '命令内容'}</span>
                  <input
                    value={rule.value}
                    onChange={(event) => update(index, { value: event.target.value })}
                    placeholder={rule.kind === 'regex' ? '^rm\\s+-rf' : 'rm -rf'}
                    spellCheck={false}
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="approval-rule-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={loading || saving}
          onClick={() => void save()}
        >
          {saving ? '正在保存…' : '保存规则'}
        </button>
      </div>
    </aside>
  )
}

function ApprovalEmpty(props: { title: string; body: string; busy?: boolean }) {
  return (
    <div className={`approval-empty${props.busy ? ' is-busy' : ''}`}>
      <span className="approval-empty-icon" aria-hidden="true" />
      <h3>{props.title}</h3>
      <p>{props.body}</p>
    </div>
  )
}

function makeRuleId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function formatWait(createdAt: string, now: number): string {
  const started = Date.parse(createdAt)
  if (!Number.isFinite(started)) return '等待时间未知'
  const seconds = Math.max(0, Math.floor((now - started) / 1_000))
  if (seconds < 60) return `已等待 ${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return `已等待 ${minutes} 分 ${rest} 秒`
  const hours = Math.floor(minutes / 60)
  return `已等待 ${hours} 小时 ${minutes % 60} 分`
}

function formatCreatedAt(createdAt: string): string {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.getTime())) return createdAt || '—'
  return date.toLocaleString('zh-CN', { hour12: false })
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
