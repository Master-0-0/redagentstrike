import type { BlackboardCatalog, BlackboardFile } from './types'

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text()
    let message = text
    try {
      const body = JSON.parse(text) as { error?: unknown; detail?: unknown; message?: unknown }
      const candidate = body.error ?? body.detail ?? body.message
      if (typeof candidate === 'string') message = candidate
    } catch {
      // Keep a non-JSON response as the backend error text.
    }
    throw new Error(message || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

export async function fetchBlackboards(): Promise<BlackboardCatalog> {
  return parse(await fetch('/api/blackboards', { cache: 'no-store' }))
}

export async function fetchBlackboardFile(workspaceId: string, ownerId: string, signal?: AbortSignal): Promise<BlackboardFile> {
  return parse(await fetch(
    `/api/blackboards/${encodeURIComponent(workspaceId)}/${encodeURIComponent(ownerId)}`,
    { cache: 'no-store', signal },
  ))
}

export async function fetchWorkerReturn(workspaceId: string, ownerId: string, returnId: string): Promise<string> {
  const result = await parse<{ text: string }>(await fetch(`/api/blackboards/${encodeURIComponent(workspaceId)}/${encodeURIComponent(ownerId)}/returns/${encodeURIComponent(returnId)}`, { cache: 'no-store' }))
  return result.text
}
