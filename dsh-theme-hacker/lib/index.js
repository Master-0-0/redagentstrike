// src/tokens.ts
function pair(value) {
  return { light: value, dark: value };
}
var bgBase = "#ffffff";
var bg1 = "#ffffff";
var bg2 = "#f5f7fb";
var bg3 = "#eef2fb";
var overlay = "#ffffff";
var moduleBg = "#f5f7fb";
var textPrimary = "#1a1a1a";
var textSecondary = "#3d4a73";
var textTertiary = "#7a8499";
var textCaption = "#8a8a8a";
var textDimmed = "#c5cad6";
var luckin = "#002fa7";
var luckinHover = "#001f7a";
var luckinOn = "#ffffff";
var luckinSoft = "rgba(0, 47, 167, 0.10)";
var luckinHoverBg = "rgba(0, 47, 167, 0.06)";
var luckinActive = "rgba(0, 47, 167, 0.14)";
var luckinAccent = "rgba(0, 47, 167, 0.18)";
var border1 = "rgba(0, 47, 167, 0.06)";
var border2 = "rgba(0, 47, 167, 0.12)";
var border3 = "rgba(0, 47, 167, 0.18)";
var border4 = "rgba(0, 47, 167, 0.28)";
var error = "#e4372c";
var errorSoft = "rgba(228, 55, 44, 0.08)";
var warn = "#ff6a3d";
var warn2 = "#ff8a5c";
var warnLabel = "#d95a2b";
var warnBg = "#fff1eb";
var success = "#2bb673";
var success2 = "#4ecf8a";
var successBg = "#e6f7ee";
var scrollbar = "#d7deee";
var scrollbarHover = "#b7c4e4";
var bubble = "#eef2fb";
var bubbleHighlight = "#d6e0f5";
var sidebar = "#ffffff";
var sidebarHover = "#f5f7fb";
var sidebarActive = "#e8eef9";
var input = "#ffffff";
var code = "#f5f7fb";
var toast = "#182d71";
var themeTokens = {
  "--dsw-alias-bg-base": pair(bgBase),
  "--dsw-alias-bg-layer-1": pair(bg1),
  "--dsw-alias-bg-layer-2": pair(bg2),
  "--dsw-alias-bg-layer-3": pair(bg3),
  "--dsw-alias-bg-mask-1": pair("rgba(24, 45, 113, 0.36)"),
  "--dsw-alias-bg-mask-2": pair("rgba(24, 45, 113, 0.16)"),
  "--dsw-alias-bg-mask-3": pair("rgba(24, 45, 113, 0.48)"),
  "--dsw-alias-bg-mask-photo": pair("rgba(24, 45, 113, 0.72)"),
  "--dsw-alias-bg-mask-drop": pair("rgba(255, 255, 255, 0.78)"),
  "--dsw-alias-bg-module-platform": pair(moduleBg),
  "--dsw-alias-bg-multi-select": pair(bg2),
  "--dsw-alias-bg-overlay": pair(overlay),
  "--dsw-alias-bg-skeleton": pair(luckinSoft),
  "--dsw-alias-border-inverted2": pair(border1),
  "--dsw-alias-border-inverted": pair(border1),
  "--dsw-alias-border-l1": pair(border1),
  "--dsw-alias-border-l2-darkmode-thin": pair(border1),
  "--dsw-alias-border-l2": pair(border2),
  "--dsw-alias-border-l3": pair(border3),
  "--dsw-alias-border-l4": pair(border4),
  "--dsw-alias-brand-primary-invert": pair(luckinOn),
  "--dsw-alias-brand-primary-new-colorprimary-new-color": pair(luckin),
  "--dsw-alias-brand-primary": pair(luckin),
  "--dsw-alias-brand-text": pair(luckin),
  "--dsw-alias-button-contrast-fill": pair(textSecondary),
  "--dsw-alias-button-elevated-fill": pair(bg1),
  "--dsw-alias-button-floating-fill": pair(bg1),
  "--dsw-alias-button-floating-hover": pair(bg2),
  "--dsw-alias-button-ghost-active-border": pair(luckin),
  "--dsw-alias-button-ghost-active-fill": pair(luckinSoft),
  "--dsw-alias-button-ghost-active-hover": pair(luckinActive),
  "--dsw-alias-button-info-fill": pair(luckin),
  "--dsw-alias-button-info-hover": pair(luckinHover),
  "--dsw-alias-button-primary-dimmed": pair(bg3),
  "--dsw-alias-button-primary-fill": pair(luckin),
  "--dsw-alias-button-primary-hover": pair(luckinHover),
  "--dsw-alias-button-tool-bar-fill-invisible": pair("rgba(255, 255, 255, 0.36)"),
  "--dsw-alias-button-tool-bar-fill": pair("rgba(238, 242, 251, 0.92)"),
  "--dsw-alias-button-tool-bar-hover": pair("rgba(232, 238, 249, 1)"),
  "--dsw-alias-interactive-bg-active": pair(luckinActive),
  "--dsw-alias-interactive-bg-hover-accent": pair(luckinAccent),
  "--dsw-alias-interactive-bg-hover-danger": pair(errorSoft),
  "--dsw-alias-interactive-bg-hover-solid": pair(bg3),
  "--dsw-alias-interactive-bg-hover": pair(luckinHoverBg),
  "--dsw-alias-label-caption": pair(textCaption),
  "--dsw-alias-label-dimmed": pair(textDimmed),
  "--dsw-alias-label-primary-bluish": pair(luckin),
  "--dsw-alias-label-primary-dimmed": pair(textSecondary),
  "--dsw-alias-label-primary-foreground": pair(luckinOn),
  "--dsw-alias-label-primary-inverted": pair(luckinOn),
  "--dsw-alias-label-primary": pair(textPrimary),
  "--dsw-alias-label-secondary": pair(textSecondary),
  "--dsw-alias-label-tertiary": pair(textTertiary),
  "--dsw-alias-link": pair(luckin),
  "--dsw-alias-markdown-citation": pair(bg3),
  "--dsw-alias-markdown-code-block-banner": pair(bg2),
  "--dsw-alias-markdown-code-block": pair(code),
  "--dsw-alias-markdown-code-segment-selected": pair(bg3),
  "--dsw-alias-markdown-code-segment-unselected": pair(code),
  "--dsw-alias-markdown-inline-code": pair(bg2),
  "--dsw-alias-markdown-placeholder": pair(bg2),
  "--dsw-alias-markdown-tag": pair(bg2),
  "--dsw-alias-scrollbar-bg-l1": pair(scrollbar),
  "--dsw-alias-scrollbar-bg-l2": pair(scrollbar),
  "--dsw-alias-scrollbar-hover-l1": pair(scrollbarHover),
  "--dsw-alias-scrollbar-hover-l2": pair(scrollbarHover),
  "--dsw-alias-state-business-primary": pair(luckin),
  "--dsw-alias-state-business-tertiary": pair(luckinSoft),
  "--dsw-alias-state-error-primary": pair(error),
  "--dsw-alias-state-error-secondary": pair(error),
  "--dsw-alias-state-success-primary": pair(success),
  "--dsw-alias-state-success-secondary": pair(success2),
  "--dsw-alias-state-success-tertiary": pair(successBg),
  "--dsw-alias-state-warn-label": pair(warnLabel),
  "--dsw-alias-state-warn-primary": pair(warn),
  "--dsw-alias-state-warn-secondary": pair(warn2),
  "--dsw-alias-state-warn-tertiary": pair(warnBg),
  "--dsw-alias-toast-bg": pair(toast),
  "--dsw-alias-tooltip-bg": pair(toast),
  "--dsw-specific-bubble-highlight": pair(bubbleHighlight),
  "--dsw-specific-bubble": pair(bubble),
  "--dsw-specific-input-major": pair(input),
  "--dsw-specific-login-input": pair(input),
  "--dsw-specific-menu": pair(bg1),
  "--dsw-specific-selector": pair(bg2),
  "--dsw-specific-sidebar-fill": pair(sidebar),
  "--dsw-specific-sidebar-nav-item-active-accent": pair(luckinAccent),
  "--dsw-specific-sidebar-nav-item-active": pair(sidebarActive),
  "--dsw-specific-sidebar-nav-item-hover": pair(sidebarHover),
  "--dsw-specific-tip": pair(bg2)
};
var BOOT_CSS = `html{color-scheme:light}body{background:${bgBase};--dsw-alias-bg-base:${bgBase};--dsw-alias-label-primary:${textPrimary};--dsw-alias-label-tertiary:${textTertiary};--dsw-alias-brand-primary:${luckin};--dsw-alias-border-l2:${border2}}`;

// src/index.ts
var name = "dsh-theme-hacker";
function apply(ctx) {
  ctx.on("webserver/index-inject", (table) => {
    table.push({ kind: "style", text: BOOT_CSS });
  });
}
export {
  apply,
  name
};
