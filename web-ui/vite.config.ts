import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const dshOrigin = process.env.VITE_DSH_ORIGIN ?? 'http://127.0.0.1:3081'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@cairn': path.join(repoRoot, 'dsh-cairn-search/src'),
      react: path.join(here, 'node_modules/react'),
      'react-dom': path.join(here, 'node_modules/react-dom'),
      'react/jsx-runtime': path.join(here, 'node_modules/react/jsx-runtime'),
      'react/jsx-dev-runtime': path.join(here, 'node_modules/react/jsx-dev-runtime'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
    proxy: {
      // Same-site health probe so the shell can tell if Harness is up
      // without depending on CORS from the DSH origin.
      '/__dsh': {
        target: dshOrigin,
        changeOrigin: true,
        rewrite: (pathName) => pathName.replace(/^\/__dsh/, ''),
      },
      '/api': {
        target: process.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (pathName) => pathName.replace(/^\/api/, ''),
      },
    },
  },
})
