"""Capture the actual matched response as an inert, local evidence preview."""
from __future__ import annotations

import base64
from html import escape
from typing import Optional, Tuple

import httpx


def response_packet(response: httpx.Response) -> str:
    status = "{} {} {}".format(response.http_version, response.status_code, response.reason_phrase)
    headers = "\r\n".join("{}: {}".format(key, value) for key, value in response.headers.multi_items())
    return status + "\r\n" + headers + "\r\n\r\n" + response.text


def capture_response_image(url: str, method: str, packet: str) -> Tuple[Optional[str], Optional[str]]:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as runtime:
            browser = runtime.chromium.launch(headless=True)
            try:
                page = browser.new_page(viewport={"width": 1100, "height": 760}, device_scale_factor=1)
                # Render escaped response text only. Never execute the target's HTML or load its assets.
                page.route("**/*", lambda route: route.abort())
                page.set_content(
                    '<html><head><meta charset="utf-8"><style>'
                    'body{margin:0;padding:32px;background:#f5f7fb;color:#172346;font:15px monospace}'
                    'h1{font:24px sans-serif;margin:0 0 16px}p{overflow-wrap:anywhere}'
                    'pre{background:white;border:1px solid #ccd5e7;border-radius:8px;padding:20px;'
                    'white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}'
                    '</style></head><body><h1>HTTP Response Evidence</h1><p>'
                    + escape(method + ' ' + url) + '</p><pre>'
                    + escape(packet[:24000]) + '</pre>'
                    + ('<p>Preview limited to 24000 characters. See body for full response.</p>' if len(packet) > 24000 else '')
                    + '</body></html>', timeout=10000,
                )
                # Fixed viewport bounds PNG size; the full decoded packet remains available in body.
                data = page.screenshot(type="png", timeout=10000)
                return "data:image/png;base64," + base64.b64encode(data).decode("ascii"), None
            finally:
                browser.close()
    except Exception as exc:
        return None, "响应截图生成失败（{}），请确认已安装 Playwright Chromium。".format(type(exc).__name__)
