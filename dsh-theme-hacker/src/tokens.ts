/** One override-layer value. Light and dark stay identical so Appearance never flips to official DSH blue. */
export type ThemeTokenModes = { light: string; dark: string }

function pair(value: string): ThemeTokenModes {
  return { light: value, dark: value }
}

const bgBase = '#ffffff'
const bg1 = '#ffffff'
const bg2 = '#f5f7fb'
const bg3 = '#eef2fb'
const overlay = '#ffffff'
const moduleBg = '#f5f7fb'

const textPrimary = '#1a1a1a'
const textSecondary = '#3d4a73'
const textTertiary = '#7a8499'
const textCaption = '#8a8a8a'
const textDimmed = '#c5cad6'

const luckin = '#002fa7'
const luckinHover = '#001f7a'
const luckinOn = '#ffffff'
const luckinSoft = 'rgba(0, 47, 167, 0.10)'
const luckinHoverBg = 'rgba(0, 47, 167, 0.06)'
const luckinActive = 'rgba(0, 47, 167, 0.14)'
const luckinAccent = 'rgba(0, 47, 167, 0.18)'

const border1 = 'rgba(0, 47, 167, 0.06)'
const border2 = 'rgba(0, 47, 167, 0.12)'
const border3 = 'rgba(0, 47, 167, 0.18)'
const border4 = 'rgba(0, 47, 167, 0.28)'

const error = '#e4372c'
const errorSoft = 'rgba(228, 55, 44, 0.08)'
const warn = '#ff6a3d'
const warn2 = '#ff8a5c'
const warnLabel = '#d95a2b'
const warnBg = '#fff1eb'
const success = '#2bb673'
const success2 = '#4ecf8a'
const successBg = '#e6f7ee'

const scrollbar = '#d7deee'
const scrollbarHover = '#b7c4e4'

const bubble = '#eef2fb'
const bubbleHighlight = '#d6e0f5'
const sidebar = '#ffffff'
const sidebarHover = '#f5f7fb'
const sidebarActive = '#e8eef9'
const input = '#ffffff'
const code = '#f5f7fb'
const toast = '#182d71'

/** Alias + specific tokens consumed by the shipped Web UI. */
export const themeTokens: Record<string, ThemeTokenModes> = {
  '--dsw-alias-bg-base': pair(bgBase),
  '--dsw-alias-bg-layer-1': pair(bg1),
  '--dsw-alias-bg-layer-2': pair(bg2),
  '--dsw-alias-bg-layer-3': pair(bg3),
  '--dsw-alias-bg-mask-1': pair('rgba(24, 45, 113, 0.36)'),
  '--dsw-alias-bg-mask-2': pair('rgba(24, 45, 113, 0.16)'),
  '--dsw-alias-bg-mask-3': pair('rgba(24, 45, 113, 0.48)'),
  '--dsw-alias-bg-mask-photo': pair('rgba(24, 45, 113, 0.72)'),
  '--dsw-alias-bg-mask-drop': pair('rgba(255, 255, 255, 0.78)'),
  '--dsw-alias-bg-module-platform': pair(moduleBg),
  '--dsw-alias-bg-multi-select': pair(bg2),
  '--dsw-alias-bg-overlay': pair(overlay),
  '--dsw-alias-bg-skeleton': pair(luckinSoft),
  '--dsw-alias-border-inverted2': pair(border1),
  '--dsw-alias-border-inverted': pair(border1),
  '--dsw-alias-border-l1': pair(border1),
  '--dsw-alias-border-l2-darkmode-thin': pair(border1),
  '--dsw-alias-border-l2': pair(border2),
  '--dsw-alias-border-l3': pair(border3),
  '--dsw-alias-border-l4': pair(border4),
  '--dsw-alias-brand-primary-invert': pair(luckinOn),
  '--dsw-alias-brand-primary-new-colorprimary-new-color': pair(luckin),
  '--dsw-alias-brand-primary': pair(luckin),
  '--dsw-alias-brand-text': pair(luckin),
  '--dsw-alias-button-contrast-fill': pair(textSecondary),
  '--dsw-alias-button-elevated-fill': pair(bg1),
  '--dsw-alias-button-floating-fill': pair(bg1),
  '--dsw-alias-button-floating-hover': pair(bg2),
  '--dsw-alias-button-ghost-active-border': pair(luckin),
  '--dsw-alias-button-ghost-active-fill': pair(luckinSoft),
  '--dsw-alias-button-ghost-active-hover': pair(luckinActive),
  '--dsw-alias-button-info-fill': pair(luckin),
  '--dsw-alias-button-info-hover': pair(luckinHover),
  '--dsw-alias-button-primary-dimmed': pair(bg3),
  '--dsw-alias-button-primary-fill': pair(luckin),
  '--dsw-alias-button-primary-hover': pair(luckinHover),
  '--dsw-alias-button-tool-bar-fill-invisible': pair('rgba(255, 255, 255, 0.36)'),
  '--dsw-alias-button-tool-bar-fill': pair('rgba(238, 242, 251, 0.92)'),
  '--dsw-alias-button-tool-bar-hover': pair('rgba(232, 238, 249, 1)'),
  '--dsw-alias-interactive-bg-active': pair(luckinActive),
  '--dsw-alias-interactive-bg-hover-accent': pair(luckinAccent),
  '--dsw-alias-interactive-bg-hover-danger': pair(errorSoft),
  '--dsw-alias-interactive-bg-hover-solid': pair(bg3),
  '--dsw-alias-interactive-bg-hover': pair(luckinHoverBg),
  '--dsw-alias-label-caption': pair(textCaption),
  '--dsw-alias-label-dimmed': pair(textDimmed),
  '--dsw-alias-label-primary-bluish': pair(luckin),
  '--dsw-alias-label-primary-dimmed': pair(textSecondary),
  '--dsw-alias-label-primary-foreground': pair(luckinOn),
  '--dsw-alias-label-primary-inverted': pair(luckinOn),
  '--dsw-alias-label-primary': pair(textPrimary),
  '--dsw-alias-label-secondary': pair(textSecondary),
  '--dsw-alias-label-tertiary': pair(textTertiary),
  '--dsw-alias-link': pair(luckin),
  '--dsw-alias-markdown-citation': pair(bg3),
  '--dsw-alias-markdown-code-block-banner': pair(bg2),
  '--dsw-alias-markdown-code-block': pair(code),
  '--dsw-alias-markdown-code-segment-selected': pair(bg3),
  '--dsw-alias-markdown-code-segment-unselected': pair(code),
  '--dsw-alias-markdown-inline-code': pair(bg2),
  '--dsw-alias-markdown-placeholder': pair(bg2),
  '--dsw-alias-markdown-tag': pair(bg2),
  '--dsw-alias-scrollbar-bg-l1': pair(scrollbar),
  '--dsw-alias-scrollbar-bg-l2': pair(scrollbar),
  '--dsw-alias-scrollbar-hover-l1': pair(scrollbarHover),
  '--dsw-alias-scrollbar-hover-l2': pair(scrollbarHover),
  '--dsw-alias-state-business-primary': pair(luckin),
  '--dsw-alias-state-business-tertiary': pair(luckinSoft),
  '--dsw-alias-state-error-primary': pair(error),
  '--dsw-alias-state-error-secondary': pair(error),
  '--dsw-alias-state-success-primary': pair(success),
  '--dsw-alias-state-success-secondary': pair(success2),
  '--dsw-alias-state-success-tertiary': pair(successBg),
  '--dsw-alias-state-warn-label': pair(warnLabel),
  '--dsw-alias-state-warn-primary': pair(warn),
  '--dsw-alias-state-warn-secondary': pair(warn2),
  '--dsw-alias-state-warn-tertiary': pair(warnBg),
  '--dsw-alias-toast-bg': pair(toast),
  '--dsw-alias-tooltip-bg': pair(toast),
  '--dsw-specific-bubble-highlight': pair(bubbleHighlight),
  '--dsw-specific-bubble': pair(bubble),
  '--dsw-specific-input-major': pair(input),
  '--dsw-specific-login-input': pair(input),
  '--dsw-specific-menu': pair(bg1),
  '--dsw-specific-selector': pair(bg2),
  '--dsw-specific-sidebar-fill': pair(sidebar),
  '--dsw-specific-sidebar-nav-item-active-accent': pair(luckinAccent),
  '--dsw-specific-sidebar-nav-item-active': pair(sidebarActive),
  '--dsw-specific-sidebar-nav-item-hover': pair(sidebarHover),
  '--dsw-specific-tip': pair(bg2),
}

/** Early index CSS so the boot splash matches Luckin blue-white. */
export const BOOT_CSS = `html{color-scheme:light}body{background:${bgBase};--dsw-alias-bg-base:${bgBase};--dsw-alias-label-primary:${textPrimary};--dsw-alias-label-tertiary:${textTertiary};--dsw-alias-brand-primary:${luckin};--dsw-alias-border-l2:${border2}}`
