import { useEffect, useRef, useState } from 'react'
import { fetchHostPolicy, saveHostPolicy } from './api'

export function HostPolicySettings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [whitelist, setWhitelist] = useState('')
  const [blacklist, setBlacklist] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    dialog.current?.showModal()
    let cancelled = false
    fetchHostPolicy().then((policy) => {
      if (cancelled) return
      setWhitelist(policy.whitelist.join('\n'))
      setBlacklist(policy.blacklist.join('\n'))
      setLoaded(true)
    }).catch(() => {
      if (!cancelled) setError('读取配置失败，请关闭后重试。')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const save = async () => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const policy = await saveHostPolicy(whitelist, blacklist)
      setWhitelist(policy.whitelist.join('\n'))
      setBlacklist(policy.blacklist.join('\n'))
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally { setSaving(false) }
  }

  return (
    <dialog ref={dialog} className="nt-settings" aria-labelledby="host-settings-title"
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose() }}>
      <header className="nt-settings-head">
        <h2 id="host-settings-title">网络时间线设置</h2>
        <button type="button" className="btn-ghost" disabled={saving} onClick={onClose}>关闭</button>
      </header>
      <p>按 host 放行或拦截经捕获代理的 HTTP(S) 请求。保存后对新请求立即生效，无需重启工作台。</p>
      <p id="host-rule-help">每行一项，也可用逗号分隔。域名或 IP 精确匹配；以点开头的后缀匹配根域名及全部子域名，例如 <code>.gov.cn, .edu.cn</code>。不填写协议、端口或路径。</p>
      <p>白名单是捕获排除名单：命中的请求正常放行，不进入人工拦截队列，也不记录到网络时间线。未命中的请求按“捕获／拦截”开关处理。黑名单优先，命中黑名单仍阻断请求。已有历史记录保留。本地工作台控制接口不受影响，未经过捕获代理的流量不受此规则控制。</p>
      <div className="nt-settings-fields">
        <label>白名单
          <textarea aria-label="白名单" aria-describedby="host-rule-help" rows={12} value={whitelist} disabled={loading || saving || !loaded}
            placeholder={'.gov.cn\n.edu.cn\napi.example.com'} spellCheck={false}
            onChange={(e) => { setWhitelist(e.target.value); setSaved(false) }} />
        </label>
        <label>黑名单
          <textarea aria-label="黑名单" aria-describedby="host-rule-help" rows={12} value={blacklist} disabled={loading || saving || !loaded}
            placeholder={'.blocked.example\ntracker.example.com'} spellCheck={false}
            onChange={(e) => { setBlacklist(e.target.value); setSaved(false) }} />
        </label>
      </div>
      <footer className="nt-settings-footer">
        <div aria-live="polite">{loading ? '正在读取配置…' : error ? <span role="alert">{error}</span> : saved ? '已保存，对新请求生效。' : '清空两份名单并保存，可恢复全部放行。'}</div>
        <button type="button" className="btn-primary" disabled={loading || saving || !loaded} onClick={() => void save()}>{saving ? '保存中…' : '保存设置'}</button>
      </footer>
    </dialog>
  )
}
