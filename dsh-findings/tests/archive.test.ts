import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { archiveFinding } from '../src/archive.ts'
import { sourceContext } from '../src/context.ts'
import { prepareOutbox, loadOutbox } from '../src/outbox.ts'
import { readSafe } from '../src/artifacts.ts'
import { endpoint } from '../src/client.ts'

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'findings-'))
  // macOS /var is a symlink; the actual workspace identity is canonical.
  const { realpath } = await import('node:fs/promises')
  const cwd = await realpath(root)
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'evidence.txt'), 'original evidence')
  return cwd
}
function execution(cwd: string, id = 'parent', header: any = {}) {
  return { agent: { session: { id, header: { cwd, ...header } } } }
}
const input = () => ({
  op: 'create',
  finding: {
    title: 'Fixture',
    target: 'local',
    summary: 'Saved fixture',
    severity: 'unknown',
    preconditions: 'fixture',
    steps: [{ id: 'step-1', description: 'Read fixture' }],
    expected_result: 'fixture',
    actual_result: 'fixture',
    agent_assessment: 'suspected',
  },
  artifacts: [
    { client_id: 'log', kind: 'tool_output', path: 'evidence.txt', step_ids: ['step-1'] },
  ],
  evidence_gaps: [
    { category: 'poc', status: 'missing', reason: 'not collected' },
    { category: 'http', status: 'not_applicable', reason: 'local fixture' },
    { category: 'screenshot', status: 'not_applicable', reason: 'text fixture' },
  ],
})

test('stable keys, explicit occurrences, and retry after original deletion', async (t) => {
  const cwd = await fixture(t)
  const source = await sourceContext({}, execution(cwd), [])
  const a = await prepareOutbox(input(), source, AbortSignal.timeout(10000))
  const b = await prepareOutbox(input(), source, AbortSignal.timeout(10000))
  assert.equal(a.manifest.submission_key, b.manifest.submission_key)
  const c = await prepareOutbox(
    { ...input(), occurrence_id: 'second' },
    source,
    AbortSignal.timeout(10000),
  )
  assert.notEqual(a.manifest.submission_key, c.manifest.submission_key)
  await rm(join(cwd, 'evidence.txt'))
  const saved = await loadOutbox(cwd, a.manifest.submission_key, AbortSignal.timeout(10000))
  assert.equal(await readFile(join(saved.path, 'artifacts/log'), 'utf8'), 'original evidence')
  assert.ok(!(await readFile(join(saved.path, 'manifest.json'), 'utf8')).includes('apiUrl'))
})

test('source parent chain, fork, unresolved parent and fact snapshots', async (t) => {
  const cwd = await fixture(t)
  await mkdir(join(cwd, '.dsh/blackboards'), { recursive: true })
  await writeFile(
    join(cwd, '.dsh/blackboards/parent.json'),
    JSON.stringify({ facts: [{ id: 'f001', description: 'parent fact' }] }),
  )
  await writeFile(
    join(cwd, '.dsh/blackboards/fork.json'),
    JSON.stringify({ facts: [{ id: 'f001', description: 'fork fact' }] }),
  )
  const ctx = {
    get: () => ({
      get: (id: string) => (id === 'parent' ? execution(cwd).agent.session : undefined),
    }),
  }
  const child = await sourceContext(
    ctx,
    execution(cwd, 'child', { origin: 'subagent', parentSession: 'parent' }),
    ['f001'],
  )
  assert.equal(child.session_id, 'child')
  assert.equal(child.owner_session_id, 'parent')
  assert.equal(child.fact_snapshots[0].description, 'parent fact')
  const fork = await sourceContext(ctx, execution(cwd, 'fork', { parentSession: 'parent' }), [
    'f001',
  ])
  assert.equal(fork.owner_session_id, 'fork')
  assert.equal(fork.fact_snapshots[0].description, 'fork fact')
  const unknown = await sourceContext(
    {},
    execution(cwd, 'child', { origin: 'subagent', parentSession: 'missing' }),
    [],
  )
  assert.equal(unknown.owner_resolution, 'unresolved')
  assert.equal(unknown.owner_session_id, null)
  await assert.rejects(
    sourceContext({}, execution(cwd, 'child', { origin: 'subagent', parentSession: 'missing' }), [
      'f001',
    ]),
    /父链缺失/,
  )
  assert.equal((await archiveFinding(input(), {}, {})).error_code, 'context_missing')
})

test('reject traversal, symlinks (including ancestor), FIFO and oversized files', async (t) => {
  const cwd = await fixture(t)
  await symlink('/etc/hosts', join(cwd, 'outside'))
  await symlink('/etc', join(cwd, 'outside-dir'))
  await promisify(execFile)('mkfifo', [join(cwd, 'fifo')])
  for (const path of ['../outside', '/etc/hosts', 'outside', 'outside-dir/hosts', 'fifo'])
    await assert.rejects(readSafe(cwd, path, 1024, AbortSignal.timeout(2000)))
  await assert.rejects(readSafe(cwd, 'evidence.txt', 2), /payload_too_large/)
  await symlink('/tmp', join(cwd, '.dsh'))
  const result = await archiveFinding(input(), {}, execution(cwd))
  assert.equal(result.ok, false)
  assert.equal(result.error_code, 'path_not_allowed')
})

test('failed service returns persisted key, retry streams old copy and saves receipt', async (t) => {
  const cwd = await fixture(t)
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address() as { port: number }
  const apiUrl = `http://127.0.0.1:${address.port}`
  await new Promise<void>((r) => server.close(() => r()))
  const result = await archiveFinding(input(), {}, execution(cwd), { apiUrl })
  assert.equal(result.ok, false)
  assert.ok(result.submission_key)
  await writeFile(join(cwd, 'evidence.txt'), 'changed source')
  let uploaded = ''
  let manifest: any
  const retryServer = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    res.setHeader('content-type', 'application/json')
    if (req.url === '/finding-submissions') {
      manifest = JSON.parse(body)
      res.end(JSON.stringify({ id: 's1', received: [], receipt: null }))
    } else if (req.method === 'PUT') {
      uploaded = body
      res.end('{}')
    } else
      res.end(
        JSON.stringify({
          ok: true,
          finding_id: 'f1',
          submission_key: manifest.submission_key,
          warnings: [],
        }),
      )
  })
  await new Promise<void>((r) => retryServer.listen(address.port, '127.0.0.1', r))
  t.after(() => new Promise<void>((r) => retryServer.close(() => r())))
  const retry = await archiveFinding(
    { op: 'retry', submission_key: result.submission_key },
    {},
    execution(cwd),
    { apiUrl },
  )
  assert.equal(retry.ok, true)
  assert.equal(uploaded, 'original evidence')
  const saved = await loadOutbox(cwd, result.submission_key!, AbortSignal.timeout(3000))
  assert.equal(JSON.parse(await readFile(join(saved.path, 'result.json'), 'utf8')).finding_id, 'f1')
})

test('loopback endpoint only and bounded timeout', async (t) => {
  for (const u of [
    'https://example.com',
    'http://127.0.0.1.evil.test',
    'http://user:password@localhost',
    'http://localhost/path',
  ])
    assert.throws(() => endpoint(u))
  const cwd = await fixture(t)
  const server = createServer((_req, _res) => {})
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const result = await archiveFinding(input(), {}, execution(cwd), {
    apiUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    timeoutMs: 200,
  })
  assert.equal(result.error_code, 'timeout')
  assert.equal(result.ok, false)
})
