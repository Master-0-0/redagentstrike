/** Injected CSS for the sidebar blackboard entry. Prefixed to avoid collisions. */

const STYLE_ID = 'dsh-cairn-blackboard-styles'

const CSS = `
.dsh-bb-layer {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  width: 100%;
  height: 42px;
  margin: 8px 0 0;
}
.dsh-bb-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: calc(100% + 4px);
  height: 42px;
  margin: 0 -2px;
  padding: 0 10px 0 8px;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
  overflow: hidden;
}
.dsh-bb-trigger:hover,
.dsh-bb-trigger[data-active] {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-bb-trigger-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-bb-trigger-meta {
  flex: none;
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
}
.dsh-bb-layer.dsh-bb-rail {
  width: 36px;
  height: 36px;
  margin: 0;
}
.dsh-bb-rail .dsh-bb-trigger {
  position: relative;
  justify-content: center;
  gap: 0;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  corner-shape: round;
}
.dsh-bb-rail-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-state-success-primary);
}
.dsh-bb-panel {
  position: fixed;
  z-index: 30;
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100vw - 24px));
  max-height: 70vh;
  overflow: hidden;
  border: 0;
  border-radius: 12px;
  background: var(--dsw-specific-menu);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.dsh-bb-header {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 44px;
  padding: 10px 12px 8px;
  box-sizing: border-box;
}
.dsh-bb-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dsh-bb-title {
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-bb-status {
  flex: none;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-bb-owner {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-bb-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-bb-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 8px 8px;
}
.dsh-bb-note {
  margin: 4px 4px 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-bb-error {
  margin: 0 4px 8px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-bb-graph {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  overflow: hidden;
}
.dsh-bb-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}
.dsh-bb-zoom { display: flex; align-items: center; gap: 3px; }
.dsh-bb-zoom button {
  border: 0;
  border-radius: 6px;
  padding: 5px 9px;
  min-height: 28px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.dsh-bb-zoom button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-bb-zoom button:disabled { opacity: .35; cursor: default; }
.dsh-bb-canvas {
  width: 100%;
  min-height: 220px;
  max-height: 55vh;
  background-color: var(--dsw-specific-menu, #fff);
  background-image: radial-gradient(var(--dsw-alias-border-l3) .8px, transparent .8px);
  background-size: 20px 20px;
  overflow: auto;
  scrollbar-width: thin;
}
.dsh-bb-canvas svg { display: block; margin: 0 auto; }
.dsh-bb-node { cursor: pointer; --bb-accent: var(--dsw-alias-label-secondary); }
.dsh-bb-node[data-kind="origin"] { --bb-accent: var(--dsw-alias-state-business-primary); }
.dsh-bb-node[data-kind="goal"] { --bb-accent: var(--dsw-alias-state-success-primary); }
.dsh-bb-intent { --bb-accent: var(--dsw-alias-state-business-primary); }
.dsh-bb-node:focus { outline: none; }
.dsh-bb-node-card {
  fill: var(--dsw-specific-menu, #fff);
  stroke: var(--dsw-alias-border-l3);
  stroke-width: 1;
  filter: drop-shadow(0 2px 3px rgb(15 23 42 / 5%));
  transition: stroke .15s, filter .15s;
}
.dsh-bb-node[data-kind="origin"] .dsh-bb-node-card,
.dsh-bb-node[data-kind="goal"] .dsh-bb-node-card { stroke: var(--bb-accent); }
.dsh-bb-node:hover .dsh-bb-node-card,
.dsh-bb-node:focus-visible .dsh-bb-node-card,
.dsh-bb-node[data-selected] .dsh-bb-node-card {
  stroke: var(--bb-accent);
  stroke-width: 2;
  filter: drop-shadow(0 3px 6px rgb(15 23 42 / 12%));
}
.dsh-bb-card-content { padding: 15px 17px; box-sizing: border-box; height: 100%; pointer-events: none; }
.dsh-bb-card-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; font-size: 11px; line-height: 16px; color: var(--bb-accent); font-weight: 600; }
.dsh-bb-card-heading span::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: currentColor; vertical-align: 1px; }
.dsh-bb-card-heading code { font-size: 10px; color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.dsh-bb-card-description { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
.dsh-bb-node[data-kind="fact"] { --bb-accent: var(--dsw-alias-label-secondary); }
.dsh-bb-node[data-kind="fact"] .dsh-bb-node-card { stroke: var(--bb-accent); }
.dsh-bb-intent .dsh-bb-node-card {
  fill: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-specific-menu, #fff));
  stroke: var(--bb-accent);
  stroke-width: 2.5;
  stroke-dasharray: 10 6;
}
.dsh-bb-intent:hover .dsh-bb-node-card,
.dsh-bb-intent:focus-visible .dsh-bb-node-card,
.dsh-bb-intent[data-selected] .dsh-bb-node-card { stroke-width: 3.5; }
.dsh-bb-intent-status { display: inline-block; margin-top: 8px; padding: 1px 7px; border-radius: 8px; font-size: 10px; line-height: 16px; color: var(--bb-accent); background: var(--dsw-alias-interactive-bg-hover); }
.dsh-bb-intent[data-status="concluded"] .dsh-bb-intent-status,
.dsh-bb-intent[data-status="complete"] .dsh-bb-intent-status { color: var(--dsw-alias-state-success-primary); }
.dsh-bb-edge[data-relation="output"] { stroke: var(--dsw-alias-state-warn-primary); }

.dsh-bb-edge { fill: none; stroke: var(--dsw-alias-border-l3); stroke-width: 1.5; }
.dsh-bb-intent[data-closed="true"] { opacity: .5; }
.dsh-bb-node[data-superseded="true"] { opacity: .5; }
.dsh-bb-edge[data-status="closed"] { stroke-dasharray: 3 5; }
.dsh-bb-edge[data-status="claimed"] { stroke: var(--dsw-alias-state-warn-primary); stroke-dasharray: 5 5; }
.dsh-bb-edge[data-status="open"] { stroke-dasharray: 4 5; }
.dsh-bb-edge[data-status="complete"] { stroke: var(--dsw-alias-state-success-primary); }
.dsh-bb-edge[data-highlighted] { stroke: var(--dsw-alias-state-business-primary); stroke-width: 2.5; }
.dsh-bb-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 8px 4px 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-bb-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 4px;
  border-radius: 2px;
  border: 1px solid var(--dsw-alias-border-l3);
  vertical-align: middle;
}
.dsh-bb-swatch.intent { border: 2px dashed var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-specific-menu, #fff)); width: 12px; height: 8px; }
.dsh-bb-swatch:not(.origin):not(.goal):not(.intent):not(.open) { border-color: var(--dsw-alias-label-secondary); }
.dsh-bb-swatch.origin { border-color: var(--dsw-alias-state-business-primary); }
.dsh-bb-swatch.goal { border-color: var(--dsw-alias-state-success-primary); }
.dsh-bb-swatch.open { border-color: var(--dsw-alias-state-warn-primary); border-style: dashed; }
.dsh-bb-detail {
  margin: 8px 4px 0;
  padding: 8px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-bb-detail-kicker {
  margin: 0 0 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-bb-detail-body {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.dsh-bb-hints {
  margin: 8px 4px 0;
}
.dsh-bb-hints-title {
  margin: 0 0 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-bb-hint {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
`

/**
 * Insert or refresh the blackboard stylesheet, including during hot updates.
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(STYLE_ID)
  if (existing) {
    if (existing.textContent !== CSS) existing.textContent = CSS
    return
  }
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
}

// A mounted consumer's effect does not rerun when only this module changes.
if (typeof document !== 'undefined' && document.getElementById(STYLE_ID)) {
  ensureStyles()
}
