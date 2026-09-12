from workbench.proxycheck import CheckResult
from workbench.proxyfetch import (
    Candidate,
    ingest_public,
    is_public_host,
    parse_geonode,
    parse_text,
    purge_lab_placeholders,
)
from workbench.proxypool import ProxyPool


def test_parse_text_skips_private_and_bad_ports():
    body = "\n".join(
        [
            "1.2.3.4:8080",
            "10.0.0.8:8080",
            "9.9.9.9:99999",
            "not-an-ip:80",
            "8.8.8.8:3128",
        ]
    )
    items = parse_text(body, "proxyscrape")
    assert {(item.host, item.port) for item in items} == {
        ("1.2.3.4", 8080),
        ("8.8.8.8", 3128),
    }


def test_parse_geonode_http():
    body = """{"data":[{"ip":"9.9.9.9","port":"8000","protocols":["http","socks4"]}]}"""
    items = parse_geonode(body, "geonode")
    assert items == [Candidate("http", "9.9.9.9", 8000, "geonode")]


def test_is_public_host():
    assert is_public_host("1.1.1.1") is True
    assert is_public_host("10.0.0.8") is False
    assert is_public_host("192.168.1.1") is False
    assert is_public_host("127.0.0.1") is False
    assert is_public_host("proxy.example") is False


def test_ingest_keeps_only_live_and_purges_lab(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    pool.add("http", "10.0.0.8", 8080)
    pool.add("http", "10.0.0.9", 8081)

    def puller():
        return (
            [
                Candidate("http", "1.2.3.4", 8080, "proxyscrape"),
                Candidate("http", "4.4.4.4", 8080, "geonode"),
                Candidate("http", "5.5.5.5", 8080, "geonode"),
            ],
            [],
            ["proxyscrape", "geonode"],
        )

    def checker(entry, timeout=None):
        ok = entry.host != "4.4.4.4"
        return CheckResult(
            ok=ok,
            latency_ms=90 if ok else 3500,
            egress_ip="198.51.100.1" if ok else None,
            error=None if ok else "timeout",
            url="http://api.ipify.org",
        )

    report = ingest_public(pool, limit=8, checker=checker, puller=puller)
    assert report.purged == 2
    assert report.tried == 3
    assert report.added == 2
    hosts = {entry.host for entry in pool.list_entries()}
    assert hosts == {"1.2.3.4", "5.5.5.5"}
    assert all(entry.source == "public" for entry in pool.list_entries())
    assert all(entry.last_check_ok is True for entry in pool.list_entries())
    pool.close()


def test_ingest_skips_existing(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    pool.add("http", "1.2.3.4", 8080, source="manual")

    def puller():
        return ([Candidate("http", "1.2.3.4", 8080, "proxyscrape")], [], ["proxyscrape"])

    def checker(entry, timeout=None):
        raise AssertionError("should not validate an existing node")

    report = ingest_public(pool, checker=checker, puller=puller, purge_lab=False)
    assert report.skipped == 1
    assert report.added == 0
    assert pool.list_entries()[0].source == "manual"
    pool.close()


def test_purge_lab_placeholders(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    pool.add("http", "10.0.0.8", 8080)
    keep = pool.add("http", "8.8.8.8", 3128)
    assert purge_lab_placeholders(pool) == 1
    assert [entry.id for entry in pool.list_entries()] == [keep.id]
    pool.close()
