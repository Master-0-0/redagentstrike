// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/board.ts
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// src/types.ts
var ORIGIN_ID = "origin";
var GOAL_ID = "goal";
var BOOTSTRAP_DESCRIPTION = "bootstrap";
var MAX_INTENTS = 3;

// src/ids.ts
function nextNumericId(prefix, ids) {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of ids) {
    const match = re.exec(id);
    if (!match) continue;
    const n = Number.parseInt(match[1], 10);
    if (n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

// src/owner.ts
var BOARD_DIR_RELATIVE = ".dsh/blackboards";
var LEGACY_BOARD_RELATIVE_PATH = ".dsh/blackboard.json";
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
function isConversationFork(session) {
  return session.origin !== "subagent" && session.parentId !== void 0 && session.isSeeded === true;
}
function forkSourceOwnerId(session, lookup) {
  if (!isConversationFork(session) || session.parentId === void 0) return void 0;
  const parent = lookup(session.parentId);
  if (parent === void 0) return session.parentId;
  return boardOwnerId(parent, lookup);
}

// src/board.ts
var BOOTSTRAP_CREATOR = "dispatcher.bootstrap";
var HINT_INIT_CREATOR = "init";
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function openIntents(board) {
  return board.intents.filter((intent) => intent.to === null && !intent.closed);
}
function isReservedBootstrap(intent) {
  return intent.from.length === 1 && intent.from[0] === ORIGIN_ID && intent.description === BOOTSTRAP_DESCRIPTION;
}
function isInitial(board) {
  if (board.facts.length !== 2) return false;
  const ids = new Set(board.facts.map((fact) => fact.id));
  if (!ids.has(ORIGIN_ID) || !ids.has(GOAL_ID)) return false;
  return board.intents.every((intent) => isReservedBootstrap(intent) && !intent.closed);
}
function bootstrapInProgress(board) {
  return board.intents.some(
    (intent) => isReservedBootstrap(intent) && intent.to === null && intent.worker !== null
  );
}
function factDescription(board, id) {
  const fact = board.facts.find((item) => item.id === id);
  if (!fact) throw new Error("unknown fact");
  return fact.description;
}
function nextFactId(board) {
  return nextNumericId("f", board.facts.map((fact) => fact.id));
}
function nextIntentId(board) {
  return nextNumericId("i", board.intents.map((intent) => intent.id));
}
function nextHintId(board) {
  return nextNumericId("h", board.hints.map((hint) => hint.id));
}
function factIds(board) {
  return board.facts.map((fact) => fact.id);
}
function snapshotCheckpoint(board) {
  return {
    factCount: board.facts.length,
    hintCount: board.hints.length,
    hadOpenIntents: openIntents(board).length > 0
  };
}
function situationTrigger(board) {
  if (board.facts.length > board.checkpoint.factCount) return "new-fact";
  if (board.hints.length > board.checkpoint.hintCount) return "new-hint";
  if (board.checkpoint.hadOpenIntents && openIntents(board).length === 0) return "intents-empty";
  return null;
}
function reasonTriggerForStart(board) {
  if (isInitial(board)) return "initial";
  return situationTrigger(board);
}
function reasonTask(board, trigger) {
  return {
    kind: "reason",
    trigger,
    factIds: factIds(board),
    openIntents: openIntents(board)
  };
}
function unclaimedExplorable(board) {
  return board.intents.filter(
    (intent) => intent.to === null && !intent.closed && intent.worker === null && !isReservedBootstrap(intent)
  );
}
function newestUnclaimed(board) {
  let newest = null;
  for (const intent of unclaimedExplorable(board)) {
    if (!newest || intent.createdAt >= newest.createdAt) newest = intent;
  }
  return newest;
}
function requireWorker(worker) {
  if (!worker) throw new Error("empty worker");
  return worker;
}
function requireActive(board) {
  if (board.status !== "active") throw new Error("not active");
}
function requireIntent(board, intentId) {
  const intent = board.intents.find((item) => item.id === intentId);
  if (!intent) throw new Error("intent not found");
  return intent;
}
function replaceIntent(board, intentId, next) {
  return {
    ...board,
    intents: board.intents.map((intent) => intent.id === intentId ? next : intent)
  };
}
function assertFrom(board, from) {
  if (from.length === 0) throw new Error("empty from");
  const ids = new Set(factIds(board));
  for (const id of from) {
    if (id === GOAL_ID) throw new Error("goal in from");
    if (!ids.has(id)) throw new Error("unknown fact");
  }
  if (new Set(from).size !== from.length) throw new Error("duplicate from");
  const superseded = new Set(board.facts.flatMap((f) => f.supersedes ?? []));
  if (from.some((id) => superseded.has(id))) throw new Error("superseded fact in from");
  return [...from];
}
function idle(reason) {
  return { kind: "idle", reason };
}
function boardPath(cwd, ownerId) {
  return join(cwd, boardRelativePath(ownerId));
}
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function writeAtomic(dest, body) {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.blackboard.${randomUUID()}.tmp`);
  await writeFile(tmp, body, "utf8");
  await rename(tmp, dest);
}
function emptyBoard(title, origin, goal, hints) {
  const createdAt = nowIso();
  const hintList = (hints ?? []).map((content, index) => ({
    id: `h${String(index + 1).padStart(3, "0")}`,
    content,
    creator: HINT_INIT_CREATOR,
    createdAt
  }));
  return {
    title,
    status: "active",
    bootstrapEnabled: true,
    facts: [
      { id: ORIGIN_ID, description: origin },
      { id: GOAL_ID, description: goal }
    ],
    intents: [],
    hints: hintList,
    reason: null,
    checkpoint: {
      factCount: 2,
      hintCount: hintList.length,
      hadOpenIntents: false
    }
  };
}
async function loadBoard(cwd, ownerId) {
  try {
    const raw = await readFile(boardPath(cwd, ownerId), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    const error = err;
    if (error.code === "ENOENT") return null;
    throw err;
  }
}
async function saveBoard(cwd, ownerId, board) {
  await writeAtomic(boardPath(cwd, ownerId), JSON.stringify(board, null, 2));
}
async function copyBoardIfAbsent(cwd, fromOwnerId, toOwnerId) {
  if (fromOwnerId === toOwnerId) return false;
  const dest = boardPath(cwd, toOwnerId);
  if (await pathExists(dest)) return false;
  const src = boardPath(cwd, fromOwnerId);
  if (!await pathExists(src)) return false;
  await writeAtomic(dest, await readFile(src, "utf8"));
  return true;
}
async function adoptLegacyIfAbsent(cwd, ownerId) {
  const dest = boardPath(cwd, ownerId);
  if (await pathExists(dest)) return false;
  const legacy = join(cwd, LEGACY_BOARD_RELATIVE_PATH);
  if (!await pathExists(legacy)) return false;
  await writeAtomic(dest, await readFile(legacy, "utf8"));
  return true;
}
async function seedBoard(cwd, ownerId, sourceOwnerId) {
  if (await pathExists(boardPath(cwd, ownerId))) return;
  if (sourceOwnerId !== void 0) {
    const copied = await copyBoardIfAbsent(cwd, sourceOwnerId, ownerId);
    if (copied) return;
  }
  await adoptLegacyIfAbsent(cwd, ownerId);
}
function nextTask(board) {
  if (board.status !== "active") return idle(board.status);
  if (isInitial(board)) {
    if (board.bootstrapEnabled && !bootstrapInProgress(board)) {
      return {
        kind: "bootstrap",
        origin: factDescription(board, ORIGIN_ID),
        goal: factDescription(board, GOAL_ID),
        hints: board.hints
      };
    }
    if (board.reason === null) return reasonTask(board, "initial");
    return idle("no task");
  }
  if (board.reason === null) {
    const trigger = situationTrigger(board);
    if (trigger) return reasonTask(board, trigger);
  }
  const intent = newestUnclaimed(board);
  if (intent) return { kind: "explore", intent };
  return idle("no task");
}
function claimIntent(board, intentId, worker) {
  requireActive(board);
  requireWorker(worker);
  const intent = requireIntent(board, intentId);
  if (intent.to !== null || intent.closed) throw new Error("already concluded or closed");
  if (intent.worker !== null && intent.worker !== worker) throw new Error("already claimed");
  if (intent.worker === worker) return board;
  return replaceIntent(board, intentId, { ...intent, worker });
}
function clearClaim(intent) {
  const { dispatchId, subagentId, pendingReturn, ...rest } = intent;
  return { ...rest, worker: null };
}
function releaseIntent(board, intentId) {
  requireActive(board);
  const intent = requireIntent(board, intentId);
  if (intent.to !== null || intent.closed) throw new Error("already concluded or closed");
  return replaceIntent(board, intentId, clearClaim(intent));
}
function concludeIntent(board, intentId, description, worker, supersedes = []) {
  requireActive(board);
  requireWorker(worker);
  const intent = requireIntent(board, intentId);
  if (intent.to !== null || intent.closed) throw new Error("already concluded or closed");
  if (intent.worker === null) throw new Error("not claimed");
  if (intent.worker !== worker) throw new Error("not claimed");
  const trimmed = description.trim();
  if (!trimmed) throw new Error("empty description");
  if (supersedes.length) {
    assertFrom(board, supersedes);
    if (supersedes.includes(ORIGIN_ID)) throw new Error("cannot supersede origin");
  }
  const fact = { id: nextFactId(board), description: trimmed, ...supersedes.length ? { supersedes: [...supersedes] } : {} };
  const concluded = {
    ...intent,
    to: fact.id,
    worker,
    concludedAt: nowIso()
  };
  return {
    board: {
      ...board,
      facts: [...board.facts, fact],
      intents: board.intents.map((item) => item.id === intentId ? concluded : item)
    },
    fact
  };
}
function startReason(board, worker) {
  requireActive(board);
  requireWorker(worker);
  if (board.reason) {
    if (board.reason.worker !== worker) throw new Error("reason held");
    return { board, trigger: board.reason.trigger };
  }
  const trigger = reasonTriggerForStart(board);
  if (!trigger) throw new Error("no reason trigger");
  const lease = {
    worker,
    trigger,
    startedAt: nowIso()
  };
  return {
    board: {
      ...board,
      reason: lease,
      checkpoint: snapshotCheckpoint(board)
    },
    trigger
  };
}
function finishReason(board, worker, result) {
  requireWorker(worker);
  if (!board.reason || board.reason.worker !== worker) throw new Error("reason not held");
  const completing = result.complete !== void 0;
  const declaring = result.intents !== void 0;
  if (completing && declaring) throw new Error("complete XOR intents");
  requireActive(board);
  if (completing) {
    const complete = result.complete;
    const from = assertFrom(board, complete.from);
    if (!from.some((id) => id !== ORIGIN_ID)) throw new Error("completion requires observed facts");
    if (openIntents(board).length) throw new Error("close or conclude open intents before completion");
    const description = complete.description.trim();
    if (!description) throw new Error("empty description");
    const createdAt2 = nowIso();
    const intent = {
      id: nextIntentId(board),
      from,
      to: GOAL_ID,
      description,
      creator: worker,
      worker,
      createdAt: createdAt2,
      concludedAt: createdAt2
    };
    return {
      ...board,
      status: "completed",
      reason: null,
      intents: [...board.intents, intent]
    };
  }
  const incoming = (result.intents ?? []).slice(0, MAX_INTENTS);
  if (incoming.length === 0 && openIntents(board).length === 0) {
    throw new Error("intents required");
  }
  const createdAt = nowIso();
  const declared = [];
  for (const item of incoming) {
    const from = assertFrom(board, item.from);
    const description = item.description.trim();
    if (!description) throw new Error("empty description");
    const target = item.target?.trim();
    if (item.target !== void 0 && !target) throw new Error("empty target");
    const peers = [...openIntents(board), ...declared];
    if (peers.some((i) => i.description.trim() === description || target && i.target === target)) {
      throw new Error("overlapping open intent; conclude or close it first");
    }
    declared.push({
      ...target ? { target } : {},
      id: nextIntentId({ ...board, intents: [...board.intents, ...declared] }),
      from,
      to: null,
      description,
      creator: worker,
      worker: null,
      createdAt,
      concludedAt: null
    });
  }
  return {
    ...board,
    reason: null,
    intents: [...board.intents, ...declared]
  };
}
function addHint(board, content, creator) {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("empty content");
  const hint = {
    id: nextHintId(board),
    content: trimmed,
    creator,
    createdAt: nowIso()
  };
  return {
    board: {
      ...board,
      hints: [...board.hints, hint]
    },
    hint
  };
}
function stopBoard(board) {
  if (board.status === "completed") return board;
  return {
    ...board,
    status: "stopped",
    reason: null,
    intents: board.intents.map(
      (intent) => intent.to === null ? clearClaim(intent) : intent
    )
  };
}
function reopenBoard(board) {
  if (board.status === "completed") throw new Error("completed board cannot be reopened");
  return { ...board, status: "active" };
}
function ensureBootstrapIntent(board) {
  if (!isInitial(board)) return board;
  if (board.intents.some(isReservedBootstrap)) return board;
  requireActive(board);
  const intent = {
    id: nextIntentId(board),
    from: [ORIGIN_ID],
    to: null,
    description: BOOTSTRAP_DESCRIPTION,
    creator: BOOTSTRAP_CREATOR,
    worker: null,
    createdAt: nowIso(),
    concludedAt: null
  };
  return { ...board, intents: [...board.intents, intent] };
}
function closeIntent(board, intentId, reason) {
  requireActive(board);
  const intent = requireIntent(board, intentId);
  if (intent.to !== null || intent.closed) throw new Error("already concluded or closed");
  if (!reason.trim()) throw new Error("empty close reason");
  const closed = replaceIntent(board, intentId, { ...clearClaim(intent), closed: { reason: reason.trim(), at: nowIso() } });
  return addHint(closed, `${intentId} closed: ${reason.trim()}`, "dispatcher.close").board;
}
var transactions = /* @__PURE__ */ new Map();
async function withBoardLock(cwd, ownerId, run) {
  const key = boardPath(cwd, ownerId);
  const prior = transactions.get(key) ?? Promise.resolve();
  const current = prior.catch(() => void 0).then(run);
  transactions.set(key, current);
  try {
    return await current;
  } finally {
    if (transactions.get(key) === current) transactions.delete(key);
  }
}
function reserveDispatch(board, intentId, dispatchId) {
  requireActive(board);
  const intent = requireIntent(board, intentId);
  if (intent.to !== null || intent.closed || !intent.worker) throw new Error("claim intent before spawn");
  if (intent.dispatchId) throw new Error("intent already dispatched");
  if (openIntents(board).some((i) => i.pendingReturn)) throw new Error("conclude, release or close returned workers before spawn");
  if (nextTask(board).kind === "reason" || board.reason) throw new Error("finish pending reason before spawn");
  return replaceIntent(board, intentId, { ...intent, dispatchId });
}
function bindDispatch(board, intentId, dispatchId, subagentId) {
  const intent = requireIntent(board, intentId);
  if (intent.dispatchId !== dispatchId || intent.closed || intent.to !== null || board.status !== "active") return board;
  return replaceIntent(board, intentId, { ...intent, subagentId });
}

// src/audit.ts
function auditBoard(board) {
  const warnings = [];
  const superseded = new Set(board.facts.flatMap((f) => f.supersedes ?? []));
  const active = board.facts.filter((f) => f.id !== "goal" && !superseded.has(f.id));
  for (const intent of board.intents.filter((i) => !i.closed && i.to === null)) {
    if (!intent.target && intent.description !== "bootstrap") warnings.push(`${intent.id}: missing single subgoal target; do not use a queue as an intent`);
    if (active.length > 2 && active.every((f) => intent.from.includes(f.id))) warnings.push(`${intent.id}: depends on every current fact; select only direct premises`);
    if (intent.from.some((id) => superseded.has(id))) warnings.push(`${intent.id}: uses superseded facts; close and redeclare from current evidence`);
    if (intent.pendingReturn) warnings.push(`${intent.id}: worker returned; conclude its finding, release for retry, or close`);
  }
  if (board.status === "active" && board.facts.length > board.checkpoint.factCount) warnings.push("New facts await reason; checkpoint is the last reason-start snapshot, not a live count");
  return warnings;
}

// src/runtime.ts
function installRuntime(ctx, targetOf) {
  ctx.on("tools/execute", async (exec, next) => {
    if (exec.name === "update_goal" && exec.agent?.session.header.origin !== "subagent") {
      const target2 = targetOf(exec);
      const args2 = exec.arguments;
      const board = await loadBoard(target2.cwd, target2.ownerId);
      if (board && args2.action === "complete" && board.status !== "completed") throw new Error("prove blackboard goal before completing the session goal");
      const result = await next();
      if (!result.isError && (args2.action === "pause" || args2.action === "blocked")) {
        await withBoardLock(target2.cwd, target2.ownerId, async () => {
          const current = await loadBoard(target2.cwd, target2.ownerId);
          if (current) {
            interruptWorkers(ctx, exec.agent, current);
            await saveBoard(target2.cwd, target2.ownerId, stopBoard(current));
          }
        });
      }
      return result;
    }
    if (!["subagent", "subagent_fork", "subagent_codex", "subagent_claude_code"].includes(exec.name)) return next();
    const target = targetOf(exec);
    if (exec.agent?.session.header.origin === "subagent") throw new Error("only the blackboard parent may dispatch explorers");
    const args = exec.arguments;
    const intentId = /^blackboard_intent:\s*(i\d+)\s*\n/.exec(args.prompt ?? "")?.[1];
    if (!intentId) throw new Error("spawn prompt must begin with blackboard_intent: iNNN followed by a newline");
    await withBoardLock(target.cwd, target.ownerId, async () => {
      const board = await loadBoard(target.cwd, target.ownerId);
      if (!board) throw new Error("initialize and claim blackboard intent before spawn");
      await saveBoard(target.cwd, target.ownerId, reserveDispatch(board, intentId, exec.callId));
    });
    const failed = async () => withBoardLock(target.cwd, target.ownerId, async () => {
      const board = await loadBoard(target.cwd, target.ownerId);
      const intent = board?.intents.find((i) => i.id === intentId);
      if (board?.status === "active" && intent?.dispatchId === exec.callId && !intent.closed && intent.to === null) {
        await saveBoard(target.cwd, target.ownerId, releaseIntent(board, intentId));
      }
    });
    try {
      const result = await next();
      if (result.isError) await failed();
      else {
        const value = result.value;
        if (typeof value?.subagentId === "string") {
          await withBoardLock(target.cwd, target.ownerId, async () => {
            const board = await loadBoard(target.cwd, target.ownerId);
            if (board) {
              const intent = board.intents.find((i) => i.id === intentId);
              if (board.status !== "active" || intent?.dispatchId !== exec.callId || intent.closed || intent.to !== null) {
                interruptChild(ctx, exec.agent, value.subagentId);
              } else await saveBoard(target.cwd, target.ownerId, bindDispatch(board, intentId, exec.callId, value.subagentId));
            }
          });
        } else if (value?.kind === "foreground") {
          await withBoardLock(target.cwd, target.ownerId, async () => {
            const board = await loadBoard(target.cwd, target.ownerId);
            if (board?.status === "active") {
              await saveBoard(target.cwd, target.ownerId, {
                ...board,
                intents: board.intents.map((i) => i.id === intentId && i.dispatchId === exec.callId && i.to === null && !i.closed ? { ...i, pendingReturn: true } : i)
              });
            }
          });
        }
      }
      return result;
    } catch (error) {
      await failed();
      throw error;
    }
  });
  ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
    if (agent.session.header.origin === "subagent") return next();
    const cwd = agent.session.header.cwd;
    if (!cwd) return next();
    await withBoardLock(cwd, agent.session.id, async () => {
      let board = await loadBoard(cwd, agent.session.id);
      if (!board) return;
      let changed = false;
      for (const message of messages) {
        if (board.hints.some((h) => h.messageId === message.id)) continue;
        const source = message.source;
        if (source.kind !== "user" && source.kind !== "subagent-settled") continue;
        const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (!text) continue;
        const added = addHint(board, text, source.kind === "user" ? "user" : "dispatcher.worker-return");
        board = { ...added.board, hints: added.board.hints.map((h) => h.id === added.hint.id ? { ...h, messageId: message.id } : h) };
        if (source.kind === "subagent-settled" && board.status === "active") {
          board = { ...board, intents: board.intents.map((i) => i.subagentId === source.senderSessionId && i.to === null && !i.closed ? { ...i, pendingReturn: true } : i) };
        }
        changed = true;
      }
      if (changed) await saveBoard(cwd, agent.session.id, board);
    });
    return next();
  });
}
function interruptWorkers(ctx, agent, board, intentId) {
  if (!agent) return;
  for (const intent of board.intents) {
    if (intentId && intent.id !== intentId) continue;
    if (intent.to !== null || intent.closed || !intent.subagentId) continue;
    interruptChild(ctx, agent, intent.subagentId);
  }
}
function interruptChild(ctx, agent, childId) {
  if (!agent) return;
  const runtime = ctx.get("subagents");
  if (!runtime) throw new Error("subagent runtime unavailable; cannot stop bound worker");
  runtime.interrupt(childId, { kind: "ancestor", agent });
}

// src/index.ts
var name = "dsh-cairn-search";
var inject = ["tools"];
var OPS = [
  "init",
  "snapshot",
  "next",
  "claim",
  "conclude",
  "reason_start",
  "reason_finish",
  "hint",
  "release",
  "close",
  "stop",
  "reopen"
];
var DESCRIPTION = "Read and update the origin\u2192goal fact-intent blackboard at .dsh/blackboards/<main-session-id>.json. This tool is the only writer of that file. Subagent sessions share the main session's board; a forked conversation gets its own copy of the source snapshot. Call op=init once per main session (title, origin, goal, optional hints), then op=next to learn the next task (bootstrap, reason, explore, or idle). Claim an intent (op=claim) before exploring it; conclude with exactly one new fact (op=conclude) or release it (op=release). Reason with op=reason_start then op=reason_finish (exactly one of complete, intents, or {}). Human judgment is op=hint. op=stop freezes writes except hints; op=reopen resumes. Use op=close with intentId and description to abandon or replace work without a fact. Use one target per intent and minimal direct from dependencies. Spawn prompts must begin with blackboard_intent: iNNN after claim. Record one distilled conclusion, including negative findings; use supersedes for corrections. Every mutation returns next; execute it before starting more exploration. Complete requires observed facts and no open intents. Do not hand-edit the board file. Policy refusals are not facts.";
var INTENT_DRAFT = {
  type: "object",
  additionalProperties: false,
  properties: {
    from: {
      type: "array",
      required: true,
      items: { type: "string" },
      description: "Fact ids this intent explores from. Must be non-empty and must not include goal."
    },
    target: { type: "string", required: true, description: "One stable subgoal key. Open intents with the same target are rejected." },
    description: {
      type: "string",
      required: true,
      description: "Independent parallelizable direction."
    }
  }
};
var HOST_UI_ENTRY_ID = "cairn-search-ui";
function apply(ctx) {
  if (isHostUiInsert(ctx)) return;
  installRuntime(ctx, (exec) => boardTarget(ctx, exec));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "blackboard",
    description: DESCRIPTION,
    parameters: {
      op: {
        type: "string",
        required: true,
        enum: [...OPS],
        description: "Blackboard operation."
      },
      title: { type: "string", description: "Board title (op=init)." },
      origin: { type: "string", description: "Known starting state (op=init)." },
      goal: { type: "string", description: "Desired end state (op=init)." },
      hints: {
        type: "array",
        items: { type: "string" },
        description: "Optional starting hints (op=init)."
      },
      intentId: { type: "string", description: "Intent id (op=claim, conclude, release)." },
      worker: { type: "string", description: "Worker label (op=claim, conclude, reason_start, reason_finish)." },
      description: { type: "string", description: "Fact text (op=conclude)." },
      supersedes: { type: "array", items: { type: "string" }, description: "Prior fact IDs replaced by this conclusion; preserve their history." },
      content: { type: "string", description: "Hint text (op=hint)." },
      creator: { type: "string", description: "Hint author; defaults to user (op=hint)." },
      complete: {
        type: "object",
        additionalProperties: false,
        description: "Goal proof (op=reason_finish). Mutually exclusive with intents.",
        properties: {
          from: {
            type: "array",
            required: true,
            items: { type: "string" },
            description: "Fact ids that jointly prove the goal. Must not include goal."
          },
          description: {
            type: "string",
            required: true,
            description: "Why these facts meet the goal."
          }
        }
      },
      intents: {
        type: "array",
        items: INTENT_DRAFT,
        description: "Declared explores (op=reason_finish). Mutually exclusive with complete."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          op: { type: "string", required: true },
          board: { type: "json", description: "Current board snapshot." },
          warnings: { type: "json", description: "Quality and recovery diagnostics." },
          next: { type: "json", description: "Next dispatcher task." },
          fact: { type: "json", description: "Fact written by conclude." },
          hint: { type: "json", description: "Hint written by hint." },
          intent: { type: "json", description: "Intent after claim, conclude, or release." },
          trigger: { type: "string", description: "Reason-lease trigger from reason_start." },
          error: { type: "string", description: "Unused on success; domain failures throw." }
        }
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      const target = boardTarget(ctx, exec);
      const { cwd, ownerId } = target;
      const result = await withBoardLock(cwd, ownerId, async () => {
        if (exec.agent?.session.header.origin === "subagent" && args.op !== "snapshot" && args.op !== "next") {
          throw new Error("only the parent session may write the blackboard");
        }
        switch (args.op) {
          case "init": {
            const existing = await loadBoard(cwd, ownerId);
            if (existing) throw new Error("board already exists; use snapshot or reopen");
            const board = ensureBootstrapIntent(emptyBoard(
              required(args.title, "title"),
              required(args.origin, "origin"),
              required(args.goal, "goal"),
              args.hints
            ));
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) };
          }
          case "snapshot": {
            const board = await requireBoard(target);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) };
          }
          case "next": {
            const board = await requireBoard(target);
            return { ok: true, op: args.op, next: nextTask(board) };
          }
          case "claim": {
            const intentId = required(args.intentId, "intentId");
            const board = claimIntent(await requireBoard(target), intentId, required(args.worker, "worker"));
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), intent: intentOf(board, intentId) };
          }
          case "conclude": {
            const intentId = required(args.intentId, "intentId");
            const { board, fact } = concludeIntent(
              await requireBoard(target),
              intentId,
              required(args.description, "description"),
              required(args.worker, "worker"),
              args.supersedes
            );
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), fact, intent: intentOf(board, intentId) };
          }
          case "reason_start": {
            const { board, trigger } = startReason(await requireBoard(target), required(args.worker, "worker"));
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), trigger };
          }
          case "reason_finish": {
            const board = finishReason(await requireBoard(target), required(args.worker, "worker"), {
              ...args.complete !== void 0 ? { complete: args.complete } : {},
              ...args.intents !== void 0 ? { intents: args.intents } : {}
            });
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) };
          }
          case "hint": {
            const { board, hint } = addHint(
              await requireBoard(target),
              required(args.content, "content"),
              args.creator?.trim() || "user"
            );
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), hint };
          }
          case "close": {
            const intentId = required(args.intentId, "intentId");
            const current = await requireBoard(target);
            const board = closeIntent(current, intentId, required(args.description, "description"));
            interruptWorkers(ctx, exec.agent, current, intentId);
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) };
          }
          case "release": {
            const intentId = required(args.intentId, "intentId");
            const current = await requireBoard(target);
            const board = releaseIntent(current, intentId);
            interruptWorkers(ctx, exec.agent, current, intentId);
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), intent: intentOf(board, intentId) };
          }
          case "stop": {
            const current = await requireBoard(target);
            interruptWorkers(ctx, exec.agent, current);
            const board = stopBoard(current);
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) };
          }
          case "reopen": {
            const board = reopenBoard(await requireBoard(target));
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) };
          }
          default: {
            const unsupported = args.op;
            throw new Error(`unsupported op: ${String(unsupported)}`);
          }
        }
      });
      return JSON.parse(JSON.stringify(result));
    },
    presentCall: (args) => ({ card: "generic", title: `blackboard ${args.op}`, kind: "search" })
  })));
}
function isHostUiInsert(ctx) {
  const fiber = ctx.fiber;
  return fiber.entry?.options?.id === HOST_UI_ENTRY_ID;
}
function sessionsOf(ctx) {
  const get = ctx.get;
  if (typeof get !== "function") return void 0;
  try {
    return get.call(ctx, "sessions", false);
  } catch {
    return void 0;
  }
}
function lineageOf(session) {
  const header = session.header;
  return {
    id: session.id,
    ...header?.parentSession !== void 0 ? { parentId: header.parentSession } : {},
    ...header?.origin !== void 0 ? { origin: header.origin } : {},
    ...header?.isSeeded !== void 0 ? { isSeeded: header.isSeeded } : {}
  };
}
function lookupOf(sessions) {
  return (id) => {
    const found = sessions?.get(id);
    return found === void 0 ? void 0 : lineageOf(found);
  };
}
function boardTarget(ctx, exec) {
  const session = exec.agent?.session;
  const cwd = session?.header?.cwd;
  if (session === void 0 || cwd === void 0 || cwd.trim() === "") {
    throw new Error("blackboard requires a session workspace");
  }
  const lookup = lookupOf(sessionsOf(ctx));
  const lineage = lineageOf(session);
  return {
    cwd,
    ownerId: boardOwnerId(lineage, lookup),
    ...isConversationFork(lineage) ? { sourceOwnerId: forkSourceOwnerId(lineage, lookup) } : {}
  };
}
async function requireBoard(target) {
  await seedBoard(target.cwd, target.ownerId, target.sourceOwnerId);
  const board = await loadBoard(target.cwd, target.ownerId);
  if (board === null) throw new Error("no blackboard; call op=init");
  return board;
}
function required(value, field) {
  const text = value?.trim() ?? "";
  if (text === "") throw new Error(`${field} is required`);
  return text;
}
function intentOf(board, intentId) {
  const intent = board.intents.find((item) => item.id === intentId);
  if (intent === void 0) throw new Error(`unknown intent ${intentId}`);
  return intent;
}
export {
  apply,
  inject,
  name
};
