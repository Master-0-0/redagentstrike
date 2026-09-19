import type {
  ApprovalOutcome,
  ApprovalPayload,
  ApprovalRule,
  ApprovalRulesPayload,
} from './types'

const jsonHeaders = { 'Content-Type': 'application/json' }

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
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function fetchApprovals(): Promise<ApprovalPayload> {
  return parse(await fetch('/api/approvals', { cache: 'no-store' }))
}

export async function decideApproval(eventId: string, outcome: ApprovalOutcome): Promise<void> {
  const response = await fetch(`/api/approvals/${encodeURIComponent(eventId)}/decision`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ outcome }),
  })
  if (!response.ok) await parse<never>(response)
}

export async function fetchApprovalRules(): Promise<ApprovalRulesPayload> {
  return parse(await fetch('/api/approvals/rules', { cache: 'no-store' }))
}

export async function putApprovalRules(rules: ApprovalRule[]): Promise<ApprovalRulesPayload> {
  const response = await fetch('/api/approvals/rules', {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ rules }),
  })
  if (!response.ok) return parse<ApprovalRulesPayload>(response)
  if (response.status === 204) return { rules }
  const text = await response.text()
  if (!text) return { rules }
  const result = JSON.parse(text) as Partial<ApprovalRulesPayload>
  return Array.isArray(result.rules) ? { rules: result.rules } : { rules }
}
