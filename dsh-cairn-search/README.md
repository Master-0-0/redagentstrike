# Cairn blackboard

The parent owns the board. Explorers return evidence; they cannot mutate it or dispatch further explorers. A new intent has one stable `target` and the minimal direct fact dependencies in `from`. Multiple open intents with the same target or identical descriptions are rejected. Dependence on every current fact produces an advisory warning, not automatic removal of potentially necessary premises.

Claim first, then begin the subagent prompt with `blackboard_intent: iNNN` and a newline. The runtime reserves that intent atomically before dispatch and binds continuable child IDs to it. Failed startup releases the claim. Returned continuable workers are marked pending from their settlement inbox notification; the parent must conclude, release or close them before spawning further work. Foreground returns are also marked pending. The parent must inspect the returned evidence: settlement itself is not a fact.

`conclude` appends a distilled finding. Optional `supersedes` IDs explicitly invalidate prior findings for future premises and goal proofs. The UI retains and dims historical facts and identifies their replacements. `close` records why work was abandoned without inventing a fact; `release` makes work retryable. Both interrupt their bound continuable child. `stop` interrupts all bound open children and freezes the board; a child arriving after stop is interrupted too. Closed work remains visible but does not count as open.

Human inbox messages and continuable settlement notices become hints, deduplicated by message ID. Each mutation returns `next` and quality warnings. Checkpoint counts retain their original meaning: the situation observed when reasoning began. Goal completion requires current observed evidence and no open intents. Session `update_goal complete` is gated on blackboard completion; successful pause/blocked updates stop the board. Repeated `init` cannot overwrite an existing board.

Read-modify-write operations are serialized per board in one plugin module instance/process, in addition to atomic file replacement. Old snapshots remain readable; new metadata is optional on disk. No historical records are automatically repaired or reinterpreted.

## Validation

`npm test` covers domain operations, backward-compatible graph parsing, concurrent writes, spawn admission/failure, child binding, inbox deduplication, late spawn cancellation, goal lifecycle, and the model-facing tool entry point. `npm run build` regenerates the committed host/client bundles. The workbench frontend imports the shared view code and is built separately in `../web-ui`.

## Boundaries

- Natural-language truth, atomicity, causal necessity and completeness against an external task inventory still require evidence review. Target keys detect exact overlap, not arbitrary semantic overlap. Missing historical results cannot be reconstructed from counts.
- External platform termination is not a Harness goal event. Its adapter or the parent must call `stop`; ordinary parent idleness must not freeze a running task.
- Settlement reconciliation happens when the parent consumes its inbox. Before parent steps and on snapshot/next, catalog reconciliation detects inactive, missing or diagnostically unreadable children for parent review. Activity is not an outcome: no automatic release or retry occurs. Query failures retain claims and return warnings. One-shot background job lifecycle is not bound like continuable children; use the preset's continuable spawn or foreground mode.
- Process-local serialization does not coordinate independent host processes writing the same workspace, and is not a cross-process lock.
- Rebuild/reload the plugin and install the updated preset skill to activate the protocol in a running deployment. Source changes alone do not restart the host.

## Worker returns and feedback

New settlement messages and foreground output are stored in optional `workerReturns`, not hints. Records retain raw content, message/dispatch/child/intent identifiers when known, and their disposition. Existing hints are never migrated or hidden, and their message IDs also suppress replay duplicates. Old files without the new array remain readable.

`next.kind=review` takes priority over search tasks and returns pending intents plus unresolved records. The parent inspects the outcome and uses conclude/release/close; these atomically resolve the records. Status observations never prove success or failure. Repeated observations are deduplicated and recovered observations remain in history. Closing an intent stores its reason on that intent; closing the final open task explicitly triggers reason without a synthetic hint.

Completed boards accept `reopen` only with non-empty feedback `description`. This appends a human feedback hint and marks the previous completion intent `invalidated` with its time and hint reference. Facts and historical completion links remain intact. New completion still requires observed evidence and no open work. Reopen on an active board is idempotent; stopped boards retain their existing resume behavior.

Both board views show a separate collapsible worker-return section, filtered to the selected intent when applicable. Invalidated completion links are labeled and visually muted. No existing board files are batch-rewritten by this update.
