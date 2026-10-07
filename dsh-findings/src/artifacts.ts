import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { open, mkdir, lstat, realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export class ArchiveError extends Error {
  code: string
  retryable: boolean
  constructor(code: string, message = code, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}
export const MAX_FILE = 20 * 1024 * 1024
export const MAX_TOTAL = 100 * 1024 * 1024

export function relativeFile(root: string, input: string): string {
  if (input.split(/[\\/]/).includes('..')) throw new ArchiveError('path_not_allowed')
  const rel = relative(root, resolve(root, input))
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith('/'))
    throw new ArchiveError('path_not_allowed')
  return rel
}

export function reader(root: string, input: string, limit: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const child = spawn(
    'python3',
    [
      fileURLToPath(new URL('./safe-read.py', import.meta.url)),
      root,
      relativeFile(root, input),
      String(limit),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], signal },
  )
  let reason = ''
  child.stderr.on('data', (data) => {
    reason += data.toString().slice(0, 256)
  })
  const completion = new Promise<void>((resolveDone, reject) => {
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolveDone() : reject(new ArchiveError(reason || 'file_not_found')),
    )
  })
  // Attach immediately: an early child failure must never be an unhandled rejection.
  completion.catch(() => {})
  return { child, completion }
}

export async function readSafe(
  root: string,
  input: string,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const { child, completion } = reader(root, input, limit, signal)
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of child.stdout) {
      size += chunk.length
      if (size > limit) throw new ArchiveError('payload_too_large')
      chunks.push(chunk)
    }
    await completion
    return Buffer.concat(chunks)
  } finally {
    if (child.exitCode === null) child.kill()
  }
}

export async function copySafe(
  root: string,
  input: string,
  destination: string,
  signal: AbortSignal,
) {
  const { child, completion } = reader(root, input, MAX_FILE, signal)
  const hash = createHash('sha256')
  let size = 0
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length
      if (size > MAX_FILE) return done(new ArchiveError('payload_too_large'))
      hash.update(chunk)
      done(null, chunk)
    },
  })
  try {
    await pipeline(
      child.stdout,
      counter,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
      { signal },
    )
    await completion
    const file = await open(destination, 'r')
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    return { size, sha256: hash.digest('hex') }
  } finally {
    if (child.exitCode === null) child.kill()
  }
}

export async function privateDirectory(root: string, path: string) {
  const rel = relativeFile(root, path)
  let current = root
  for (const part of rel.split(sep)) {
    current = resolve(current, part)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e
    }
    const st = await lstat(current)
    if (!st.isDirectory() || st.isSymbolicLink() || (await realpath(current)) !== current)
      throw new ArchiveError('path_not_allowed')
  }
}

export function mediaType(filename: string) {
  if (/\.png$/i.test(filename)) return 'image/png'
  if (/\.jpe?g$/i.test(filename)) return 'image/jpeg'
  if (/\.json$/i.test(filename)) return 'application/json'
  if (/\.(py|js|ts|sh|txt|log|http|md|html|yaml|yml|xml|csv)$/i.test(filename)) return 'text/plain'
  return 'application/octet-stream'
}
