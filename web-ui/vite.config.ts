import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const dshOrigin = process.env.VITE_DSH_ORIGIN ?? 'http://127.0.0.1:3081'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-site health probe so the shell can tell if Harness is up
      // without depending on CORS from the DSH origin.
      '/__dsh': {
        target: dshOrigin,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__dsh/, ''),
      },
      '/api': {
        target: process.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
