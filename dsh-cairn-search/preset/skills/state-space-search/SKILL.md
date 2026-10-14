---
name: state-space-search
description: Use when this session is the Cairn 搜索 preset, or when a problem has a clear origin, a clear goal, and an unknown path — drive the fact-intent blackboard with the `blackboard` tool, bootstrap then reason then explore, and coordinate workers only through the board.
---

# State-space search (Cairn)

A general problem-solving loop, not a role playbook. Origin is known, goal is defined, the path is unknown. Grow a shared graph until some facts jointly satisfy the goal.

This skill encodes a blackboard + stigmergy scheduler. It does **not** encode any attack technique, exploit, or unauthorized-testing procedure.

## Authorization

Operate only where the user has authority (this workspace, systems they own, or an engagement they explicitly authorized). If the request is unauthorized access, exploitation, or attacking a third party, refuse. Negative findings and "this direction is closed" are valid facts. Policy refusals are not facts — do not write them to the board. Do not invent a specialist workflow or copy pentest examples into intents.

## Sole writer

**Only this parent session calls the `blackboard` tool.** The engine owns `.dsh/blackboards/<this main session id>.json`. Subagents share that file; a forked session gets its own copy. Do not create, edit, or rewrite board files with filesystem tools. Explorers never call `blackboard`; they return one JSON object to the parent, and the parent writes it.

Load this skill before the first `blackboard` call.

## Primitives

| Primitive | Meaning | Rules |
| --- | --- | --- |
| **Fact** | Confirmed objective finding | Append-only. Never edit or delete. A state change is a *new* fact. Description is the distilled conclusion; bulky raw output lives in a file and is referenced. Ids: `origin`, `goal`, then `f001`… |
| **Intent** | Declared exploration direction | A hyperedge `from` one or more fact ids. Independent, parallelizable, non-overlapping. Not a task checklist and not a role. Ids: `i001`…. **`goal` must not appear in `from`.** |
| **Hint** | External judgment | Not part of the causal graph. Human messages in this session are hints. |

Complete means a concluded intent with `to` equal to `goal` whose `from` lists the proving facts. Do not mark completion on partial progress.

## Tool mapping

Call `blackboard` with the `op` discriminator. Do not hand-edit YAML or JSON to simulate these steps.

| When | Call |
| --- | --- |
| First turn of a new problem | `op=init` with `title`, `origin`, `goal`, optional `hints` |
| After every write | Execute the returned `next`; call `op=next` whenever you need refreshed work |
| `next` says `review` | Inspect `records` and the actual child outcome; `conclude`, `release`, or `close` the associated intent. Unknown status is not a fact. |
| `next` says `reason` | `op=reason_start`, think on the snapshot, then `op=reason_finish` |
| `next` says `explore` | `op=claim`, spawn one subagent, then `op=conclude` (or `op=release` on failure) |
| Human message arrives mid-search | Runtime records human inbox messages as hints; use `op=hint` for other external judgments |
| User asks to stop exploring | `op=stop` — cancel in-flight explores; **do not** `conclude` after stop |
| Direction abandoned or replaced | `op=close` with `intentId` and a factual `description` explaining why; no invented fact |
| Need the current board without scheduling | `op=snapshot` |
| Resume a stopped board | `op=reopen` |
| Revisit a completed goal after explicit feedback | `op=reopen` with non-empty `description`; prior completion is retained as invalidated history |

`init` then loop `next` until `idle` or the board is `completed` / `stopped`.

## Scheduler

Same worker type, three search tasks plus a prioritized return review. `next` chooses; the parent executes.

1. **Bootstrap** — `next.kind` is `bootstrap`. The parent itself tries the whole origin→goal problem (do not spawn a subagent). If the goal is definitively met, `conclude` the reserved bootstrap intent with the proving fact, then `reason_finish` with `complete`. If not, `conclude` with the best confirmed fact only (never `complete` on a bootstrap miss), then `next` again.
2. **Reason** — `next.kind` is `reason`. Call `reason_start` (worker `parent`). Reason **may run while explores are in flight**. The trigger is taken at **reason start**: fact count up, hint count up, or open intents went `>0 → 0`. Declaring new intents does **not** retrigger reason. After thinking, `reason_finish` with exactly one of:
   - `complete: { from, description }` — proving facts, `to` becomes `goal`
   - `intents: [{ from, target, description }, …]` — at most 3, high-value, non-overlapping, `goal` not in `from`; the engine stores them unclaimed (`worker: null`)
   - `{}` — no-op when open intents already cover the new situation
   If open intents is empty and the goal is unmet, you **must** propose intents.
3. **Explore** — `next.kind` is `explore`. Claim the newest unclaimed non-bootstrap open intent **before** spawning. Spawn one subagent for that intent only. The child returns **one** objective fact, including a negative finding. The parent writes it with `conclude`. On timeout, crash, or refusal to explore, `release` (clear worker, leave `to` null). Release is **not** a reason trigger.

Review takes priority in every active state. After reviews, if `next` says reason, reason even if explores are still in flight; otherwise consume the newest claimable explore. Start independent explores in one turn; do not wait for one before claiming another.

## Explore subagent prompt

Spawn with `run_in_background` default (continuable). Set `run_in_background: false` only if the next parent action cannot proceed without that one result.

Give the child:

- start the prompt with `blackboard_intent: iNNN` and a newline; the runtime requires a prior claim and binds the spawned child to this intent
- the current board snapshot as JSON (from the `claim` / `snapshot` result)
- `intent_id` and `intent_description`
- instruction: explore **only** this intent; return one JSON object `{"description": "..."}`; do not propose new intents; do not call `blackboard`; do not edit `.dsh/blackboards/`; put bulky evidence in a file and reference it; a thorough negative result is a valid fact
- authorization: same as this skill

After the child returns, parent: `blackboard op=conclude` with that `description`. Then `op=next`.

## Stop

`op=stop` freezes the board (`status: stopped`). Cancel in-flight subagents. Do not `conclude` and do not invent a fallback fact. Hints may still be recorded. `op=reopen` resumes.

## Stigmergy

Agents coordinate only through the board. Do not treat private chat as shared memory. Workers do not claim, heartbeat, or talk to each other. They receive a prompt and return structured output.

## What not to do

- Do not invent specialist roles (scanner, reviewer, …). Tasks come from the graph.
- Do not coordinate through side-channel chat instead of the board.
- Do not rewrite history facts; add a new fact when the world changed.
- Do not put `goal` in an intent's `from`.
- Do not copy attack playbooks into intents. Intents are domain-agnostic directions ("isolate the failing module", "check the contract at the API boundary").
- Do not rebuild an external dispatcher. The `blackboard` tool is the dispatcher.

## Evidence and lifecycle checks

Each new intent needs one stable `target` subgoal key, not a queue of unrelated tasks. Keep `from` to necessary direct premises; the snapshot is context, not a dependency list. Duplicate open targets are rejected. Close replaced work before declaring a successor. A retry may reuse the same released intent.

Conclude one distilled objective finding at a time, including negative findings. Reference evidence files instead of embedding execution transcripts. Pass `supersedes: ["fNNN"]` to explicitly replace an outdated finding. History remains visible but superseded facts cannot justify new intents or completion. Existing historical boards are not rewritten automatically.

Every tool mutation returns `next` and quality warnings. Resolve returned workers before spawning more exploration. Runtime records settlement in `workerReturns`, separately from human hints, and marks the current matching intent pending; the parent must review and conclude, release or close it. Spawn failures release their reservation automatically. Child sessions cannot write the board or dispatch further explorers.

Completion requires an observed fact (not origin alone) and no open intents. Independently check every goal criterion against the referenced evidence; the engine cannot verify natural-language truth. On external task expiry or termination call `stop`, even if the goal is unmet. Stop interrupts bound continuable workers; ordinary parent idleness does not mean the external task ended. Do not reopen a completed board just to append unrelated work. Human hints remain writable after stop. Late worker returns are archived without resuming work or creating facts.

## Return review and recovery

`workerReturns` preserves raw foreground/background output and status observations. Existing historical hints are unchanged. New worker notifications and closure reasons do not become hints. Only a reviewed `conclude` creates a fact; closing the final open intent still triggers reasoning.

Before parent steps and on `snapshot`/`next`, the runtime checks bound children through the Harness catalog. `inactive`, missing children and diagnostic rows indicate uncertain outcomes, not proven failure. Inspect the child's actual result before concluding, releasing or closing; continue observing if unsure. A failed catalog query retains claims and returns a warning. There is no automatic retry, timeout release, or synthesized finding. Recovered observations clear without erasing their history. Claims with unfinished spawn calls are excluded from recovery checks.

To reopen a completed goal, require explicit feedback and pass it as `description`. The feedback becomes a hint, not a verified fact. The prior completion remains visible as invalidated history; the next reason cycle must reevaluate the evidence. Calling reopen again on an active board is a no-op. Unrelated goals should use a new board.
