import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPreset } from '../scripts/install-preset.mjs'
import { parseDocument } from 'yaml'

test('preset migration preserves custom plugins, limits and script tags and is idempotent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-install-'))
  try {
    const directory = join(home, '.agent-presets/cairn')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'agent.cordis.yml')
    await writeFile(path, `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    prefix: Custom user instructions.\n    suffix: Keep this suffix.\n- id: cairn-search\n  name: dsh-cairn-search\n  config:\n    maxConcurrent: 2\n- id: custom-plugin\n  name: user-plugin\n  disabled: !!js process.platform === 'win32'\n- id: intel-library\n  name: dsh-intel\n`)
    const original = await readFile(path, 'utf8')
    assert.ok((await installPreset(home, true)).length > 0)
    assert.equal(await readFile(path, 'utf8'), original)
    await installPreset(home)
    const text = await readFile(path, 'utf8')
    assert.match(text, /Custom user instructions/)
    assert.match(text, /Keep this suffix/)
    assert.match(text, /maxConcurrent: 2/)
    assert.match(text, /user-plugin/)
    assert.match(text, /dsh-intel/)
    assert.match(text, /!!js/)
    assert.ok((await readdir(directory)).some(name => name.endsWith('.bak')))
    assert.deepEqual(await installPreset(home), [])
    const doc = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    const persona = doc.contents.items[0].get('config')
    persona.set('prefix', persona.get('prefix').replace('You own planning and evidence review', 'STALE MANAGED ROLE') + '\nUser postscript survives.')
    await writeFile(path, doc.toString())
    await installPreset(home)
    const updated = await readFile(path, 'utf8')
    assert.match(updated, /User postscript survives/)
    assert.doesNotMatch(updated, /STALE MANAGED ROLE/)
    assert.equal(updated.split('Cairn protocol v2 replaces earlier').length - 1, 1)
    assert.deepEqual(await installPreset(home), [])
  } finally { await rm(home, { recursive: true, force: true }) }
})
