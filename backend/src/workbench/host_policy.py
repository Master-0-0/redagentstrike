"""Persistent host rules shared by the control plane and the capture proxy."""
from __future__ import annotations

import ipaddress
import json
import os
import re
import tempfile
from pathlib import Path


def normalize_host(value: str) -> str:
    host = value.strip().lower().rstrip('.')
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    try:
        host = host.encode('idna').decode('ascii')
    except UnicodeError:
        raise ValueError('无效 host：' + value)
    if len(host) > 253 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part) for part in host.split('.')):
        raise ValueError('无效 host：' + value + '（请填写域名或 IP，不含协议、端口和路径）')
    return host


def parse_rules(text: str) -> list:
    rules = []
    for item in re.split(r'[\s,，;；]+', text.strip()):
        if not item:
            continue
        suffix = item.startswith('.')
        host = normalize_host(item[1:] if suffix else item)
        if suffix:
            try:
                ipaddress.ip_address(host)
            except ValueError:
                pass
            else:
                raise ValueError('IP 地址不能作为域名后缀：' + item)
        rule = ('.' if suffix else '') + host
        if rule not in rules:
            rules.append(rule)
    return rules


def load_policy(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {'whitelist': [], 'blacklist': []}
    return {key: parse_rules('\n'.join(data[key])) for key in ('whitelist', 'blacklist')}


def save_policy(path: Path, whitelist: str, blacklist: str) -> dict:
    data = {'whitelist': parse_rules(whitelist), 'blacklist': parse_rules(blacklist)}
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.host-policy-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return data


def matches(host: str, rule: str) -> bool:
    if rule.startswith('.'):
        return host == rule[1:] or host.endswith(rule)
    return host == rule


def blocked_reason(host: str, policy: dict) -> str:
    host = normalize_host(host)
    if any(matches(host, rule) for rule in policy['blacklist']):
        return '命中 host 黑名单'
    return ''
