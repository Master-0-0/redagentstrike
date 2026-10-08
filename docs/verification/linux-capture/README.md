# Linux 网络时间线捕获修复

日期：2026-10-09（Asia/Shanghai）。正式捕获支持 macOS 与 Linux，不再通过测试覆盖平台判断。

## 修改

- `Settings.capture_supported` 允许 `darwin` 和 `linux`。
- 不支持的平台返回 `capture_platform_unsupported`；前端提示改为支持 macOS/Linux。
- 原 macOS 专属冒烟测试改为跨平台的真实本地 HTTP 测试，使用真实 API 监听和 mitmproxy addon 回传，不再依赖外网，也不将启动失败跳过。
- Linux 运行测试移除临时 monkeypatch，验证正式代码的 HTTP/HTTPS、拦截、重放和捕获启停。
- 托管 Harness 测试增加开启捕获后的代理注入、关闭后的代理撤销检查。
- README 和测试镜像说明同步更新；旧兼容性报告保留为历史基线。

## 验证结果

- Debian 12 / ARM64 / Python 3.11：后端 **182 passed**，无跳过，见 [backend.log](backend.log) 与 [JUnit](backend.xml)。
- macOS / Python 3.9：平台判断、API 能力声明、不支持平台拒绝启动及真实 HTTP 捕获 **5 passed**，见 [macos-targeted.log](macos-targeted.log)。
- Linux 实际网络链路，见 [runtime-smoke.log](runtime-smoke.log)、[记录](runtime-smoke.json)：
  - HTTP 和 HTTPS 请求经过真实 mitmproxy，记录进入 DuckDB 时间线。
  - HTTPS 两段均校验证书；本地测试 TLS 服务使用测试 CA，mitmproxy 通过标准 upstream CA 选项信任它，客户端信任生成的 mitm CA。没有关闭 TLS 验证。
  - 拦截请求未到达目标；修改 URL 后放行，目标收到修改后的请求。
  - 丢弃请求未到达目标。
  - 重放经捕获代理返回 200。
  - 关闭后直连请求不增加时间线；重新开启后继续捕获。
- 托管 Harness 开关捕获时，`harness.proxied` 分别为 true/false；工作台、内嵌 Harness 和 Chromium 渲染通过，停止后端口关闭，见 [harness-smoke.log](harness-smoke.log)。

## 使用与范围

已更新本机 Docker 工作台，访问地址保持 `http://127.0.0.1:5173/`。Compose 命名数据卷保留。网络时间线中的捕获开关现在可在 Linux 上使用。

捕获范围仍为经过代理的 HTTP(S)，不包含绕过代理的工具流量、裸 TCP/UDP 或 DNS。AMD64、Ubuntu 和其他内核没有在本轮实测；真实模型服务、复杂证书钉扎和多出口轮换未做端到端验证。本次没有修改 lsof 缺失提示、Harness 非回环 ready URL 解析等独立问题。
