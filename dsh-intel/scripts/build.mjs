import { build } from 'esbuild'
await build({ entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true, format: 'esm', platform: 'node', target: 'es2022', packages: 'external' })
