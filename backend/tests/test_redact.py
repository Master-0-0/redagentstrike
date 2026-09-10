from workbench.redact import decode_body, plain_headers, redact_headers, redact_url, truncate_body


def test_redacts_authorization_and_cookie():
    out = redact_headers(
        {
            "Authorization": "Bearer secret-token",
            "Cookie": "sid=abc",
            "Content-Type": "application/json",
        }
    )
    assert out["Authorization"] == "[redacted]"
    assert out["Cookie"] == "[redacted]"
    assert out["Content-Type"] == "application/json"


def test_redacts_query_token():
    url = redact_url("https://api.example.com/v1?token=supersecret&q=1")
    assert "supersecret" not in url
    assert "token=%5Bredacted%5D" in url or "token=[redacted]" in url
    assert "q=1" in url


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
