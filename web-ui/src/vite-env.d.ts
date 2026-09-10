/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DSH_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
