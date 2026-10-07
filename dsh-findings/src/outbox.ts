import { createHash, randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  ArchiveError,
  copySafe,
  MAX_TOTAL,
  mediaType,
  privateDirectory,
  readSafe,
} from './artifacts.ts'

export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export async function atomicJSON(path: string, data: any) {
  const tmp = `${path}.${randomUUID()}.tmp`
  const fd = await open(tmp, 'wx', 0o600)
  try {
    await fd.writeFile(JSON.stringify(data, null, 2))
    await fd.sync()
  } finally {
    await fd.close()
  }
  await rename(tmp, path)
}
export function boxPath(root: string, key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new ArchiveError('invalid_manifest', '无效 submission_key')
  return join(root, '.dsh/findings-outbox', key)
}
export async function loadOutbox(root: string, key: string, signal: AbortSignal) {
  const path = boxPath(root, key)
  const manifest = JSON.parse(
    (await readSafe(root, join(path, 'manifest.json'), 1024 * 1024, signal)).toString(),
  )
  const { submission_key, content_digest, ...content } = manifest
  if (
    submission_key !== key ||
    content_digest !== key ||
    createHash('sha256').update(canonical(content)).digest('hex') !== key
  )
    throw new ArchiveError('hash_mismatch', '待提交清单完整性异常')
  return { path, manifest }
}

export async function prepareOutbox(args: any, source: any, signal: AbortSignal) {
  if (!['create', 'append'].includes(args.op))
    throw new ArchiveError('invalid_manifest', 'op 必须为 create/append/retry')
  const root = source.workspace_path
  const pending = join(root, '.dsh/findings-outbox', `preparing-${randomUUID()}`)
  await privateDirectory(root, join(pending, 'artifacts'))
  try {
    const artifacts: any[] = []
    let total = 0
    if (
      !Array.isArray(args.artifacts ?? []) ||
      (args.artifacts?.length ?? 0) > 20 ||
      (args.network_refs?.length ?? 0) > 20
    )
      throw new ArchiveError('payload_too_large')
    const ids = new Set<string>()
    for (const a of args.artifacts ?? []) {
      signal.throwIfAborted()
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(a.client_id) ||
        ids.has(a.client_id) ||
        typeof a.path !== 'string'
      )
        throw new ArchiveError('invalid_manifest', '附件 ID/路径无效或重复')
      ids.add(a.client_id)
      const copied = await copySafe(root, a.path, join(pending, 'artifacts', a.client_id), signal)
      total += copied.size
      if (total > MAX_TOTAL) throw new ArchiveError('payload_too_large')
      artifacts.push({
        client_id: a.client_id,
        kind: a.kind,
        filename: basename(a.path),
        media_type: mediaType(a.path),
        ...copied,
        description: a.description ?? '',
        step_ids: a.step_ids ?? [],
        capture_method: a.capture_method ?? 'tool_file',
        captured_at: a.captured_at ?? null,
        page_url: a.page_url ?? null,
        execution_note: a.execution_note ?? '',
      })
    }
    const content = JSON.parse(
      JSON.stringify({
        op: args.op,
        ...(args.op === 'create'
          ? { finding: args.finding }
          : { finding_id: args.finding_id, note: args.note ?? '' }),
        source,
        artifacts,
        network_refs: args.network_refs ?? [],
        evidence_gaps: args.evidence_gaps ?? [],
        resolved_gap_ids: args.resolved_gap_ids ?? [],
        occurrence_id: args.occurrence_id ?? null,
      }),
    )
    const key = createHash('sha256').update(canonical(content)).digest('hex')
    const manifest = { ...content, submission_key: key, content_digest: key }
    if (Buffer.byteLength(JSON.stringify(manifest)) > 1024 * 1024)
      throw new ArchiveError('payload_too_large')
    await atomicJSON(join(pending, 'manifest.json'), manifest)
    const path = boxPath(root, key)
    try {
      await rename(pending, path)
    } catch (error: any) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      return await loadOutbox(root, key, signal)
    }
    const directory = await open(join(root, '.dsh/findings-outbox'), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return { path, manifest }
  } finally {
    await rm(pending, { recursive: true, force: true })
  }
}
