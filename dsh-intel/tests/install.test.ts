import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
const exec = promisify(execFile)
test('preset installer is additive, backed up and idempotent; custom settings survive', async () => {
  const home = await mkdtemp(join(tmpdir(), 'intel-install-'))
  const preset = join(home, '.agent-presets/cairn')
  await mkdir(preset, { recursive: true })
  const path = join(preset, 'agent.cordis.yml')
  const original = '- id: existing\n  name: dsh-cairn-search\n'
  await writeFile(path, original)
  const run = () => exec(process.execPath, ['scripts/install-preset.mjs'], { env: { ...process.env, DSH_HOME: home } })
  try {
    await run()
    const next = await readFile(path, 'utf8')
    assert.ok(next.startsWith(original))
    assert.equal(next.match(/name: dsh-intel/g)?.length, 1)
    assert.equal((await readdir(preset)).filter(p => p.endsWith('.bak')).length, 1)
    const custom = next.replace('8787', '9999')
    await writeFile(path, custom)
    await run()
    assert.equal(await readFile(path, 'utf8'), custom)
    assert.ok((await readFile(join(preset, 'skills/intel-library/SKILL.md'), 'utf8')).includes('Runtime intelligence'))
  } finally { await rm(home, { recursive: true, force: true }) }
})
