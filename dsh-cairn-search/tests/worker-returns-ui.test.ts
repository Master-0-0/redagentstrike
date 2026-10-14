import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { emptyBoard } from '../src/board.ts'
import { layoutBoard } from '../src/view.ts'

// Exercise the shared UI used by both the sidebar and workbench without a live host.
const root = fileURLToPath(new URL('../../', import.meta.url))
const result = buildSync({
  stdin: {
    contents: `export { WorkerReturns } from './dsh-cairn-search/src/client/WorkerReturns.tsx';
      export { BlackboardGraph } from './dsh-cairn-search/src/client/BlackboardGraph.tsx';
      export { zh } from './dsh-cairn-search/src/client/locales.ts';
      export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';`,
    resolveDir: root,
  },
  alias: { react: `${root}web-ui/node_modules/react`, 'react-dom': `${root}web-ui/node_modules/react-dom` },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
})
const loaded = { exports: {} as any }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports)
const { WorkerReturns, BlackboardGraph, zh, createElement, renderToStaticMarkup } = loaded.exports
const t = (key: string) => zh[key] ?? key

function view() {
  const board = emptyBoard('Review board', 'start', 'goal')
  board.intents = [{ id: 'i001', from: ['origin'], to: 'goal', description: 'old proof', creator: 'p', worker: 'p', createdAt: 'now', concludedAt: 'now', invalidated: { at: 'later', hintId: 'h001' } }]
  board.workerReturns = [
    { id: 'r001', kind: 'return', content: '<script>unsafe text</script>', intentId: 'i001', createdAt: 'now' },
    { id: 'r002', kind: 'return', content: 'unlinked result', createdAt: 'now', resolution: { action: 'archived', at: 'now' } },
  ]
  return layoutBoard(board)
}

test('shared returns panel defaults collapsed, escapes raw output and filters selected intent', () => {
  const all = renderToStaticMarkup(createElement(WorkerReturns, { view: view(), t }))
  assert.match(all, /子代理返回/)
  assert.match(all, /未关联任务/)
  assert.match(all, /待审核/)
  assert.match(all, /已留档/)
  assert.doesNotMatch(all, /<details[^>]*open/)
  assert.doesNotMatch(all, /<script>/)
  assert.match(all, /&lt;script&gt;/)
  const selected = renderToStaticMarkup(createElement(WorkerReturns, { view: view(), selectedId: 'intent:i001', t }))
  assert.doesNotMatch(selected, /unlinked result/)
})

test('invalidated completion is distinctly labeled on the shared graph', () => {
  const html = renderToStaticMarkup(createElement(BlackboardGraph, { view: view(), selectedId: undefined, onSelect: () => {}, t }))
  assert.match(html, /data-status="invalidated"/)
  assert.match(html, /历史完成（已失效）/)
  assert.doesNotMatch(html, /data-status="complete"/)
})
