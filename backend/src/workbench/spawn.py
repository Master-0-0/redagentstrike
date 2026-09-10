from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Dict, Optional

import certifi

from .config import Settings


def proxy_env(settings: Settings, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Environment for a spawned tool that should send HTTP(S) through mitm."""
    env = dict(os.environ)
    if extra:
        env.update(extra)
    proxy = "http://{}:{}".format(settings.proxy_host, settings.proxy_port)
    env["HTTP_PROXY"] = proxy
    env["HTTPS_PROXY"] = proxy
    env["http_proxy"] = proxy
    env["https_proxy"] = proxy
    env["NO_PROXY"] = "127.0.0.1,localhost,::1"
    env["no_proxy"] = env["NO_PROXY"]
    env["NODE_USE_ENV_PROXY"] = "1"
    ca = ensure_combined_ca(settings)
    if ca is not None:
        env["SSL_CERT_FILE"] = str(ca)
        env["REQUESTS_CA_BUNDLE"] = str(ca)
        env["CURL_CA_BUNDLE"] = str(ca)
        env["GIT_SSL_CAINFO"] = str(ca)
        env["AWS_CA_BUNDLE"] = str(ca)
    if settings.mitm_ca.exists():
        env["NODE_EXTRA_CA_CERTS"] = str(settings.mitm_ca)
    return env


def ensure_combined_ca(settings: Settings) -> Optional[Path]:
    if not settings.mitm_ca.exists():
        return None
    mitm = settings.mitm_ca.read_text(encoding="utf-8")
    system = Path(certifi.where()).read_text(encoding="utf-8")
    settings.combined_ca.write_text(system.rstrip() + "\n" + mitm, encoding="utf-8")
    return settings.combined_ca


def which_curl() -> Optional[str]:
    return shutil.which("curl")


def proxy_url(settings: Settings) -> str:
    return "http://{}:{}".format(settings.proxy_host, settings.proxy_port)


def direct_env(settings: Settings, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Environment with this workbench proxy stripped, so DSH can reach the network after capture stops."""
    env = dict(os.environ)
    if extra:
        env.update(extra)
    ours = proxy_url(settings)
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        if env.get(key) == ours:
            env.pop(key, None)
    if env.get("NODE_EXTRA_CA_CERTS") == str(settings.mitm_ca):
        env.pop("NODE_EXTRA_CA_CERTS", None)
    for key in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "AWS_CA_BUNDLE"):
        if env.get(key) == str(settings.combined_ca):
            env.pop(key, None)
    if env.get("NODE_USE_ENV_PROXY") == "1" and "HTTP_PROXY" not in env and "http_proxy" not in env:
        env.pop("NODE_USE_ENV_PROXY", None)
    return env
