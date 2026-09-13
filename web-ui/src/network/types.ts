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
  egress_proxy_id?: string | null
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

export type ProxyScheme = 'http' | 'https' | 'socks5'

export type ProxyEmpty = 'no_entries' | 'all_disabled' | 'all_cooling' | 'ok'

export type ProxyEntry = {
  id: string
  scheme: ProxyScheme
  host: string
  port: number
  username: string
  has_password: boolean
  enabled: boolean
  source: string
  note: string
  fail_streak: number
  cooling: boolean
  cooldown_until: string | null
  last_ok_at: string | null
  last_fail_at: string | null
  alive: boolean | null
  latency_ms: number | null
  egress_ip: string | null
  checked_at: string | null
  check_error: string | null
}

export type ProxyCounts = {
  total: number
  nodes: number
  enabled: number
  cooling: number
  alive: number
  dead: number
  unknown: number
  latency_ms: number | null
}

export type ProxyAgentLease = {
  lease_id: string | null
  proxy_id: string | null
  url: string | null
}

export type ProxyPoolPayload = {
  entries: ProxyEntry[]
  counts: ProxyCounts
  empty: ProxyEmpty
  agent?: ProxyAgentLease
}

export type PocTemplate = {
  template_id: string
  category: string
  id: string
  name: string
  severity: string
  author: string
  description: string
  tags: string[]
}

export type PocTemplateDetail = PocTemplate & { content: string }

export type PocMatcherResult = {
  type: string
  part: string
  matched: boolean
  detail: string
}

export type PocScanAttempt = {
  url: string
  method: string
  status: number | null
  duration_ms: number
  matched: boolean
  matchers: PocMatcherResult[]
  error: string | null
}

export type PocScanResult = {
  template_id: string
  id: string
  name: string
  severity: string
  matched: boolean
  image: string | null
  body: string | null
  image_error: string | null
  attempts: PocScanAttempt[]
}

export type PocScanReport = {
  target: string
  duration_ms: number
  matched: number
  total: number
  results: PocScanResult[]
}
