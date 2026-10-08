# Linux Docker 兼容性实测报告

> 本文是修复前的历史基线。Linux 捕获限制已在后续修复，最新结果见 [Linux 捕获修复记录](../linux-capture/README.md)。

测试日期：2026-10-09（Asia/Shanghai）。结论：**项目主体可在 Debian Linux ARM64 运行；当前正式代码仍不支持 Linux 网络捕获，完整 Docker 部署也需要补齐依赖与网络配置。**

## 环境与范围

- Debian 12 Bookworm，linux/arm64；Docker Desktop 的 LinuxKit 6.12.76 内核。
- Node 24.21.0、pnpm 11.7.0、Python 3.11.2、mitmproxy 11.0.2。
- 最终镜像：`ct-st3-linux-compat:debian12`，约 1.80 GB（Docker inspect Size）。
- 镜像 ID：`sha256:a7b287605f04933f361ffe35f1c85ab50725826067c6fc4e702fdc7952ddd4a7`。
- 根仓库 HEAD：`9c0c85f1a6f23651c4cac3534d40fc85fc80ccc3`；构建包含测试开始时工作区已有的未提交修改，包括启停脚本与 Harness 退出清理。
- Harness HEAD：`4165dd064531f6444d75abadb47310042e5d5865`。
- 未使用宿主模型凭据、宿主数据、特权容器或 seccomp 放宽；本轮没有修改业务代码的平台判断。

这次验证的是 Debian ARM64，不覆盖 Ubuntu、Linux AMD64、其他内核、非 root 运行或 macOS 回归。模型对话、真实目标扫描及完整 HTTPS/证书/拦截/出口轮换链路未作端到端验证；相关单元测试不能替代这些验证。

## 实际通过项

| 项目 | 结果与证据 |
|---|---|
| 干净 Linux 构建 | Web UI、Harness、四个本地插件均构建成功；[构建日志](build.log)、[最终镜像日志](build-final.log) |
| 后端测试 | **177 passed、1 skipped**；包括数据库、审批、画板、情报、成果库、报告、PoC 与代理相关测试；[日志](backend.log)、[JUnit](backend.xml) |
| 插件测试 | Cairn **34**、Intel **4**、Findings **5** 项通过；主题插件完成构建，没有单独 test 脚本 |
| 服务启停 | API、Vite、Harness 启动成功；重复启动复用进程；停止后 8787/5173/3081 端口全部关闭；[日志](harness-smoke.log) |
| 浏览器页面 | Chromium 实际加载工作台与内嵌 Harness，未捕获页面 JS 异常；[截图](workbench-linux.png)、[错误列表](browser-errors.json) |
| 截图及中文报告 | 真实 Chromium 生成 PoC 响应截图；带文泉驿字体时现有 DOCX/PDF 导出测试通过；[截图](response-evidence.png) |
| 捕获底层诊断 | 独立进程临时放开平台判断后，本地 HTTP 请求经真实 mitmproxy/addon 写入 DuckDB 时间线；[日志](runtime-smoke.log)、[响应记录](runtime-smoke.json) |
| Linux 沙箱 | 编译 Landlock 后报告 full；只读写入被拒绝，工作区写入成功；[日志](sandbox-smoke.log) |

最终干净容器的所有检查组退出码均为 0，见 [status.txt](status.txt)。其中捕获测试通过代表“成功复现原代码的平台拒绝并完成隔离诊断”，不代表正式 Linux 捕获已被启用。唯一跳过的 pytest 是明确要求 macOS 的捕获冒烟测试。

## 兼容性问题及处理

### 1. Linux 网络捕获被业务代码明确禁止：尚未兼容

`backend/src/workbench/config.py` 的 `capture_supported` 仅允许 `darwin`；`mitm.py` 在 Linux 返回 `capture_macos_only`。启用捕获失败，依赖该代理的实时流量捕获/拦截链路因此不可正常使用。

诊断证明基础 HTTP 代理到时间线链路可以在 Linux 上工作，不能据此断言完整捕获已兼容。后续需要正式扩展平台判断并验证 HTTPS CA 注入、Harness 重启代理切换、拦截/重放与出口轮换。本次没有改动这一产品行为。

### 2. 缺少 lsof 会使 Harness 启动被误判失败：镜像依赖问题

`HarnessManager` 通过 `lsof -nP -iTCP:PORT -sTCP:LISTEN` 获取进程；命令不存在时返回 None。实测 Harness 已打印 ready URL，但 `start.sh` 因查不到 pid 报“启动失败”并清理进程，见 [baseline/start.log](baseline/start.log)。

安装 `lsof` 后，启动、重复启动与停止测试通过。最终镜像已补齐；Linux `ps` 获取代理环境变量的真实进程测试也通过，见 [探测日志](font-and-process-probes.log)。

### 3. 沙箱不能只依靠普通 pnpm build：需要 Linux 原生程序和内核支持

初始镜像没有 bubblewrap，Landlock 平台包的 `bin/landlock-run` 也不存在，因此受限命令报 `SANDBOX_UNAVAILABLE`，见 [原始日志](sandbox-baseline.log)。

安装 bubblewrap 后仍失败，直接调用报 `Creating new namespace failed: Operation not permitted`，见 [探测日志](bubblewrap-probe.log)。这是本轮 Docker 默认权限的限制。

安装 `musl-tools`，在 `deepseek-harness/native/landlock-run` 执行 `pnpm run build:native` 后，Landlock 在本轮内核下可用，且实际隔离读写通过。最终镜像包含这一步；没有改成不受限执行。其他 Docker 宿主内核是否支持，必须重新探测。

### 4. 回环监听阻止容器外访问：需要部署适配

容器内部访问成功，但访问该容器网卡 IP 的 8787/5173/3081 全部连接拒绝，见 [网络探测](container-network.json)。服务默认绑定 `127.0.0.1`，端口映射不会改变监听地址。

需要将对外入口绑定 `0.0.0.0`，并整体处理前端开发服务器、API 代理、浏览器使用的 Harness URL。不能仅把 `WORKBENCH_DSH_HOST` 改为 `0.0.0.0`：当前 `READY_RE` 只识别 `127.0.0.1` 的 ready URL。这一附加风险来自源码检查，本轮没有执行修改后的跨容器访问方案。

### 5. 中文字体和 Chromium 属于必需的系统准备

容器通常没有 macOS 的 `/Library/Fonts/Arial Unicode.ttf`。实测隐藏 Linux 中文字体后 PDF 字体加载明确失败，恢复文泉驿后成功。最终镜像安装 `fonts-wqy-zenhei`；也可设置 `WORKBENCH_REPORT_FONT` 指向适用的 TrueType 字体。

Playwright 的 Python 包安装并不等于浏览器已安装。镜像执行 `python -m playwright install --with-deps chromium`，实际截图与 UI 渲染成功。

### 6. 源码镜像的构建准备：可解决，非 Linux 业务不兼容

- 去除 `.git` 后，Harness 构建默认执行 `git rev-parse HEAD` 失败，见 [失败日志](build-missing-git.log)。通过官方 `DSH_CLIENT_COMMIT_HASH` 参数解决。
- Web UI 直接引用 `dsh-cairn-search/src`，Docker 构建不能仅复制 `web-ui/`；本轮已调整复制顺序。
- 插件使用当前 CLI 的 `plugin --profile web add` 安装；最终镜像包含四插件、peer 链接和 Cairn preset。

## 复现与交付

镜像构建和运行命令见 [测试镜像说明](../../../docker/linux-compat/README.md)。测试脚本均在 `docker/linux-compat/`，最终运行不需要宿主源码挂载，只需挂载 `/results` 保存日志。诊断容器已清理，镜像保留在本机，没有推送到镜像仓库。

建议优先处理正式 Linux 捕获支持及 Docker 网络入口，然后补 Linux CI（至少 ARM64/AMD64）与真实 HTTPS、Agent 执行链路测试。当前可以确认主体功能具有 Linux 可移植性，但不能标记为完整的双平台支持。
