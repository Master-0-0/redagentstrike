export type Kind =
  | 'poc'
  | 'http_snapshot'
  | 'http_request'
  | 'http_response'
  | 'browser_screenshot'
  | 'response_screenshot'
  | 'tool_output'
  | 'attachment'
export type Step = {
  id: string
  description: string
  artifact_client_ids?: string[]
  artifact_ids?: string[]
}
export type FindingInput = {
  title: string
  target: string
  summary: string
  severity: string
  preconditions: string
  steps: Step[]
  expected_result: string
  actual_result: string
  agent_assessment: string
}
export type Source = {
  source_type: 'manual' | 'cairn'
  workspace_id?: string | null
  workspace_path?: string | null
  session_id?: string | null
  owner_session_id?: string | null
  owner_resolution?: string
  fact_snapshots?: { id: string; description: string }[]
}
export type Gap = {
  id?: string
  category: string
  status: string
  reason: string
  resolved_at?: string | null
}
export type NetworkRef = { event_id: string; run_id: string; step_ids?: string[] }
export type Upload = {
  file: File
  kind: Exclude<Kind, 'http_snapshot'>
  description?: string
  step_ids?: string[]
  capture_method?: string
}
export type Draft = {
  finding?: Partial<FindingInput>
  source?: Source
  uploads?: Upload[]
  network_refs?: NetworkRef[]
}
export type Artifact = {
  id: string
  kind: Kind
  filename: string
  size: number
  sha256: string
  media_type: string
  description: string
  step_ids: string[]
  integrity: string
  fidelity: string
  representation: string
  truncation: string
  redaction: string
  capture_method: string
  captured_at?: string
  archived_at: string
  execution_note?: string
  network_ref?: NetworkRef
  page_url?: string
}
export type FindingCard = Pick<FindingInput, 'title' | 'target' | 'summary' | 'severity'> & {
  id: string
  review_status: string
  remediation_status: string
  version: number
  created_at: string
  artifact_count: number
  gap_count: number
  sources: Source[]
}
export type FindingDetail = FindingInput &
  Omit<FindingCard, 'artifact_count' | 'gap_count'> & {
    artifacts: Artifact[]
    evidence_gaps: Gap[]
    history: {
      id: string
      operation: string
      actor: string
      note: string
      created_at: string
      before?: unknown
      after?: unknown
    }[]
  }
export type Receipt = {
  ok: boolean
  finding_id: string
  submission_key: string
  warnings: string[]
}
export const kinds: Record<Kind, string> = {
  poc: '提交的 PoC 文件',
  http_snapshot: 'HTTP 解析快照',
  http_request: 'HTTP 请求文件',
  http_response: 'HTTP 响应文件',
  browser_screenshot: '浏览器页面截图',
  response_screenshot: '响应文本截图',
  tool_output: '工具输出',
  attachment: '其他附件',
}
export const reviews: Record<string, string> = {
  pending: '待复核',
  confirmed: '已确认',
  false_positive: '误报',
}
export const remedies: Record<string, string> = {
  not_started: '未开始',
  in_progress: '修复中',
  fixed: '已修复',
  retest_passed: '复测通过',
  not_applicable: '不适用',
}
export const severities: Record<string, string> = {
  unknown: '未知',
  info: '信息',
  low: '低危',
  medium: '中危',
  high: '高危',
  critical: '严重',
}
