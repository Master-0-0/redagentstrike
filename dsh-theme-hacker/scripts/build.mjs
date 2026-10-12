import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgId = 'dsh-theme-hacker'
const outDir = join(root, 'lib')
const rawClient = join(outDir, 'client.raw.cjs')

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
})

await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.ts'],
  outfile: rawClient,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  external: ['react'],
  loader: { '.svg': 'text' },
  target: 'es2022',
  logLevel: 'info',
})

const body = await readFile(rawClient, 'utf8')
await writeFile(
  join(outDir, 'client.js'),
  [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkgId)}, factory: (require) => {`,
    'var module = { exports: {} }; var exports = module.exports;',
    body,
    'return module.exports; } });',
    '',
  ].join('\n'),
)
await rm(rawClient)
