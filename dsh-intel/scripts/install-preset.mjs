#!/usr/bin/env node
/** Add only our row and skill; preserve user composition and retain backups. */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const preset = join(home, '.agent-presets/cairn')
const composition = join(preset, 'agent.cordis.yml')
let text
try {
  text = await readFile(composition, 'utf8')
} catch {
  throw new Error(
    'Cairn preset is not installed. Install it from dsh-cairn-search/preset first; this updater never replaces an existing preset.',
  )
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
if (!/^\s*name:\s*['"]?dsh-intel['"]?\s*$/m.test(text)) {
  if (/^\s*-\s*id:\s*intel-library\s*$/m.test(text))
    throw new Error(
      'Entry ID intel-library already exists with another plugin; choose a distinct ID manually.',
    )
  await copyFile(composition, composition + '.' + stamp + '.bak')
  await writeFile(
    composition,
    text +
      '\n# Independent intelligence tools (preset-scoped).\n- id: intel-library\n  name: dsh-intel\n  config:\n    apiUrl: http://127.0.0.1:8787\n',
    { mode: 0o600 },
  )
}
const skill = join(preset, 'skills/intel-library/SKILL.md')
await mkdir(dirname(skill), { recursive: true })
const next = await readFile(join(root, 'skills/intel-library/SKILL.md'), 'utf8')
try {
  if ((await readFile(skill, 'utf8')) !== next) await copyFile(skill, skill + '.' + stamp + '.bak')
} catch (e) {
  if (e.code !== 'ENOENT') throw e
}
await writeFile(skill, next, { mode: 0o600 })
console.log(
  'Updated ' +
    preset +
    '; existing settings preserved. Restart the Harness when no active session needs it.',
)
console.log(
  'Encrypted retry queue is under DSH_HOME/intel-outbox; keep its key private.',
)
