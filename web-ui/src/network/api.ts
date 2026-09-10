import type { NetworkEvent, NetworkPayload, ReplayResult, RequestDraft } from './types'

const jsonHeaders = { 'Content-Type': 'application/json' }

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

export async function fetchNetworkEvent(eventId: string): Promise<NetworkEvent> {
  return parse(await fetch(`/api/network/events/${encodeURIComponent(eventId)}`, { cache: 'no-store' }))
}

export async function clearNetwork(): Promise<{ ok: boolean; deleted: number }> {
  return parse(await fetch('/api/network/clear', { method: 'POST' }))
}

export async function fetchNetwork(opts: {
  host?: string
  from?: string
  to?: string
}): Promise<NetworkPayload> {
  const params = new URLSearchParams()
  if (opts.host?.trim()) params.set('host', opts.host.trim())
  if (opts.from?.trim()) params.set('from', opts.from.trim())
  if (opts.to?.trim()) params.set('to', opts.to.trim())
  const query = params.toString()
  return parse(await fetch(`/api/network${query ? `?${query}` : ''}`, { cache: 'no-store' }))
}

export async function setCapture(enabled: boolean): Promise<{ error: string | null }> {
  return parse(await fetch('/api/capture', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ enabled }),
  }))
}

export async function setIntercept(enabled: boolean): Promise<{ error: string | null }> {
  return parse(await fetch('/api/capture/intercept', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ enabled }),
  }))
}

export async function forwardHold(id: string, draft: RequestDraft): Promise<void> {
  await parse(await fetch(`/api/capture/pending/${encodeURIComponent(id)}/forward`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(draft),
  }))
}

export async function dropHold(id: string): Promise<void> {
  await parse(await fetch(`/api/capture/pending/${encodeURIComponent(id)}/drop`, { method: 'POST' }))
}

export async function loadDraft(eventId: string): Promise<{ draft: RequestDraft | null; stale: boolean }> {
  return parse(await fetch(`/api/network/drafts/${encodeURIComponent(eventId)}`, { cache: 'no-store' }))
}

export async function replayDraft(draft: RequestDraft): Promise<ReplayResult> {
  return parse(await fetch('/api/capture/replay', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(draft),
  }))
}

export async function health(): Promise<{
  ok: boolean
  harness?: { url?: string | null; proxied?: boolean }
}> {
  return parse(await fetch('/api/health', { cache: 'no-store' }))
}
