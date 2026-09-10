---
name: state-space-search
description: Use when this session is the Cairn 搜索 preset, or when a problem has a clear origin, a clear goal, and an unknown path — maintain the fact-intent blackboard, bootstrap then reason then explore, and coordinate workers only through the board.
whenToUse: Goal-directed search with unknown path; debugging across a large unknown space; any origin→goal problem where roles and a preset workflow would be a guess.
---

# State-space search (Cairn)

A general problem-solving loop, not a role playbook. Origin is known, goal is defined, the path is unknown. Grow a shared graph until some facts jointly satisfy the goal.

This skill encodes the architecture of [oritera/Cairn](https://github.com/oritera/Cairn): blackboard + stigmergy + OODA. It does **not** encode any attack technique, exploit, or unauthorized-testing procedure.

## Authorization

Operate only where the user has authority (this workspace, systems they own, or an engagement they explicitly authorized). If the request is unauthorized access, exploitation, or attacking a third party, refuse. Negative findings and "this direction is closed" are valid facts. Do not invent a penetration workflow.

## Primitives

| Primitive | Meaning | Rules |
| --- | --- | --- |
| **Fact** | Confirmed objective finding | Append-only. Never edit or delete. State change is a *new* fact. Description is the distilled conclusion; bulky raw output lives in a file and is referenced. |
| **Intent** | Declared exploration direction | A hyperedge `from` one or more fact ids (never `goal`). Independent, parallelizable, non-overlapping. Not a task checklist and not a role. |
| **Hint** | External judgment | Not part of the causal graph. Human messages in this session are hints. After an explore round, a short situation assessment may also be a hint so later readers do not re-derive dead ends. |

Special facts written at project start: `origin`, `goal`. Ordinary facts: `f001`, `f002`, … Intents: `i001`, `i002`, …

## Surfaces in this harness

Cairn's server/dispatcher are not running here. Map them onto DeepSeek Harness:

| Cairn | This preset |
| --- | --- |
| Server (graph consistency) | `.dsh/blackboard.json` — the only shared memory. Parent mutates it with `blackboard_apply`; `blackboard_read` loads it |
| Dispatcher | **This parent session**: schedule, claim, apply ops |
| Reason lease | Parent exclusive: only the parent proposes complete / new intents |
| Explore worker | `subagent` (background, one intent each) |
| Hint | User messages, plus optional `hints` on the board |

Workers do not claim, heartbeat, or talk to each other. They receive a prompt and return structured output. The parent is the sole writer of the board, and **must** write through `blackboard_apply` (never raw `write` / `edit` / shell redirect of the JSON). Explorers must not write the board at all.

## Board

Path: `<workspace>/.dsh/blackboard.json`

Call `blackboard_read` (missing file → empty board). Call `blackboard_apply` to mutate; the tool persists atomically and fails without writing on a protocol error. Schema: `references/board.example.json`. Keep the board small; point at evidence files instead of inlining dumps.

Claim an intent with `blackboard_apply` `action: "claim"` **before** spawning the explorer (never start then claim). Heartbeat is the claim: keep `worker` set while the child runs. If the holder disappears or the user stops that explore, `action: "release"` (clears `worker`, leaves `to` null) — the intent stays open for reclaim. Conclude is atomic: `action: "conclude"` creates the Fact and sets Intent `to` in the same op. Reason **declares** intents with `worker: null`; it does not claim them.

Do not treat an explore failure, a dropped child, or a release that leaves the intent open as a new situation. Only a new fact, a new hint, or open intents going from some→none retriggers reason.

**Complete** is a concluded intent whose `to` is `goal` and whose `from` lists the facts that jointly prove the goal — not a vibe, not partial progress. Reopening a completed board deletes that completion edge (and may record `external_feedback`); `active` never keeps `to: goal`.

If `status` leaves `active` (user stop), cancel in-flight explores and **do not** conclude-write leftover work.

## Scheduler

Same worker type, three tasks. Follow the **implemented** loop, not the stricter design-doc wording:

1. **Bootstrap** — board has only `origin` + `goal`, no ordinary intents. Try to solve the whole problem directly. Return `fact + complete` only if the goal is *definitively* met. If not, write the best confirmed fact (bootstrap conclude) and leave the initial state, then reason.
2. **Reason** — `reason` lease is free, and this is the first look **or** the situation changed vs the checkpoint taken at the **start** of the last successful reason: fact count ↑, hint count ↑, or open intents `>0 → 0`. Creating intents does **not** retrigger reason. Reason **may run while explores are in flight** and while unclaimed intents still exist. Output exactly one of: `complete` | new `intents` (at most 3, high-value, non-overlapping, `from` never includes `goal`) | no-op if open intents already cover the new situation. If open intents is empty and goal is unmet, you **must** propose intents. One reason lease at a time. Always clear `reason` when finished.
3. **Explore** — an unclaimed non-bootstrap open intent exists and reason is not the current priority. Claim the **newest** (`created_at`), spawn one subagent. The child returns **one** objective fact, including a negative finding. The parent writes that fact and concludes the intent. Parallel explores are allowed.

Priority after leaving the initial state: if a reason trigger fired → reason first; else consume the newest claimable explore.

Hard stop (`status: stopped`): kill children, skip conclude fallback.

## Task contracts

Parent and children still speak in prose to the user. **Parent board writes go through `blackboard_apply`.** Explorers return one fact JSON and do not call `blackboard_apply`.

Init (first turn, empty board):

```json
{"action": "init", "origin": "...", "goal": "...", "title": "", "hints": []}
```

Bootstrap success (only when goal is proven in this attempt):

```json
{"action": "bootstrap", "fact": "...", "complete": "..."}
```

Bootstrap conclude (goal unmet — fact only, never `complete`):

```json
{"action": "bootstrap", "fact": "..."}
```

Reason — goal met / new work / wait:

```json
{"action": "reason", "complete_from": ["f001"], "complete_description": "..."}
{"action": "reason", "intents": [{"from": ["f001"], "description": "..."}]}
{"action": "reason"}
```

Claim then spawn; after the child returns, parent conclude (or release if nothing confirmed):

```json
{"action": "claim", "intent_id": "i001"}
{"action": "conclude", "intent_id": "i001", "description": "..."}
{"action": "release", "intent_id": "i001"}
```

Explore return (always one incremental fact; a thorough negative result counts. Policy refusals are not facts — do not write them to the board):

```json
{"accepted": true, "data": {"description": "..."}}
```

Conclude phase (timeout, stuck, or user asks to stop exploring): stop acting, do not wait, summarize only already confirmed facts. Bootstrap conclude returns `fact` only — never `complete`.

## OODA (every worker)

1. **Observe** — `blackboard_read` (explore: board + the claimed intent, passed by the parent).
2. **Orient** — become an expert in *this* domain from the facts; notice drift.
3. **Decide** — parent: complete / intents / no-op. Explorer: how to pursue this intent only.
4. **Act** — parent `blackboard_apply` and may spawn explorers. Explorer returns one fact JSON.

## Subagent prompt (explore)

Spawn with `run_in_background` default (continuable). Start independent explores in one turn. Set `run_in_background: false` only if the next parent action cannot proceed without that one result.

Give the child:

- the current board JSON (from `blackboard_read`)
- `intent_id` and `intent_description`
- instruction: explore only this intent; return one JSON object as above; do not propose new intents; do not call `blackboard_apply`; do not edit `.dsh/blackboard.json`; put bulky evidence in a file and reference it; a thorough negative result is a valid fact
- authorization: same as this skill

After settlement, parent: `blackboard_apply` `conclude` with the child's description (keep `worker` as the producer). Then reason if the situation changed. If the child died with nothing confirmed, `release` (`worker: null`, `to` still null) and do not reason solely for that failure.

Hard stop (`status: stopped`): kill children, skip conclude fallback.

## What not to do

- Do not invent specialist roles (scanner, exploiter, reviewer, …). Tasks come from the graph.
- Do not coordinate through side-channel chat instead of the board.
- Do not rewrite history facts; add a new fact when the world changed.
- Do not mark completion on partial progress.
- Do not copy Cairn's pentest examples into intents. Intents are domain-agnostic directions ("isolate the failing module", "check the contract at the API boundary").
- Do not rebuild Cairn server/dispatcher/containers. The board file plus `blackboard_read` / `blackboard_apply` is enough inside this harness.
- Do not hand-edit `.dsh/blackboard.json`. Parent: tools only. Explorers: no writes.
