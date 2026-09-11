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
.dsh-bb-canvas {
  width: 100%;
  min-height: 180px;
  border-radius: 8px;
  background: transparent;
  overflow: auto;
}
.dsh-bb-canvas svg {
  display: block;
}
.dsh-bb-node {
  cursor: pointer;
}
.dsh-bb-node:focus {
  outline: none;
}
.dsh-bb-node-card {
  fill: var(--dsw-alias-interactive-bg-hover);
  stroke: var(--dsw-alias-border-l3);
  stroke-width: 1;
}
.dsh-bb-node[data-kind="origin"] .dsh-bb-node-card {
  stroke: var(--dsw-alias-state-business-primary);
}
.dsh-bb-node[data-kind="goal"] .dsh-bb-node-card {
  stroke: var(--dsw-alias-state-success-primary);
}
.dsh-bb-node[data-selected] .dsh-bb-node-card {
  stroke-width: 1.5;
}
.dsh-bb-node-id {
  fill: var(--dsw-alias-label-tertiary);
  font-size: 10px;
}
.dsh-bb-node-text {
  fill: var(--dsw-alias-label-primary);
  font-size: 11px;
}
.dsh-bb-stub .dsh-bb-node-card {
  fill: transparent;
  stroke-dasharray: 3 2;
  stroke: var(--dsw-alias-state-warn-primary);
}
.dsh-bb-edge {
  fill: none;
  stroke: var(--dsw-alias-label-tertiary);
  stroke-width: 1.25;
}
.dsh-bb-edge[data-status="claimed"] {
  stroke: var(--dsw-alias-state-warn-primary);
  stroke-dasharray: 5 3;
}
.dsh-bb-edge[data-status="open"] {
  stroke-dasharray: 3 3;
}
.dsh-bb-edge[data-status="complete"] {
  stroke: var(--dsw-alias-state-success-primary);
}
.dsh-bb-edge[data-status="concluded"] {
  stroke: var(--dsw-alias-label-secondary);
}
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
 * Insert the blackboard stylesheet once per document.
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
}
