---
name: proxy-pool
description: Use when fuzzing or probing an HTTP API and the request times out or cannot connect — get a new egress IP from the workbench proxy pool and retry.
---

# 工作台代理池（Agent 换 IP）

工作台在 `http://127.0.0.1:8787`。代理池给 Agent 出口 IP。本地捕获口 `127.0.0.1:8088` 只记时间线，不要拿池节点去替换它。

## 何时领 IP

| 情况 | 做 |
|---|---|
| 第一次要换出口，或还没有当前节点 | `op=get` |
| 超时、连不上、代理 407 | `op=next`，`reason` 用 `timeout` / `connect` / `http_407` |
| 这次请求已经成功走出这个节点 | `op=ok` |
| HTTP 403 / 429 / 5xx | **不要** `next`（多半是目标策略） |

同一目标最多 `next` 3 次。池空（HTTP 409）就停，不要假装已经换过 IP。

## 怎么调

```sh
curl -sS -X POST http://127.0.0.1:8787/proxy-pool/agent \
  -H 'Content-Type: application/json' \
  -d '{"op":"get"}'
```

换节点：

```sh
curl -sS -X POST http://127.0.0.1:8787/proxy-pool/agent \
  -H 'Content-Type: application/json' \
  -d '{"op":"next","reason":"timeout"}'
```

看当前：`GET http://127.0.0.1:8787/proxy-pool/agent`

返回里的 `url` 是出口，例如 `http://203.0.113.10:8080`。`127.0.0.1` 不用代理。

## 怎么把流量走出这个 IP

1. **捕获已开**（环境里已有 `HTTP_PROXY=http://127.0.0.1:8088`）：先 `get`/`next`，再按原样重试请求。工作台会把后续经过 8088 的流量转到刚领的节点。不要再加一层 `-x` 指向池节点，否则时间线会丢。
2. **捕获未开**：重试用 `curl -x "$url"`（或同等 HTTP 代理设置），`$url` 来自接口返回。

不要把池节点写进模型要记的密码或报告里当「已验证生产出口」。免费节点会挂。
