import { BOOT_CSS } from './tokens.ts'

export const name = 'dsh-theme-hacker'

interface IndexInjectionTable {
  push(row: { kind: 'style'; text: string }): void
}

interface HostContext {
  on(event: 'webserver/index-inject', listener: (table: IndexInjectionTable) => void): void
}

export function apply(ctx: HostContext): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'style', text: BOOT_CSS })
  })
}
