/** Runtime boundaries: spawn admission and durable parent inbox reconciliation. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { addHint, bindDispatch, loadBoard, releaseIntent, reserveDispatch, saveBoard, withBoardLock, stopBoard } from './board.ts'

import type { Board } from './types.ts'

interface Target { cwd: string; ownerId: string }
export function installRuntime(ctx: Context, targetOf: (exec: ToolExecution) => Target): void {
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'update_goal' && exec.agent?.session.header.origin !== 'subagent') {
      const target = targetOf(exec)
      const args = exec.arguments as { action?: string }
      const board = await loadBoard(target.cwd, target.ownerId)
      if (board && args.action === 'complete' && board.status !== 'completed') throw new Error('prove blackboard goal before completing the session goal')
      const result = await next()
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
    if (!['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code'].includes(exec.name)) return next()
    const target = targetOf(exec)
    if (exec.agent?.session.header.origin === 'subagent') throw new Error('only the blackboard parent may dispatch explorers')
    const args = exec.arguments as { prompt?: string }
    const intentId = /^blackboard_intent:\s*(i\d+)\s*\n/.exec(args.prompt ?? '')?.[1]
    if (!intentId) throw new Error('spawn prompt must begin with blackboard_intent: iNNN followed by a newline')
    await withBoardLock(target.cwd, target.ownerId, async () => {
      const board = await loadBoard(target.cwd, target.ownerId)
      if (!board) throw new Error('initialize and claim blackboard intent before spawn')
      await saveBoard(target.cwd, target.ownerId, reserveDispatch(board, intentId, exec.callId))
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
            if (board?.status === 'active') {
              await saveBoard(target.cwd, target.ownerId, {
                ...board,
                intents: board.intents.map(i => i.id === intentId && i.dispatchId === exec.callId && i.to === null && !i.closed ? { ...i, pendingReturn: true } : i),
              })
            }
          })
        }
      }
      return result
    } catch (error) { await failed(); throw error }
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
        const added = addHint(board, text, source.kind === 'user' ? 'user' : 'dispatcher.worker-return')
        board = { ...added.board, hints: added.board.hints.map(h => h.id === added.hint.id ? { ...h, messageId: message.id } : h) }
        if (source.kind === 'subagent-settled' && board.status === 'active') {
          board = { ...board, intents: board.intents.map(i => i.subagentId === source.senderSessionId && i.to === null && !i.closed ? { ...i, pendingReturn: true } : i) }
        }
        changed = true
      }
      if (changed) await saveBoard(cwd, agent.session.id, board)
    })
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
