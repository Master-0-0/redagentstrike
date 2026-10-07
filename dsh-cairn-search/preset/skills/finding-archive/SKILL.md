---
name: finding-archive
description: Default automatic findings archiving for every authorized Cairn testing task; preserve existing evidence and leave human review pending.
---

## Default workflow

Load this skill at the start of every authorized testing task. Automatically archive meaningful vulnerability candidates supported by existing evidence, without waiting for a separate user request or asking the user to re-enter the report. Respect an explicit task-level opt-out. Do not turn ordinary progress facts, failed checks, or a completed board into vulnerabilities.

Build the report from observed materials, state unknown prerequisites/results honestly, and declare missing evidence. Keep the returned finding_id and append later materials for the same known finding. Explorers that archive successfully include finding_id/submission_key inside the description of their original single JSON fact returned to the parent; preserve the original return envelope and never add fields; the parent reuses that finding_id instead of creating a duplicate. Different sessions are not merged by similarity alone. No tool action changes human review or remediation states.

At a suitable point retry a transient archive failure once using its saved submission_key. Continue search independently. Summarize saved IDs and any unresolved archive failures at task end; never claim success without a committed receipt. Archiving does not add a blackboard completion condition.

Use `archive_finding` when existing materials support a result worth preserving. It never runs a PoC, replays traffic, captures screenshots, or changes the blackboard. Continue the original state-space-search rules. Archiving is never a Cairn completion condition. If an explorer cannot access this tool, include the real evidence paths and source details inside the description of the original single JSON fact returned to the parent; the parent archives under its own execution identity and describes the original material source.

For `op=create`, supply `finding` with title, target, summary, severity (`unknown`, `info`, `low`, `medium`, `high`, `critical`), preconditions, steps (`[{id,description,artifact_client_ids:[]}]`), expected_result, actual_result, and agent_assessment (`suspected` or `reproduced`). State unknown information honestly. All creations remain pending human review.

`artifacts` contains existing workspace files: `{client_id,kind,path,description,step_ids,capture_method,captured_at,execution_note}`. IDs use letters/digits/underscore/hyphen. Kinds: poc, http_request, http_response, browser_screenshot, response_screenshot, tool_output, attachment. Files are limited to 20 MiB each, 20 files and 100 MiB per submission. Paths must stay inside the workspace; symlinks are rejected. If an existing tool only returned text, use the existing file tools to save it first. A submitted PoC is not proof of execution. A response-text screenshot is not a browser screenshot and cannot replace the full response attachment.

Optional `fact_ids` reference only the current owner board. Workspace, session, owner and fact snapshots are resolved by the plugin, not supplied by the model. Missing parents prevent fact lookup; a submission without facts can retain an unresolved owner.

`network_refs` is an array of explicit `{event_id,run_id,step_ids:[]}` (maximum 20). Do not derive event IDs or Runs from the current Run, domain, timestamps or assumptions. Imported HTTP is a transformed parsed snapshot, with unknown completeness unless independently known.

Explicitly list missing or inapplicable categories in `evidence_gaps`: `{category,status,reason}` where category is poc/http/screenshot/tool_output/description and status is missing/not_applicable. Never silently omit a failed file reference. Correct the input and declare a gap if the evidence really is unavailable.

For `op=append`, supply finding_id, note, new artifacts/network_refs/gaps, and optional resolved_gap_ids. Existing steps may receive new evidence; step edits and human statuses belong to the UI. A gap resolution needs a note or supporting materials. To record an intentional independent repeated validation, supply a distinct occurrence_id.

On failure, report ok=false. A returned submission_key means the local manifest and file copies were saved. `op=retry, submission_key=...` uses these copies even after original files change or disappear. Network references not yet snapshotted still depend on their source events. Do not retry forever or block Cairn scheduling. Never put service credentials into findings manifests. Previews and downloads preserve saved credentials without masking.
