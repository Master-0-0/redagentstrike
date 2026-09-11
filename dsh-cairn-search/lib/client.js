window.__ModuleLoader__.load({ id: "dsh-cairn-search", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);

// src/client/BlackboardSidebarPanel.tsx
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// src/owner.ts
var BOARD_DIR_RELATIVE = ".dsh/blackboards";
function encodeBoardOwnerId(id) {
  const trimmed = id.trim();
  if (trimmed === "") throw new Error("empty board owner");
  if (trimmed === "." || trimmed === "..") throw new Error("invalid board owner");
  let out = "";
  for (const ch of trimmed) {
    if (/^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}
function boardRelativePath(ownerId) {
  return `${BOARD_DIR_RELATIVE}/${encodeBoardOwnerId(ownerId)}.json`;
}
function boardOwnerId(from, lookup) {
  const seen = /* @__PURE__ */ new Set();
  let current = from;
  while (current.origin === "subagent" && current.parentId !== void 0 && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId = current.parentId;
    const parent = lookup(parentId);
    if (parent === void 0) return parentId;
    current = parent;
  }
  return current.id;
}
function boardOwnerFromList(list) {
  if (list.current === void 0) return void 0;
  const lookup = (id) => {
    const row = list.byId[id];
    const catalogParent = parentFromCatalog(id, list.subagentsByParent);
    if (row === void 0 && catalogParent === void 0) return void 0;
    return lineageFromList(id, list);
  };
  return boardOwnerId(lineageFromList(list.current, list), lookup);
}
function parentFromCatalog(childId, catalogs) {
  if (catalogs === void 0) return void 0;
  for (const [parentId, snapshot] of Object.entries(catalogs)) {
    if (snapshot.entries.some((entry) => entry.kind === "child" && entry.id === childId)) {
      return parentId;
    }
  }
  return void 0;
}
function lineageFromList(id, list) {
  const row = list.byId[id];
  const catalogParent = parentFromCatalog(id, list.subagentsByParent);
  return {
    id,
    ...row?.parentId !== void 0 ? { parentId: row.parentId } : catalogParent !== void 0 ? { parentId: catalogParent } : {},
    ...row?.origin !== void 0 ? { origin: row.origin } : catalogParent !== void 0 ? { origin: "subagent" } : {},
    ...row?.isSeeded !== void 0 ? { isSeeded: row.isSeeded } : {}
  };
}

// src/types.ts
var ORIGIN_ID = "origin";
var GOAL_ID = "goal";

// src/view.ts
var NODE_WIDTH = 168;
var NODE_HEIGHT = 56;
var OPEN_WIDTH = 168;
var OPEN_HEIGHT = 44;
var COLUMN_GAP = 64;
var ROW_GAP = 20;
var PAD = 28;
function parseBoard(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.title !== "string" || !isStatus(value.status)) return null;
  if (typeof value.bootstrapEnabled !== "boolean") return null;
  if (!Array.isArray(value.facts) || !Array.isArray(value.intents) || !Array.isArray(value.hints)) return null;
  const facts = [];
  for (const item of value.facts) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.description !== "string") return null;
    facts.push({ id: item.id, description: item.description });
  }
  const intents = [];
  for (const item of value.intents) {
    const intent = parseIntent(item);
    if (intent === null) return null;
    intents.push(intent);
  }
  const hints = [];
  for (const item of value.hints) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.content !== "string" || typeof item.creator !== "string" || typeof item.createdAt !== "string") return null;
    hints.push({
      id: item.id,
      content: item.content,
      creator: item.creator,
      createdAt: item.createdAt
    });
  }
  const reason = parseReason(value.reason);
  if (reason === void 0) return null;
  if (!isRecord(value.checkpoint)) return null;
  const { factCount, hintCount, hadOpenIntents } = value.checkpoint;
  if (typeof factCount !== "number" || typeof hintCount !== "number" || typeof hadOpenIntents !== "boolean") {
    return null;
  }
  return {
    title: value.title,
    status: value.status,
    bootstrapEnabled: value.bootstrapEnabled,
    facts,
    intents,
    hints,
    reason,
    checkpoint: { factCount, hintCount, hadOpenIntents }
  };
}
function layoutBoard(board) {
  const columns = /* @__PURE__ */ new Map();
  columns.set(ORIGIN_ID, 0);
  const visiting = /* @__PURE__ */ new Set();
  const columnOf = (id) => {
    const held = columns.get(id);
    if (held !== void 0) return held;
    if (visiting.has(id)) return 1;
    visiting.add(id);
    const incoming = board.intents.filter((intent) => intent.to === id);
    const col = incoming.length === 0 ? 1 : 1 + Math.max(0, ...incoming.flatMap((intent) => intent.from.map((from) => columnOf(from))));
    visiting.delete(id);
    columns.set(id, col);
    return col;
  };
  for (const fact of board.facts) columnOf(fact.id);
  const factColumns = board.facts.map((fact) => columns.get(fact.id) ?? 1);
  const maxFactCol = factColumns.length === 0 ? 0 : Math.max(...factColumns);
  columns.set(GOAL_ID, Math.max(columns.get(GOAL_ID) ?? 1, maxFactCol + 1));
  const byColumn = /* @__PURE__ */ new Map();
  for (const fact of board.facts) {
    const col = columns.get(fact.id) ?? 1;
    const row = byColumn.get(col) ?? [];
    row.push(fact.id);
    byColumn.set(col, row);
  }
  const factById = new Map(board.facts.map((fact) => [fact.id, fact]));
  const nodes = [];
  const nodeAt = /* @__PURE__ */ new Map();
  let maxCol = 0;
  let maxBottom = 0;
  for (const [col, ids] of [...byColumn.entries()].sort((a, b) => a[0] - b[0])) {
    maxCol = Math.max(maxCol, col);
    ids.forEach((id, index) => {
      const fact = factById.get(id);
      if (fact === void 0) return;
      const node = {
        id,
        kind: id === ORIGIN_ID ? "origin" : id === GOAL_ID ? "goal" : "fact",
        description: fact.description,
        x: PAD + col * (NODE_WIDTH + COLUMN_GAP),
        y: PAD + index * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT
      };
      nodes.push(node);
      nodeAt.set(id, node);
      maxBottom = Math.max(maxBottom, node.y + node.height);
    });
  }
  const edges = board.intents.map((intent) => ({
    id: intent.id,
    from: intent.from,
    to: intent.to,
    description: intent.description,
    status: edgeStatus(intent),
    worker: intent.worker,
    creator: intent.creator
  }));
  const stubs = [];
  const openByColumn = /* @__PURE__ */ new Map();
  for (const edge of edges) {
    if (edge.to !== null) continue;
    const fromCols = edge.from.map((id) => columns.get(id) ?? 0);
    const col = (fromCols.length === 0 ? 0 : Math.max(...fromCols)) + 1;
    const list = openByColumn.get(col) ?? [];
    list.push(edge);
    openByColumn.set(col, list);
  }
  for (const [col, list] of openByColumn) {
    maxCol = Math.max(maxCol, col);
    const occupied = (byColumn.get(col) ?? []).length;
    list.forEach((edge, index) => {
      const stub = {
        id: `open:${edge.id}`,
        intentId: edge.id,
        description: edge.description,
        worker: edge.worker,
        x: PAD + col * (NODE_WIDTH + COLUMN_GAP),
        y: PAD + (occupied + index) * (NODE_HEIGHT + ROW_GAP),
        width: OPEN_WIDTH,
        height: OPEN_HEIGHT
      };
      stubs.push(stub);
      maxBottom = Math.max(maxBottom, stub.y + stub.height);
    });
  }
  const openCount = board.intents.filter((intent) => intent.to === null).length;
  const claimedCount = board.intents.filter((intent) => intent.to === null && intent.worker !== null).length;
  return {
    title: board.title,
    status: board.status,
    bootstrapEnabled: board.bootstrapEnabled,
    nodes,
    edges,
    stubs,
    hints: board.hints,
    reason: board.reason,
    factCount: board.facts.length,
    openCount,
    claimedCount,
    width: PAD * 2 + (maxCol + 1) * NODE_WIDTH + maxCol * COLUMN_GAP,
    height: PAD * 2 + Math.max(NODE_HEIGHT, maxBottom - PAD)
  };
}
function readBoardText(text) {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "missing" };
  const board = parseBoard(trimmed);
  if (board === null) return { kind: "invalid", message: "blackboard.json is not a valid board" };
  return { kind: "ready", view: layoutBoard(board) };
}
function nodeAnchor(node, side) {
  return {
    x: side === "left" ? node.x : node.x + node.width,
    y: node.y + node.height / 2
  };
}
function edgePath(from, to) {
  const start = nodeAnchor(from, "right");
  const end = nodeAnchor(to, "left");
  const mid = (start.x + end.x) / 2;
  return `M ${start.x} ${start.y} C ${mid} ${start.y}, ${mid} ${end.y}, ${end.x} ${end.y}`;
}
function edgeStatus(intent) {
  if (intent.to === GOAL_ID) return "complete";
  if (intent.to !== null) return "concluded";
  if (intent.worker !== null) return "claimed";
  return "open";
}
function parseIntent(item) {
  if (!isRecord(item)) return null;
  if (typeof item.id !== "string" || typeof item.description !== "string") return null;
  if (typeof item.creator !== "string" || typeof item.createdAt !== "string") return null;
  if (!Array.isArray(item.from) || item.from.some((id) => typeof id !== "string")) return null;
  if (item.to !== null && typeof item.to !== "string") return null;
  if (item.worker !== null && typeof item.worker !== "string") return null;
  if (item.concludedAt !== null && typeof item.concludedAt !== "string") return null;
  return {
    id: item.id,
    from: item.from,
    to: item.to,
    description: item.description,
    creator: item.creator,
    worker: item.worker,
    createdAt: item.createdAt,
    concludedAt: item.concludedAt
  };
}
function parseReason(value) {
  if (value === null) return null;
  if (!isRecord(value)) return void 0;
  if (typeof value.worker !== "string" || typeof value.startedAt !== "string") return void 0;
  if (value.trigger !== "initial" && value.trigger !== "new-fact" && value.trigger !== "new-hint" && value.trigger !== "intents-empty") return void 0;
  return { worker: value.worker, trigger: value.trigger, startedAt: value.startedAt };
}
function isStatus(value) {
  return value === "active" || value === "stopped" || value === "completed";
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/client/BlackboardGraph.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var ELLIPSIS = "\u2026";
function BlackboardGraph({ view, selectedId, onSelect, t }) {
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const stubByIntent = new Map(view.stubs.map((stub) => [stub.intentId, stub]));
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-bb-canvas", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "svg",
    {
      width: view.width,
      height: view.height,
      viewBox: `0 0 ${view.width} ${view.height}`,
      role: "img",
      "aria-label": view.title,
      children: [
        view.edges.flatMap((edge) => {
          const dest = edge.to === null ? stubByIntent.get(edge.id) : byId.get(edge.to);
          if (dest === void 0) return [];
          return edge.from.flatMap((fromId) => {
            const source = byId.get(fromId);
            if (source === void 0) return [];
            return [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "path",
                {
                  className: "dsh-bb-edge",
                  "data-status": edge.status,
                  d: edgePath(source, dest)
                },
                `${edge.id}:${fromId}`
              )
            ];
          });
        }),
        view.nodes.map((node) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          NodeCard,
          {
            node,
            selected: selectedId === node.id,
            kicker: t(`kind.${node.kind}`),
            onSelect
          },
          node.id
        )),
        view.stubs.map((stub) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          StubCard,
          {
            stub,
            selected: selectedId === stub.id,
            onSelect
          },
          stub.id
        ))
      ]
    }
  ) });
}
function NodeCard({
  node,
  selected,
  kicker,
  onSelect
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "g",
    {
      className: "dsh-bb-node",
      "data-kind": node.kind,
      "data-selected": selected || void 0,
      transform: `translate(${node.x} ${node.y})`,
      onClick: () => {
        onSelect(node.id);
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("title", { children: `${kicker} ${node.id}: ${node.description}` }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "rect",
          {
            className: "dsh-bb-node-card",
            width: node.width,
            height: node.height,
            rx: 8
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("text", { className: "dsh-bb-node-id", x: 10, y: 18, children: truncate(`${kicker} \xB7 ${node.id}`, 22) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("text", { className: "dsh-bb-node-text", x: 10, y: 36, children: truncate(node.description, 22) })
      ]
    }
  );
}
function StubCard({
  stub,
  selected,
  onSelect
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "g",
    {
      className: "dsh-bb-node dsh-bb-stub",
      "data-selected": selected || void 0,
      transform: `translate(${stub.x} ${stub.y})`,
      onClick: () => {
        onSelect(stub.id);
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("title", { children: stub.description }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "rect",
          {
            className: "dsh-bb-node-card",
            width: stub.width,
            height: stub.height,
            rx: 8
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("text", { className: "dsh-bb-node-id", x: 10, y: 16, children: truncate(stub.intentId, 22) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("text", { className: "dsh-bb-node-text", x: 10, y: 32, children: truncate(stub.description, 22) })
      ]
    }
  );
}
function selectedDetail(view, selectedId) {
  if (selectedId === void 0) return void 0;
  const node = view.nodes.find((item) => item.id === selectedId);
  if (node !== void 0) {
    return { kicker: node.id, body: node.description };
  }
  const stub = view.stubs.find((item) => item.id === selectedId);
  if (stub !== void 0) {
    const edge = view.edges.find((item) => item.id === stub.intentId);
    return {
      kicker: stub.intentId,
      body: edge === void 0 ? stub.description : describeEdge(edge)
    };
  }
  return void 0;
}
function describeEdge(edge) {
  const lines = [edge.description, `from ${edge.from.join(", ")}`];
  if (edge.to !== null) lines.push(`to ${edge.to}`);
  if (edge.worker !== null) lines.push(`worker ${edge.worker}`);
  return lines.join("\n");
}
function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`;
}

// src/client/BlackboardSidebarPanel.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var PANEL_GAP = 8;
var POLL_MS = 1500;
function BlackboardSidebarPanel({
  wide,
  useSessions,
  t,
  readBoard
}) {
  const current = useSessions((state) => state.current);
  const byId = useSessions((state) => state.byId) ?? {};
  const catalogs = useSessions((state) => state.subagentsByParent);
  const ownerId = (0, import_react.useMemo)(() => {
    try {
      return boardOwnerFromList({
        current,
        byId,
        ...catalogs !== void 0 ? { subagentsByParent: catalogs } : {}
      });
    } catch {
      return current;
    }
  }, [byId, catalogs, current]);
  const ownerTitle = ownerId === void 0 ? void 0 : byId[ownerId]?.displayTitle;
  const [open, setOpen] = (0, import_react.useState)(false);
  const [anchor, setAnchor] = (0, import_react.useState)();
  const [snapshot, setSnapshot] = (0, import_react.useState)();
  const [selectedId, setSelectedId] = (0, import_react.useState)();
  const rootRef = (0, import_react.useRef)(null);
  const readRef = (0, import_react.useRef)(readBoard);
  readRef.current = readBoard;
  (0, import_react.useEffect)(() => {
    setSelectedId(void 0);
    if (!open || current === void 0 || ownerId === void 0) {
      setSnapshot(void 0);
      return;
    }
    setSnapshot(void 0);
    const controller = new AbortController();
    const pull = () => {
      void readRef.current(current, ownerId, controller.signal).then((next) => {
        if (!controller.signal.aborted) setSnapshot(next);
      }).catch((error) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setSnapshot({ kind: "error", message });
      });
    };
    pull();
    const timer = window.setInterval(pull, POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [current, ownerId, open]);
  (0, import_react.useLayoutEffect)(() => {
    if (!open) return;
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect === void 0) return;
      setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + PANEL_GAP });
    };
    place();
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
    };
  }, [open]);
  (0, import_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open, setOpen);
  const view = snapshot?.kind === "ready" ? snapshot.view : void 0;
  const statusKey = view === void 0 ? "status.active" : `status.${view.status}`;
  const statusLabel = t(statusKey);
  const detail = view === void 0 ? void 0 : selectedDetail(view, selectedId);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { ref: rootRef, className: wide ? "dsh-bb-layer" : "dsh-bb-layer dsh-bb-rail", children: [
    open && anchor !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
      "section",
      {
        className: "dsh-bb-panel",
        style: anchor,
        "data-blackboard-panel": true,
        "data-blackboard-owner": ownerId,
        "aria-label": t("panel.title"),
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { className: "dsh-bb-header", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-bb-title-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsh-bb-title", children: view?.title ?? t("panel.title") }),
              view !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsh-bb-status", children: statusLabel })
            ] }),
            ownerTitle !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsh-bb-owner", children: t("panel.owner", { title: ownerTitle }) }),
            view !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-bb-meta", children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("meta.facts", { count: view.factCount }) }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("meta.open", { count: view.openCount }) }),
              view.reason !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("meta.reasoning", { worker: view.reason.worker }) })
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsh-bb-body", children: panelBody({ current, snapshot, view, selectedId, setSelectedId, t, detail }) })
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: t("panel.trigger"), delayMs: 500, disabled: wide, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
      "button",
      {
        type: "button",
        className: "dsh-bb-trigger",
        "data-blackboard-open": open || void 0,
        "data-active": open || void 0,
        "aria-label": t("panel.aria", { status: statusLabel }),
        "aria-expanded": open,
        onClick: () => {
          setOpen((value) => !value);
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(BlackboardIcon, { size: wide ? 16 : 18 }),
          wide && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsh-bb-trigger-label", children: t("panel.trigger") }),
            view !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsh-bb-trigger-meta", children: view.factCount })
          ] }),
          !wide && view !== void 0 && view.openCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsh-bb-rail-dot", "aria-hidden": "true" })
        ]
      }
    ) })
  ] });
}
function panelBody({
  current,
  snapshot,
  view,
  selectedId,
  setSelectedId,
  t,
  detail
}) {
  if (current === void 0) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-bb-note", children: t("panel.noSession") });
  if (snapshot === void 0) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-bb-note", children: t("panel.loading") });
  if (snapshot.kind === "missing") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-bb-note", children: t("panel.empty") });
  if (snapshot.kind === "invalid") {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-bb-error", role: "alert", children: t("panel.invalid", { message: snapshot.message }) });
  }
  if (snapshot.kind === "error") {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-bb-error", role: "alert", children: t("panel.load.error", { message: snapshot.message }) });
  }
  if (view === void 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(BlackboardGraph, { view, selectedId, onSelect: setSelectedId, t }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-bb-legend", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsh-bb-swatch origin" }),
        t("legend.origin")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsh-bb-swatch" }),
        t("legend.fact")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsh-bb-swatch goal" }),
        t("legend.goal")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsh-bb-swatch open" }),
        t("legend.claimed")
      ] })
    ] }),
    detail !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-bb-detail", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-bb-detail-kicker", children: detail.kicker }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-bb-detail-body", children: detail.body })
    ] }),
    view.hints.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-bb-hints", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-bb-hints-title", children: t("detail.hint") }),
      view.hints.map((hint) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-bb-hint", children: hint.content }, hint.id))
    ] })
  ] });
}
function BlackboardIcon({ size }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2", stroke: "currentColor", strokeWidth: "1.25" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M4 6.5h8M4 9.5h5", stroke: "currentColor", strokeWidth: "1.25", strokeLinecap: "round" })
  ] });
}

// src/client/locales.ts
var NS = "blackboard";
var zh = {
  "panel.trigger": "\u753B\u677F",
  "panel.title": "\u753B\u677F",
  "panel.aria": "\u753B\u677F\uFF0C{status}",
  "panel.empty": "\u5F53\u524D\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u753B\u677F\u3002Agent \u8C03\u7528 blackboard op=init \u540E\u4F1A\u5199\u5165\u8BE5\u4E3B\u4F1A\u8BDD\u7684\u753B\u677F\u6587\u4EF6\u3002\u5B50\u4EE3\u7406\u5171\u7528\u4E3B\u4F1A\u8BDD\u7684\u753B\u677F\u3002",
  "panel.loading": "\u6B63\u5728\u52A0\u8F7D\u753B\u677F\u2026",
  "panel.owner": "\u4F1A\u8BDD {title}",
  "panel.noSession": "\u6253\u5F00\u4E00\u4E2A\u5E26\u5DE5\u4F5C\u533A\u7684\u4F1A\u8BDD\u540E\u5373\u53EF\u67E5\u770B\u753B\u677F\u3002",
  "panel.invalid": "\u65E0\u6CD5\u89E3\u6790\u753B\u677F\uFF1A{message}",
  "panel.load.error": "\u8BFB\u53D6\u753B\u677F\u5931\u8D25\uFF1A{message}",
  "status.active": "\u8FDB\u884C\u4E2D",
  "status.stopped": "\u5DF2\u505C\u6B62",
  "status.completed": "\u5DF2\u5B8C\u6210",
  "meta.facts": "{count} \u6761\u4E8B\u5B9E",
  "meta.open": "{count} \u6761\u672A\u5B8C\u6210\u610F\u56FE",
  "meta.reasoning": "\u6B63\u5728\u63A8\u7406\uFF08{worker}\uFF09",
  "legend.origin": "\u8D77\u70B9",
  "legend.goal": "\u76EE\u6807",
  "legend.fact": "\u4E8B\u5B9E",
  "legend.open": "\u63A2\u7D22\u4E2D",
  "legend.claimed": "\u5DF2\u8BA4\u9886",
  "detail.intent": "\u610F\u56FE {id}",
  "detail.fact": "\u4E8B\u5B9E {id}",
  "detail.from": "\u6765\u81EA {ids}",
  "detail.worker": "\u6267\u884C\u8005 {worker}",
  "detail.hint": "\u63D0\u793A",
  "kind.origin": "\u8D77\u70B9",
  "kind.goal": "\u76EE\u6807",
  "kind.fact": "\u4E8B\u5B9E"
};
var en = {
  "panel.trigger": "Blackboard",
  "panel.title": "Blackboard",
  "panel.aria": "Blackboard, {status}",
  "panel.empty": "This session has no blackboard yet. The agent writes the main session file after blackboard op=init. Subagents share that board.",
  "panel.loading": "Loading blackboard\u2026",
  "panel.owner": "Session {title}",
  "panel.noSession": "Open a session with a workspace to view the blackboard.",
  "panel.invalid": "Could not parse the blackboard: {message}",
  "panel.load.error": "Failed to read the blackboard: {message}",
  "status.active": "active",
  "status.stopped": "stopped",
  "status.completed": "completed",
  "meta.facts": "{count} facts",
  "meta.open": "{count} open intents",
  "meta.reasoning": "reasoning ({worker})",
  "legend.origin": "Origin",
  "legend.goal": "Goal",
  "legend.fact": "Fact",
  "legend.open": "Exploring",
  "legend.claimed": "Claimed",
  "detail.intent": "Intent {id}",
  "detail.fact": "Fact {id}",
  "detail.from": "from {ids}",
  "detail.worker": "worker {worker}",
  "detail.hint": "Hints",
  "kind.origin": "Origin",
  "kind.goal": "Goal",
  "kind.fact": "Fact"
};

// src/client/rpc.ts
async function loadBoardSnapshot(remote, sessionId, ownerId, signal) {
  let path;
  try {
    path = boardRelativePath(ownerId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "error", message };
  }
  const chunks = [];
  let offset = 1;
  for (; ; ) {
    const result = await remote.workspaceFiles.read(
      sessionId,
      path,
      { offset },
      signal
    );
    if (!result.ok) {
      if (result.error?.code === "workspace-file/not-found") return { kind: "missing" };
      return { kind: "error", message: result.error?.message ?? "read failed" };
    }
    if (result.value.lines > 0) chunks.push(result.value.text);
    if (result.value.eof) break;
    offset += result.value.lines;
    if (offset > 1e6) return { kind: "error", message: "blackboard is too large to display" };
  }
  return readBoardText(chunks.join("\n"));
}

// src/client/styles.ts
var STYLE_ID = "dsh-cairn-blackboard-styles";
var CSS = `
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
`;
function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// src/client/index.ts
var name = "dsh-cairn-search";
var inject = ["slots", "locale", "remote", "remote.workspaceFiles"];
function apply(ctx) {
  ensureStyles();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-cairn-search: dictionaries");
  const remote = ctx.remote;
  ctx.slots.inject(
    "sidebar.footer.action",
    () => ctx.slots.register({
      name: "sidebar.footer.action",
      id: "blackboard-panel",
      // Ahead of ui-subagent (order 0): this control sits above 子代理.
      order: -10,
      locale: NS,
      inject: () => ({
        readBoard: (sessionId, ownerId, signal) => loadBoardSnapshot(remote, sessionId, ownerId, signal)
      })
    }, BlackboardSidebarPanel)
  );
}

return module.exports; } });
