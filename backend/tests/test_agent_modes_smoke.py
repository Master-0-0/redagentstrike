from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
SHIPPED = ROOT / "deepseek-harness" / "packages" / "preset" / "agent-presets" / "presets"
CAIRN = ROOT / "dsh-cairn-search" / "preset" / "agent.cordis.yml"

# Every Agent mode that can fuzz HTTP and call the workbench pool.
MODES = (
    ("standard", SHIPPED / "standard" / "agent.cordis.yml", True),
    ("ptc", SHIPPED / "ptc" / "agent.cordis.yml", True),
    ("minimal", SHIPPED / "minimal" / "agent.cordis.yml", False),
    ("cordis", SHIPPED / "cordis" / "agent.cordis.yml", True),
    ("cairn", CAIRN, True),
)


def test_each_mode_has_a_shell_that_can_call_the_pool():
    for name, path, has_skill in MODES:
        text = path.read_text(encoding="utf-8")
        assert path.is_file(), name
        assert (
            "dsh-tool-bash" in text or "dsh-tool-bash-persistent" in text
        ), "{} has no bash tool".format(name)
        if has_skill:
            assert "dsh-tool-skill" in text, "{} has no skill tool".format(name)
        if name == "cairn":
            assert "proxy-pool" in text, "cairn persona must mention the pool skill"


def test_live_agent_get_from_each_mode_shell_command(client):
    """Same curl every mode's shell would run. One get, then next, then ok."""
    client.post("/proxy-pool", json={"scheme": "http", "host": "1.1.1.1", "port": 8001})
    client.post("/proxy-pool", json={"scheme": "http", "host": "2.2.2.2", "port": 8002})
    first = None
    for name, _path, _skill in MODES:
        got = client.post("/proxy-pool/agent", json={"op": "get"})
        assert got.status_code == 200, name
        body = got.json()
        assert body.get("url"), name
        if first is None:
            first = body["lease_id"]
        else:
            assert body["lease_id"] == first, name
    rotated = client.post("/proxy-pool/agent", json={"op": "next", "reason": "timeout"})
    assert rotated.status_code == 200
    assert rotated.json()["lease_id"] != first
    assert client.post("/proxy-pool/agent", json={"op": "ok"}).status_code == 200
