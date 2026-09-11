/** Append-only fact-intent blackboard. Domain-agnostic; no attack semantics. */

export type ProjectStatus = 'active' | 'stopped' | 'completed'

export interface Fact {
  readonly id: string
  readonly description: string
}

export interface Intent {
  readonly id: string
  readonly from: readonly string[]
  readonly to: string | null
  readonly description: string
  readonly creator: string
  readonly worker: string | null
  readonly createdAt: string
  readonly concludedAt: string | null
}

export interface Hint {
  readonly id: string
  readonly content: string
  readonly creator: string
  readonly createdAt: string
}

export interface ReasonLease {
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
  title: string
  status: ProjectStatus
  bootstrapEnabled: boolean
  facts: Fact[]
  intents: Intent[]
  hints: Hint[]
  reason: ReasonLease | null
  checkpoint: Checkpoint
}

export type NextTask =
  | { kind: 'bootstrap'; origin: string; goal: string; hints: Hint[] }
  | { kind: 'reason'; trigger: ReasonLease['trigger']; factIds: string[]; openIntents: Intent[] }
  | { kind: 'explore'; intent: Intent }
  | { kind: 'idle'; reason: string }

export const ORIGIN_ID = 'origin'
export const GOAL_ID = 'goal'
export const BOOTSTRAP_DESCRIPTION = 'bootstrap'
export const MAX_INTENTS = 3
