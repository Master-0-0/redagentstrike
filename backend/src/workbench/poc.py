from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import re
import time
from typing import Any, Dict, Iterable, List
from urllib.parse import urlsplit

import httpx
import yaml
from .poc_evidence import capture_response_image, response_packet


class TemplateError(ValueError):
    pass


def list_templates(root: Path) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    if not root.is_dir():
        return items
    for file in sorted(file for file in root.rglob("*") if file.suffix in {".yaml", ".yml"}):
        try:
            template = _load_file(root, file.relative_to(root).as_posix())
        except (OSError, TemplateError):
            continue
        items.append(_summary(file.relative_to(root).as_posix(), template))
    return items


def read_template(root: Path, template_id: str) -> Dict[str, Any]:
    file = _resolve(root, template_id)
    try:
        content = file.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise KeyError("template_not_found") from exc
    try:
        template = yaml.safe_load(content)
    except yaml.YAMLError as exc:
        raise TemplateError("template_yaml_invalid") from exc
    _validate(template)
    return {**_summary(template_id, template), "content": content}


def scan_templates(
    root: Path,
    target: str,
    template_ids: Iterable[str],
    timeout: float = 10.0,
    concurrency: int = 4,
) -> Dict[str, Any]:
    base_url = _normalize_target(target)
    unique_ids = list(dict.fromkeys(str(item) for item in template_ids))
    if not unique_ids:
        raise TemplateError("templates_required")
    if len(unique_ids) > 20:
        raise TemplateError("too_many_templates")
    timeout = min(max(float(timeout), 1.0), 30.0)
    concurrency = min(max(int(concurrency), 1), 10)
    loaded = [(template_id, _load_file(root, template_id)) for template_id in unique_ids]
    started = time.perf_counter()
    results: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(concurrency, len(loaded))) as pool:
        futures = {
            pool.submit(_scan_one, base_url, template_id, template, timeout): template_id
            for template_id, template in loaded
        }
        for future in as_completed(futures):
            results.append(future.result())
    order = {template_id: index for index, template_id in enumerate(unique_ids)}
    results.sort(key=lambda item: order[item["template_id"]])
    return {
        "target": base_url,
        "duration_ms": round((time.perf_counter() - started) * 1000),
        "matched": sum(1 for item in results if item["matched"]),
        "total": len(results),
        "results": results,
    }


def _scan_one(
    base_url: str,
    template_id: str,
    template: Dict[str, Any],
    timeout: float,
) -> Dict[str, Any]:
    info = template["info"]
    attempts: List[Dict[str, Any]] = []
    matched = False
    evidence_body = None
    evidence_image = None
    image_error = None
    with httpx.Client(timeout=timeout, verify=True, trust_env=False) as client:
        for request in template["http"]:
            method = str(request.get("method", "GET")).upper()
            paths = request.get("path") or []
            if isinstance(paths, str):
                paths = [paths]
            for raw_path in paths:
                url = _render(str(raw_path), base_url)
                headers = {
                    str(key): _render(str(value), base_url)
                    for key, value in (request.get("headers") or {}).items()
                }
                body = _render(str(request.get("body", "")), base_url)
                began = time.perf_counter()
                try:
                    response = client.request(
                        method,
                        url,
                        headers=headers,
                        content=body.encode("utf-8") if body else None,
                        follow_redirects=bool(request.get("redirects", False)),
                    )
                    matcher_results = _match_response(response, request)
                    attempt_matched = _combine(
                        [item["matched"] for item in matcher_results],
                        str(request.get("matchers-condition", "or")),
                    )
                    attempts.append({
                        "url": str(response.url),
                        "method": method,
                        "status": response.status_code,
                        "duration_ms": round((time.perf_counter() - began) * 1000),
                        "matched": attempt_matched,
                        "matchers": matcher_results,
                        "error": None,
                    })
                    if attempt_matched:
                        matched = True
                        evidence_body = response_packet(response)
                        evidence_image, image_error = capture_response_image(str(response.url), method, evidence_body)
                        break
                except httpx.RequestError as exc:
                    attempts.append({
                        "url": url,
                        "method": method,
                        "status": None,
                        "duration_ms": round((time.perf_counter() - began) * 1000),
                        "matched": False,
                        "matchers": [],
                        "error": exc.__class__.__name__,
                    })
            if matched:
                break
    return {
        "template_id": template_id,
        "id": template["id"],
        "name": info["name"],
        "severity": str(info.get("severity", "info")),
        "matched": matched,
        "body": evidence_body,
        "image": evidence_image,
        "image_error": image_error,
        "attempts": attempts,
    }


def _match_response(response: httpx.Response, request: Dict[str, Any]) -> List[Dict[str, Any]]:
    body = response.text
    headers = "\n".join(f"{key}: {value}" for key, value in response.headers.items())
    out: List[Dict[str, Any]] = []
    for matcher in request.get("matchers") or []:
        kind = str(matcher.get("type", "word"))
        part = str(matcher.get("part", "body"))
        haystack = headers if part in {"header", "headers"} else body
        if part == "all":
            haystack = headers + "\n\n" + body
        if kind == "status":
            values = [int(value) for value in matcher.get("status") or []]
            hit = response.status_code in values
            detail = "status in {}".format(values)
        elif kind == "regex":
            values = [str(value) for value in matcher.get("regex") or []]
            hits = [re.search(value, haystack, re.MULTILINE) is not None for value in values]
            hit = _combine(hits, str(matcher.get("condition", "or")))
            detail = "{} regex".format(len(values))
        else:
            values = [str(value) for value in matcher.get("words") or []]
            hits = [value in haystack for value in values]
            hit = _combine(hits, str(matcher.get("condition", "or")))
            detail = "{} word".format(len(values))
        if matcher.get("negative"):
            hit = not hit
        out.append({"type": kind, "part": part, "matched": hit, "detail": detail})
    return out


def _combine(values: List[bool], condition: str) -> bool:
    if not values:
        return False
    return all(values) if condition.lower() == "and" else any(values)


def _normalize_target(target: str) -> str:
    value = target.strip()
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError as exc:
        raise TemplateError("target_invalid") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.query or parsed.fragment:
        raise TemplateError("target_invalid")
    return value.rstrip("/")


def _render(value: str, base_url: str) -> str:
    parsed = urlsplit(base_url)
    root_url = "{}://{}".format(parsed.scheme, parsed.netloc)
    replacements = {
        "{{BaseURL}}": base_url,
        "{{RootURL}}": root_url,
        "{{Hostname}}": parsed.netloc,
    }
    for key, replacement in replacements.items():
        value = value.replace(key, replacement)
    return value


def _load_file(root: Path, template_id: str) -> Dict[str, Any]:
    file = _resolve(root, template_id)
    try:
        template = yaml.safe_load(file.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise KeyError("template_not_found") from exc
    except yaml.YAMLError as exc:
        raise TemplateError("template_yaml_invalid") from exc
    _validate(template)
    return template


def _resolve(root: Path, template_id: str) -> Path:
    if not template_id.endswith((".yaml", ".yml")):
        raise TemplateError("template_id_invalid")
    root = root.resolve()
    file = (root / template_id).resolve()
    if root not in file.parents:
        raise TemplateError("template_id_invalid")
    return file


def _validate(template: Any) -> None:
    if not isinstance(template, dict):
        raise TemplateError("template_invalid")
    if not isinstance(template.get("id"), str) or not template["id"]:
        raise TemplateError("template_id_missing")
    info = template.get("info")
    if not isinstance(info, dict) or not isinstance(info.get("name"), str):
        raise TemplateError("template_info_invalid")
    requests = template.get("http")
    if not isinstance(requests, list) or not requests:
        raise TemplateError("template_http_missing")
    if set(template) - {"id", "info", "http"}:
        raise TemplateError("template_unsupported_field")
    if len(requests) > 10:
        raise TemplateError("template_request_limit")
    for request in requests:
        if not isinstance(request, dict) or set(request) - {"method", "path", "headers", "body", "redirects", "matchers-condition", "matchers"}:
            raise TemplateError("template_http_unsupported")
        paths = request.get("path")
        if not isinstance(paths, list) or not 1 <= len(paths) <= 10:
            raise TemplateError("template_paths_invalid")
        if any(not isinstance(path, str) or not path.startswith(("{{BaseURL}}", "{{RootURL}}")) for path in paths):
            raise TemplateError("template_paths_invalid")
        if request.get("method", "GET") not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}:
            raise TemplateError("template_method_invalid")
        if not isinstance(request.get("headers", {}), dict) or not isinstance(request.get("body", ""), str):
            raise TemplateError("template_request_invalid")
        if request.get("matchers-condition", "or") not in {"and", "or"}:
            raise TemplateError("template_condition_invalid")
        if not isinstance(request.get("redirects", False), bool):
            raise TemplateError("template_redirects_invalid")
        matchers = request.get("matchers")
        if not isinstance(matchers, list) or not matchers:
            raise TemplateError("template_matchers_missing")
        for matcher in matchers:
            if not isinstance(matcher, dict) or set(matcher) - {"type", "part", "status", "words", "regex", "condition", "negative"}:
                raise TemplateError("template_matcher_unsupported")
            kind = matcher.get("type")
            if kind not in {"status", "word", "regex"}:
                raise TemplateError("template_matcher_unsupported")
            values = matcher.get({"status": "status", "word": "words", "regex": "regex"}[kind])
            if not isinstance(values, list) or not values:
                raise TemplateError("template_matcher_values_invalid")
            if any(not isinstance(value, int if kind == "status" else str) for value in values):
                raise TemplateError("template_matcher_values_invalid")
            if matcher.get("condition", "or") not in {"and", "or"} or matcher.get("part", "body") not in {"body", "header", "headers", "all"}:
                raise TemplateError("template_matcher_condition_invalid")
            if not isinstance(matcher.get("negative", False), bool):
                raise TemplateError("template_matcher_negative_invalid")
            if kind == "regex":
                try:
                    for value in values:
                        re.compile(value)
                except re.error as exc:
                    raise TemplateError("template_regex_invalid") from exc


def _summary(template_id: str, template: Dict[str, Any]) -> Dict[str, Any]:
    info = template["info"]
    category = template_id.split("/", 1)[0] if "/" in template_id else "其他"
    tags = info.get("tags") or []
    if isinstance(tags, str):
        tags = [item.strip() for item in tags.split(",") if item.strip()]
    return {
        "template_id": template_id,
        "category": category,
        "id": template["id"],
        "name": info["name"],
        "severity": str(info.get("severity", "info")),
        "author": str(info.get("author", "")),
        "description": str(info.get("description", "")),
        "tags": tags,
    }
