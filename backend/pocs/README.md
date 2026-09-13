# PoC 模板

## 网络时间线

开启“网络时间线 → 捕获”后，PoC 通过请求层回调直接记录实际发送的 HTTP 请求，不经过拦截队列，也不改变直连/代理链路。请求和响应（包括重定向、失败及每次代理轮换）逐条写入同一网络仓库，标记 `source=poc`，关联 `scan_id`、`template_id`、`attempt_index`，保存耗时、错误和代理地址。详情可查看头体，并复用重放编辑器；不会拦截或修改正在执行的扫描请求。

扫描响应返回 `scan_id` 和 `recording_warnings`；每个 `transport_attempts` 的 `network_event_id` 是最后一跳记录，`network_requests` 包含重定向各跳的记录 ID、URL、方法和序号。未捕获时 ID 为空。池为空不伪造请求记录。记录失败显示警告但不影响匹配、截图或代理重试。

只记录发送时开启捕获且绑定当前会话的请求。关闭捕获、切换会话、清空时间线会丢弃尚未完成请求的补写；清空后新发出的请求可以正常记录。新增可空的 metadata 列兼容旧网络记录。代理认证头不写入时间线和重放缓存。

命中结果含 `body`（解码后的 HTTP 状态行、响应头和正文）、`image`（PNG data URL）、`image_error`。截图由本次响应的转义文本生成，不重新请求目标、不执行响应中的脚本；截图为首屏预览，完整响应见 body。未命中时这三个字段均为空。截图失败不改变命中结论。

安装后端依赖后需运行 `backend/.venv/bin/python -m playwright install chromium` 安装截图浏览器。

扫描支持 `proxy_mode`：`fallback`（默认，直连发生请求异常或 407 后领取代理）、`pool`（从第一次请求起使用代理）、`direct`（仅直连）。通过代理池已有的领取、成功和失败接口维护租约，每个请求最多尝试三个不同代理；池为空或节点耗尽会返回请求失败，不会在强制代理模式下退回直连。普通 HTTP 4xx/5xx 仍交给 matcher 判断。每条请求的 `transport_attempts` 提供访问方式、节点 ID、租约 ID、状态码和错误，不返回代理凭据。

代理重试会重发模板请求，包括 POST；有写入副作用的模板可选择仅直连。`127.0.0.1` 目标需要部署在同机的转发代理，外部代理的回环地址不是本机服务。

代理冒烟测试（本地 Nacos 在 8848 运行时）：在 backend 目录运行 `PYTHONPATH=src .venv/bin/python scripts/smoke_poc_proxy.py`。使用临时隔离数据库及两个真实本地 HTTP 代理：领取首节点收到 407 → 回写失败 → 领取下一节点转发 Nacos → 验证命中及 image/body。代理记录和临时数据库会自动清理，不改动日常代理池。

目录结构：`产品名/模板名.yaml`。页面的 PoC 管理按产品分组，点击文件读取原始 YAML，勾选后执行扫描。

实现参考 ProjectDiscovery 的 [HTTP 模板](https://docs.projectdiscovery.io/templates/protocols/http/basic-http) 和 [Matchers](https://docs.projectdiscovery.io/templates/reference/matchers) 结构：模板加载与校验 → HTTP 请求执行 → 响应匹配 → 结果聚合。

这是工作台自有的 HTTP 模板执行器，并非完整 nuclei 引擎。支持 `id`、`info`、`http`，请求支持 `method/path/headers/body/redirects`，变量支持 `BaseURL/RootURL/Hostname`，匹配支持 `status/word/regex`、`and/or`、`negative` 以及 `body/header/all`。不支持的字段直接报错，不能直接导入全部 nuclei 模板（例如 DSL、raw、flow、extractors、headless、code 等）。

Nacos 模板由本项目编写。目标填服务根地址，如 `http://127.0.0.1:8848`，模板自带 `/nacos` 路径。默认口令模板会尝试一次 `nacos/nacos` 登录；未授权用户列表模板只读取一条记录。命中表示响应满足模板条件，应结合具体部署配置复核。

接口：`GET /poc/templates`、`GET /poc/templates/{分类/文件.yaml}`、`POST /poc/scan`。扫描请求字段为 `target/templates/timeout/concurrency`；一次最多 20 个模板，单模板最多 10 组请求、每组 10 个路径。请求超时 1–30 秒、并发 1–10。结果包括目标、耗时、每个模板的命中与请求错误、HTTP 状态及 matcher 明细。结果暂保留在当前页面，切换页面后清除。
