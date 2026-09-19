export type ApprovalOutcome = 'allowed-once' | 'rejected'

export type ApprovalItem = {
  event_id: string
  session_id: string
  tool_name: string
  call_id?: string
  command: string
  matched_rules: string[]
  reason?: string
  created_at: string
}

export type ApprovalBridge = {
  connected: boolean
  error: string | null
}

export type ApprovalPayload = {
  pending: ApprovalItem[]
  pending_count: number
  bridge: ApprovalBridge
}

export type ApprovalRule = {
  id: string
  label: string
  kind: 'command' | 'regex'
  value: string
  enabled: boolean
}

export type ApprovalRulesPayload = {
  rules: ApprovalRule[]
}
