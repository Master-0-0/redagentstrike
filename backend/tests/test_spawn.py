def test_proxy_env_sets_proxy_and_no_proxy(settings, tmp_path):
    from workbench.spawn import proxy_env

    ca = settings.mitm_ca
    ca.parent.mkdir(parents=True, exist_ok=True)
    ca.write_text("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n")
    env = proxy_env(settings)
    assert env["HTTP_PROXY"].endswith(":18080")
    assert env["HTTPS_PROXY"] == env["HTTP_PROXY"]
    assert env["NO_PROXY"] == ""
    assert env["no_proxy"] == ""
    assert env["SSL_CERT_FILE"].endswith("combined-ca.pem")
    assert env["NODE_EXTRA_CA_CERTS"] == str(ca)
    assert env["NODE_USE_ENV_PROXY"] == "1"


def test_direct_env_strips_workbench_proxy(settings, monkeypatch):
    from workbench.spawn import direct_env, proxy_url

    monkeypatch.setenv("HTTP_PROXY", proxy_url(settings))
    monkeypatch.setenv("HTTPS_PROXY", proxy_url(settings))
    monkeypatch.setenv("NODE_USE_ENV_PROXY", "1")
    env = direct_env(settings)
    assert "HTTP_PROXY" not in env
    assert "HTTPS_PROXY" not in env
