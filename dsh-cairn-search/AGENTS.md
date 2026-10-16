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

Workspace file `<cwd>/.dsh/blackboards/<main-session-id>.json` (`boardRelativePath`). Small boards use pretty-printed JSON; at 512 total records this becomes an atomic `cairn-segments-v1` manifest referencing immutable 256-record blocks in `.dsh/blackboard-segments/`. Readers must hydrate the manifest before interpreting the board. Transactions use a heartbeat filesystem lock across host processes. Large worker returns use immutable content-addressed workspace files; retain blocks and returns across forks. Publish referenced content before the manifest. Do not delete historical blocks without tracing all fork references.

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
- Protocol v2 explores oldest eligible work, resumes a claim without dispatch, and enforces persisted open/concurrent/retry limits. Legacy pure-domain fixtures retain their old ordering.
- Explore failure / release: `worker=null`, `to` still null. That is **not** a reason trigger.
- Protocol v2 initializes directly into reason. Migrate an unfinished legacy bootstrap intent by closing it without inventing a fact. Preserve finished bootstrap history.
- Protocol v2 conclude requires an actual unresolved dispatched worker return. Status observations do not qualify.
- `stopped`: reject graph writes; hints and archived worker returns remain writable. No conclude fallback.
- Worker returns are separate from hints. `next=review` takes priority; only the parent concludes facts.
- Completed boards reopen only with explicit feedback; retain old completion as invalidated history.
- Negative findings are valid facts. Policy refusals are not facts.

## Tool `blackboard`

Single model-facing tool. `op` discriminator:

| op | args | result |
|---|---|---|
| `init` | title, origin, goal, hints?, criteria? | bounded snapshot + next |
| `snapshot` | | board |
| `next` | | NextTask |
| `claim` | intentId, worker | intent |
| `conclude` | intentId, description, worker | fact + intent |
| `reason_start` | worker | trigger + snapshot |
| `reason_finish` | worker, reasonId, complete? \| intents? \| {} | bounded snapshot + next |
| `lookup` | section, offset?, limit?, id?, contentOffset? | paginated history or complete item text chunks |
| `hint` | content, creator? | hint |
| `release` | intentId | intent |
| `stop` | | board |
| `reopen` | description required when completed | board + next |

`complete` on reason_finish: `{ from: string[], description: string, proofs: { criterionId: string, from: string[], description: string }[] }`. Supply exactly one proof per acceptance criterion using current observed facts.
`intents` on reason_finish: `{ from: string[], description: string, target?: string, skills?: string[] }[]`. Carry the current persisted `reasonId`; stale reasoning submissions are rejected.

Resolve cwd from `exec.agent.session.header.cwd`. Owner id is the subagent lineage root (a conversation fork is its own root). Reject if cwd is missing.

## Authorization

Refuse to encode attack procedures. This is a general origin→goal search board.
