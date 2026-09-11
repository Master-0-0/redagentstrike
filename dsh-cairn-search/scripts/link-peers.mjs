#!/usr/bin/env node
/** Point peer specs at the running dsh install so ESM realpath resolution matches the host. */
import { mkdir, symlink, lstat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const peers = ['dsh-tools', 'cordis']
const sourceRoot = join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai')
const destRoot = join(root, 'node_modules/@deepseek-ai')

await mkdir(destRoot, { recursive: true })
for (const name of peers) {
  const from = join(sourceRoot, name)
  const to = join(destRoot, name)
  try {
    const st = await lstat(to)
    if (st.isSymbolicLink()) await unlink(to)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') throw error
  }
  await symlink(from, to)
  console.log(`linked @deepseek-ai/${name} -> ${from}`)
}
