from workbench.redact import decode_body, plain_headers, truncate_body


def test_truncates_and_marks_binary():
    text = truncate_body("x" * 5000, limit=20)
    assert text.startswith("x" * 20)
    assert "truncated" in text
    binary = truncate_body(b"\x00\x01\x02" + b"\xff" * 40)
    assert binary.startswith("[binary")


def test_plain_headers_and_decode_body_keep_secrets_and_full_text():
    out = plain_headers({"Authorization": "Bearer secret-token", "X-Long": "n" * 2000})
    assert out["Authorization"] == "Bearer secret-token"
    assert out["X-Long"] == "n" * 2000
    assert decode_body("x" * 5000) == "x" * 5000
    assert decode_body(b"\x00\xff") == "\x00\xff"
