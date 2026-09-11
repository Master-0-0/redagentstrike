# dsh-cairn-search

Out-of-tree DeepSeek Harness plugin. Implements a **fact-intent blackboard** for the user preset `cairn` (Cairn 搜索). Architecture from oritera/Cairn; **do not copy** that repo's code, prompts, or pentest content.

## Layout

- `src/types.ts` — frozen vocabulary. Do not rename fields without updating every caller.
- `src/owner.ts` — main-session board ownership (subagents share, forks copy). No cordis.
- `src/board.ts` — load/save + mutations + `nextTask`. No cordis.
- `src/view.ts` — parse a board snapshot and place the origin→goal graph. Read-only.
- `src/index.ts` — Cordis function plugin: `name` / `inject` / `apply`. Registers one tool `blackboard`. Host-plane insert `cairn-search-ui` skips the tool so it stays preset-scoped.
- `src/client/` — Web sidebar-foot blackboard entry (`order: -10`, above 子代理). Follows the selected session's owner board (subagents share, forks are independent) through `workspaceFiles.read`.
- `cordis.patch.yml` — host insert that serves the `./client` bundle. Install this package as a profile bundle (`dsh plugin add`) so the web roster picks it up.
- `scripts/link-peers.mjs` — after install, symlink `@deepseek-ai/dsh-tools` and `cordis` to `~/.dsh/profiles/node_modules` so the running host and this plugin share one registry instance.
- `tests/` — node:test against `board.ts`, `owner.ts`, `view.ts`, and the client read helper.
- `preset/` — files copied into `~/.dsh/.agent-presets/cairn/`.

## Persistence

Workspace file `<cwd>/.dsh/blackboards/<main-session-id>.json` (`boardRelativePath`). JSON, pretty-printed, atomic write (temp + rename). Create `.dsh/blackboards/` as needed.

Ownership:

| Scene | Board file |
| --- | --- |
| New main session | create `.dsh/blackboards/<that session id>.json` on `op=init` |
| Restore an existing session | keep reading the same file |
| Main session spawns subagents | children share the main session file |
| Sidebar switches session | show that session's owner board |
| Fork a session | new file; copy the source snapshot when present |

A leftover `<cwd>/.dsh/blackboard.json` is adopted once into a missing per-session file.

Resolve cwd from `exec.agent.session.header.cwd`. Owner id walks `origin === 'subagent'` parent links. Reject if cwd is missing.

## Invariants (engine must enforce)

- Facts append-only; never edit/delete. Ids: `origin`, `goal`, then `f001`…
- Intent ids `i001`…. `from` is a non-empty hyperedge. **`goal` must not appear in `from`.**
- Complete = concluded intent with `to === "goal"` whose `from` lists proving facts.
- Claim before explore: set `worker` then return the intent. Never start then claim.
- Reason **declares** intents with `worker: null`. Truncate to `MAX_INTENTS`.
- Reason may run while explores are in flight. Trigger vs checkpoint taken at **reason start**: factCount↑, hintCount↑, or openIntents `>0 → 0`. Declaring intents does not retrigger.
- Explore picks the **newest** unclaimed non-bootstrap open intent (`createdAt`).
- Explore failure / release: `worker=null`, `to` still null. That is **not** a reason trigger.
- Bootstrap reserved intent: `from=["origin"]`, `description="bootstrap"`, `creator="dispatcher.bootstrap"`.
- Bootstrap execute success: one fact + complete. Bootstrap conclude: fact only.
- `stopped`: reject writes except hints. No conclude fallback.
- Negative findings are valid facts. Policy refusals are not facts.

## Tool `blackboard`

Single model-facing tool. `op` discriminator:

| op | args | result |
|---|---|---|
| `init` | title, origin, goal, hints? | snapshot + next |
| `snapshot` | | board |
| `next` | | NextTask |
| `claim` | intentId, worker | intent |
| `conclude` | intentId, description, worker | fact + intent |
| `reason_start` | worker | trigger + snapshot |
| `reason_finish` | worker, complete? \| intents? \| {} | snapshot + next |
| `hint` | content, creator? | hint |
| `release` | intentId | intent |
| `stop` | | board |
| `reopen` | | board |

`complete` on reason_finish: `{ from: string[], description: string }`.
`intents` on reason_finish: `{ from: string[], description: string }[]`.

Resolve cwd from `exec.agent.session.header.cwd`. Owner id is the subagent lineage root (a conversation fork is its own root). Reject if cwd is missing.

## Authorization

Refuse to encode attack procedures. This is a general origin→goal search board.
