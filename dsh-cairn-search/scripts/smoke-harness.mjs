/** Real Loader/Agent/Tools composition, deterministic local model, no network. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(root, '..')
const host = createRequire(join(homedir(), '.dsh/profiles/web/package.json'))
const pkg = name => import(pathToFileURL(host.resolve('@deepseek-ai/' + name)).href)
const { Context } = await pkg('cordis')
const { default: Loader } = await pkg('cordis-plugin-loader')
const { default: AgentLoop } = await pkg('dsh-agent-loop')
const { default: SessionPersistence } = await pkg('dsh-session-persistence-jsonl')
const { default: SessionQuery } = await pkg('dsh-session-query-sqlite')
const { default: AgentPresets } = await pkg('dsh-agent-presets')
const { default: Skills } = await pkg('dsh-skill')
const { SubagentRuntime } = await pkg('dsh-subagent')
const Spawn = await pkg('dsh-subagent-spawn-in-process')
const Fork = await pkg('dsh-subagent-fork-in-process')
const { LlmAdapter, createUserMessage } = await pkg('dsh-llm')
const { defineTool } = await pkg('dsh-tools')
const { mountAgentLoopTestDependencies } = await import(pathToFileURL(join(repo, 'deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js')).href)
const cwd = await realpath(await mkdtemp(join(tmpdir(), 'cairn-composition-')))
let ctx = new Context()
class Adapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    const text = JSON.stringify({ description: 'Verified fixture evidence in evidence.txt' })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const adapter = new Adapter()
async function mountHost() {
  ctx.baseUrl = pathToFileURL(cwd).href + '/'
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionPersistence, { root: join(cwd, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionQuery, { path: join(cwd, 'sessions.sqlite') })
  await ctx.plugin(Skills)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn)
  await ctx.plugin(Fork)
  await ctx.plugin(AgentPresets, { default: 'plain', roots: [{ path: join(cwd, 'presets'), trust: 'system' }], includeShippedRoot: false, includeUserRoot: false })
  ctx.llm.registerAdapter(['fixture'], adapter)
  ctx.tools.register(defineTool({ name: 'bash', description: 'fixture execution', parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: { executed: { type: 'boolean', required: true } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: () => ({ executed: true }) }))
  // The shipped preset registers these tools; this fixture needs only their
  // catalog identities to validate its exact explorer deny-list.
  for (const name of ['workflow', 'ralph']) ctx.tools.register(defineTool({
    name, description: 'restricted fixture tool', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
    execute: () => { throw new Error('restricted tool must never execute') },
  }))
}
try {
  for (const name of ['cairn', 'plain']) await mkdir(join(cwd, 'presets', name), { recursive: true })
  await writeFile(join(cwd, 'presets/plain/agent.cordis.yml'), '[]\n')
  await writeFile(join(cwd, 'presets/cairn/agent.cordis.yml'), JSON.stringify([
    { id: 'cairn', name: join(root, 'lib/index.js') },
    { id: 'skills', name: host.resolve('@deepseek-ai/dsh-skill-filesystem'), config: { customSkillDirs: [join(root, 'preset/skills')] } },
    { id: 'tool-skill', name: host.resolve('@deepseek-ai/dsh-tool-skill') },
    { id: 'subagent', name: host.resolve('@deepseek-ai/dsh-tool-subagent'), config: { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable', toolFilter: { deny: ['blackboard', 'subagent', 'subagent_fork', 'workflow', 'ralph'] }, persona: 'You are a Cairn explorer. Load cairn-explorer, execute only your assigned intent.' } },
    { id: 'subagent-fork', name: host.resolve('@deepseek-ai/dsh-tool-subagent'), config: { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable', toolFilter: { deny: ['blackboard', 'subagent', 'subagent_fork', 'workflow', 'ralph'] }, persona: 'You are a Cairn explorer. Load cairn-explorer, execute only your assigned intent.' } },
  ]))
  await mountHost()
  const create = async (id, preset) => (await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions: { provider: 'fixture', model: 'fixture' }, setup: async c => void(await ctx.agentPresets.mount(c, preset)) })).agent
  let parent = await create('parent', 'cairn')
  const plain = await create('plain', 'plain')
  const call = (name, args, agent = parent) => ctx.tools.execute({ signal: new AbortController().signal, callId: crypto.randomUUID(), name, arguments: args, agent })
  const childChecks = []
  ctx.on('subagent/start', info => {
    childChecks.push((async () => {
      const child = ctx.agents.get(info.id)
      assert.ok(child, 'the dispatched explorer is registered')
      assert.equal((await call('skill', { name: 'cairn-explorer' }, child)).isError, false)
      assert.equal((await call('skill', { name: 'state-space-search' }, child)).isError, true)
      assert.equal((await call('bash', {}, child)).isError, false)
      assert.equal((await call('blackboard', { op: 'snapshot' }, child)).isError, true)
    })())
  })
  assert.equal((await call('bash', {})).isError, true)
  assert.equal((await call('bash', {}, plain)).isError, false)
  let reasonId
  const boardCall = async args => {
    if (args.op === 'reason_finish') args = { ...args, reasonId }
    const result = await call('blackboard', args)
    assert.equal(result.isError, false, JSON.stringify(result))
    if (result.value.board?.reason?.id) reasonId = result.value.board.reason.id
    return result.value
  }
  assert.equal((await boardCall({ op: 'init', title: 'fixture', origin: 'start', goal: 'verify evidence' })).next.kind, 'reason')
  await boardCall({ op: 'reason_start', worker: 'parent' })
  await boardCall({ op: 'reason_finish', worker: 'parent', intents: [{ from: ['origin'], target: 'fixture', description: 'verify fixture', skills: ['cairn-explorer'] }] })
  await boardCall({ op: 'claim', intentId: 'i001', worker: 'parent' })
  const spawned = await call('subagent', { prompt: 'blackboard_intent: i001\nCheck the fixture.', description: 'fixture', run_in_background: false })
  assert.equal(spawned.isError, false, JSON.stringify(spawned))
  assert.ok(JSON.stringify(adapter.requests).includes('Direct premises'))
  assert.ok(JSON.stringify(adapter.requests).includes('cairn-explorer'))
  const snapshot = await boardCall({ op: 'snapshot' })
  assert.equal(snapshot.next.kind, 'review')
  await boardCall({ op: 'conclude', intentId: 'i001', worker: 'parent', description: 'Verified fixture evidence.' })
  await boardCall({ op: 'reason_start', worker: 'parent' })
  await boardCall({ op: 'reason_finish', worker: 'parent', complete: { from: ['f001'], description: 'The fixture was verified.', proofs: [{ criterionId: 'c001', from: ['f001'], description: 'Verified fixture evidence.' }] } })
  const persisted = JSON.parse(await readFile(join(cwd, '.dsh/blackboards/parent.json'), 'utf8'))
  assert.equal(persisted.status, 'completed')
  assert.ok(persisted.workerReturns.some(r => r.resolution?.action === 'conclude'))
  await boardCall({ op: 'reopen', description: 'Verify continuable background return handling.' })
  await boardCall({ op: 'reason_start', worker: 'parent' })
  await boardCall({ op: 'reason_finish', worker: 'parent', intents: [{ from: ['f001'], target: 'background', description: 'verify background fixture', skills: ['cairn-explorer'] }] })
  await boardCall({ op: 'claim', intentId: 'i003', worker: 'parent' })
  let settled
  const ended = new Promise(resolve => { settled = resolve })
  const disposeEnd = ctx.on('subagent/end', settled)
  let timer
  try {
    const result = await call('subagent', { prompt: 'blackboard_intent: i003\nCheck the background fixture.', description: 'background fixture', run_in_background: true })
    assert.equal(result.isError, false, JSON.stringify(result))
    await Promise.race([ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('background fixture did not settle')), 5000) })])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review the returned fixture evidence.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const review = await boardCall({ op: 'snapshot' })
    assert.equal(review.next.kind, 'review')
    const durable = JSON.parse(await readFile(join(cwd, '.dsh/blackboards/parent.json'), 'utf8'))
    assert.ok(durable.workerReturns.some(r => r.intentId === 'i003' && r.kind === 'return'))
    await boardCall({ op: 'conclude', intentId: 'i003', worker: 'parent', description: 'Reviewed background fixture evidence.' })
  } finally { clearTimeout(timer); disposeEnd() }
  await boardCall({ op: 'reason_start', worker: 'parent' })
  await boardCall({ op: 'reason_finish', worker: 'parent', intents: [{ from: ['f002'], target: 'fork', description: 'verify fork explorer isolation', skills: ['cairn-explorer'] }] })
  await boardCall({ op: 'claim', intentId: 'i004', worker: 'parent' })
  const forked = await call('subagent_fork', { prompt: 'blackboard_intent: i004\nVerify the assigned evidence.', description: 'fork fixture', run_in_background: false })
  assert.equal(forked.isError, false, JSON.stringify(forked))
  await boardCall({ op: 'conclude', intentId: 'i004', worker: 'parent', description: 'Reviewed fork evidence.' })
  await Promise.all(childChecks)
  assert.equal(childChecks.length, 3)
  // Recover an interrupted reasoning lease and a claim committed before dispatch.
  await boardCall({ op: 'reason_start', worker: 'parent' })
  const heldReason = reasonId
  const restart = async () => {
    await ctx.fiber.dispose()
    ctx = new Context()
    await mountHost()
    parent = (await ctx.agents.resume({ resumeSessionId: 'parent', agentOptions: { provider: 'fixture', model: 'fixture' }, setup: async c => void(await ctx.agentPresets.mount(c, 'cairn')) })).agent
  }
  await restart()
  const recovered = await boardCall({ op: 'snapshot' })
  assert.equal(recovered.next.kind, 'reason')
  assert.equal(recovered.board.reason.id, heldReason)
  await boardCall({ op: 'reason_finish', worker: 'parent', intents: [{ from: ['f002'], target: 'restart', description: 'verify cold recovery' }] })
  await boardCall({ op: 'claim', intentId: 'i005', worker: 'parent' })
  await restart()
  const pending = await boardCall({ op: 'next' })
  assert.equal(pending.next.kind, 'explore')
  assert.equal(pending.next.intent.id, 'i005')
  assert.equal((await call('bash', {})).isError, true)
  const finalDispatch = await call('subagent', { prompt: 'blackboard_intent: i005\nVerify the resumed task.', description: 'cold recovery', run_in_background: false })
  assert.equal(finalDispatch.isError, false, JSON.stringify(finalDispatch))
  assert.equal((await boardCall({ op: 'snapshot' })).next.kind, 'review')
  console.log('PASS: Loader composition, scoped parent enforcement, unaffected plain mode, actual child dispatch, child skill loading and tool isolation, foreground/background review, completion and fresh-host recovery')
} finally {
  await ctx.fiber.dispose()
  await rm(cwd, { recursive: true, force: true })
}
