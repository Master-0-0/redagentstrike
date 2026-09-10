const STORAGE_KEY = 'agent-workbench.dshUrl'
export const DEFAULT_DSH_URL = import.meta.env.VITE_DSH_URL ?? 'http://127.0.0.1:3081/'
export const DSH_URL_EVENT = 'workbench:dsh-url'

export function readStoredDshUrl(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && stored.trim()) return stored.trim()
  } catch {
    /* private mode */
  }
  return DEFAULT_DSH_URL
}

export function persistDshUrl(url: string): void {
  const trimmed = url.trim()
  if (!trimmed) return
  localStorage.setItem(STORAGE_KEY, trimmed)
  window.dispatchEvent(new CustomEvent(DSH_URL_EVENT, { detail: trimmed }))
}
