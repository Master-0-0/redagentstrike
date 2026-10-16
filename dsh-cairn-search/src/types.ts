/** Append-only fact-intent blackboard. Domain-agnostic; no attack semantics. */

export type ProjectStatus = 'active' | 'stopped' | 'completed'

export interface Fact {
  readonly id: string
  readonly description: string
  readonly supersedes?: readonly string[]
}

export interface Intent {
  readonly attempts?: number
  readonly feedbackRevision?: number
  readonly skills?: readonly string[]
  readonly id: string
  readonly from: readonly string[]
  readonly to: string | null
  readonly description: string
  readonly creator: string
  readonly worker: string | null
  readonly createdAt: string
  readonly closed?: { readonly reason: string; readonly at: string }
  readonly target?: string
  readonly invalidated?: { readonly at: string; readonly hintId: string }
  readonly pendingReturn?: boolean
  readonly dispatchId?: string
  readonly subagentId?: string
  readonly concludedAt: string | null
}

export interface Hint {
  readonly id: string
  readonly content: string
  readonly creator: string
  readonly createdAt: string
  readonly messageId?: string
}

export interface WorkerReturn {
  readonly contentRef?: string
  readonly contentLength?: number
  readonly id: string
  readonly kind: 'return' | 'observation'
  readonly content: string
  readonly createdAt: string
  readonly messageId?: string
  readonly subagentId?: string
  readonly intentId?: string
  readonly dispatchId?: string
  readonly observation?: string
  readonly resolution?: { readonly action: 'conclude' | 'release' | 'close' | 'recovered' | 'archived'; readonly at: string }
}

export interface ReasonLease {
  readonly id?: string
  readonly worker: string
  readonly trigger: 'initial' | 'new-fact' | 'new-hint' | 'intents-empty'
  readonly startedAt: string
}

export interface Checkpoint {
  readonly factCount: number
  readonly hintCount: number
  readonly hadOpenIntents: boolean
}

export interface Board {
  criteria?: { id: string; description: string }[]
  protocolVersion?: 2
  policy?: SearchPolicy
  title: string
  status: ProjectStatus
  bootstrapEnabled: boolean
  facts: Fact[]
  intents: Intent[]
  workerReturns?: WorkerReturn[]
  hints: Hint[]
  reason: ReasonLease | null
  pendingIntentsEmpty?: boolean
  workerStatusWarning?: string
  checkpoint: Checkpoint
}

export interface SearchPolicy {
  maxOpenIntents: number
  maxConcurrent: number
  maxAttempts: number
  maxExplorations: number
}

export type NextTask =
  | { kind: 'review'; intents: Intent[]; records: WorkerReturn[] }
  | { kind: 'bootstrap'; origin: string; goal: string; hints: Hint[] }
  | { kind: 'reason'; trigger: ReasonLease['trigger']; factIds: string[]; openIntents: Intent[] }
  | { kind: 'explore'; intent: Intent }
  | { kind: 'idle'; reason: string }

export const ORIGIN_ID = 'origin'
export const GOAL_ID = 'goal'
export const BOOTSTRAP_DESCRIPTION = 'bootstrap'
export const MAX_INTENTS = 3
