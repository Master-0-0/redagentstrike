import { createElement, useId } from 'react'
import radarEye from '../../assets/radar-eye.svg'
import { themeTokens } from '../tokens.ts'

export const name = 'dsh-theme-hacker'
export const inject = ['theme', 'slots']

interface ThemeRuntime {
  overrideTokens(source: string, tokens: typeof themeTokens): () => void
}

interface ClientContext {
  slots: {
    inject(name: string, setup: () => () => void): () => void
    register(options: { name: string; priority: number }, component: unknown): () => void
  }
  theme: ThemeRuntime
  effect(setup: () => (() => void) | void, label?: string): void
}

const artwork = radarEye.replace(/<svg[^>]*>/, '').replace('</svg>', '')

/** Monochrome vector mark shared by the sidebar and welcome screen. */
function RadarEye({ size, className }: { size: number; className?: string }) {
  const maskId = `radar-eye-${useId()}`
  return createElement('svg', {
    width: size,
    height: size * 0.6,
    viewBox: '0 0 120 72',
    fill: 'currentColor',
    className,
    'aria-hidden': true,
    'data-brand': 'radar-eye',
    style: { color: 'var(--dsw-alias-label-primary)', display: 'block' },
    dangerouslySetInnerHTML: { __html: artwork.replaceAll('radar-eye-cutout', maskId) },
  })
}

/** Brand name paired with the radar-eye mark. */
function RadarBrandName() {
  return createElement('span', {
    style: { fontSize: 17, fontWeight: 600, letterSpacing: '0.12em', whiteSpace: 'nowrap' },
  }, '无相之瞳')
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register({ name: 'sidebar.brand.name', priority: -10 }, RadarBrandName))
  for (const name of ['sidebar.brand.mark', 'conversation.hero.brand.mark']) {
    ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -10 }, RadarEye))
  }
  ctx.effect(
    () => ctx.theme.overrideTokens('dsh-theme-hacker', themeTokens),
    'dsh-theme-hacker: tokens',
  )
}
