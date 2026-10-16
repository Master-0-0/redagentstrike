# Cairn blackboard

The parent owns the board. Explorers return evidence; they cannot mutate it or dispatch further explorers. A new intent has one stable `target` and the minimal direct fact dependencies in `from`. Multiple open intents with the same target or identical descriptions are rejected. Dependence on every current fact produces an advisory warning, not automatic removal of potentially necessary premises.

Claim first, then begin the subagent prompt with `blackboard_intent: iNNN` and a newline. The runtime reserves that intent atomically before dispatch and binds continuable child IDs to it. Failed startup releases the claim. Returned continuable workers are marked pending from their settlement inbox notification; the parent must conclude, release or close them before spawning further work. Foreground returns are also marked pending. The parent must inspect the returned evidence: settlement itself is not a fact.

`conclude` appends a distilled finding. Optional `supersedes` IDs explicitly invalidate prior findings for future premises and goal proofs. The UI retains and dims historical facts and identifies their replacements. `close` records why work was abandoned without inventing a fact; `release` makes work retryable. Both interrupt their bound continuable child. `stop` interrupts all bound open children and freezes the board; a child arriving after stop is interrupted too. Closed work remains visible but does not count as open.

Human inbox messages become hints; continuable settlement notices become worker-return records, deduplicated by message ID. Each mutation returns `next` and quality warnings. Checkpoint counts retain their original meaning: the situation observed when reasoning began. Goal completion requires current observed evidence and no open intents. Session `update_goal complete` is gated on blackboard completion; successful pause/blocked updates stop the board. Repeated `init` cannot overwrite an existing board.

Read-modify-write operations are serialized per board within and across host processes, in addition to atomic file replacement. Legacy snapshots remain readable and upgrade on a parent operation; unfinished bootstrap intents close explicitly, while existing facts and completed history are retained.

## Validation

`npm test` covers domain operations, backward-compatible graph parsing, concurrent writes, spawn admission/failure, child binding, inbox deduplication, late spawn cancellation, goal lifecycle, and the model-facing tool entry point. `npm run build` regenerates the committed host/client bundles. The workbench frontend imports the shared view code and is built separately in `../web-ui`.

## Boundaries

- Natural-language truth, atomicity, causal necessity and completeness against an external task inventory still require evidence review. Target keys detect exact overlap, not arbitrary semantic overlap. Missing historical results cannot be reconstructed from counts.
- External platform termination is not a Harness goal event. Its adapter or the parent must call `stop`; ordinary parent idleness must not freeze a running task.
- Settlement reconciliation happens when the parent consumes its inbox. Before parent steps and on snapshot/next, catalog reconciliation detects inactive, missing or diagnostically unreadable children for parent review. Activity is not an outcome: no automatic release or retry occurs. Query failures retain claims and return warnings. One-shot background job lifecycle is not bound like continuable children; use the preset's continuable spawn or foreground mode.
- All writers must use withBoardLock. Uncoordinated external edits are unsupported; the filesystem lock cannot protect writers that ignore it.
- Rebuild/reload the plugin and install the updated preset skill to activate the protocol in a running deployment. Source changes alone do not restart the host.

## Worker returns and feedback

New settlement messages and foreground output are stored in optional `workerReturns`, not hints. Records retain raw content, message/dispatch/child/intent identifiers when known, and their disposition. Existing hints are never migrated or hidden, and their message IDs also suppress replay duplicates. Old files without the new array remain readable.

`next.kind=review` takes priority over search tasks and returns pending intents plus unresolved records. The parent inspects the outcome and uses conclude/release/close; these atomically resolve the records. Status observations never prove success or failure. Repeated observations are deduplicated and recovered observations remain in history. Closing an intent stores its reason on that intent; closing the final open task explicitly triggers reason without a synthetic hint.

Completed boards accept `reopen` only with non-empty feedback `description`. This appends a human feedback hint and marks the previous completion intent `invalidated` with its time and hint reference. Facts and historical completion links remain intact. New completion still requires observed evidence and no open work. Reopen on an active board is idempotent; stopped boards retain their existing resume behavior.

Both board views show a separate collapsible worker-return section, filtered to the selected intent when applicable. Invalidated completion links are labeled and visually muted. No existing board files are batch-rewritten by this update.

## Protocol v2 long-session behavior

Initialization now schedules reasoning without parent exploration. The parent is a coordinator: execution tools are denied at the Cairn runtime boundary while child sessions retain those tools. Workflow/Ralph bypasses are rejected. Explorers receive a dedicated persona, load cairn-explorer and the intent's explicit skills, and return evidence. Only an actual unresolved worker return can support a new v2 conclusion. Parent read tools are reserved for evidence review.

Legacy boards upgrade on a parent blackboard operation; unfinished reserved bootstrap work is closed without a synthetic fact. Facts and completed history remain. Open work, concurrent dispatch and retry budgets are persisted from the plugin configuration. Repeated directions with identical premises require new feedback. Only runtime-recorded user messages reset exploration budgets; model-authored hints cannot reset them, even when labeled `user`. Unfinished reasoning and claims without dispatch remain schedulable. Explicit goal resume reopens stopped boards. Completing the session goal also checks that the board's completion still has current observed evidence.

At 512 total records, persistence switches from a full JSON snapshot to an atomic `cairn-segments-v1` manifest. Facts, intents, hints and return metadata live in immutable, SHA-256-addressed blocks of up to 256 records under `.dsh/blackboard-segments/`. Only changed blocks are written; host and sidebar keep bounded caches of immutable blocks. Forks copy the manifest and retain their exact evidence revision. Keep the segments and `.dsh/blackboard-content/` together with the board when backing up a workspace. Workbench and finding receipts understand both formats. Full history views and cold loads still scale with history size; ordinary updates no longer rewrite that history. There is no automatic block deletion because fork snapshots can retain old blocks.

Fact supersession propagates through derivations. An explicitly replacing observation does not depend on the premise it corrects; unrelated invalid premises still invalidate it. New conclusions and completion proofs reject stale dependencies.

Model snapshots are partial bounded views, not authoritative inventories. Use lookup with section, offset and limit to browse history; id and contentOffset retrieve complete item text in chunks. Large raw returns are written once under .dsh/blackboard-content and previewed in the board. Both views load full return content on request. Content is shared immutably across conversation forks and must not be garbage-collected while a board references it.

Read-modify-write transactions use proper-lockfile across processes; the complete transaction must hold the lock. Graph layout uses iterative indexed dependency traversal, and identical snapshots reuse the last layout.

## Deployment and verification

Build with npm run build, then run npm run install-preset -- --dry-run to inspect destinations and npm run install-preset to merge the owned role/configuration updates. The installer backs up changed files, preserves unrelated plugins and existing limits, and copies the coordinator/explorer skills. Reload the host/preset after deployment; existing running child compositions keep their captured configuration until recreated. npm run test:integration exercises the actual Harness Loader and tool dispatch with a local deterministic adapter, including an unaffected plain preset.

Completion requires one observed-evidence proof for every initialized acceptance criterion. reason_finish also requires the current reasonId; a delayed submission cannot finish a newer reasoning lease. The per-feedback exploration limit bounds repeated novel directions even when exact-target deduplication does not apply. Natural-language truth remains a review responsibility; structural proofs are not external verification.
