from threading import Thread
import time

from workbench.intercept import HoldBoard


def test_passthrough_when_disabled():
    board = HoldBoard()
    decision = board.hold({"method": "GET", "url": "http://a.test/", "headers": {}, "body": ""})
    assert decision["action"] == "forward"
    assert decision["url"] == "http://a.test/"
    assert board.status()["pending_count"] == 0


def test_forward_can_edit_request():
    board = HoldBoard(wait_s=2)
    board.set_enabled(True)
    result = {}

    def worker():
        result["d"] = board.hold(
            {"method": "GET", "url": "http://a.test/", "headers": {"A": "1"}, "body": ""}
        )

    thread = Thread(target=worker)
    thread.start()
    item = None
    for _ in range(40):
        pending = board.status()["pending"]
        if pending:
            item = pending[0]
            break
        time.sleep(0.05)
    assert item is not None
    board.forward(
        item["id"],
        {"method": "POST", "url": "http://b.test/x", "headers": {"X": "1"}, "body": "hi"},
    )
    thread.join(timeout=2)
    assert result["d"]["action"] == "forward"
    assert result["d"]["method"] == "POST"
    assert result["d"]["url"] == "http://b.test/x"
    assert result["d"]["body"] == "hi"


def test_drop_and_disable_releases_queue():
    board = HoldBoard(wait_s=2)
    board.set_enabled(True)
    result = {}

    def worker():
        result["d"] = board.hold({"method": "GET", "url": "http://a.test/", "headers": {}, "body": ""})

    thread = Thread(target=worker)
    thread.start()
    for _ in range(40):
        if board.status()["pending"]:
            break
        time.sleep(0.05)
    board.set_enabled(False)
    thread.join(timeout=2)
    assert result["d"]["action"] == "forward"
    assert board.status()["pending_count"] == 0
