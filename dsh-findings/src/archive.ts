import { realpath } from 'node:fs/promises'
import { ArchiveError } from './artifacts.ts'
import { sourceContext } from './context.ts'
import { loadOutbox, prepareOutbox } from './outbox.ts'
import { transmit } from './client.ts'

export async function archiveFinding(
  args: any,
  ctx: any,
  exec: any,
  config: { apiUrl?: string; timeoutMs?: number } = {},
) {
  const deadline = AbortSignal.timeout(Math.min(config.timeoutMs ?? 30000, 30000))
  const signal = exec.signal ? AbortSignal.any([deadline, exec.signal]) : deadline
  let key: string | undefined
  try {
    const session = exec.agent?.session
    if (!session?.id || !session.header?.cwd) throw new ArchiveError('context_missing')
    const root = await realpath(session.header.cwd)
    const box =
      args.op === 'retry'
        ? await loadOutbox(root, args.submission_key, signal)
        : await prepareOutbox(
            args,
            await sourceContext(ctx, exec, args.fact_ids ?? [], signal),
            signal,
          )
    key = box.manifest.submission_key
    return await transmit(root, box, config.apiUrl ?? 'http://127.0.0.1:8787', signal)
  } catch (error: any) {
    const timeout = signal.aborted
    const known = error instanceof ArchiveError
    const code = timeout
      ? 'timeout'
      : known
        ? error.code
        : error.code === 'ENOSPC'
          ? 'disk_full'
          : error.code === 'ENOENT'
            ? 'file_not_found'
            : 'service_unavailable'
    return {
      ok: false,
      error_code: code,
      message: timeout
        ? '归档超时，已停止本次上传'
        : known
          ? error.message
          : '归档失败，请检查服务和本地存储',
      retryable: timeout || (known ? error.retryable : true),
      ...(key ? { submission_key: key } : {}),
      warnings: key ? ['重试使用 outbox 副本；尚未由服务端快照化的网络引用仍依赖原事件存活'] : [],
    }
  }
}
