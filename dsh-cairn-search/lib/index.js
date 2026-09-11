// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/board.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// src/types.ts
var BOARD_RELATIVE_PATH = ".dsh/blackboard.json";
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

// src/board.ts
var BOOTSTRAP_CREATOR = "dispatcher.bootstrap";
var HINT_INIT_CREATOR = "init";
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function openIntents(board) {
  return board.intents.filter((intent) => intent.to === null);
}
function isReservedBootstrap(intent) {
  return intent.from.length === 1 && intent.from[0] === ORIGIN_ID && intent.description === BOOTSTRAP_DESCRIPTION;
}
function isInitial(board) {
  if (board.facts.length !== 2) return false;
  const ids = new Set(board.facts.map((fact) => fact.id));
  if (!ids.has(ORIGIN_ID) || !ids.has(GOAL_ID)) return false;
  return board.intents.every(isReservedBootstrap);
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
    (intent) => intent.to === null && intent.worker === null && !isReservedBootstrap(intent)
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
  return [...from];
}
function idle(reason) {
  return { kind: "idle", reason };
}
function boardPath(cwd) {
  return join(cwd, BOARD_RELATIVE_PATH);
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
async function loadBoard(cwd) {
  try {
    const raw = await readFile(boardPath(cwd), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    const error = err;
    if (error.code === "ENOENT") return null;
    throw err;
  }
}
async function saveBoard(cwd, board) {
  const dest = boardPath(cwd);
  await mkdir(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.blackboard.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(board, null, 2), "utf8");
  await rename(tmp, dest);
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
  if (intent.to !== null) throw new Error("already concluded");
  if (intent.worker !== null && intent.worker !== worker) throw new Error("already claimed");
  if (intent.worker === worker) return board;
  return replaceIntent(board, intentId, { ...intent, worker });
}
function releaseIntent(board, intentId) {
  requireActive(board);
  const intent = requireIntent(board, intentId);
  if (intent.to !== null) throw new Error("already concluded");
  return replaceIntent(board, intentId, { ...intent, worker: null });
}
function concludeIntent(board, intentId, description, worker) {
  requireActive(board);
  requireWorker(worker);
  const intent = requireIntent(board, intentId);
  if (intent.to !== null) throw new Error("already concluded");
  if (intent.worker === null) throw new Error("not claimed");
  if (intent.worker !== worker) throw new Error("not claimed");
  const trimmed = description.trim();
  if (!trimmed) throw new Error("empty description");
  const fact = { id: nextFactId(board), description: trimmed };
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
  if (board.status !== "active" && !completing) throw new Error("not active");
  if (board.status === "completed") throw new Error("not active");
  if (completing) {
    const complete = result.complete;
    const from = assertFrom(board, complete.from);
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
    declared.push({
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
  return {
    ...board,
    status: "stopped",
    reason: null,
    intents: board.intents.map(
      (intent) => intent.to === null ? { ...intent, worker: null } : intent
    )
  };
}
function reopenBoard(board) {
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
  "stop",
  "reopen"
];
var DESCRIPTION = "Read and update the origin\u2192goal fact-intent blackboard at .dsh/blackboard.json. This tool is the only writer of that file. Call op=init once per workspace (title, origin, goal, optional hints), then op=next to learn the next task (bootstrap, reason, explore, or idle). Claim an intent (op=claim) before exploring it; conclude with exactly one new fact (op=conclude) or release it (op=release). Reason with op=reason_start then op=reason_finish (exactly one of complete, intents, or {}). Human judgment is op=hint. op=stop freezes writes except hints; op=reopen resumes. Do not hand-edit the board file. Policy refusals are not facts.";
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
    description: {
      type: "string",
      required: true,
      description: "Independent parallelizable direction."
    }
  }
};
function apply(ctx) {
  ctx.tools.register(defineTool({
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
      const cwd = workspaceCwd(exec);
      switch (args.op) {
        case "init": {
          const board = ensureBootstrapIntent(emptyBoard(
            required(args.title, "title"),
            required(args.origin, "origin"),
            required(args.goal, "goal"),
            args.hints
          ));
          await saveBoard(cwd, board);
          return { ok: true, op: args.op, board, next: nextTask(board) };
        }
        case "snapshot": {
          const board = await requireBoard(cwd);
          return { ok: true, op: args.op, board };
        }
        case "next": {
          const board = await requireBoard(cwd);
          return { ok: true, op: args.op, next: nextTask(board) };
        }
        case "claim": {
          const intentId = required(args.intentId, "intentId");
          const board = claimIntent(await requireBoard(cwd), intentId, required(args.worker, "worker"));
          await saveBoard(cwd, board);
          return { ok: true, op: args.op, board, intent: intentOf(board, intentId) };
        }
        case "conclude": {
          const intentId = required(args.intentId, "intentId");
          const { board, fact } = concludeIntent(
            await requireBoard(cwd),
            intentId,
            required(args.description, "description"),
            required(args.worker, "worker")
          );
          await saveBoard(cwd, board);
          return { ok: true, op: args.op, board, fact, intent: intentOf(board, intentId) };
        }
        case "reason_start": {
          const { board, trigger } = startReason(await requireBoard(cwd), required(args.worker, "worker"));
          await saveBoard(cwd, board);
          return { ok: true, op: args.op, board, trigger };
        }
        case "reason_finish": {
          const board = finishReason(await requireBoard(cwd), required(args.worker, "worker"), {
            ...args.complete !== void 0 ? { complete: args.complete } : {},
            ...args.intents !== void 0 ? { intents: args.intents } : {}
          });
          await saveBoard(cwd, board);
          return { ok: true, op: args.op, board, next: nextTask(board) };
        }
        case "hint": {
          const { board, hint } = addHint(
            await requireBoard(cwd),
            required(args.content, "content"),
            args.creator?.trim() || "user"
          );
          await saveBoard(cwd, board);
          return { ok: true, op: args.op, board, hint };
        }
        case "release": {
          const intentId = required(args.intentId, "intentId");
          const board = releaseIntent(await requireBoard(cwd), intentId);
          await saveBoard(cwd, board);
          return { ok: true, op: args.op, board, intent: intentOf(board, intentId) };
        }
        case "stop": {
          const board = stopBoard(await requireBoard(cwd));
          await saveBoard(cwd, board);
          return { ok: true, op: args.op, board };
        }
        case "reopen": {
          const board = reopenBoard(await requireBoard(cwd));
          await saveBoard(cwd, board);
          return { ok: true, op: args.op, board };
        }
        default: {
          const unsupported = args.op;
          throw new Error(`unsupported op: ${String(unsupported)}`);
        }
      }
    },
    presentCall: (args) => ({ card: "generic", title: `blackboard ${args.op}`, kind: "search" })
  }));
}
function workspaceCwd(exec) {
  const cwd = exec.agent?.session.header.cwd;
  if (cwd === void 0 || cwd.trim() === "") {
    throw new Error("blackboard requires a session workspace");
  }
  return cwd;
}
async function requireBoard(cwd) {
  const board = await loadBoard(cwd);
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
