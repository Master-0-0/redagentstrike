import type { Receipt, Upload } from './types'
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch('/api' + path, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(30000),
    headers: {
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.message ?? body.detail ?? `HTTP ${response.status}`)
  return body
}
export type Prepared = { manifest: Record<string, unknown>; uploads: Upload[] }
export async function prepare(
  manifest: Record<string, unknown>,
  uploads: Upload[],
): Promise<Prepared> {
  if (
    uploads.length > 20 ||
    uploads.some((u) => u.file.size > 20 * 1024 * 1024) ||
    uploads.reduce((n, u) => n + u.file.size, 0) > 100 * 1024 * 1024
  )
    throw new Error('最多 20 个附件，每个 20 MiB，合计 100 MiB。')
  const artifacts = await Promise.all(
    uploads.map(async (u, index) => ({
      client_id: `file-${index}`,
      kind: u.kind,
      filename: u.file.name,
      size: u.file.size,
      sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await u.file.arrayBuffer()))]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join(''),
      media_type: u.file.type || 'application/octet-stream',
      description: u.description || '',
      step_ids: u.step_ids ?? [],
      capture_method: u.capture_method || 'manual_upload',
    })),
  )
  return {
    manifest: { ...manifest, artifacts, submission_key: crypto.randomUUID() },
    uploads: [...uploads],
  }
}
export async function submit(prepared: Prepared): Promise<Receipt> {
  const signal = AbortSignal.timeout(30000)
  const s = await api<{ id: string; received: string[]; receipt: Receipt | null }>(
    '/finding-submissions',
    { method: 'POST', body: JSON.stringify(prepared.manifest), signal },
  )
  if (s.receipt) return s.receipt
  for (const [index, u] of prepared.uploads.entries()) {
    if (s.received.includes(`file-${index}`)) continue
    await api(`/finding-submissions/${s.id}/artifacts/file-${index}`, {
      method: 'PUT',
      headers: { 'content-type': u.file.type || 'application/octet-stream' },
      body: u.file,
      signal,
    })
  }
  return api(`/finding-submissions/${s.id}/commit`, { method: 'POST', signal })
}
export function artifactUrl(fid: string, aid: string, preview = false) {
  return `/api/findings/${encodeURIComponent(fid)}/artifacts/${encodeURIComponent(aid)}${preview ? '?preview=true' : ''}`
}
