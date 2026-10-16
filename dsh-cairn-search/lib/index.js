// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/board.ts
import { access, mkdir as mkdir2, readFile as readFile2, rename as rename2, writeFile as writeFile2, realpath } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { dirname as dirname2, join as join2 } from "node:path";
import { randomUUID as randomUUID2, createHash as createHash2 } from "node:crypto";

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

// src/evidence.ts
function invalidFactIds(board) {
  const invalid = new Set(board.facts.flatMap((f) => f.supersedes ?? []));
  const facts = new Map(board.facts.map((f) => [f.id, f]));
  const dependents = /* @__PURE__ */ new Map();
  for (const intent of board.intents) {
    if (!intent.to || intent.to === "goal") continue;
    const replacement = new Set(facts.get(intent.to)?.supersedes ?? []);
    for (const premise of intent.from) {
      if (replacement.has(premise)) continue;
      const outputs = dependents.get(premise) ?? [];
      outputs.push(intent.to);
      dependents.set(premise, outputs);
    }
  }
  const queue = [...invalid];
  for (let index = 0; index < queue.length; index++) {
    for (const output of dependents.get(queue[index]) ?? []) {
      if (invalid.has(output)) continue;
      invalid.add(output);
      queue.push(output);
    }
  }
  return invalid;
}

// src/storage.ts
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

// src/storage-format.ts
var STORAGE_FORMAT = "cairn-segments-v1";
var SEGMENT_FIELDS = ["facts", "intents", "hints", "workerReturns"];
var SEGMENT_PATH = /^\.dsh\/blackboard-segments\/[a-f0-9]{64}\.json$/;
async function hydrateBoard(document, read) {
  if (document.storageRevision !== document.storageEndRevision) throw new Error("blackboard changed during paginated read; retry the snapshot");
  if (!("storageFormat" in document)) {
    const { storageRevision: storageRevision2, storageEndRevision: storageEndRevision2, ...board2 } = document;
    return board2;
  }
  if (document.storageFormat !== STORAGE_FORMAT) throw new Error("unsupported blackboard storage format");
  const { storageFormat, storageRevision, storageEndRevision, segments, ...metadata } = document;
  const board = { ...metadata };
  for (const field of SEGMENT_FIELDS) {
    if (!Array.isArray(segments?.[field])) throw new Error("invalid blackboard segment index");
    const records = [];
    for (const ref of segments[field]) {
      if (!SEGMENT_PATH.test(ref.path) || !Number.isSafeInteger(ref.count) || ref.count < 1 || ref.count > 256) throw new Error("invalid blackboard segment reference");
      const values = JSON.parse(await read(ref.path));
      if (!Array.isArray(values) || values.length !== ref.count) throw new Error("blackboard segment count mismatch");
      records.push(...values);
    }
    ;
    board[field] = records;
  }
  return board;
}

// src/storage.ts
var cache = /* @__PURE__ */ new Map();
var cacheBytes = 0;
function remember(path, text) {
  if (cache.has(path)) return;
  if (text.length > 8 * 1024 * 1024) return;
  cache.set(path, text);
  cacheBytes += text.length;
  while (cacheBytes > 8 * 1024 * 1024 || cache.size > 512) {
    const key = cache.keys().next().value;
    cacheBytes -= cache.get(key).length;
    cache.delete(key);
  }
}
async function readStoredBoard(cwd, text) {
  return hydrateBoard(JSON.parse(text), async (path) => {
    const full = join(cwd, path);
    let content = cache.get(full);
    if (content === void 0) {
      content = await readFile(full, "utf8");
      if (!path.endsWith(`/${createHash("sha256").update(content).digest("hex")}.json`)) throw new Error("blackboard segment failed integrity check");
      remember(full, content);
    }
    return content;
  });
}
async function serializeStoredBoard(cwd, board) {
  const revision = randomUUID();
  if (SEGMENT_FIELDS.reduce((n, field) => n + (board[field]?.length ?? 0), 0) < 512) return JSON.stringify({ storageRevision: revision, ...board, storageEndRevision: revision }, null, 2);
  const { facts, intents, hints, workerReturns, ...metadata } = board;
  const segments = {};
  for (const field of SEGMENT_FIELDS) {
    const values = board[field] ?? [];
    const refs = [];
    for (let offset = 0; offset < values.length; offset += 256) {
      const chunk = values.slice(offset, offset + 256);
      const content = JSON.stringify(chunk, null, 2);
      const hash = createHash("sha256").update(content).digest("hex");
      const path = `.dsh/blackboard-segments/${hash}.json`;
      const full = join(cwd, path);
      if (!cache.has(full)) {
        try {
          if (await readFile(full, "utf8") !== content) throw new Error("existing blackboard segment failed integrity check");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await mkdir(dirname(full), { recursive: true });
          const temp = `${full}.${randomUUID()}.tmp`;
          await writeFile(temp, content, "utf8");
          await rename(temp, full);
        }
        remember(full, content);
      }
      refs.push({ path, count: chunk.length });
    }
    segments[field] = refs;
  }
  return JSON.stringify({ storageRevision: revision, ...metadata, storageFormat: STORAGE_FORMAT, segments, storageEndRevision: revision }, null, 2);
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
  if ((board.pendingIntentsEmpty || board.checkpoint.hadOpenIntents) && openIntents(board).length === 0) return "intents-empty";
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
    (intent) => intent.to === null && !intent.closed && (intent.worker === null || !intent.dispatchId) && !isReservedBootstrap(intent)
  );
}
function newestUnclaimed(board) {
  let newest = null;
  for (const intent of unclaimedExplorable(board)) {
    if (!newest || (board.protocolVersion === 2 ? intent.createdAt < newest.createdAt || intent.createdAt === newest.createdAt && (intent.attempts ?? 0) < (newest.attempts ?? 0) : intent.createdAt >= newest.createdAt)) newest = intent;
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
  const superseded = invalidFactIds(board);
  if (from.some((id) => superseded.has(id))) throw new Error("superseded fact in from");
  return [...from];
}
function idle(reason) {
  return { kind: "idle", reason };
}
function boardPath(cwd, ownerId) {
  return join2(cwd, boardRelativePath(ownerId));
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
  await mkdir2(dirname2(dest), { recursive: true });
  const tmp = join2(dirname2(dest), `.blackboard.${randomUUID2()}.tmp`);
  await writeFile2(tmp, body, "utf8");
  await rename2(tmp, dest);
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
  let raw;
  try {
    raw = await readFile2(boardPath(cwd, ownerId), "utf8");
  } catch (err) {
    const error = err;
    if (error.code === "ENOENT") return null;
    throw err;
  }
  const board = await readStoredBoard(cwd, raw);
  return { ...board, workerReturns: board.workerReturns ?? [] };
}
async function saveBoard(cwd, ownerId, board) {
  const records = await Promise.all((board.workerReturns ?? []).map(async (record) => {
    if (record.contentRef || record.content.length <= 2048) return record;
    const hash = createHash2("sha256").update(record.content).digest("hex");
    const contentRef = `.dsh/blackboard-content/${hash}.txt`;
    const path = join2(cwd, contentRef);
    await writeAtomic(path, record.content);
    return { ...record, content: `${record.content.slice(0, 600)}
[Full return available through lookup]`, contentRef, contentLength: record.content.length };
  }));
  await writeAtomic(boardPath(cwd, ownerId), await serializeStoredBoard(cwd, { ...board, workerReturns: records }));
}
async function readReturnContent(cwd, record) {
  if (!record.contentRef) return record.content;
  if (!/^\.dsh\/blackboard-content\/[a-f0-9]{64}\.txt$/.test(record.contentRef)) throw new Error("invalid return content reference");
  const content = await readFile2(join2(cwd, record.contentRef), "utf8");
  const hash = createHash2("sha256").update(content).digest("hex");
  if (!record.contentRef.endsWith(`/${hash}.txt`)) throw new Error("archived worker return failed integrity check");
  return content;
}
async function copyBoardIfAbsent(cwd, fromOwnerId, toOwnerId) {
  if (fromOwnerId === toOwnerId) return false;
  const dest = boardPath(cwd, toOwnerId);
  if (await pathExists(dest)) return false;
  const src = boardPath(cwd, fromOwnerId);
  if (!await pathExists(src)) return false;
  await writeAtomic(dest, await readFile2(src, "utf8"));
  return true;
}
async function adoptLegacyIfAbsent(cwd, ownerId) {
  const dest = boardPath(cwd, ownerId);
  if (await pathExists(dest)) return false;
  const legacy = join2(cwd, LEGACY_BOARD_RELATIVE_PATH);
  if (!await pathExists(legacy)) return false;
  await writeAtomic(dest, await readFile2(legacy, "utf8"));
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
  const pending = openIntents(board).filter((i) => i.pendingReturn);
  if (pending.length) return { kind: "review", intents: pending, records: (board.workerReturns ?? []).filter((r) => !r.resolution && pending.some((i) => i.id === r.intentId && i.dispatchId === r.dispatchId)) };
  if (board.reason !== null) return reasonTask(board, board.reason.trigger);
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
  if (board.policy && openIntents(board).filter((i) => i.dispatchId && !i.pendingReturn).length >= board.policy.maxConcurrent) return idle("workers running; await their returns");
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
  const attempts = (intent.attempts ?? 0) + 1;
  if (board.policy && attempts >= board.policy.maxAttempts) return closeIntent(board, intentId, `Attempt budget exhausted (${attempts}); replan or request new evidence before retrying.`);
  return resolveReturns(replaceIntent(board, intentId, { ...clearClaim(intent), attempts, createdAt: nowIso() }), intent, "release");
}
function concludeIntent(board, intentId, description, worker, supersedes = []) {
  requireActive(board);
  requireWorker(worker);
  const intent = requireIntent(board, intentId);
  if (intent.to !== null || intent.closed) throw new Error("already concluded or closed");
  if (intent.worker === null) throw new Error("not claimed");
  if (intent.worker !== worker) throw new Error("not claimed");
  const invalid = invalidFactIds(board);
  if (intent.from.some((id) => invalid.has(id) && !supersedes.includes(id))) throw new Error("intent premises are no longer valid; close and redeclare");
  if (board.protocolVersion === 2 && (!intent.dispatchId || !(board.workerReturns ?? []).some((r) => r.intentId === intent.id && r.dispatchId === intent.dispatchId && r.kind === "return" && !r.resolution))) throw new Error("review an actual dispatched worker return before concluding");
  const trimmed = description.trim();
  if (!trimmed) throw new Error("empty description");
  if (supersedes.length) {
    assertFrom(board, supersedes);
    if (supersedes.includes(ORIGIN_ID)) throw new Error("cannot supersede origin");
  }
  const fact = { id: nextFactId(board), description: trimmed, ...supersedes.length ? { supersedes: [...supersedes] } : {} };
  const concluded = {
    ...intent,
    pendingReturn: false,
    to: fact.id,
    worker,
    concludedAt: nowIso()
  };
  return {
    board: resolveReturns({
      ...board,
      facts: [...board.facts, fact],
      intents: board.intents.map((item) => item.id === intentId ? concluded : item)
    }, intent, "conclude"),
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
    id: randomUUID2(),
    worker,
    trigger,
    startedAt: nowIso()
  };
  return {
    board: {
      ...board,
      reason: lease,
      pendingIntentsEmpty: false,
      checkpoint: snapshotCheckpoint(board)
    },
    trigger
  };
}
function finishReason(board, worker, result, reasonId) {
  requireWorker(worker);
  if (!board.reason || board.reason.worker !== worker) throw new Error("reason not held");
  if (board.protocolVersion === 2 && (!reasonId || reasonId !== board.reason.id)) throw new Error("reasonId does not match the current reason; reload before submitting");
  const completing = result.complete !== void 0;
  const declaring = result.intents !== void 0;
  if (completing && declaring) throw new Error("complete XOR intents");
  requireActive(board);
  if (completing) {
    const complete = result.complete;
    if (board.protocolVersion === 2) {
      const criteria = board.criteria ?? [];
      const proofs = complete.proofs ?? [];
      if (!criteria.length || proofs.length !== criteria.length || new Set(proofs.map((p) => p.criterionId)).size !== criteria.length) throw new Error("provide one evidence proof per acceptance criterion");
      for (const criterion of criteria) {
        const proof = proofs.find((p) => p.criterionId === criterion.id);
        if (!proof || !proof.description.trim() || !proof.from.some((id) => id !== ORIGIN_ID)) throw new Error(`missing observed proof for ${criterion.id}`);
        assertFrom(board, proof.from);
        if (proof.from.some((id) => !complete.from.includes(id))) throw new Error("criterion proof facts must be included in completion from");
      }
    }
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
      description: complete.proofs ? `${description}

Acceptance proofs: ${JSON.stringify(complete.proofs)}` : description,
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
  const feedbackRevision = board.hints.filter((h) => h.creator === "user" && h.messageId).length;
  if (board.policy && incoming.length && board.intents.filter((i) => i.feedbackRevision === feedbackRevision).length + incoming.length > board.policy.maxExplorations) {
    throw new Error("exploration budget exhausted for this feedback revision; review progress and stop or request explicit feedback, do not continue generating directions");
  }
  if (incoming.length === 0 && openIntents(board).length === 0) {
    throw new Error("intents required");
  }
  if (board.policy && openIntents(board).length + incoming.length > board.policy.maxOpenIntents) throw new Error("open intent budget exceeded; resolve existing work first");
  const createdAt = nowIso();
  const declared = [];
  for (const item of incoming) {
    const from = assertFrom(board, item.from);
    const description = item.description.trim();
    if (!description) throw new Error("empty description");
    const target = item.target?.trim();
    if (item.target !== void 0 && !target) throw new Error("empty target");
    const peers = [...openIntents(board), ...declared];
    if (board.protocolVersion === 2 && board.intents.some((i) => (i.feedbackRevision ?? -1) === feedbackRevision && (i.target === target && !!target || i.description.trim() === description) && i.from.length === from.length && i.from.every((id) => from.includes(id)))) throw new Error("direction already attempted with the same evidence; use new evidence or explicit feedback");
    if (peers.some((i) => i.description.trim() === description || target && i.target === target)) {
      throw new Error("overlapping open intent; conclude or close it first");
    }
    declared.push({
      ...target ? { target } : {},
      ...board.protocolVersion === 2 ? { feedbackRevision, skills: [...new Set(item.skills ?? [])] } : {},
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
    workerReturns: (board.workerReturns ?? []).map((r) => r.resolution ? r : { ...r, resolution: { action: "archived", at: nowIso() } }),
    intents: board.intents.map(
      (intent) => intent.to === null ? clearClaim(intent) : intent
    )
  };
}
function reopenBoard(board, description) {
  if (board.status === "active") return board;
  if (board.status === "stopped") return { ...board, status: "active" };
  if (!description?.trim()) throw new Error("completed board requires feedback description");
  const completions = board.intents.filter((i) => i.to === GOAL_ID && !i.invalidated);
  if (completions.length !== 1) throw new Error("expected one valid completion intent");
  const added = addHint(board, description, "user.feedback");
  return {
    ...added.board,
    status: "active",
    reason: null,
    intents: board.intents.map((i) => i.id === completions[0].id ? { ...i, invalidated: { at: nowIso(), hintId: added.hint.id } } : i)
  };
}
function closeIntent(board, intentId, reason) {
  requireActive(board);
  const intent = requireIntent(board, intentId);
  if (intent.to !== null || intent.closed) throw new Error("already concluded or closed");
  if (!reason.trim()) throw new Error("empty close reason");
  const closed = replaceIntent(board, intentId, { ...clearClaim(intent), closed: { reason: reason.trim(), at: nowIso() } });
  return resolveReturns({ ...closed, pendingIntentsEmpty: openIntents(closed).length === 0 || board.pendingIntentsEmpty }, intent, "close");
}
var transactions = /* @__PURE__ */ new Map();
async function withBoardLock(cwd, ownerId, run) {
  const key = boardPath(await realpath(cwd), ownerId);
  const prior = transactions.get(key) ?? Promise.resolve();
  const current = prior.catch(() => void 0).then(async () => {
    await mkdir2(dirname2(key), { recursive: true });
    const release = await lockfile.lock(key, { realpath: false, retries: { retries: 60, minTimeout: 25, maxTimeout: 250 } });
    try {
      return await run();
    } finally {
      await release();
    }
  });
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
  assertFrom(board, intent.from);
  if (board.policy && openIntents(board).filter((i) => i.dispatchId && !i.pendingReturn).length >= board.policy.maxConcurrent) throw new Error("concurrent worker budget exceeded; await returns");
  if (openIntents(board).some((i) => i.pendingReturn)) throw new Error("conclude, release or close returned workers before spawn");
  if (nextTask(board).kind === "reason" || board.reason) throw new Error("finish pending reason before spawn");
  return replaceIntent(board, intentId, { ...intent, dispatchId });
}
function bindDispatch(board, intentId, dispatchId, subagentId) {
  const intent = requireIntent(board, intentId);
  if (intent.dispatchId !== dispatchId || intent.closed || intent.to !== null || board.status !== "active") return board;
  return replaceIntent(board, intentId, { ...intent, subagentId });
}
function recordWorkerReturn(board, input) {
  const records = board.workerReturns ?? [];
  if (input.messageId && (board.hints.some((h) => h.messageId === input.messageId) || records.some((r) => r.messageId === input.messageId))) return board;
  const intent = board.intents.find((i) => input.dispatchId ? i.dispatchId === input.dispatchId && (!input.intentId || i.id === input.intentId) : !!input.subagentId && i.subagentId === input.subagentId);
  const active = board.status === "active" && intent && intent.to === null && !intent.closed;
  const record = {
    ...input,
    id: nextNumericId("r", records.map((r) => r.id)),
    createdAt: nowIso(),
    ...intent ? { intentId: intent.id, dispatchId: intent.dispatchId } : {},
    ...!active ? { resolution: { action: "archived", at: nowIso() } } : {}
  };
  return {
    ...board,
    workerReturns: [...records, record],
    intents: board.intents.map((i) => active && i.id === intent.id ? { ...i, pendingReturn: true } : i)
  };
}
function resolveReturns(board, intent, action) {
  return { ...board, workerReturns: (board.workerReturns ?? []).map((r) => r.intentId === intent.id && r.dispatchId === intent.dispatchId && !r.resolution ? { ...r, resolution: { action, at: nowIso() } } : r) };
}
function observeWorker(board, intent, observation) {
  const records = board.workerReturns ?? [];
  const related = records.filter((r) => r.intentId === intent.id && r.dispatchId === intent.dispatchId && !r.resolution);
  if (related.some((r) => r.kind === "return")) return board;
  if (!observation && !related.some((r) => r.kind === "observation")) return board;
  if (observation && related.some((r) => r.observation === observation)) return board;
  const updated = {
    ...board,
    workerReturns: records.map((r) => related.includes(r) && r.kind === "observation" ? { ...r, resolution: { action: "recovered", at: nowIso() } } : r),
    intents: board.intents.map((i) => i.id === intent.id ? { ...i, pendingReturn: false } : i)
  };
  return observation ? recordWorkerReturn(updated, {
    kind: "observation",
    content: observation,
    observation,
    intentId: intent.id,
    dispatchId: intent.dispatchId,
    subagentId: intent.subagentId
  }) : updated;
}

// src/model-view.ts
var PREVIEW_CHARS = 160;
var preview = (text) => text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}\u2026 [use lookup for full text]`;
function modelBoard(board) {
  const invalid = invalidFactIds(board);
  const intents = board.intents.filter((i) => i.to === null && !i.closed).slice(0, 6);
  const ids = /* @__PURE__ */ new Set(["origin", "goal", ...intents.flatMap((i) => i.from).slice(0, 12), ...board.facts.slice(-8).map((f) => f.id)]);
  return {
    title: preview(board.title),
    status: board.status,
    reason: board.reason,
    policy: board.policy,
    criteria: board.criteria?.map((c) => ({ ...c, description: preview(c.description) })),
    counts: { facts: board.facts.length, intents: board.intents.length, hints: board.hints.length, workerReturns: board.workerReturns?.length ?? 0 },
    facts: board.facts.filter((f) => ids.has(f.id)).slice(0, 22).map((f) => ({ ...f, description: preview(f.description), invalid: invalid.has(f.id) })),
    intents: intents.map((i) => ({ ...i, from: i.from.slice(0, 12), description: preview(i.description) })),
    hints: board.hints.slice(-3).map((h) => ({ ...h, content: preview(h.content) })),
    partial: true,
    history: "Use lookup with section, offset, limit to browse history; id and contentOffset read complete item text. Omitted evidence is not absent or invalid."
  };
}
function modelNext(next) {
  if (next.kind === "review") return {
    ...next,
    intents: next.intents.slice(0, 3).map((i) => ({ ...i, from: i.from.slice(0, 12), description: preview(i.description) })),
    records: next.records.slice(0, 3).map((r) => ({ ...r, content: preview(r.content) })),
    remaining: Math.max(0, next.intents.length - 3)
  };
  if (next.kind === "reason") return {
    ...next,
    factIds: next.factIds.slice(-12),
    openIntents: next.openIntents.slice(0, 6).map((i) => ({ ...i, from: i.from.slice(0, 12), description: preview(i.description) })),
    partial: true
  };
  if (next.kind === "explore") return { ...next, intent: { ...next.intent, from: next.intent.from.slice(0, 12), description: preview(next.intent.description) } };
  return next;
}
function lookupBoard(board, section, offset = 0, limit = 5, id, contentOffset = 0) {
  if (![offset, contentOffset].every((n) => Number.isSafeInteger(n) && n >= 0) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error("invalid pagination; limit must be 1..10");
  const values = section === "state" ? [{ id: "state", title: board.title, status: board.status, reason: board.reason, policy: board.policy, checkpoint: board.checkpoint }] : section === "criteria" ? board.criteria ?? [] : section === "facts" ? board.facts : section === "intents" ? board.intents : section === "hints" ? board.hints : section === "workerReturns" ? board.workerReturns ?? [] : void 0;
  if (!values) throw new Error("unknown lookup section");
  if (id) {
    const item = values.find((v) => v.id === id);
    if (!item) throw new Error("lookup item not found");
    const text = JSON.stringify(item);
    return { id, contentOffset, text: text.slice(contentOffset, contentOffset + 6e3), nextContentOffset: contentOffset + 6e3 < text.length ? contentOffset + 6e3 : null };
  }
  const items = values.slice(offset, offset + limit).map((item) => ({ id: item.id, preview: JSON.stringify(item).slice(0, PREVIEW_CHARS) }));
  return { section, total: values.length, offset, items, nextOffset: offset + items.length < values.length ? offset + items.length : null };
}
function budgetResult(value) {
  const size = () => JSON.stringify(value, null, 2).length;
  for (const key of ["fact", "intent", "hint"]) {
    if (!value[key]) continue;
    value[key] = { id: value[key].id, description: preview(value[key].description ?? value[key].content ?? "") };
  }
  if (value.page?.text) {
    while (size() > 7500 && value.page.text.length > 1) {
      value.page.text = value.page.text.slice(0, Math.floor(value.page.text.length / 2));
      value.page.nextContentOffset = value.page.contentOffset + value.page.text.length;
    }
  }
  if (size() <= 7500) return value;
  const board = value.board;
  return {
    ok: value.ok,
    op: value.op,
    board: board ? { status: board.status, counts: board.counts, reason: board.reason ? { id: board.reason.id, trigger: board.reason.trigger, partial: true } : null, partial: true } : void 0,
    next: value.next ? { kind: value.next.kind, intentId: value.next.intent?.id, trigger: value.next.trigger } : void 0,
    warnings: ["Result exceeded the view budget. Use lookup to inspect complete records and acceptance criteria before acting; section=state, id=state retrieves the full reasoning lease."]
  };
}

// src/audit.ts
function completionEvidenceIssues(board) {
  if (board.status !== "completed") return ["blackboard is not completed"];
  const completions = board.intents.filter((i) => i.to === "goal" && !i.closed && !i.invalidated);
  if (!completions.length) return ["completed blackboard has no current completion proof"];
  const invalid = invalidFactIds(board);
  const observed = new Set(board.facts.filter((f) => f.id !== "origin" && f.id !== "goal").map((f) => f.id));
  return completions.flatMap((i) => !i.from.length || i.from.some((id) => !observed.has(id) || invalid.has(id)) ? [`${i.id}: completion uses missing or invalid evidence; reopen and revalidate the goal`] : []);
}
function auditBoard(board) {
  const warnings = board.workerStatusWarning ? [board.workerStatusWarning] : [];
  if (board.status === "completed") warnings.push(...completionEvidenceIssues(board));
  const superseded = invalidFactIds(board);
  const active = board.facts.filter((f) => f.id !== "goal" && !superseded.has(f.id));
  for (const intent of board.intents.filter((i) => !i.closed && i.to === null)) {
    if (!intent.target && intent.description !== "bootstrap") warnings.push(`${intent.id}: missing single subgoal target; do not use a queue as an intent`);
    if (active.length > 2 && active.every((f) => intent.from.includes(f.id))) warnings.push(`${intent.id}: depends on every current fact; select only direct premises`);
    if (intent.from.some((id) => superseded.has(id))) warnings.push(`${intent.id}: uses superseded facts; close and redeclare from current evidence`);
    if (intent.pendingReturn) warnings.push(`${intent.id}: worker return or status observation needs review; inspect the actual outcome before concluding, releasing, or closing`);
  }
  if (board.status === "active" && board.facts.length > board.checkpoint.factCount) warnings.push("New facts await reason; checkpoint is the last reason-start snapshot, not a live count");
  return warnings;
}

// src/runtime.ts
var inFlight = /* @__PURE__ */ new Set();
var flightKey = (target, id) => `${target.cwd}/${target.ownerId}/${id}`;
var dispatchTools = /* @__PURE__ */ new Set(["subagent", "subagent_fork", "subagent_codex", "subagent_claude_code"]);
var coordinatorTools = /* @__PURE__ */ new Set([
  "blackboard",
  "skill",
  "read",
  "read_image",
  "ask_user_question",
  "archive_finding",
  "query_intel_lib",
  "get_goal",
  "create_goal",
  "update_goal",
  "list_agents",
  "interrupt_agent",
  "todo_write"
]);
function installRuntime(ctx, targetOf) {
  ctx.on("tools/execute", async (exec, next) => {
    const child = exec.agent?.session.header.origin === "subagent";
    if (exec.name === "workflow" || exec.name === "ralph") throw new Error("Cairn exploration must use claimed blackboard intents and subagent dispatch");
    if (child && exec.name === "skill" && exec.arguments.name === "state-space-search") {
      throw new Error("state-space-search is the coordinator skill; load cairn-explorer and the assigned execution skills");
    }
    if (!child && !coordinatorTools.has(exec.name) && !dispatchTools.has(exec.name)) {
      throw new Error("Cairn parent coordinates and reviews evidence; delegate execution through a claimed intent");
    }
    if (!child && (exec.name === "read" || exec.name === "read_image")) {
      const target2 = targetOf(exec);
      const board = await loadBoard(target2.cwd, target2.ownerId);
      if (!board?.workerReturns?.some((r) => r.kind === "return") && !board?.facts.some((f) => f.id !== "origin" && f.id !== "goal")) {
        throw new Error("Bootstrap only initializes and delegates; parent file reads are for reviewing returned evidence. Assign investigation to an explorer first.");
      }
    }
    if (exec.name === "update_goal" && exec.agent?.session.header.origin !== "subagent") {
      const target2 = targetOf(exec);
      const args2 = exec.arguments;
      const board = await loadBoard(target2.cwd, target2.ownerId);
      if (args2.action === "complete" && (!board || completionEvidenceIssues(board).length)) throw new Error("prove blackboard goal with current evidence before completing the session goal");
      const result = await next();
      if (!result.isError && args2.action === "resume") {
        await withBoardLock(target2.cwd, target2.ownerId, async () => {
          const current = await loadBoard(target2.cwd, target2.ownerId);
          if (current?.status === "stopped") await saveBoard(target2.cwd, target2.ownerId, reopenBoard(current));
        });
      }
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
    if (!dispatchTools.has(exec.name)) return next();
    const target = targetOf(exec);
    if (exec.agent?.session.header.origin === "subagent") throw new Error("only the blackboard parent may dispatch explorers");
    const args = exec.arguments;
    const intentId = /^blackboard_intent:\s*(i\d+)\s*\n/.exec(args.prompt ?? "")?.[1];
    if (!intentId) throw new Error("spawn prompt must begin with blackboard_intent: iNNN followed by a newline");
    await withBoardLock(target.cwd, target.ownerId, async () => {
      const board = await loadBoard(target.cwd, target.ownerId);
      if (!board) throw new Error("initialize and claim blackboard intent before spawn");
      await saveBoard(target.cwd, target.ownerId, reserveDispatch(board, intentId, exec.callId));
      inFlight.add(flightKey(target, exec.callId));
      const intent = board.intents.find((i) => i.id === intentId);
      exec.arguments = { ...args, prompt: `${args.prompt ?? ""}

Cairn execution contract: Load cairn-explorer first. Load each assigned skill before acting: ${JSON.stringify(intent.skills ?? [])}. You are an explorer, not the coordinator. Execute only this intent: ${intent.description}. Return one objective JSON finding with evidence paths. Do not initialize or write the blackboard or dispatch agents.
Direct premises: ${JSON.stringify(board.facts.filter((f) => intent.from.includes(f.id)))}` };
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
            if (board) await saveBoard(target.cwd, target.ownerId, recordWorkerReturn(board, {
              kind: "return",
              content: JSON.stringify(result.value ?? result.content),
              messageId: `foreground:${exec.callId}`,
              intentId,
              dispatchId: exec.callId
            }));
          });
        }
      }
      return result;
    } catch (error) {
      await failed();
      throw error;
    } finally {
      inFlight.delete(flightKey(target, exec.callId));
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
        if (source.kind === "user") {
          const added = addHint(board, text, "user");
          board = { ...added.board, hints: added.board.hints.map((h) => h.id === added.hint.id ? { ...h, messageId: message.id } : h) };
        } else {
          board = recordWorkerReturn(board, { kind: "return", content: text, messageId: message.id, subagentId: source.senderSessionId });
        }
        changed = true;
      }
      if (changed) await saveBoard(cwd, agent.session.id, board);
    });
    await reconcileWorkers(ctx, { cwd, ownerId: agent.session.id });
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
async function reconcileWorkers(ctx, target) {
  const snapshot = await loadBoard(target.cwd, target.ownerId);
  if (!snapshot || snapshot.status !== "active") return [];
  const candidates = snapshot.intents.filter((i) => i.dispatchId && i.to === null && !i.closed && !inFlight.has(flightKey(target, i.dispatchId)));
  if (!candidates.length) {
    if (snapshot.workerStatusWarning) await withBoardLock(target.cwd, target.ownerId, async () => {
      const board = await loadBoard(target.cwd, target.ownerId);
      if (board && !board.intents.some((i) => i.dispatchId && i.to === null && !i.closed)) {
        const { workerStatusWarning, ...rest } = board;
        await saveBoard(target.cwd, target.ownerId, rest);
      }
    });
    return [];
  }
  let rows;
  try {
    const runtime = ctx.get("subagents");
    if (!runtime) throw new Error("subagent runtime unavailable");
    rows = await runtime.listChildren(target.ownerId);
  } catch (error) {
    const warning = `Worker status query unavailable; claims retained: ${error instanceof Error ? error.message : String(error)}`;
    await withBoardLock(target.cwd, target.ownerId, async () => {
      const board = await loadBoard(target.cwd, target.ownerId);
      if (board?.status === "active" && board.workerStatusWarning !== warning) await saveBoard(target.cwd, target.ownerId, { ...board, workerStatusWarning: warning });
    });
    return [warning];
  }
  await withBoardLock(target.cwd, target.ownerId, async () => {
    let board = await loadBoard(target.cwd, target.ownerId);
    if (!board || board.status !== "active") return;
    const before = board;
    if (board.workerStatusWarning) {
      const { workerStatusWarning, ...rest } = board;
      board = rest;
    }
    for (const candidate of candidates) {
      const intent = board.intents.find((i) => i.id === candidate.id && i.dispatchId === candidate.dispatchId && i.to === null && !i.closed);
      if (!intent || inFlight.has(flightKey(target, intent.dispatchId))) continue;
      const row = rows.find((r) => r.id === intent.subagentId);
      const observation = !intent.subagentId ? "Dispatch has no bound child; verify the original spawn before retrying." : !row ? "Bound child is absent from the catalog; outcome is unknown." : row.kind === "diagnostic" ? `Child status diagnostic: ${row.reason}; outcome is unknown.` : row.activity === "inactive" ? "Child is inactive without a recorded return; inspect its result before deciding." : void 0;
      board = observeWorker(board, intent, observation);
    }
    if (board !== before) await saveBoard(target.cwd, target.ownerId, board);
  });
  return [];
}

// src/protocol.ts
import { randomUUID as randomUUID3 } from "node:crypto";
function searchPolicy(input = {}) {
  const policy = { maxOpenIntents: 6, maxConcurrent: 3, maxAttempts: 3, maxExplorations: 128, ...input };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (policy.maxConcurrent > policy.maxOpenIntents) throw new Error("maxConcurrent exceeds maxOpenIntents");
  return policy;
}
function upgradeBoard(board, policy) {
  if (board.protocolVersion === 2) return board;
  const at = (/* @__PURE__ */ new Date()).toISOString();
  return {
    ...board,
    protocolVersion: 2,
    policy,
    bootstrapEnabled: false,
    reason: board.reason ? { ...board.reason, id: board.reason.id ?? randomUUID3() } : null,
    criteria: board.criteria ?? [{ id: "c001", description: board.facts.find((f) => f.id === "goal")?.description ?? board.title }],
    pendingIntentsEmpty: board.status === "active" || board.pendingIntentsEmpty,
    intents: board.intents.map((i) => i.to === null && !i.closed && i.creator === "dispatcher.bootstrap" ? { ...i, worker: null, closed: { reason: "Bootstrap migrated to delegated exploration; no result inferred.", at } } : i)
  };
}

// src/index.ts
var name = "dsh-cairn-search";
var inject = ["tools"];
var OPS = [
  "init",
  "snapshot",
  "lookup",
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
var DESCRIPTION = "Read and update the origin\u2192goal fact-intent blackboard at .dsh/blackboards/<main-session-id>.json. This tool is the only writer of that file. Subagent sessions share the main session's board; a forked conversation gets its own copy of the source snapshot. Call op=init once per main session (title, origin, goal, optional hints), then op=next to learn the next task (review, reason, explore, or idle). Initialization decomposes; the parent never performs bootstrap exploration. Snapshots are bounded views; use lookup for omitted history and full item text. Claim an intent (op=claim) before exploring it; conclude with exactly one new fact (op=conclude) or release it (op=release). Reason with op=reason_start then op=reason_finish (exactly one of complete, intents, or {}). Human judgment is op=hint. op=stop freezes writes except hints; op=reopen resumes. Use op=close with intentId and description to abandon or replace work without a fact. Use one target per intent and minimal direct from dependencies. Spawn prompts must begin with blackboard_intent: iNNN after claim. Record one distilled conclusion, including negative findings; use supersedes for corrections. Review pending worker returns before other work; inspect unknown outcomes, then conclude, release or close. Returns are not hints or facts. Completed boards require feedback description to reopen; old completion stays as invalidated history. Every mutation returns next; execute it before starting more exploration. Complete requires observed facts and no open intents. Do not hand-edit the board file. Policy refusals are not facts.";
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
    skills: { type: "array", items: { type: "string" }, description: "Exact execution skill names the explorer must load before acting." },
    target: { type: "string", required: true, description: "One stable subgoal key. Open intents with the same target are rejected." },
    description: {
      type: "string",
      required: true,
      description: "Independent parallelizable direction."
    }
  }
};
var HOST_UI_ENTRY_ID = "cairn-search-ui";
function apply(ctx, config = {}) {
  const policy = searchPolicy(config);
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
      section: { type: "string", enum: ["facts", "intents", "hints", "workerReturns", "criteria", "state"], description: "History collection for lookup; state contains current metadata and the complete reasoning lease." },
      offset: { type: "number", description: "Lookup item offset, default 0." },
      limit: { type: "number", description: "Lookup page size 1..10, default 5." },
      id: { type: "string", description: "Lookup one complete item, in text chunks." },
      contentOffset: { type: "number", description: "Offset within a lookup item text, default 0." },
      title: { type: "string", description: "Board title (op=init)." },
      origin: { type: "string", description: "Known starting state (op=init)." },
      goal: { type: "string", description: "Desired end state (op=init)." },
      criteria: { type: "array", items: { type: "string" }, description: "Explicit acceptance criteria for init; defaults to the goal." },
      hints: {
        type: "array",
        items: { type: "string" },
        description: "Optional starting hints (op=init)."
      },
      intentId: { type: "string", description: "Intent id (op=claim, conclude, release, close)." },
      worker: { type: "string", description: "Worker label (op=claim, conclude, reason_start, reason_finish)." },
      reasonId: { type: "string", description: "Required for reason_finish: current board.reason.id from reason_start or snapshot." },
      description: { type: "string", description: "Fact text (conclude), closure reason (close), or required feedback when reopening a completed board (reopen)." },
      supersedes: { type: "array", items: { type: "string" }, description: "Prior fact IDs replaced by this conclusion; preserve their history." },
      content: { type: "string", description: "Hint text (op=hint)." },
      creator: { type: "string", description: "Hint author; defaults to user (op=hint)." },
      complete: {
        type: "object",
        additionalProperties: false,
        description: "Goal proof (op=reason_finish). Mutually exclusive with intents.",
        properties: {
          proofs: { type: "array", items: { type: "object", additionalProperties: false, properties: { criterionId: { type: "string", required: true }, from: { type: "array", items: { type: "string" }, required: true }, description: { type: "string", required: true } } }, description: "Exactly one observed-evidence proof for every acceptance criterion." },
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
          page: { type: "json", description: "Paginated history or item text." },
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
      if ((args.op === "snapshot" || args.op === "next") && exec.agent?.session.header.origin !== "subagent") {
        await reconcileWorkers(ctx, target);
      }
      const result = await withBoardLock(cwd, ownerId, async () => {
        if (exec.agent?.session.header.origin === "subagent") {
          throw new Error("only the parent session may write the blackboard");
        }
        switch (args.op) {
          case "init": {
            const existing = await loadBoard(cwd, ownerId);
            if (existing) throw new Error("board already exists; use snapshot or reopen");
            const board = upgradeBoard(emptyBoard(
              required(args.title, "title"),
              required(args.origin, "origin"),
              required(args.goal, "goal"),
              args.hints
            ), policy);
            if (args.criteria) {
              if (!args.criteria.length || args.criteria.length > 20 || args.criteria.some((c) => !c.trim())) throw new Error("criteria must contain 1..20 nonempty acceptance conditions");
              board.criteria = args.criteria.map((description, n) => ({ id: `c${String(n + 1).padStart(3, "0")}`, description: description.trim() }));
            }
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) };
          }
          case "lookup": {
            let board = await requireBoard(target, policy);
            if (args.section === "workerReturns" && args.id) {
              const record = board.workerReturns?.find((r) => r.id === args.id);
              if (record?.contentRef) board = { ...board, workerReturns: [{ ...record, content: await readReturnContent(cwd, record) }] };
            }
            return { ok: true, op: args.op, page: lookupBoard(board, args.section ?? "facts", args.offset, args.limit, args.id, args.contentOffset) };
          }
          case "snapshot": {
            const board = await requireBoard(target, policy);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) };
          }
          case "next": {
            const board = await requireBoard(target, policy);
            return { ok: true, op: args.op, next: nextTask(board), warnings: auditBoard(board) };
          }
          case "claim": {
            const intentId = required(args.intentId, "intentId");
            const board = claimIntent(await requireBoard(target, policy), intentId, required(args.worker, "worker"));
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), intent: intentOf(board, intentId) };
          }
          case "conclude": {
            const intentId = required(args.intentId, "intentId");
            const { board, fact } = concludeIntent(
              await requireBoard(target, policy),
              intentId,
              required(args.description, "description"),
              required(args.worker, "worker"),
              args.supersedes
            );
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), fact, intent: intentOf(board, intentId) };
          }
          case "reason_start": {
            const { board, trigger } = startReason(await requireBoard(target, policy), required(args.worker, "worker"));
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), trigger };
          }
          case "reason_finish": {
            const board = finishReason(await requireBoard(target, policy), required(args.worker, "worker"), {
              ...args.complete !== void 0 ? { complete: args.complete } : {},
              ...args.intents !== void 0 ? { intents: args.intents } : {}
            }, args.reasonId);
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) };
          }
          case "hint": {
            const { board, hint } = addHint(
              await requireBoard(target, policy),
              required(args.content, "content"),
              args.creator?.trim() || "user"
            );
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), hint };
          }
          case "close": {
            const intentId = required(args.intentId, "intentId");
            const current = await requireBoard(target, policy);
            const board = closeIntent(current, intentId, required(args.description, "description"));
            interruptWorkers(ctx, exec.agent, current, intentId);
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) };
          }
          case "release": {
            const intentId = required(args.intentId, "intentId");
            const current = await requireBoard(target, policy);
            const board = releaseIntent(current, intentId);
            interruptWorkers(ctx, exec.agent, current, intentId);
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board), intent: intentOf(board, intentId) };
          }
          case "stop": {
            const current = await requireBoard(target, policy);
            interruptWorkers(ctx, exec.agent, current);
            const board = stopBoard(current);
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) };
          }
          case "reopen": {
            const board = reopenBoard(await requireBoard(target, policy), args.description);
            await saveBoard(cwd, ownerId, board);
            return { ok: true, op: args.op, board, warnings: auditBoard(board), next: nextTask(board) };
          }
          default: {
            const unsupported = args.op;
            throw new Error(`unsupported op: ${String(unsupported)}`);
          }
        }
      });
      return JSON.parse(JSON.stringify(budgetResult({
        ...result,
        ..."board" in result && result.board ? { board: modelBoard(result.board) } : {},
        ..."next" in result && result.next ? { next: modelNext(result.next) } : {},
        ..."warnings" in result ? { warnings: result.warnings?.slice(0, 12) } : {}
      })));
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
async function requireBoard(target, policy) {
  await seedBoard(target.cwd, target.ownerId, target.sourceOwnerId);
  const board = await loadBoard(target.cwd, target.ownerId);
  if (board === null) throw new Error("no blackboard; call op=init");
  const upgraded = upgradeBoard(board, policy);
  if (upgraded !== board) await saveBoard(target.cwd, target.ownerId, upgraded);
  return upgraded;
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
