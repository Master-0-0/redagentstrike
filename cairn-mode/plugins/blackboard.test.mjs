import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from './blackboard.mjs'

function makeCtx() {
  const tools = []
  return {
    tools: {
      register(def) {
        tools.push(def)
        return () => {}
      },
    },
    _tools: tools,
  }
}

function execFor(cwd) {
  return { agent: { id: 'parent-1', session: { header: { cwd } } } }
}

describe('plugin surface', () => {
  it('is a Cordis preset plugin with tools inject and node:fs I/O', async () => {
    assert.equal(name, 'cairn-blackboard')
    assert.deepEqual(inject, ['tools'])
    const src = await readFile(new URL('./blackboard.mjs', import.meta.url), 'utf8')
    assert.match(src, /from 'node:fs\/promises'/)
    assert.doesNotMatch(src, /from ['"]@deepseek-ai\//)
    const ctx = makeCtx()
    apply(ctx)
    assert.deepEqual(ctx._tools.map((t) => t.name), ['blackboard_read', 'blackboard_apply'])
  })
})

describe('sequential disk ops', () => {
  it('init, hint, claim, conclude persist through blackboard.json', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cairn-blackboard-'))
    try {
      const ctx = makeCtx()
      apply(ctx)
      const read = ctx._tools.find((t) => t.name === 'blackboard_read')
      const write = ctx._tools.find((t) => t.name === 'blackboard_apply')
      const exec = execFor(cwd)

      const empty = await read.execute({}, exec)
      assert.equal(empty.exists, false)

      const inited = await write.execute({
        action: 'init',
        origin: 'tests fail',
        goal: 'tests pass',
      }, exec)
      assert.equal(inited.task.task, 'bootstrap')

      await write.execute({ action: 'bootstrap', fact: 'the suite is red' }, exec)
      await write.execute({
        action: 'reason',
        intents: [{ from: ['f001'], description: 'run the failing suite' }],
      }, exec)
      await write.execute({ action: 'claim' }, exec)
      const concluded = await write.execute({
        action: 'conclude',
        intent_id: 'i002',
        description: 'one assertion still fails',
      }, exec)
      assert.equal(concluded.task.task, 'reason')

      const loaded = await read.execute({}, exec)
      assert.equal(loaded.exists, true)
      assert.equal(loaded.board.facts.at(-1).description, 'one assertion still fails')
      const onDisk = JSON.parse(await readFile(join(cwd, '.dsh', 'blackboard.json'), 'utf8'))
      assert.equal(onDisk.facts.at(-1).description, 'one assertion still fails')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
