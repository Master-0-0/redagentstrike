import { realpath, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readBoardFacts } from './board-facts.ts'
import { ArchiveError } from './artifacts.ts'

type Session = { id: string; header?: { cwd?: string; parentSession?: string; origin?: string } }
export function encodeOwner(id: string) {
  if (!id.trim() || ['.', '..'].includes(id.trim())) throw new ArchiveError('context_missing')
  return [...id.trim()]
    .map((c) =>
      /^[A-Za-z0-9._-]$/.test(c)
        ? c
        : `~${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
    )
    .join('')
}
export async function sourceContext(ctx: any, exec: any, factIds: string[], signal?: AbortSignal) {
  const session: Session | undefined = exec.agent?.session
  if (!session?.id || !session.header?.cwd)
    throw new ArchiveError('context_missing', '归档需要执行会话与工作区')
  const root = await realpath(session.header.cwd)
  let sessions: { get(id: string): Session | undefined } | undefined
  try {
    sessions = ctx.get?.('sessions', false)
  } catch {
    /* optional public service */
  }
  let current = session
  let resolved = true
  const seen = new Set<string>()
  while (current.header?.origin === 'subagent') {
    if (seen.has(current.id) || !current.header.parentSession) {
      resolved = false
      break
    }
    seen.add(current.id)
    const parent = sessions?.get(current.header.parentSession)
    if (!parent) {
      resolved = false
      break
    }
    current = parent
  }
  const source = {
    source_type: 'cairn',
    workspace_path: root,
    workspace_id: null as string | null,
    session_id: session.id,
    owner_session_id: resolved ? current.id : null,
    owner_resolution: resolved ? 'resolved' : 'unresolved',
    fact_snapshots: [] as { id: string; description: string }[],
  }
  if (factIds.length) {
    if (!resolved) throw new ArchiveError('context_missing', '父链缺失，无法可靠读取引用事实')
    source.fact_snapshots = await readBoardFacts(root, `.dsh/blackboards/${encodeOwner(current.id)}.json`, factIds, signal)
  }
  // Registry lookup is optional; lack of an ID never changes workspace identity.
  try {
    const registry = JSON.parse(
      await readFile(
        join(process.env.DSH_HOME || homedir() + '/.dsh', 'storages/workspace.json'),
        'utf8',
      ),
    )
    for (const [id, row] of Object.entries(registry.tables?.workspaces || {}) as [string, any][]) {
      if (typeof row.path === 'string' && (await realpath(row.path).catch(() => '')) === root) {
        source.workspace_id = id
        break
      }
    }
  } catch {
    /* retain canonical path */
  }
  return source
}
