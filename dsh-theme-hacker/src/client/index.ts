import { themeTokens } from '../tokens.ts'

export const name = 'dsh-theme-hacker'
export const inject = ['theme']

interface ThemeRuntime {
  overrideTokens(source: string, tokens: typeof themeTokens): () => void
}

interface ClientContext {
  theme: ThemeRuntime
  effect(setup: () => (() => void) | void, label?: string): void
}

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.theme.overrideTokens('dsh-theme-hacker', themeTokens),
    'dsh-theme-hacker: tokens',
  )
}
