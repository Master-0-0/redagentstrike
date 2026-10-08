/** Real Harness preset/tool/subagent integration; scripted LLM, only local fixture data. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(root, '..')
const requireHost = createRequire(join(homedir(), '.dsh/profiles/web/package.json'))
const pkg = name => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)).href)
const { Context } = await pkg('cordis')
const { default: Loader } = await pkg('cordis-plugin-loader')
const { default: Include } = await pkg('cordis-plugin-include')
const { default: AgentLoop } = await pkg('dsh-agent-loop')
const { default: AgentPresets } = await pkg('dsh-agent-presets')
const { default: Skills } = await pkg('dsh-skill')
const { LlmAdapter } = await pkg('dsh-llm')
const { snapshotSubagentDescriptor } = await pkg('dsh-subagent')
const { startInProcessRun } = await import(pathToFileURL(join(repo, 'deepseek-harness/packages/subagent/subagent-in-process-driver/lib/index.js')).href)
const { mountAgentLoopTestDependencies } = await import(pathToFileURL(join(repo, 'deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js')).href)
const apiUrl = process.argv[2]
await mkdir(process.argv[3], { recursive: true })
const cwd = await realpath(process.argv[3])
await mkdir(join(cwd, 'presets/cairn'), { recursive: true })
await writeFile(join(cwd, 'presets/cairn/agent.cordis.yml'), `- id: intel-library\n  name: ${JSON.stringify(join(root, 'lib/index.js'))}\n  config:\n    apiUrl: ${apiUrl}\n- id: skills\n  name: ${JSON.stringify(requireHost.resolve('@deepseek-ai/dsh-skill-filesystem'))}\n  config:\n    customSkillDirs:\n      - ${JSON.stringify(join(root, 'skills'))}\n- id: tool-skill\n  name: ${JSON.stringify(requireHost.resolve('@deepseek-ai/dsh-tool-skill'))}\n`)
await mkdir(join(cwd, '.dsh/blackboards'), { recursive: true })
const board = JSON.stringify({ facts: [{ id: 'f001', description: 'Fixture summary, unchanged.' }] })
await writeFile(join(cwd, '.dsh/blackboards/parent.json'), board)
class Adapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'fixture ready' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture ready' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const ctx = new Context(); let run
try {
  ctx.baseUrl = pathToFileURL(cwd).href + '/'
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(Skills)
  await ctx.plugin(AgentPresets, { default: 'cairn', roots: [{ path: join(cwd, 'presets'), trust: 'system' }], includeShippedRoot: false, includeUserRoot: false })
  const adapter = new Adapter(); ctx.llm.registerAdapter(['fixture'], adapter)
  const parent = (await ctx.agents.create({ sessionId: 'parent', meta: { cwd }, agentOptions: { provider: 'fixture', model: 'fixture' }, setup: async agentCtx => void (await ctx.agentPresets.mount(agentCtx, 'cairn')) })).agent
  assert.equal(ctx.tools.schemas().some(t => t.name === 'save_intel'), false)
  assert.ok(ctx.tools.schemas(parent).some(t => t.name === 'query_intel_lib'))
  run = await startInProcessRun({ label: 'intel fixture', prompt: [{ type: 'text', text: 'Return ready.' }], parent, signal: new AbortController().signal, descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'spawn', label: 'intel fixture' }) }, {})
  await run.result
  const child = run.localAgent
  assert.ok(adapter.requests.at(-1).tools.some(t => t.name === 'save_intel'))
  assert.ok(JSON.stringify(adapter.requests.at(-1)).includes('intel-library'))
  const call = (name, args, agent = child) => ctx.tools.execute({ signal: new AbortController().signal, callId: crypto.randomUUID(), name, arguments: args, agent })
  const skill = await call('skill', { name: 'intel-library' })
  assert.ok(JSON.stringify(skill).includes('Runtime intelligence'))
  const saved = await call('save_intel', { submission_key: 'harness-fixture', entities: [{ ref: 'p', kind: 'token', name: 'HARNESS_FIXTURE', identifier: 'fixture-service', secret: 'FIXTURE-NOT-REAL' }] })
  assert.ok(JSON.stringify(saved).includes('"ok":true'), JSON.stringify(saved).slice(0, 1200))
  const workspaces = await fetch(apiUrl + '/intel/workspaces').then(r => r.json())
  const wid = workspaces.items.find(w => w.path === cwd).id
  const result = await fetch(apiUrl + `/intel/workspaces/${wid}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.json())
  const eid = result.items[0].id
  assert.equal(result.items[0].latest_observation.session_id, child.session.id)
  assert.equal(result.items[0].latest_observation.owner_session_id, 'parent')
  const summary = await call('query_intel_lib', { ids: [eid] }, parent)
  assert.ok(!JSON.stringify(summary).includes('FIXTURE-NOT-REAL'))
  const revealed = await call('query_intel_lib', { ids: [eid], include_secrets: true }, parent)
  assert.ok(JSON.stringify(revealed).includes('FIXTURE-NOT-REAL'))
  assert.equal(await readFile(join(cwd, '.dsh/blackboards/parent.json'), 'utf8'), board)
  const verification = { preset_scoped: true, inherited_by_child: true, skill_loaded: true, child_save_parent_query: true, explicit_secret_read: true, board_unchanged: true }
  await writeFile(join(cwd, 'verification.json'), JSON.stringify(verification, null, 2))
  console.log(JSON.stringify(verification))
} finally { if (run) await run.dispose(); await ctx.fiber.dispose() }
