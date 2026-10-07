#!/usr/bin/env node
/** Deterministic local integration through real Harness registry/preset/subagent runtime.
 * Only the LLM transport is scripted. No scan, shell, browser target or replay tool is used.
 * Usage: node scripts/smoke-harness.mjs http://127.0.0.1:18789 /absolute/private/workspace
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(pluginRoot, '..')
const requireHost = createRequire(join(homedir(), '.dsh/profiles/web/package.json'))
const pkg = async (name) => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)).href)
const { Context } = await pkg('cordis')
const { default: Loader } = await pkg('cordis-plugin-loader')
const { default: Include } = await pkg('cordis-plugin-include')
const { default: AgentLoop } = await pkg('dsh-agent-loop')
const { default: AgentPresets } = await pkg('dsh-agent-presets')
const { default: Skills } = await pkg('dsh-skill')
const { LlmAdapter } = await pkg('dsh-llm')
const { snapshotSubagentDescriptor } = await pkg('dsh-subagent')
const { startInProcessRun } = await import(
  pathToFileURL(
    join(repo, 'deepseek-harness/packages/subagent/subagent-in-process-driver/lib/index.js'),
  ).href
)
const { mountAgentLoopTestDependencies } = await import(
  pathToFileURL(
    join(repo, 'deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'),
  ).href
)
const apiUrl = process.argv[2] || 'http://127.0.0.1:18789'
await mkdir(process.argv[3], { recursive: true, mode: 0o700 })
const cwd = await realpath(process.argv[3])
await mkdir(join(cwd, 'presets/cairn'), { recursive: true })
// Real file-loader resolution of the production built plugin in a preset.
await writeFile(
  join(cwd, 'presets/cairn/agent.cordis.yml'),
  `- id: findings-archive\n  name: ${JSON.stringify(requireHost.resolve('dsh-findings'))}\n  config:\n    apiUrl: ${apiUrl}\n- id: skills\n  name: ${JSON.stringify(requireHost.resolve('@deepseek-ai/dsh-skill-filesystem'))}\n  config:\n    customSkillDirs:\n      - ${JSON.stringify(join(pluginRoot, 'skills'))}\n- id: tool-skill\n  name: ${JSON.stringify(requireHost.resolve('@deepseek-ai/dsh-tool-skill'))}\n`,
)
await writeFile(join(cwd, 'poc.txt'), 'Fixture PoC source; no executable payload.\n')
await writeFile(join(cwd, 'request.http'), 'GET /fixture HTTP/1.1\nHost: local-fixture\n\n')
await writeFile(
  join(cwd, 'response.http'),
  'HTTP/1.1 200 OK\nContent-Type: text/plain\n\narchival fixture\n',
)
await writeFile(
  join(cwd, 'tool.log'),
  'Local integration fixture produced the attached evidence files.\n',
)
await mkdir(join(cwd, '.dsh/blackboards'), { recursive: true })
const board = JSON.stringify({
  facts: [{ id: 'f001', description: 'Local fixture evidence was generated for archive testing.' }],
})
await writeFile(join(cwd, '.dsh/blackboards/parent.json'), board)
class Adapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }
  async *stream(options) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'child fixture ready' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'child fixture ready' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const ctx = new Context()
let run
try {
  ctx.baseUrl = pathToFileURL(cwd).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Skills)
  await ctx.plugin(AgentPresets, {
    default: 'cairn',
    roots: [{ path: join(cwd, 'presets'), trust: 'system' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const parent = (
    await ctx.agents.create({
      sessionId: 'parent',
      meta: { cwd },
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: async (agentCtx) => void (await ctx.agentPresets.mount(agentCtx, 'cairn')),
    })
  ).agent
  assert.equal(
    ctx.tools.schemas().some((s) => s.name === 'archive_finding'),
    false,
    'must not be global',
  )
  assert.ok(ctx.tools.schemas(parent).some((s) => s.name === 'archive_finding'))
  assert.ok(
    (await ctx.systemPrompt.assemble({ scope: parent })).sections.some(
      (s) => s.name === 'findings-archive-default' && s.text.includes('default part of the task'),
    ),
  )
  assert.ok(
    !(await ctx.systemPrompt.assemble()).sections.some(
      (s) => s.name === 'findings-archive-default',
    ),
  )
  run = await startInProcessRun(
    {
      label: 'archive fixture child',
      prompt: [{ type: 'text', text: 'Return fixture ready; do not run anything.' }],
      parent,
      signal: new AbortController().signal,
      descriptor: snapshotSubagentDescriptor({
        mode: 'one-shot',
        provider: 'spawn',
        label: 'archive fixture child',
      }),
    },
    {},
  )
  await run.result
  const child = run.localAgent
  assert.ok(child)
  assert.ok(
    adapter.requests.at(-1).tools.some((t) => t.name === 'archive_finding'),
    'actual child request must contain archive tool',
  )
  assert.ok(ctx.tools.schemas(child).some((t) => t.name === 'archive_finding'))
  assert.ok(
    JSON.stringify(adapter.requests.at(-1)).includes(
      'Default findings archiving for authorized testing',
    ),
    'child request must carry default independent guidance',
  )
  const skillResult = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: 'load-archive-skill',
    name: 'skill',
    arguments: { name: 'finding-archive' },
    agent: child,
  })
  assert.ok(
    JSON.stringify(skillResult).includes('Archiving is never a Cairn completion condition'),
    'archive skill must load in actual child',
  )
  const args = {
    op: 'create',
    finding: {
      title: '本地归档闭环验证',
      target: 'local-fixture（无外部目标）',
      summary: '通过真实 Harness 工具注册、Cairn preset 和探索子代理上下文提交证据。',
      severity: 'info',
      preconditions: '本机隔离测试材料',
      steps: [{ id: 'step-1', description: '检查已生成的本地证据文件' }],
      expected_result: '归档后文件可独立读取',
      actual_result: '等待归档服务校验并提交',
      agent_assessment: 'suspected',
    },
    fact_ids: ['f001'],
    artifacts: [
      ['poc', 'poc.txt'],
      ['http_request', 'request.http'],
      ['http_response', 'response.http'],
      ['tool_output', 'tool.log'],
      ['response_screenshot', 'response.png'],
    ].map(([kind, path], i) => ({
      client_id: `evidence-${i}`,
      kind,
      path,
      step_ids: ['step-1'],
      capture_method: 'local_integration_fixture',
    })),
    evidence_gaps: [],
  }
  const toolResult = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: 'archive-fixture-1',
    name: 'archive_finding',
    arguments: args,
    agent: child,
  })
  await writeFile(join(cwd, 'tool-result.json'), JSON.stringify(toolResult, null, 2))
  const receiptText = JSON.stringify(toolResult)
  assert.ok(
    receiptText.includes('finding_id') && receiptText.includes('"ok":true'),
    'tool must return a committed receipt: ' + receiptText.slice(0, 1200),
  )
  const listing = await fetch(apiUrl + '/findings').then((r) => r.json())
  const item = listing.items.find((f) => f.title === args.finding.title)
  assert.ok(item)
  const detail = await fetch(apiUrl + '/findings/' + item.id).then((r) => r.json())
  assert.equal(detail.sources[0].session_id, child.session.id)
  assert.equal(detail.sources[0].owner_session_id, 'parent')
  assert.equal(detail.review_status, 'pending')
  assert.equal(detail.artifacts.length, 5)
  assert.equal(await readFile(join(cwd, '.dsh/blackboards/parent.json'), 'utf8'), board)
  for (const a of args.artifacts) await rm(join(cwd, a.path))
  for (const a of detail.artifacts)
    assert.equal((await fetch(apiUrl + `/findings/${item.id}/artifacts/${a.id}`)).status, 200)
  await run.dispose()
  run = null
  await writeFile(
    join(cwd, 'verification.json'),
    JSON.stringify(
      {
        finding_id: item.id,
        execution_session: child.session.id,
        owner: 'parent',
        artifacts: detail.artifacts.length,
        preset_scoped: true,
        default_guidance_in_parent_and_child: true,
        subagent_inherits: true,
        skill_loaded: true,
        installed_bundle_resolved: true,
        source_files_deleted: true,
        board_unchanged: true,
      },
      null,
      2,
    ),
  )
  console.log(await readFile(join(cwd, 'verification.json'), 'utf8'))
} finally {
  if (run) await run.dispose()
  await ctx.fiber.dispose()
}
