import { realpath, mkdir, writeFile, open, lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { constants } from 'node:fs'
import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto'

export function endpoint(input: string) {
  const u = new URL(input)
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.pathname !== '/' || u.username || u.password || u.search || u.hash) throw new Error('local_api_required')
  return u.origin
}
export async function contextFor(ctx: any, exec: any) {
  const session = exec.agent?.session
  if (!session?.id || !session.header?.cwd) throw new Error('session_context_missing')
  const workspace_path = await realpath(session.header.cwd)
  let owner = session, seen = new Set<string>(), resolved = true
  let sessions: any
  try { sessions = ctx.get?.('sessions', false) } catch { /* optional */ }
  while (owner.header?.origin === 'subagent') {
    if (seen.has(owner.id)) { resolved = false; break }
    seen.add(owner.id)
    const parent = sessions?.get(owner.header?.parentSession)
    if (!parent) { resolved = false; break }
    owner = parent
  }
  return { workspace_path, session_id: session.id, owner_session_id: resolved ? owner.id : null }
}

async function request(base: string, path: string, body: any, signal: AbortSignal) {
  const encoded = JSON.stringify(body)
  if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('payload_too_large')
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: encoded, redirect: 'error', signal })
  const value = await response.json()
  if (!response.ok) {
    // Only accept a controlled code; never echo HTTP body/secret input into errors.
    const code = typeof value.error_code === 'string' && /^[a-z_]{1,80}$/.test(value.error_code) ? value.error_code : 'intel_request_failed'
    throw Object.assign(new Error(code), { retryable: response.status >= 500 })
  }
  return value
}

async function privateDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('outbox_directory_invalid')
}
async function readPrivate(path: string) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await f.stat()
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('outbox_file_invalid')
    return await f.readFile()
  } finally { await f.close() }
}
async function outbox(workspace: string) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const root = join(home, 'intel-outbox')
  await privateDir(root)
  const dir = join(root, createHash('sha256').update(workspace).digest('hex'))
  await privateDir(dir)
  const keypath = join(dir, 'key')
  // Atomic key publication: concurrent tool calls must never see a partial key.
  let key: Buffer
  try { key = await readPrivate(keypath) } catch (e: any) {
    if (e.code !== 'ENOENT') throw e
    const temp = join(dir, randomUUID() + '.key.tmp')
    await writeFile(temp, randomBytes(32), { flag: 'wx', mode: 0o600 })
    const { link } = await import('node:fs/promises')
    try { await link(temp, keypath) } catch (err: any) { if (err.code !== 'EEXIST') throw err } finally { await unlink(temp) }
    key = await readPrivate(keypath)
  }
  if (key.length !== 32) throw new Error('outbox_key_invalid')
  return { dir, key }
}
function encrypt(key: Buffer, data: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  const bytes = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), bytes])
}
function decrypt(key: Buffer, data: Buffer) {
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
  cipher.setAuthTag(data.subarray(12, 28))
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8')
}

export async function executeIntel(kind: 'query' | 'save', args: any, ctx: any, exec: any, config: { apiUrl?: string; timeoutMs?: number } = {}) {
  let submission_key = args.submission_key
  try {
    const base = endpoint(config.apiUrl || 'http://127.0.0.1:8787')
    const context = await contextFor(ctx, exec)
    const deadline = AbortSignal.timeout(config.timeoutMs || 15000)
    const signal = exec.signal ? AbortSignal.any([deadline, exec.signal]) : deadline
    if (kind === 'query') {
      // Whitelist query fields. The model cannot replace runtime workspace/session identity.
      const body: any = { context }
      for (const key of ['category', 'kind', 'status', 'q', 'ids', 'related_to', 'include_secrets', 'include_details', 'offset', 'limit']) if (args[key] !== undefined) body[key] = args[key]
      return await request(base, '/intel/agent/query', body, signal)
    }
    const retry = args.op === 'retry'
    if (args.op && !['save', 'retry'].includes(args.op)) throw new Error('invalid_operation')
    if (retry && !submission_key) throw new Error('submission_key_required')
    submission_key ||= randomUUID()
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(submission_key)) throw new Error('invalid_submission_key')
    const { dir, key } = await outbox(context.workspace_path)
    const path = join(dir, submission_key + '.bin')
    let body: any
    if (retry) {
      body = JSON.parse(decrypt(key, await readPrivate(path)))
      if (body.context.workspace_path !== context.workspace_path) throw new Error('workspace_mismatch')
    } else {
      body = { context, submission_key, entities: args.entities || [], relations: args.relations || [] }
      const encoded = JSON.stringify(body)
      if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('payload_too_large')
      try {
        const prior = JSON.parse(decrypt(key, await readPrivate(path)))
        if (JSON.stringify(prior) !== encoded) throw new Error('submission_conflict')
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e
        const temp = join(dir, randomUUID() + '.tmp')
        const f = await open(temp, 'wx', 0o600)
        try { await f.writeFile(encrypt(key, encoded)); await f.sync() } finally { await f.close() }
        // Exclusive publication: same-key concurrent saves may not overwrite each other.
        const { link } = await import('node:fs/promises')
        try { await link(temp, path) } catch (err: any) {
          if (err.code !== 'EEXIST') throw err
          if (decrypt(key, await readPrivate(path)) !== encoded) throw new Error('submission_conflict')
        } finally { await unlink(temp) }
      }
    }
    return await request(base, '/intel/agent/save', body, signal)
  } catch (e: any) {
    const allowed = typeof e.message === 'string' && /^[a-z_]{1,80}$/.test(e.message)
    return { ok: false, error_code: allowed ? e.message : 'intel_unavailable', retryable: e.retryable ?? !allowed, ...(submission_key ? { submission_key } : {}) }
  }
}
