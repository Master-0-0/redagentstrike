"""Read Cairn blackboard JSON files from DeepSeek Harness workspaces."""

from __future__ import annotations

from functools import lru_cache
import json
import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


BOARD_DIR_RELATIVE = Path(".dsh") / "blackboards"
OWNER_ID_RE = re.compile(r"^[A-Za-z0-9._~-]+$")
WORKSPACE_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class BlackboardBadRequest(ValueError):
    """Caller named an unsafe workspace or board owner id."""


class BlackboardNotFound(LookupError):
    """Workspace or board file is absent from the DSH registry tree."""


def list_blackboards(dsh_home: Path) -> Dict[str, Any]:
    """List session boards under each registered DSH workspace.

    @param dsh_home: Harness home that stores `storages/workspace.json`.
    @returns catalog with `dsh_home` and ordered `workspaces`.
    """
    home = dsh_home.expanduser().resolve()
    workspaces: List[Dict[str, Any]] = []
    for record in _workspace_records(home):
        root = Path(record["path"])
        workspaces.append({
            "id": record["id"],
            "title": record["title"],
            "path": str(root),
            "boards": _list_boards(root),
        })
    return {"dsh_home": str(home), "workspaces": workspaces}


def read_blackboard(dsh_home: Path, workspace_id: str, owner_id: str) -> Dict[str, Any]:
    """Read one board JSON body from a registered workspace.

    @param dsh_home: Harness home that stores the workspace registry.
    @param workspace_id: Durable workspace record id.
    @param owner_id: Encoded main-session id (board filename stem).
    @returns board file identity plus UTF-8 text.
    """
    workspace = _workspace_by_id(dsh_home, workspace_id)
    path = _board_file(Path(workspace["path"]), owner_id)
    try:
        text = path.read_text(encoding="utf-8")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = None  # Preserve malformed legacy text for the UI diagnostic.
        if isinstance(payload, dict) and "storageFormat" in payload:
            text = json.dumps(_hydrate_board(Path(workspace["path"]).expanduser().resolve(), payload), ensure_ascii=False)
    except OSError as exc:
        raise BlackboardNotFound("blackboard not found") from exc
    return {
        "workspace_id": workspace["id"],
        "owner_id": owner_id,
        "path": str(path),
        "text": text,
    }


def _hydrate_board(root: Path, board: Dict[str, Any]) -> Dict[str, Any]:
    if board.get("storageFormat") != "cairn-segments-v1":
        raise BlackboardBadRequest("unsupported blackboard storage format")
    segments = board.get("segments")
    if not isinstance(segments, dict):
        raise BlackboardBadRequest("invalid blackboard segment index")
    if board.get("storageRevision") != board.get("storageEndRevision"):
        raise BlackboardBadRequest("blackboard manifest revision mismatch")
    result = {key: value for key, value in board.items() if key not in {"storageFormat", "segments", "storageRevision", "storageEndRevision"}}
    for field in ("facts", "intents", "hints", "workerReturns"):
        refs = segments.get(field)
        if not isinstance(refs, list):
            raise BlackboardBadRequest("invalid blackboard segment index")
        records = []
        for ref in refs:
            if not isinstance(ref, dict) or not isinstance(ref.get("path"), str) or not re.fullmatch(r"\.dsh/blackboard-segments/[a-f0-9]{64}\.json", ref["path"]):
                raise BlackboardBadRequest("invalid blackboard segment reference")
            path = root / ref["path"]
            if not _contained(path, root):
                raise BlackboardBadRequest("segment path outside workspace")
            content = path.read_bytes()
            if not ref["path"].endswith("/" + hashlib.sha256(content).hexdigest() + ".json"):
                raise BlackboardBadRequest("blackboard segment failed integrity check")
            values = json.loads(content)
            if not isinstance(values, list) or not 1 <= len(values) <= 256 or len(values) != ref.get("count"):
                raise BlackboardBadRequest("blackboard segment count mismatch")
            records.extend(values)
        result[field] = records
    return result


def _workspace_records(dsh_home: Path) -> List[Dict[str, str]]:
    document = _load_workspace_unit(dsh_home)
    if document is None:
        return []
    tables = document.get("tables")
    if not isinstance(tables, dict):
        return []
    raw_rows = tables.get("workspaces")
    if not isinstance(raw_rows, dict):
        return []
    global_state = document.get("global")
    ordered_ids: List[str] = []
    if isinstance(global_state, dict):
        ids = global_state.get("workspaceIds")
        if isinstance(ids, list):
            ordered_ids = [item for item in ids if isinstance(item, str)]
    seen = set(ordered_ids)
    for key in raw_rows:
        if isinstance(key, str) and key not in seen:
            ordered_ids.append(key)
    records: List[Dict[str, str]] = []
    for workspace_id in ordered_ids:
        row = raw_rows.get(workspace_id)
        if not isinstance(row, dict):
            continue
        path_value = row.get("path")
        if not isinstance(path_value, str) or not path_value.strip():
            continue
        title = row.get("title")
        records.append({
            "id": workspace_id,
            "title": title if isinstance(title, str) and title.strip() else Path(path_value).name,
            "path": path_value,
        })
    return records


def _workspace_by_id(dsh_home: Path, workspace_id: str) -> Dict[str, str]:
    if not WORKSPACE_ID_RE.fullmatch(workspace_id):
        raise BlackboardBadRequest("invalid workspace id")
    home = dsh_home.expanduser().resolve()
    for record in _workspace_records(home):
        if record["id"] == workspace_id:
            return record
    raise BlackboardNotFound("workspace not found")


def _load_workspace_unit(dsh_home: Path) -> Optional[Dict[str, Any]]:
    path = dsh_home / "storages" / "workspace.json"
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    unit = payload.get("unit")
    if not isinstance(unit, dict) or unit.get("name") != "workspace":
        return None
    return payload


def _list_boards(workspace_root: Path) -> List[Dict[str, Any]]:
    board_dir = _board_dir(workspace_root)
    if board_dir is None:
        return []
    items: List[Dict[str, Any]] = []
    try:
        entries = list(board_dir.iterdir())
    except OSError:
        return []
    for entry in entries:
        if entry.suffix != ".json" or not entry.is_file():
            continue
        if not _contained(entry, board_dir):
            continue
        owner_id = entry.stem
        if not OWNER_ID_RE.fullmatch(owner_id):
            continue
        title, status = _board_preview(entry)
        try:
            mtime = datetime.fromtimestamp(entry.stat().st_mtime, timezone.utc).isoformat()
        except OSError:
            continue
        items.append({
            "owner_id": owner_id,
            "title": title,
            "status": status,
            "mtime": mtime,
        })
    items.sort(key=lambda item: item["mtime"], reverse=True)
    return items


def _board_file(workspace_root: Path, owner_id: str) -> Path:
    if not OWNER_ID_RE.fullmatch(owner_id) or owner_id in {".", ".."}:
        raise BlackboardBadRequest("invalid board owner")
    board_dir = _board_dir(workspace_root)
    if board_dir is None:
        raise BlackboardNotFound("blackboard not found")
    path = (board_dir / "{}.json".format(owner_id)).resolve()
    if not _contained(path, board_dir) or not path.is_file():
        raise BlackboardNotFound("blackboard not found")
    return path


def _board_dir(workspace_root: Path) -> Optional[Path]:
    try:
        root = workspace_root.expanduser().resolve()
    except OSError:
        return None
    if not root.is_dir():
        return None
    board_dir = (root / BOARD_DIR_RELATIVE).resolve()
    if not board_dir.is_dir() or not _contained(board_dir, root):
        return None
    return board_dir


def _contained(child: Path, parent: Path) -> bool:
    try:
        return child.resolve().is_relative_to(parent.resolve())
    except (OSError, ValueError):
        return False


def _board_preview(path: Path) -> Tuple[Optional[str], Optional[str]]:
    try:
        info = path.stat()
        return _cached_board_preview(str(path), info.st_mtime_ns, info.st_size)
    except OSError:
        return None, None


@lru_cache(maxsize=256)
def _cached_board_preview(filename: str, mtime_ns: int, size: int) -> Tuple[Optional[str], Optional[str]]:
    path = Path(filename)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None, None
    if not isinstance(payload, dict):
        return None, None
    title = payload.get("title")
    status = payload.get("status")
    return (
        title if isinstance(title, str) else None,
        status if isinstance(status, str) else None,
    )


def read_blackboard_return(dsh_home: Path, workspace_id: str, owner_id: str, return_id: str) -> Dict[str, Any]:
    """Read one archived return only after resolving it through its owner board."""
    document = read_blackboard(dsh_home, workspace_id, owner_id)
    board = json.loads(document["text"])
    record = next((r for r in board.get("workerReturns", []) if r.get("id") == return_id), None)
    if record is None:
        raise BlackboardNotFound("worker return not found")
    reference = record.get("contentRef")
    if not reference:
        return {"text": record.get("content", "")}
    if not isinstance(reference, str) or not re.fullmatch(r"\.dsh/blackboard-content/[a-f0-9]{64}\.txt", reference):
        raise BlackboardBadRequest("invalid return reference")
    workspace = _workspace_by_id(dsh_home, workspace_id)
    root = Path(workspace["path"]).resolve()
    path = root / reference
    if not _contained(path, root):
        raise BlackboardBadRequest("return path outside workspace")
    try:
        return {"text": path.read_text(encoding="utf-8")}
    except OSError as exc:
        raise BlackboardNotFound("return content unavailable") from exc
