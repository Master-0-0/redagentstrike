# PoC 模板

命中结果含 `body`（解码后的 HTTP 状态行、响应头和正文）、`image`（PNG data URL）、`image_error`。截图由本次响应的转义文本生成，不重新请求目标、不执行响应中的脚本；截图为首屏预览，完整响应见 body。未命中时这三个字段均为空。截图失败不改变命中结论。

安装后端依赖后需运行 `backend/.venv/bin/python -m playwright install chromium` 安装截图浏览器。

目录结构：`产品名/模板名.yaml`。页面的 PoC 管理按产品分组，点击文件读取原始 YAML，勾选后执行扫描。

实现参考 ProjectDiscovery 的 [HTTP 模板](https://docs.projectdiscovery.io/templates/protocols/http/basic-http) 和 [Matchers](https://docs.projectdiscovery.io/templates/reference/matchers) 结构：模板加载与校验 → HTTP 请求执行 → 响应匹配 → 结果聚合。

这是工作台自有的 HTTP 模板执行器，并非完整 nuclei 引擎。支持 `id`、`info`、`http`，请求支持 `method/path/headers/body/redirects`，变量支持 `BaseURL/RootURL/Hostname`，匹配支持 `status/word/regex`、`and/or`、`negative` 以及 `body/header/all`。不支持的字段直接报错，不能直接导入全部 nuclei 模板（例如 DSL、raw、flow、extractors、headless、code 等）。

Nacos 模板由本项目编写。目标填服务根地址，如 `http://127.0.0.1:8848`，模板自带 `/nacos` 路径。默认口令模板会尝试一次 `nacos/nacos` 登录；未授权用户列表模板只读取一条记录。命中表示响应满足模板条件，应结合具体部署配置复核。

接口：`GET /poc/templates`、`GET /poc/templates/{分类/文件.yaml}`、`POST /poc/scan`。扫描请求字段为 `target/templates/timeout/concurrency`；一次最多 20 个模板，单模板最多 10 组请求、每组 10 个路径。请求超时 1–30 秒、并发 1–10。结果包括目标、耗时、每个模板的命中与请求错误、HTTP 状态及 matcher 明细。结果暂保留在当前页面，切换页面后清除。
