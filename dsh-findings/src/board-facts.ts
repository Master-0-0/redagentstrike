import { createHash } from 'node:crypto'
import { parser } from 'stream-json'
import { pick } from 'stream-json/filters/pick.js'
import { streamArray } from 'stream-json/streamers/stream-array.js'
import chain, { none } from 'stream-chain'
import { ArchiveError, reader } from './artifacts.ts'

/** Stream only fact records from an anchored board descriptor. Historical raw
 * returns never become an in-memory board or count toward the receipt budget.
 */
export async function readBoardFacts(root: string, path: string, ids: string[], signal?: AbortSignal): Promise<{ id: string; description: string }[]> {
  const wanted = new Set(ids)
  const found = new Map<string, { id: string; description: string }>()
  const segments = []
  for await (const ref of records(root, path, 'segments.facts', signal)) {
    if (typeof ref?.path !== 'string' || !/^\.dsh\/blackboard-segments\/[a-f0-9]{64}\.json$/.test(ref.path) || !Number.isSafeInteger(ref.count) || ref.count < 1 || ref.count > 256) throw new ArchiveError('invalid_manifest')
    segments.push(ref)
  }
  async function* facts() {
    if (!segments.length) { yield* records(root, path, 'facts', signal); return }
    for (const ref of segments) {
      let count = 0
      for await (const fact of records(root, ref.path, '', signal, ref.path.split('/').at(-1)!.slice(0, 64))) { count++; yield fact }
      if (count !== ref.count) throw new ArchiveError('invalid_manifest')
    }
  }
  let bytes = 0
  {
    for await (const fact of facts()) {
      if (!wanted.has(fact?.id)) continue
      if (typeof fact.description !== 'string') throw new ArchiveError('invalid_manifest')
      bytes += Buffer.byteLength(fact.description, 'utf8')
      if (bytes > 1024 * 1024) throw new ArchiveError('payload_too_large', 'Selected fact descriptions exceed the receipt budget')
      found.set(fact.id, { id: fact.id, description: fact.description })
    }
    return [...wanted].map(id => {
      const fact = found.get(id)
      if (!fact) throw new ArchiveError('invalid_manifest', `事实不存在：${id}`)
      return fact
    })
  }
}

async function* records(root: string, path: string, filter: string, signal?: AbortSignal, expectedHash?: string): AsyncGenerator<any> {
  const { child, completion } = reader(root, path, Number.MAX_SAFE_INTEGER, signal)
  const hash = createHash('sha256')
  child.stdout.on('data', data => hash.update(data))
  let string: string | undefined
  // Pack only strings surviving the facts filter. Raw return strings are
  // discarded token-by-token rather than allocated by the parser.
  const packFactStrings = (token: { name: string; value?: string }) => {
    if (token.name === 'startString') { string = ''; return none }
    if (token.name === 'stringChunk' && string !== undefined) {
      string += token.value ?? ''
      if (string.length > 1024 * 1024) throw new ArchiveError('payload_too_large')
      return none
    }
    if (token.name === 'endString' && string !== undefined) {
      const value = string; string = undefined
      return { name: 'stringValue', value }
    }
    return token
  }
  const stream = chain([child.stdout, parser({ packStrings: false }), ...(filter ? [pick({ filter })] : []), packFactStrings, streamArray()])
  try {
    for await (const entry of stream) yield entry.value
    await completion
    if (expectedHash && hash.digest('hex') !== expectedHash) throw new ArchiveError('invalid_manifest', 'Fact segment failed integrity check')
  } finally {
    stream.destroy()
    if (child.exitCode === null) child.kill()
  }
}
