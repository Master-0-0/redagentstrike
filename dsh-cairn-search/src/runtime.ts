/** Runtime boundaries: spawn admission and durable parent inbox reconciliation. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { addHint, bindDispatch, loadBoard, releaseIntent, reserveDispatch, saveBoard, withBoardLock, stopBoard, reopenBoard, recordWorkerReturn, observeWorker } from './board.ts'

import type { Board } from './types.ts'
import { completionEvidenceIssues } from './audit.ts'

const inFlight = new Set<string>()
const flightKey = (target: Target, id: string) => `${target.cwd}/${target.ownerId}/${id}`
const dispatchTools = new Set(['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code'])
// This listener is installed only in the Cairn preset. Keep execution tools in
// that preset so explorers inherit them, but enforce the coordinator's role.
const coordinatorTools = new Set(['blackboard', 'skill', 'read', 'read_image', 'ask_user_question',
  'archive_finding', 'query_intel_lib', 'get_goal', 'create_goal', 'update_goal', 'list_agents', 'interrupt_agent', 'todo_write'])

interface Target { cwd: string; ownerId: string }
export function installRuntime(ctx: Context, targetOf: (exec: ToolExecution) => Target): void {
  ctx.on('tools/execute', async (exec, next) => {
    const child = exec.agent?.session.header.origin === 'subagent'
    if (exec.name === 'workflow' || exec.name === 'ralph') throw new Error('Cairn exploration must use claimed blackboard intents and subagent dispatch')
    if (child && exec.name === 'skill' && (exec.arguments as { name?: string }).name === 'state-space-search') {
      throw new Error('state-space-search is the coordinator skill; load cairn-explorer and the assigned execution skills')
    }
    if (!child && !coordinatorTools.has(exec.name) && !dispatchTools.has(exec.name)) {
      throw new Error('Cairn parent coordinates and reviews evidence; delegate execution through a claimed intent')
    }
    if (!child && (exec.name === 'read' || exec.name === 'read_image')) {
      const target = targetOf(exec)
      const board = await loadBoard(target.cwd, target.ownerId)
      if (!board?.workerReturns?.some(r => r.kind === 'return') && !board?.facts.some(f => f.id !== 'origin' && f.id !== 'goal')) {
        throw new Error('Bootstrap only initializes and delegates; parent file reads are for reviewing returned evidence. Assign investigation to an explorer first.')
      }
    }
    if (exec.name === 'update_goal' && exec.agent?.session.header.origin !== 'subagent') {
      const target = targetOf(exec)
      const args = exec.arguments as { action?: string }
      const board = await loadBoard(target.cwd, target.ownerId)
      if (args.action === 'complete' && (!board || completionEvidenceIssues(board).length)) throw new Error('prove blackboard goal with current evidence before completing the session goal')
      const result = await next()
      if (!result.isError && args.action === 'resume') {
        await withBoardLock(target.cwd, target.ownerId, async () => {
          const current = await loadBoard(target.cwd, target.ownerId)
          if (current?.status === 'stopped') await saveBoard(target.cwd, target.ownerId, reopenBoard(current))
        })
      }
      if (!result.isError && (args.action === 'pause' || args.action === 'blocked')) {
        await withBoardLock(target.cwd, target.ownerId, async () => {
          const current = await loadBoard(target.cwd, target.ownerId)
          if (current) {
            interruptWorkers(ctx, exec.agent, current)
            await saveBoard(target.cwd, target.ownerId, stopBoard(current))
          }
        })
      }
      return result
    }
    if (!dispatchTools.has(exec.name)) return next()
    const target = targetOf(exec)
    if (exec.agent?.session.header.origin === 'subagent') throw new Error('only the blackboard parent may dispatch explorers')
    const args = exec.arguments as { prompt?: string }
    const intentId = /^blackboard_intent:\s*(i\d+)\s*\n/.exec(args.prompt ?? '')?.[1]
    if (!intentId) throw new Error('spawn prompt must begin with blackboard_intent: iNNN followed by a newline')
    await withBoardLock(target.cwd, target.ownerId, async () => {
      const board = await loadBoard(target.cwd, target.ownerId)
      if (!board) throw new Error('initialize and claim blackboard intent before spawn')
      await saveBoard(target.cwd, target.ownerId, reserveDispatch(board, intentId, exec.callId))
      inFlight.add(flightKey(target, exec.callId))
      const intent = board.intents.find(i => i.id === intentId)!
      exec.arguments = { ...args, prompt: `${args.prompt ?? ''}` + `\n\nCairn execution contract: Load cairn-explorer first. Load each assigned skill before acting: ${JSON.stringify(intent.skills ?? [])}. You are an explorer, not the coordinator. Execute only this intent: ${intent.description}. Return one objective JSON finding with evidence paths. Do not initialize or write the blackboard or dispatch agents.\nDirect premises: ${JSON.stringify(board.facts.filter(f => intent.from.includes(f.id)))}` }
    })
    const failed = async () => withBoardLock(target.cwd, target.ownerId, async () => {
      const board = await loadBoard(target.cwd, target.ownerId)
      const intent = board?.intents.find(i => i.id === intentId)
      if (board?.status === 'active' && intent?.dispatchId === exec.callId && !intent.closed && intent.to === null) {
        await saveBoard(target.cwd, target.ownerId, releaseIntent(board, intentId))
      }
    })
    try {
      const result = await next()
      if (result.isError) await failed()
      else {
        const value = result.value as { subagentId?: string; kind?: string }
        if (typeof value?.subagentId === 'string') {
          await withBoardLock(target.cwd, target.ownerId, async () => {
            const board = await loadBoard(target.cwd, target.ownerId)
            if (board) {
              const intent = board.intents.find(i => i.id === intentId)
              if (board.status !== 'active' || intent?.dispatchId !== exec.callId || intent.closed || intent.to !== null) {
                interruptChild(ctx, exec.agent, value.subagentId!)
              } else await saveBoard(target.cwd, target.ownerId, bindDispatch(board, intentId, exec.callId, value.subagentId!))
            }
          })
        } else if (value?.kind === 'foreground') {
          await withBoardLock(target.cwd, target.ownerId, async () => {
            const board = await loadBoard(target.cwd, target.ownerId)
            if (board) await saveBoard(target.cwd, target.ownerId, recordWorkerReturn(board, {
              kind: 'return', content: JSON.stringify(result.value ?? result.content),
              messageId: `foreground:${exec.callId}`, intentId, dispatchId: exec.callId,
            }))
          })
        }
      }
      return result
    } catch (error) { await failed(); throw error }
    finally { inFlight.delete(flightKey(target, exec.callId)) }
  })

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (agent.session.header.origin === 'subagent') return next()
    const cwd = agent.session.header.cwd
    if (!cwd) return next()
    await withBoardLock(cwd, agent.session.id, async () => {
      let board = await loadBoard(cwd, agent.session.id)
      if (!board) return
      let changed = false
      for (const message of messages) {
        if (board.hints.some(h => h.messageId === message.id)) continue
        const source = message.source as { kind: string; senderSessionId?: string }
        if (source.kind !== 'user' && source.kind !== 'subagent-settled') continue
        const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
        if (!text) continue
        if (source.kind === 'user') {
          const added = addHint(board, text, 'user')
          board = { ...added.board, hints: added.board.hints.map(h => h.id === added.hint.id ? { ...h, messageId: message.id } : h) }
        } else {
          board = recordWorkerReturn(board, { kind: 'return', content: text, messageId: message.id, subagentId: source.senderSessionId })
        }
        changed = true
      }
      if (changed) await saveBoard(cwd, agent.session.id, board)
    })
    await reconcileWorkers(ctx, { cwd, ownerId: agent.session.id })
    return next()
  })
}

/** Cancel only children bound to this board, with the calling parent's authority. */
export function interruptWorkers(ctx: Context, agent: ToolExecution['agent'], board: Board, intentId?: string): void {
  if (!agent) return
  for (const intent of board.intents) {
    if (intentId && intent.id !== intentId) continue
    if (intent.to !== null || intent.closed || !intent.subagentId) continue
    interruptChild(ctx, agent, intent.subagentId)
  }
}

function interruptChild(ctx: Context, agent: ToolExecution['agent'], childId: string): void {
  if (!agent) return
  const runtime = ctx.get('subagents')
  if (!runtime) throw new Error('subagent runtime unavailable; cannot stop bound worker')
  runtime.interrupt(childId as Parameters<typeof runtime.interrupt>[0], { kind: 'ancestor', agent })
}

/** Query outside the write lock; compare dispatch identity again before applying observations. */
export async function reconcileWorkers(ctx: Context, target: Target): Promise<string[]> {
  const snapshot = await loadBoard(target.cwd, target.ownerId)
  if (!snapshot || snapshot.status !== 'active') return []
  const candidates = snapshot.intents.filter(i => i.dispatchId && i.to === null && !i.closed && !inFlight.has(flightKey(target, i.dispatchId)))
  if (!candidates.length) {
    if (snapshot.workerStatusWarning) await withBoardLock(target.cwd, target.ownerId, async () => {
      const board = await loadBoard(target.cwd, target.ownerId)
      if (board && !board.intents.some(i => i.dispatchId && i.to === null && !i.closed)) {
        const { workerStatusWarning, ...rest } = board
        await saveBoard(target.cwd, target.ownerId, rest)
      }
    })
    return []
  }
  let rows: { kind: string; id: string; activity?: string; reason?: string }[]
  try {
    const runtime = ctx.get('subagents')
    if (!runtime) throw new Error('subagent runtime unavailable')
    rows = await runtime.listChildren(target.ownerId as Parameters<typeof runtime.listChildren>[0])
  } catch (error) {
    const warning = `Worker status query unavailable; claims retained: ${error instanceof Error ? error.message : String(error)}`
    await withBoardLock(target.cwd, target.ownerId, async () => {
      const board = await loadBoard(target.cwd, target.ownerId)
      if (board?.status === 'active' && board.workerStatusWarning !== warning) await saveBoard(target.cwd, target.ownerId, { ...board, workerStatusWarning: warning })
    })
    return [warning]
  }
  await withBoardLock(target.cwd, target.ownerId, async () => {
    let board = await loadBoard(target.cwd, target.ownerId)
    if (!board || board.status !== 'active') return
    const before = board
    if (board.workerStatusWarning) { const { workerStatusWarning, ...rest } = board; board = rest }
    for (const candidate of candidates) {
      const intent = board.intents.find(i => i.id === candidate.id && i.dispatchId === candidate.dispatchId && i.to === null && !i.closed)
      if (!intent || inFlight.has(flightKey(target, intent.dispatchId!))) continue
      const row = rows.find(r => r.id === intent.subagentId)
      const observation = !intent.subagentId ? 'Dispatch has no bound child; verify the original spawn before retrying.'
        : !row ? 'Bound child is absent from the catalog; outcome is unknown.'
        : row.kind === 'diagnostic' ? `Child status diagnostic: ${row.reason}; outcome is unknown.`
        : row.activity === 'inactive' ? 'Child is inactive without a recorded return; inspect its result before deciding.' : undefined
      board = observeWorker(board, intent, observation)
    }
    if (board !== before) await saveBoard(target.cwd, target.ownerId, board)
  })
  return []
}
