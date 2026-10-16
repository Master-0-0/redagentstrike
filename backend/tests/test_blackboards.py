from __future__ import annotations

import json
import hashlib
import pytest
from pathlib import Path

from fastapi.testclient import TestClient

from workbench.api import create_app
from workbench.blackboards import (
    BlackboardBadRequest,
    BlackboardNotFound,
    list_blackboards,
    read_blackboard,
)
from workbench.config import Settings


EXAMPLE_BOARD = {
    "title": "Find why parseDuration rejects 1.5h",
    "status": "active",
    "bootstrapEnabled": False,
    "facts": [
        {"id": "origin", "description": "parseDuration rejects 1.5h."},
        {"id": "goal", "description": "Name the rejecting check."},
        {"id": "f001", "description": "Amount 1.5 and unit h."},
    ],
    "intents": [
        {
            "id": "i001",
            "from": ["origin"],
            "to": "f001",
            "description": "Trace parseDuration.",
            "creator": "parent",
            "worker": None,
            "createdAt": "2026-09-11T00:00:00.000Z",
            "concludedAt": "2026-09-11T00:01:00.000Z",
        },
        {
            "id": "i002",
            "from": ["f001"],
            "to": None,
            "description": "Find the numeric validation.",
            "creator": "parent",
            "worker": "explore-i002",
            "createdAt": "2026-09-11T00:02:00.000Z",
            "concludedAt": None,
        },
    ],
    "hints": [
        {
            "id": "h001",
            "content": "Prefer the parser module.",
            "creator": "user",
            "createdAt": "2026-09-11T00:00:30.000Z",
        }
    ],
    "reason": None,
    "checkpoint": {"factCount": 3, "hintCount": 1, "hadOpenIntents": True},
}

SECOND_BOARD = {
    **EXAMPLE_BOARD,
    "title": "Second session board",
    "status": "stopped",
}


def _write_registry(dsh_home: Path, workspaces: dict[str, dict], order: list[str] | None = None) -> None:
    storages = dsh_home / "storages"
    storages.mkdir(parents=True)
    payload = {
        "unit": {"name": "workspace", "version": 2},
        "global": {
            "initialized": True,
            "workspaceIds": order if order is not None else list(workspaces),
            "archivedSessionIds": [],
        },
        "tables": {"workspaces": workspaces},
    }
    (storages / "workspace.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _write_board(workspace: Path, owner_id: str, board: dict) -> Path:
    board_dir = workspace / ".dsh" / "blackboards"
    board_dir.mkdir(parents=True, exist_ok=True)
    path = board_dir / "{}.json".format(owner_id)
    path.write_text(json.dumps(board, indent=2) + "\n", encoding="utf-8")
    return path


def test_segmented_board_reads_exact_snapshot_and_rejects_corruption(tmp_path: Path):
    home, project = tmp_path / "home", tmp_path / "project"
    project.mkdir()
    _write_registry(home, {"ws": {"path": str(project)}})
    directory = project / ".dsh/blackboard-segments"
    directory.mkdir(parents=True)
    manifest = {key: value for key, value in EXAMPLE_BOARD.items() if key not in {"facts", "intents", "hints", "workerReturns"}}
    manifest.update(storageFormat="cairn-segments-v1", segments={})
    for field in ("facts", "intents", "hints", "workerReturns"):
        values = EXAMPLE_BOARD.get(field, [])
        refs = []
        if values:
            content = json.dumps(values).encode()
            filename = hashlib.sha256(content).hexdigest() + ".json"
            (directory / filename).write_bytes(content)
            refs.append({"path": ".dsh/blackboard-segments/" + filename, "count": len(values)})
        manifest["segments"][field] = refs
    _write_board(project, "p", manifest)
    read = json.loads(read_blackboard(home, "ws", "p")["text"])
    assert read["facts"] == EXAMPLE_BOARD["facts"]
    assert list_blackboards(home)["workspaces"][0]["boards"][0]["title"] == EXAMPLE_BOARD["title"]
    (project / manifest["segments"]["facts"][0]["path"]).write_text("[]")
    with pytest.raises(BlackboardBadRequest, match="integrity"):
        read_blackboard(home, "ws", "p")


def test_lists_boards_from_registered_workspaces(tmp_path: Path):
    dsh_home = tmp_path / "home"
    project_a = tmp_path / "project-a"
    project_b = tmp_path / "project-b"
    project_a.mkdir()
    project_b.mkdir()
    _write_board(project_a, "session-one", EXAMPLE_BOARD)
    _write_board(project_a, "session-two", SECOND_BOARD)
    _write_registry(dsh_home, {
        "ws-a": {
            "path": str(project_a),
            "title": "Alpha",
            "sessionIds": ["session-one"],
            "createdAt": "2026-09-11T00:00:00.000Z",
            "updatedAt": "2026-09-11T00:00:00.000Z",
        },
        "ws-b": {
            "path": str(project_b),
            "title": "Beta",
            "sessionIds": [],
            "createdAt": "2026-09-11T00:00:00.000Z",
            "updatedAt": "2026-09-11T00:00:00.000Z",
        },
    }, order=["ws-b", "ws-a"])

    catalog = list_blackboards(dsh_home)

    assert catalog["dsh_home"] == str(dsh_home.resolve())
    assert [item["id"] for item in catalog["workspaces"]] == ["ws-b", "ws-a"]
    beta, alpha = catalog["workspaces"]
    assert beta["boards"] == []
    assert {item["owner_id"] for item in alpha["boards"]} == {"session-one", "session-two"}
    by_owner = {item["owner_id"]: item for item in alpha["boards"]}
    assert by_owner["session-one"]["title"] == EXAMPLE_BOARD["title"]
    assert by_owner["session-one"]["status"] == "active"
    assert by_owner["session-two"]["status"] == "stopped"

    body = read_blackboard(dsh_home, "ws-a", "session-one")
    assert json.loads(body["text"])["title"] == EXAMPLE_BOARD["title"]
    assert body["owner_id"] == "session-one"


def test_missing_registry_and_board_dir_are_empty(tmp_path: Path):
    dsh_home = tmp_path / "empty-home"
    dsh_home.mkdir()
    catalog = list_blackboards(dsh_home)
    assert catalog["workspaces"] == []

    project = tmp_path / "lonely"
    project.mkdir()
    _write_registry(dsh_home, {
        "ws-empty": {
            "path": str(project),
            "title": "Lonely",
            "sessionIds": [],
            "createdAt": "2026-09-11T00:00:00.000Z",
            "updatedAt": "2026-09-11T00:00:00.000Z",
        }
    })
    catalog = list_blackboards(dsh_home)
    assert catalog["workspaces"][0]["boards"] == []


def test_rejects_path_traversal_owner_ids(tmp_path: Path):
    dsh_home = tmp_path / "home"
    project = tmp_path / "project"
    project.mkdir()
    secret = tmp_path / "secret.json"
    secret.write_text("{\"secret\": true}\n", encoding="utf-8")
    _write_board(project, "safe", EXAMPLE_BOARD)
    _write_registry(dsh_home, {
        "ws-a": {
            "path": str(project),
            "title": "Alpha",
            "sessionIds": [],
            "createdAt": "2026-09-11T00:00:00.000Z",
            "updatedAt": "2026-09-11T00:00:00.000Z",
        }
    })

    try:
        read_blackboard(dsh_home, "ws-a", "../secret")
        assert False, "expected BlackboardBadRequest"
    except BlackboardBadRequest:
        pass

    try:
        read_blackboard(dsh_home, "missing", "safe")
        assert False, "expected BlackboardNotFound"
    except BlackboardNotFound:
        pass


def test_blackboards_http_routes(tmp_path: Path):
    dsh_home = tmp_path / "home"
    project = tmp_path / "project"
    project.mkdir()
    _write_board(project, "session-one", EXAMPLE_BOARD)
    _write_registry(dsh_home, {
        "ws-a": {
            "path": str(project),
            "title": "Alpha",
            "sessionIds": [],
            "createdAt": "2026-09-11T00:00:00.000Z",
            "updatedAt": "2026-09-11T00:00:00.000Z",
        }
    })
    settings = Settings(
        data_dir=tmp_path / "data",
        api_port=18787,
        proxy_port=18080,
        dsh_home=dsh_home,
    )
    (tmp_path / "data").mkdir()
    app = create_app(settings)
    with TestClient(app) as client:
        listed = client.get("/blackboards").json()
        assert listed["workspaces"][0]["id"] == "ws-a"
        assert listed["workspaces"][0]["boards"][0]["owner_id"] == "session-one"
        detail = client.get("/blackboards/ws-a/session-one")
        assert detail.status_code == 200
        assert json.loads(detail.json()["text"])["title"] == EXAMPLE_BOARD["title"]
        assert client.get("/blackboards/ws-a/../secret").status_code in {400, 404}
        assert client.get("/blackboards/nope/session-one").status_code == 404


def test_archived_worker_return_is_resolved_through_its_board(tmp_path: Path):
    import pytest
    from workbench.blackboards import read_blackboard_return
    home, workspace = tmp_path / 'home', tmp_path / 'workspace'
    workspace.mkdir()
    _write_registry(home, {'ws': {'path': str(workspace), 'title': 'test'}})
    reference = '.dsh/blackboard-content/' + 'a' * 64 + '.txt'
    content_path = workspace / reference
    content_path.parent.mkdir(parents=True)
    content_path.write_text('完整返回', encoding='utf-8')
    board = {**EXAMPLE_BOARD, 'workerReturns': [{'id': 'r001', 'content': 'preview', 'contentRef': reference}]}
    _write_board(workspace, 'p', board)
    assert read_blackboard_return(home, 'ws', 'p', 'r001')['text'] == '完整返回'
    with pytest.raises(BlackboardNotFound):
        read_blackboard_return(home, 'ws', 'p', 'absent')
    board['workerReturns'][0]['contentRef'] = '../outside'
    _write_board(workspace, 'p', board)
    with pytest.raises(BlackboardBadRequest):
        read_blackboard_return(home, 'ws', 'p', 'r001')
