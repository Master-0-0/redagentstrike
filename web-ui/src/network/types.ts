export type RunInfo = {
  id: string
  title: string
  created_at: string
  ended_at: string | null
  capture_started: boolean
  open: boolean
}

export type ToolCallMatch = {
  id: string
  ts: string
  name: string
  payload: Record<string, unknown>
}

export type RequestDraft = {
  method: string
  url: string
  host?: string
  headers: Record<string, string>
  body: string
}

export type PendingHold = RequestDraft & { id: string }

export type NetworkEvent = {
  id: string
  ts: string
  host: string
  summary: string
  join: {
    method: string
    url: string
    status: number | null
  }
  truncated: {
    req_headers: Record<string, string>
    req_body: string
    resp_headers: Record<string, string>
    resp_body: string
  }
  evidence_id: string | null
  failed: boolean
  tool_call: ToolCallMatch | null
}

export type CaptureInfo = {
  mode: string
  scope: string
  platform: string
  listening: boolean
  intercept: boolean
  pending_count: number
  pending: PendingHold[]
  supported: boolean
  proxy: string
  error: string | null
  pid: number | null
  harness?: {
    managed: boolean
    proxied: boolean
    pid: number | null
    url: string | null
    error: string | null
  }
}

export type Counts = {
  total: number
  status_2xx: number
  status_4xx: number
  status_5xx: number
  failed: number
}

export type EmptyKind = 'idle' | 'store_unavailable' | 'proxy_off' | null

export type NetworkPayload = {
  run_id: string | null
  run: RunInfo | null
  capture: CaptureInfo
  events: NetworkEvent[]
  counts: Counts
  empty: EmptyKind
  store_error?: string | null
}

export type ReplayResult = {
  status: number
  headers: Record<string, string>
  body: string
  via_proxy: boolean
}
