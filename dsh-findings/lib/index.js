// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/archive.ts
import { realpath as realpath3 } from "node:fs/promises";

// src/artifacts.ts
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, mkdir, lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
var ArchiveError = class extends Error {
  code;
  retryable;
  constructor(code, message = code, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
};
var MAX_FILE = 20 * 1024 * 1024;
var MAX_TOTAL = 100 * 1024 * 1024;
function relativeFile(root, input) {
  if (input.split(/[\\/]/).includes("..")) throw new ArchiveError("path_not_allowed");
  const rel = relative(root, resolve(root, input));
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith("/"))
    throw new ArchiveError("path_not_allowed");
  return rel;
}
function reader(root, input, limit, signal) {
  signal?.throwIfAborted();
  const child = spawn(
    "python3",
    [
      fileURLToPath(new URL("./safe-read.py", import.meta.url)),
      root,
      relativeFile(root, input),
      String(limit)
    ],
    { stdio: ["ignore", "pipe", "pipe"], signal }
  );
  let reason = "";
  child.stderr.on("data", (data) => {
    reason += data.toString().slice(0, 256);
  });
  const completion = new Promise((resolveDone, reject) => {
    child.on("error", reject);
    child.on(
      "close",
      (code) => code === 0 ? resolveDone() : reject(new ArchiveError(reason || "file_not_found"))
    );
  });
  completion.catch(() => {
  });
  return { child, completion };
}
async function readSafe(root, input, limit, signal) {
  const { child, completion } = reader(root, input, limit, signal);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > limit) throw new ArchiveError("payload_too_large");
      chunks.push(chunk);
    }
    await completion;
    return Buffer.concat(chunks);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}
async function copySafe(root, input, destination, signal) {
  const { child, completion } = reader(root, input, MAX_FILE, signal);
  const hash = createHash("sha256");
  let size = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > MAX_FILE) return done(new ArchiveError("payload_too_large"));
      hash.update(chunk);
      done(null, chunk);
    }
  });
  try {
    await pipeline(
      child.stdout,
      counter,
      createWriteStream(destination, { flags: "wx", mode: 384 }),
      { signal }
    );
    await completion;
    const file = await open(destination, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    if (child.exitCode === null) child.kill();
  }
}
async function privateDirectory(root, path) {
  const rel = relativeFile(root, path);
  let current = root;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    try {
      await mkdir(current, { mode: 448 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const st = await lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink() || await realpath(current) !== current)
      throw new ArchiveError("path_not_allowed");
  }
}
function mediaType(filename) {
  if (/\.png$/i.test(filename)) return "image/png";
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  if (/\.json$/i.test(filename)) return "application/json";
  if (/\.(py|js|ts|sh|txt|log|http|md|html|yaml|yml|xml|csv)$/i.test(filename)) return "text/plain";
  return "application/octet-stream";
}

// src/context.ts
import { realpath as realpath2, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
function encodeOwner(id) {
  if (!id.trim() || [".", ".."].includes(id.trim())) throw new ArchiveError("context_missing");
  return [...id.trim()].map(
    (c) => /^[A-Za-z0-9._-]$/.test(c) ? c : `~${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`
  ).join("");
}
async function sourceContext(ctx, exec, factIds, signal) {
  const session = exec.agent?.session;
  if (!session?.id || !session.header?.cwd)
    throw new ArchiveError("context_missing", "\u5F52\u6863\u9700\u8981\u6267\u884C\u4F1A\u8BDD\u4E0E\u5DE5\u4F5C\u533A");
  const root = await realpath2(session.header.cwd);
  let sessions;
  try {
    sessions = ctx.get?.("sessions", false);
  } catch {
  }
  let current = session;
  let resolved = true;
  const seen = /* @__PURE__ */ new Set();
  while (current.header?.origin === "subagent") {
    if (seen.has(current.id) || !current.header.parentSession) {
      resolved = false;
      break;
    }
    seen.add(current.id);
    const parent = sessions?.get(current.header.parentSession);
    if (!parent) {
      resolved = false;
      break;
    }
    current = parent;
  }
  const source = {
    source_type: "cairn",
    workspace_path: root,
    workspace_id: null,
    session_id: session.id,
    owner_session_id: resolved ? current.id : null,
    owner_resolution: resolved ? "resolved" : "unresolved",
    fact_snapshots: []
  };
  if (factIds.length) {
    if (!resolved) throw new ArchiveError("context_missing", "\u7236\u94FE\u7F3A\u5931\uFF0C\u65E0\u6CD5\u53EF\u9760\u8BFB\u53D6\u5F15\u7528\u4E8B\u5B9E");
    const board = JSON.parse(
      (await readSafe(
        root,
        `.dsh/blackboards/${encodeOwner(current.id)}.json`,
        1024 * 1024,
        signal
      )).toString()
    );
    source.fact_snapshots = [...new Set(factIds)].map((id) => {
      const fact = board.facts?.find((f) => f.id === id);
      if (!fact || typeof fact.description !== "string")
        throw new ArchiveError("invalid_manifest", `\u4E8B\u5B9E\u4E0D\u5B58\u5728\uFF1A${id}`);
      return { id, description: fact.description };
    });
  }
  try {
    const registry = JSON.parse(
      await readFile(
        join(process.env.DSH_HOME || homedir() + "/.dsh", "storages/workspace.json"),
        "utf8"
      )
    );
    for (const [id, row] of Object.entries(registry.tables?.workspaces || {})) {
      if (typeof row.path === "string" && await realpath2(row.path).catch(() => "") === root) {
        source.workspace_id = id;
        break;
      }
    }
  } catch {
  }
  return source;
}

// src/outbox.ts
import { createHash as createHash2, randomUUID } from "node:crypto";
import { open as open2, rename, rm } from "node:fs/promises";
import { basename, join as join2 } from "node:path";
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).filter((k) => value[k] !== void 0).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function atomicJSON(path, data) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = await open2(tmp, "wx", 384);
  try {
    await fd.writeFile(JSON.stringify(data, null, 2));
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(tmp, path);
}
function boxPath(root, key) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new ArchiveError("invalid_manifest", "\u65E0\u6548 submission_key");
  return join2(root, ".dsh/findings-outbox", key);
}
async function loadOutbox(root, key, signal) {
  const path = boxPath(root, key);
  const manifest = JSON.parse(
    (await readSafe(root, join2(path, "manifest.json"), 1024 * 1024, signal)).toString()
  );
  const { submission_key, content_digest, ...content } = manifest;
  if (submission_key !== key || content_digest !== key || createHash2("sha256").update(canonical(content)).digest("hex") !== key)
    throw new ArchiveError("hash_mismatch", "\u5F85\u63D0\u4EA4\u6E05\u5355\u5B8C\u6574\u6027\u5F02\u5E38");
  return { path, manifest };
}
async function prepareOutbox(args, source, signal) {
  if (!["create", "append"].includes(args.op))
    throw new ArchiveError("invalid_manifest", "op \u5FC5\u987B\u4E3A create/append/retry");
  const root = source.workspace_path;
  const pending = join2(root, ".dsh/findings-outbox", `preparing-${randomUUID()}`);
  await privateDirectory(root, join2(pending, "artifacts"));
  try {
    const artifacts = [];
    let total = 0;
    if (!Array.isArray(args.artifacts ?? []) || (args.artifacts?.length ?? 0) > 20 || (args.network_refs?.length ?? 0) > 20)
      throw new ArchiveError("payload_too_large");
    const ids = /* @__PURE__ */ new Set();
    for (const a of args.artifacts ?? []) {
      signal.throwIfAborted();
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(a.client_id) || ids.has(a.client_id) || typeof a.path !== "string")
        throw new ArchiveError("invalid_manifest", "\u9644\u4EF6 ID/\u8DEF\u5F84\u65E0\u6548\u6216\u91CD\u590D");
      ids.add(a.client_id);
      const copied = await copySafe(root, a.path, join2(pending, "artifacts", a.client_id), signal);
      total += copied.size;
      if (total > MAX_TOTAL) throw new ArchiveError("payload_too_large");
      artifacts.push({
        client_id: a.client_id,
        kind: a.kind,
        filename: basename(a.path),
        media_type: mediaType(a.path),
        ...copied,
        description: a.description ?? "",
        step_ids: a.step_ids ?? [],
        capture_method: a.capture_method ?? "tool_file",
        captured_at: a.captured_at ?? null,
        page_url: a.page_url ?? null,
        execution_note: a.execution_note ?? ""
      });
    }
    const content = JSON.parse(
      JSON.stringify({
        op: args.op,
        ...args.op === "create" ? { finding: args.finding } : { finding_id: args.finding_id, note: args.note ?? "" },
        source,
        artifacts,
        network_refs: args.network_refs ?? [],
        evidence_gaps: args.evidence_gaps ?? [],
        resolved_gap_ids: args.resolved_gap_ids ?? [],
        occurrence_id: args.occurrence_id ?? null
      })
    );
    const key = createHash2("sha256").update(canonical(content)).digest("hex");
    const manifest = { ...content, submission_key: key, content_digest: key };
    if (Buffer.byteLength(JSON.stringify(manifest)) > 1024 * 1024)
      throw new ArchiveError("payload_too_large");
    await atomicJSON(join2(pending, "manifest.json"), manifest);
    const path = boxPath(root, key);
    try {
      await rename(pending, path);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      return await loadOutbox(root, key, signal);
    }
    const directory = await open2(join2(root, ".dsh/findings-outbox"), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { path, manifest };
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}

// src/client.ts
import { Readable } from "node:stream";
import { join as join3 } from "node:path";
function endpoint(input) {
  const url = new URL(input);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new ArchiveError("invalid_manifest", "\u5F52\u6863\u670D\u52A1\u4EC5\u5141\u8BB8\u672C\u673A HTTP API \u6839\u5730\u5740");
  return url.origin;
}
async function transmit(root, box, apiUrl, signal) {
  const base = endpoint(apiUrl);
  async function request(path, options = {}) {
    const response = await fetch(base + path, { ...options, signal, redirect: "error" });
    const value = await response.json();
    if (!response.ok)
      throw new ArchiveError(
        value.error_code || "service_unavailable",
        value.message || `HTTP ${response.status}`,
        value.retryable ?? response.status >= 500
      );
    return value;
  }
  const s = await request("/finding-submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(box.manifest)
  });
  let receipt = s.receipt;
  if (!receipt) {
    for (const a of box.manifest.artifacts) {
      if (s.received.includes(a.client_id)) continue;
      const { child, completion } = reader(
        root,
        join3(box.path, "artifacts", a.client_id),
        a.size,
        signal
      );
      try {
        await request(`/finding-submissions/${s.id}/artifacts/${a.client_id}`, {
          method: "PUT",
          headers: { "content-type": a.media_type },
          body: Readable.toWeb(child.stdout),
          duplex: "half"
        });
        await completion;
      } finally {
        if (child.exitCode === null) child.kill();
      }
    }
    receipt = await request(`/finding-submissions/${s.id}/commit`, { method: "POST" });
  }
  if (!receipt?.ok) throw new ArchiveError("service_unavailable", "\u670D\u52A1\u672A\u8FD4\u56DE committed \u56DE\u6267", true);
  try {
    await atomicJSON(join3(box.path, "result.json"), receipt);
  } catch {
    receipt.warnings = [
      ...receipt.warnings ?? [],
      "\u5F52\u6863\u5DF2\u6210\u529F\uFF0C\u4F46\u672C\u5730\u56DE\u6267\u5199\u5165\u5931\u8D25\uFF1B\u53EF\u4F7F\u7528\u540C\u4E00 key \u91CD\u8BD5\u67E5\u8BE2"
    ];
  }
  return receipt;
}

// src/archive.ts
async function archiveFinding(args, ctx, exec, config = {}) {
  const deadline = AbortSignal.timeout(Math.min(config.timeoutMs ?? 3e4, 3e4));
  const signal = exec.signal ? AbortSignal.any([deadline, exec.signal]) : deadline;
  let key;
  try {
    const session = exec.agent?.session;
    if (!session?.id || !session.header?.cwd) throw new ArchiveError("context_missing");
    const root = await realpath3(session.header.cwd);
    const box = args.op === "retry" ? await loadOutbox(root, args.submission_key, signal) : await prepareOutbox(
      args,
      await sourceContext(ctx, exec, args.fact_ids ?? [], signal),
      signal
    );
    key = box.manifest.submission_key;
    return await transmit(root, box, config.apiUrl ?? "http://127.0.0.1:8787", signal);
  } catch (error) {
    const timeout = signal.aborted;
    const known = error instanceof ArchiveError;
    const code = timeout ? "timeout" : known ? error.code : error.code === "ENOSPC" ? "disk_full" : error.code === "ENOENT" ? "file_not_found" : "service_unavailable";
    return {
      ok: false,
      error_code: code,
      message: timeout ? "\u5F52\u6863\u8D85\u65F6\uFF0C\u5DF2\u505C\u6B62\u672C\u6B21\u4E0A\u4F20" : known ? error.message : "\u5F52\u6863\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u670D\u52A1\u548C\u672C\u5730\u5B58\u50A8",
      retryable: timeout || (known ? error.retryable : true),
      ...key ? { submission_key: key } : {},
      warnings: key ? ["\u91CD\u8BD5\u4F7F\u7528 outbox \u526F\u672C\uFF1B\u5C1A\u672A\u7531\u670D\u52A1\u7AEF\u5FEB\u7167\u5316\u7684\u7F51\u7EDC\u5F15\u7528\u4ECD\u4F9D\u8D56\u539F\u4E8B\u4EF6\u5B58\u6D3B"] : []
    };
  }
}

// src/guidance.ts
var ARCHIVE_GUIDANCE = `Default findings archiving for authorized testing:
At the start of each authorized testing task, load the finding-archive skill. Archiving existing evidence is a default part of the task; do not ask the user to manually re-enter finding information or wait for a separate archive request.
When existing evidence supports a meaningful vulnerability candidate, use archive_finding to create a pending-review finding with the real target, summary, prerequisites, steps, expected/actual results, and existing evidence files or explicit network event/Run IDs. State uncertainty and missing evidence honestly. A template match, a blackboard fact, or a completed board does not independently confirm a vulnerability. Ordinary progress facts and unsuccessful checks are not automatically finding candidates.
Keep the returned finding_id. Append new materials for the same known finding instead of creating duplicate cards. For a subagent's successfully archived finding, include finding_id and submission_key inside the description of the original single JSON fact returned to the parent; never add return fields or change the explorer return protocol; the parent must reuse that finding_id. If the subagent cannot archive, return the real evidence paths and source details for the parent to archive under its own execution identity. Never guess ownership or merge unrelated sessions by similarity alone.
All automatic creations stay pending human review. Never change human review/remediation statuses. Respect an explicit user request to disable automatic archiving for the task.
On failure, retain the outbox submission_key and report the failure. Retry a transient failure once with op=retry and the same key at a suitable point; do not reread modified source files, retry indefinitely, or block ongoing search. In the task summary report saved finding IDs and any unresolved archive failures.
Continue all original blackboard rules. Archiving is never a Cairn completion condition. It does not run extra PoCs, replay traffic, or collect new evidence on its own.`;

// src/index.ts
var name = "dsh-findings";
var inject = ["tools", "systemPrompt"];
function apply(ctx, config = {}) {
  ctx.get("systemPrompt").section({ name: "findings-archive-default", order: 850, text: ARCHIVE_GUIDANCE });
  ctx.tools.register(
    defineTool({
      name: "archive_finding",
      description: "Archive existing evidence copies without running tests or changing the blackboard. Load finding-archive for the contract. create requires structured finding and explicit evidence gaps; append preserves human review; retry sends the saved outbox. Evidence files must be inside the session workspace. A reproduced assessment still starts pending human review.",
      parameters: {
        op: { type: "string", required: true, enum: ["create", "append", "retry"] },
        finding: {
          type: "json",
          description: "title,target,summary,severity,preconditions,steps:[{id,description,artifact_client_ids?}],expected_result,actual_result,agent_assessment (suspected/reproduced)."
        },
        finding_id: { type: "string" },
        note: { type: "string" },
        fact_ids: { type: "array", items: { type: "string" } },
        artifacts: {
          type: "json",
          description: "Array of {client_id,kind,path,description?,step_ids?,capture_method?,captured_at?,execution_note?}."
        },
        network_refs: {
          type: "json",
          description: "Array of exact {event_id,run_id,step_ids?}. Never guess event/session ownership."
        },
        evidence_gaps: {
          type: "json",
          description: "Array of {category:poc|http|screenshot|tool_output|description,status:missing|not_applicable,reason}."
        },
        resolved_gap_ids: { type: "array", items: { type: "string" } },
        occurrence_id: { type: "string" },
        submission_key: { type: "string" }
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value, null, 2) }
        ]
      },
      execute: (args, exec) => archiveFinding(args, ctx, exec, config)
    })
  );
}
export {
  apply,
  inject,
  name
};
