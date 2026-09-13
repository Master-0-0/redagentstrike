"""PoC transport with bounded, observable proxy-pool rotation."""
from typing import Optional
from urllib.parse import urlsplit

import httpx

from .proxypool import PoolEmpty, ProxyPool


class PocTransportError(Exception):
    def __init__(self, error, attempts):
        self.error = error
        self.attempts = attempts
        super().__init__(error)


def send_request(client, pool: Optional[ProxyPool], mode, timeout, method, url, recording=None, **kwargs):
    attempts = []
    excluded = []
    routes = [False] if mode == 'direct' else ([False] + [True] * 3 if mode == 'fallback' else [True] * 3)
    for use_proxy in routes:
        lease = None
        if use_proxy:
            try:
                if pool is None:
                    raise PoolEmpty()
                lease = pool.lease(excluded)
            except PoolEmpty:
                attempts.append({'proxy_id': None, 'lease_id': None, 'status': None, 'error': 'pool_empty', 'via': 'pool'})
                raise PocTransportError('pool_empty', attempts)
        response = None
        error = None
        proxy_host = urlsplit(lease.url).hostname if lease else None
        entry = pool.get(lease.proxy_id) if lease else None
        egress_ip = entry.last_egress_ip if entry else None
        observer = recording.hooks(lease.proxy_id if lease else None, egress_ip or proxy_host) if recording else None
        hooks = {'request': [observer.on_request], 'response': [observer.on_response]} if observer else {}
        previous_hooks = client.event_hooks
        try:
            if lease:
                with httpx.Client(proxy=lease.url, timeout=timeout, verify=True, trust_env=False, event_hooks=hooks) as proxied:
                    response = proxied.request(method, url, **kwargs)
            else:
                if observer:
                    client.event_hooks = hooks
                response = client.request(method, url, **kwargs)
            if response.status_code == 407:
                error = 'http_407'
        except httpx.RequestError as exc:
            error = type(exc).__name__
            if observer:
                observer.finish(error=error)
        finally:
            client.event_hooks = previous_hooks
        attempts.append({'proxy_id': lease.proxy_id if lease else None,
                         'proxy_host': proxy_host, 'egress_ip': egress_ip,
                         'lease_id': lease.lease_id if lease else None,
                         'status': response.status_code if response is not None else None,
                         'error': error, 'via': 'pool' if lease else 'direct'})
        if observer:
            attempts[-1]['network_requests'] = observer.events
            attempts[-1]['network_event_id'] = observer.events[-1]['network_event_id'] if observer.events else None
        if error is None:
            if lease:
                pool.ok(lease.lease_id)
            return response, attempts
        if lease:
            pool.fail(lease.lease_id, reason=error)
            excluded.append(lease.proxy_id)
    raise PocTransportError(attempts[-1]['error'], attempts)
