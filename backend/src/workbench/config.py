from __future__ import annotations

import os
import platform
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


def _default_data_dir() -> Path:
    override = os.environ.get("WORKBENCH_DATA")
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parents[2] / "data"


def _default_dsh_home() -> Path:
    override = os.environ.get("WORKBENCH_DSH_HOME") or os.environ.get("DSH_HOME")
    if override and override.strip():
        return Path(override).expanduser().resolve()
    return Path.home() / ".dsh"


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    api_host: str = "127.0.0.1"
    api_port: int = 8787
    proxy_host: str = "127.0.0.1"
    proxy_port: int = 8088
    join_window_s: float = 8.0
    findings_file_limit: int = 20 * 1024 * 1024
    findings_total_limit: int = 100 * 1024 * 1024
    findings_manifest_limit: int = 1024 * 1024
    findings_max_files: int = 20
    findings_max_network_refs: int = 20
    body_limit: int = 1_000_000
    header_value_limit: int = 0
    url_limit: int = 2048
    dsh_root: Optional[Path] = None
    dsh_host: str = "127.0.0.1"
    dsh_port: int = 3081
    manage_dsh: bool = False
    dsh_home: Path = field(default_factory=_default_dsh_home)

    @property
    def control_db(self) -> Path:
        return self.data_dir / "control.sqlite"

    @property
    def net_db(self) -> Path:
        return self.data_dir / "net.duckdb"

    @property
    def mitm_confdir(self) -> Path:
        return self.data_dir / "mitm"

    @property
    def poc_templates_dir(self) -> Path:
        return Path(__file__).resolve().parents[2] / "pocs"

    @property
    def approval_rules_path(self) -> Path:
        return self.data_dir / "approval-rules.json"

    @property
    def dsh_approval_patch(self) -> Path:
        return Path(__file__).resolve().parents[2] / "dsh" / "approval.patch.yml"

    @property
    def dsh_hook_config(self) -> Path:
        return Path(__file__).resolve().parents[2] / "dsh" / "hooks.json"

    @property
    def dsh_hook_root(self) -> Path:
        return Path(__file__).resolve().parents[2] / "dsh"

    @property
    def hook_api_url(self) -> str:
        return "http://{}:{}".format(self.api_host, self.api_port)

    @property
    def combined_ca(self) -> Path:
        return self.data_dir / "combined-ca.pem"

    @property
    def mitm_ca(self) -> Path:
        return self.mitm_confdir / "mitmproxy-ca-cert.pem"

    @property
    def platform(self) -> str:
        return sys.platform

    @property
    def capture_supported(self) -> bool:
        return self.platform == "darwin"

    @property
    def capture_meta(self) -> dict:
        return {
            "mode": "proxy_inject",
            "scope": "http_only",
            "platform": "darwin" if self.platform == "darwin" else self.platform,
            "os": platform.system(),
        }


def _default_dsh_root() -> Path:
    override = os.environ.get("WORKBENCH_DSH_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parents[3] / "deepseek-harness"


def load_settings() -> Settings:
    dsh_root = _default_dsh_root()
    manage_raw = os.environ.get("WORKBENCH_MANAGE_DSH")
    if manage_raw is None:
        manage_dsh = dsh_root.is_dir()
    else:
        manage_dsh = manage_raw.strip() not in {"0", "false", "False", "no"}
    settings = Settings(
        data_dir=_default_data_dir(),
        api_host=os.environ.get("WORKBENCH_API_HOST", "127.0.0.1"),
        api_port=int(os.environ.get("WORKBENCH_API_PORT", "8787")),
        proxy_host=os.environ.get("WORKBENCH_PROXY_HOST", "127.0.0.1"),
        proxy_port=int(os.environ.get("WORKBENCH_PROXY_PORT", "8088")),
        dsh_root=dsh_root,
        dsh_host=os.environ.get("WORKBENCH_DSH_HOST", "127.0.0.1"),
        dsh_port=int(os.environ.get("WORKBENCH_DSH_PORT", "3081")),
        manage_dsh=manage_dsh,
        dsh_home=_default_dsh_home(),
        findings_file_limit=int(os.environ.get("WORKBENCH_FINDINGS_FILE_LIMIT", 20 * 1024 * 1024)),
        findings_total_limit=int(os.environ.get("WORKBENCH_FINDINGS_TOTAL_LIMIT", 100 * 1024 * 1024)),
        findings_manifest_limit=int(os.environ.get("WORKBENCH_FINDINGS_MANIFEST_LIMIT", 1024 * 1024)),
        findings_max_files=int(os.environ.get("WORKBENCH_FINDINGS_MAX_FILES", 20)),
        findings_max_network_refs=int(os.environ.get("WORKBENCH_FINDINGS_MAX_NETWORK_REFS", 20)),
        body_limit=int(os.environ.get("WORKBENCH_BODY_LIMIT", "1000000")),
        header_value_limit=int(os.environ.get("WORKBENCH_HEADER_VALUE_LIMIT", "0")),
    )
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.mitm_confdir.mkdir(parents=True, exist_ok=True)
    return settings
