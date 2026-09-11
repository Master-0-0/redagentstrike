/** Browser half: sidebar-foot blackboard graph over `.dsh/blackboard.json`. */

import { BlackboardSidebarPanel } from './BlackboardSidebarPanel.tsx'
import { NS, en, zh } from './locales.ts'
import { loadBoardSnapshot, type WorkspaceFilesReadRemote } from './rpc.ts'
import { ensureStyles } from './styles.ts'

export const name = 'dsh-cairn-search'
export const inject = ['slots', 'locale', 'remote', 'remote.workspaceFiles']

interface SlotsRuntime {
  inject(name: string, setup: () => () => void): () => void
  register(options: {
    name: string
    id: string
    order: number
    locale: string
    inject: () => { readBoard: (sessionId: string, signal: AbortSignal) => ReturnType<typeof loadBoardSnapshot> }
  }, component: unknown): () => void
}

interface LocaleRuntime {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
}

interface BrowserContext {
  effect(setup: () => (() => void) | void, label?: string): void
  locale: LocaleRuntime
  slots: SlotsRuntime
  remote: WorkspaceFilesReadRemote
}

/**
 * Register dictionaries and the sidebar footer action above the subagent entry.
 * @param ctx - client root context carrying slots, locale, and workspace file reads.
 */
export function apply(ctx: BrowserContext): void {
  ensureStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-cairn-search: dictionaries')
  const remote = ctx.remote
  ctx.slots.inject(
    'sidebar.footer.action',
    () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'blackboard-panel',
      // Ahead of ui-subagent (order 0): this control sits above 子代理.
      order: -10,
      locale: NS,
      inject: () => ({
        readBoard: (sessionId: string, signal: AbortSignal) => loadBoardSnapshot(remote, sessionId, signal),
      }),
    }, BlackboardSidebarPanel),
  )
}
