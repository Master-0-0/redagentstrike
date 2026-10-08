import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { endpoint, contextFor, executeIntel } from '../src/client.ts'

test('local endpoint rejects remote roots, redirects credentials and URL payloads', () => {
  assert.equal(endpoint('http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
  for (const input of ['https://example.com', 'http://127.0.0.1/x', 'http://user:password@localhost', 'http://localhost/?q=x']) assert.throws(() => endpoint(input))
})

test('runtime context follows subagent lineage, forks own their source, no board required', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intel-context-'))
  try {
    const parent = { id: 'main', header: { cwd: root } }
    const exec = { agent: { session: { id: 'child', header: { cwd: root, origin: 'subagent', parentSession: 'main' } } } }
    assert.equal((await contextFor({ get: () => ({ get: () => parent }) }, exec)).owner_session_id, 'main')
    assert.equal((await contextFor({}, exec)).owner_session_id, null)
    assert.equal((await contextFor({}, { agent: { session: { id: 'fork', header: { cwd: root, origin: 'fork', parentSession: 'main' } } } })).owner_session_id, 'fork')
    assert.deepEqual(await readdir(root), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('encrypted durable retry, stable context, query whitelist, timeout and failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intel-client-')), oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const received: any[] = []
  let fail = true, hanging = false
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    received.push({ url: req.url, body: JSON.parse(text) })
    if (hanging) return
    res.setHeader('content-type', 'application/json')
    if (fail) { res.statusCode = 503; res.end(JSON.stringify({ error_code: 'intel_storage_unavailable' })); return }
    res.end(JSON.stringify({ ok: true, entities: [{ ref: 'p', id: 'saved-id' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const config = { apiUrl: `http://127.0.0.1:${address.port}` }
  const exec = { agent: { session: { id: 'original', header: { cwd: root } } } }
  const args = { submission_key: 'stable', entities: [{ ref: 'p', kind: 'password', name: 'fixture', identifier: 'fixture', secret: 'NEVER-PLAINTEXT-IN-OUTBOX' }] }
  try {
    const first = await executeIntel('save', args, {}, exec, config)
    assert.equal(first.ok, false); assert.equal(first.submission_key, 'stable'); assert.equal(first.retryable, true)
    const dirs = await readdir(join(root, 'intel-outbox'))
    const file = await readFile(join(root, 'intel-outbox', dirs[0], 'stable.bin'))
    assert.equal(file.includes(Buffer.from('NEVER-PLAINTEXT-IN-OUTBOX')), false)
    fail = false
    const restored = await executeIntel('save', { op: 'retry', submission_key: 'stable' }, {}, { agent: { session: { id: 'later', header: { cwd: root } } } }, config)
    assert.equal(restored.ok, true)
    assert.deepEqual(received[0].body, received[1].body)
    const conflict = await executeIntel('save', { ...args, entities: [] }, {}, exec, config)
    assert.equal(conflict.error_code, 'submission_conflict')
    await executeIntel('query', { q: 'fixture', context: { workspace_path: '/other' }, workspace_id: 'forged' }, {}, exec, config)
    assert.equal(received.at(-1).body.context.session_id, 'original')
    assert.equal(received.at(-1).body.workspace_id, undefined)
    assert.notEqual(received.at(-1).body.context.workspace_path, '/other')
    hanging = true
    const timeout = await executeIntel('query', {}, {}, exec, { ...config, timeoutMs: 30 })
    assert.equal(timeout.ok, false)
    assert.equal(timeout.error_code, 'intel_unavailable')
    assert.equal((await executeIntel('save', { op: 'retry', submission_key: '../escape' }, {}, exec, config)).error_code, 'invalid_submission_key')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    await rm(root, { recursive: true, force: true })
  }
})
