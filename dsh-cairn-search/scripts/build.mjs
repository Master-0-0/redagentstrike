import { builtinModules } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'lib')

await mkdir(outDir, { recursive: true })

await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  logLevel: 'info',
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-tools',
    ...builtinModules,
    ...builtinModules.map(name => `node:${name}`),
  ],
})
