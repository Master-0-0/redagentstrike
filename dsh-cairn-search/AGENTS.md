# dsh-cairn-search

Out-of-tree DeepSeek Harness plugin. Implements a **fact-intent blackboard** for the user preset `cairn` (Cairn 搜索). Architecture from oritera/Cairn; **do not copy** that repo's code, prompts, or pentest content.

## Layout

- `src/types.ts` — frozen vocabulary. Do not rename fields without updating every caller.
- `src/board.ts` — load/save + mutations + `nextTask`. No cordis.
- `src/index.ts` — Cordis function plugin: `name` / `inject` / `apply`. Registers one tool `blackboard`.
- `scripts/link-peers.mjs` — after install, symlink `@deepseek-ai/dsh-tools` and `cordis` to `~/.dsh/profiles/node_modules` so the running host and this plugin share one registry instance.
- `tests/` — node:test against `board.ts` only.
- `preset/` — files copied into `~/.dsh/.agent-presets/cairn/`.

## Persistence

Workspace file `<cwd>/.dsh/blackboard.json` (`BOARD_RELATIVE_PATH`). JSON, pretty-printed, atomic write (temp + rename). Create `.dsh/` as needed.

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

Resolve cwd from `exec.agent.session.header.cwd`. Reject if missing.

## Authorization

Refuse to encode attack procedures. This is a general origin→goal search board.
