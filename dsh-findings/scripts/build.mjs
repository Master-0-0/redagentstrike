import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
await mkdir('lib', { recursive: true })
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  packages: 'external',
})
await copyFile('src/safe-read.py', 'lib/safe-read.py')
