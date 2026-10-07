import { Readable } from 'node:stream'
import { join } from 'node:path'
import { ArchiveError, reader } from './artifacts.ts'
import { atomicJSON } from './outbox.ts'

export function endpoint(input: string) {
  const url = new URL(input)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new ArchiveError('invalid_manifest', '归档服务仅允许本机 HTTP API 根地址')
  return url.origin
}
export async function transmit(root: string, box: any, apiUrl: string, signal: AbortSignal) {
  const base = endpoint(apiUrl)
  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch(base + path, { ...options, signal, redirect: 'error' })
    const value = await response.json()
    if (!response.ok)
      throw new ArchiveError(
        value.error_code || 'service_unavailable',
        value.message || `HTTP ${response.status}`,
        value.retryable ?? response.status >= 500,
      )
    return value
  }
  const s = await request('/finding-submissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(box.manifest),
  })
  let receipt = s.receipt
  if (!receipt) {
    for (const a of box.manifest.artifacts) {
      if (s.received.includes(a.client_id)) continue
      const { child, completion } = reader(
        root,
        join(box.path, 'artifacts', a.client_id),
        a.size,
        signal,
      )
      try {
        await request(`/finding-submissions/${s.id}/artifacts/${a.client_id}`, {
          method: 'PUT',
          headers: { 'content-type': a.media_type },
          body: Readable.toWeb(child.stdout),
          duplex: 'half',
        } as RequestInit)
        await completion
      } finally {
        if (child.exitCode === null) child.kill()
      }
    }
    receipt = await request(`/finding-submissions/${s.id}/commit`, { method: 'POST' })
  }
  if (!receipt?.ok) throw new ArchiveError('service_unavailable', '服务未返回 committed 回执', true)
  // A local receipt-write failure must not turn a committed archive into a lie.
  try {
    await atomicJSON(join(box.path, 'result.json'), receipt)
  } catch {
    receipt.warnings = [
      ...(receipt.warnings ?? []),
      '归档已成功，但本地回执写入失败；可使用同一 key 重试查询',
    ]
  }
  return receipt
}
