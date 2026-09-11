import { builtinModules } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgId = 'dsh-cairn-search'
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
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-tools',
    ...builtinModules,
    ...builtinModules.map(name => `node:${name}`),
  ],
})

await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.ts'],
  outfile: rawClient,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  logLevel: 'info',
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
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
