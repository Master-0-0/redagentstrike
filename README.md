# 渗透 Agent 工作台

单机渗透测试 Agent 工作台：把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 嵌进侧栏，并补上审批、画板、HTTP 网络时间线、PoC 扫描和出口代理池。

MVP 面向 **macOS 本机自用**。控制面与 Web 默认只绑 `127.0.0.1`，不是多用户远程产品。仅在你有权测试的环境上使用。

## 它做什么

| 页面 | 作用 |
|---|---|
| Agent 工作台 | iframe 嵌入本地 `dsh web`（默认 `127.0.0.1:3081`） |
| 画板展示 | 读取 Cairn 搜索会话的 fact-intent 图 |
| 审批 | 高危 shell 命令进队，人工允许一次或拒绝 |
| 证据 | 占位：按 Run 浏览产物（尚未接真数据） |
| 网络时间线 | 经本地 mitm 的 HTTP(S) 捕获、拦截、重放 |
| poc 扫描 | 工作台自有 YAML HTTP 模板（不是完整 nuclei） |
| 代理池 | 手工/公开源条目；fuzz 超时后换出口 IP |
| 设置 | 填写 Harness 带 token 的地址 |

捕获打开时，工作台会重启本地 Harness，并注入 `HTTP_PROXY=http://127.0.0.1:8088` 与 mitm CA。关掉捕获后会去掉代理，避免模型请求卡在已停的代理上。

```
web-ui :5173  ──/api──►  workbench API :8787
                 └──/__dsh──►  dsh web :3081
工具 HTTP(S) ──► mitmdump :8088 ──► DuckDB 时间线
                      └── upstream ──► 代理池条目（可选）
```

## 仓库结构

```
backend/              FastAPI 控制面 + DuckDB 网络仓 + mitm addon
web-ui/                React 壳（Vite）
deepseek-harness/      DeepSeek Harness 源码（git submodule）
dsh-cairn-search/      Cairn 搜索：blackboard 工具 + 侧栏图 + cairn preset
dsh-theme-hacker/      Harness Web 主题
vulhub-nacos-cve-2021-29441/   可选本地 Nacos 靶场（CVE-2021-29441）
.dsh/skills/proxy-pool/        Agent 换 IP 的 skill（启动 API 时复制到 ~/.dsh）
```

本地数据默认写在 `backend/data/`（已 gitignore）：`control.sqlite`、`net.duckdb`、mitm CA、`dsh-web.log`。

## 环境要求

- macOS（网络捕获仅 darwin；其它平台 API 可起，捕获会报 `capture_macos_only`）
- Python 3.9+
- Node.js `^22.19` 或 `>=24`，以及 [pnpm](https://pnpm.io/) 11.x
- 可选：`mitmdump`（捕获）、Docker（Nacos 靶场）、Chromium（PoC 命中截图）

## 部署（本机安装）

在仓库根目录执行。首次需要拉 submodule 并构建 Harness。

### 1. 克隆

```sh
git clone --recurse-submodules <本仓库 URL>
cd ct-st3
```

若已经克隆但没有 submodule：

```sh
git submodule update --init --recursive
```

### 2. DeepSeek Harness

```sh
cd deepseek-harness
pnpm install
pnpm run build
cd ..
```

模型密钥在工作台「Agent 工作台」内打开 **Settings → Models** 填写，写入 `~/.dsh/.credentials.yaml`，不要提交到 git。也可事先 `export DEEPSEEK_API_KEY=...`。

### 3. Harness 插件与 Cairn preset

```sh
(cd dsh-cairn-search && npm install && npm run build)
(cd dsh-theme-hacker && npm install && npm run build)

cd deepseek-harness
pnpm dsh plugin add ../dsh-cairn-search
pnpm dsh plugin add ../dsh-theme-hacker
cd ..

mkdir -p ~/.dsh/.agent-presets/cairn
cp -R dsh-cairn-search/preset/. ~/.dsh/.agent-presets/cairn/
```

`dsh-cairn-search` 的 `postinstall` 会把 `@deepseek-ai/dsh-tools` / `cordis` 链到 `~/.dsh/profiles/node_modules`。若链接失败，先完成上一步的 `plugin add`，再在插件目录执行 `npm run link-peers`。

### 4. 后端

```sh
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m playwright install chromium
cd ..
```

捕获需要独立的 mitmproxy（避免和 FastAPI 依赖打架）：

```sh
python3 -m venv backend/.venv-mitm
backend/.venv-mitm/bin/pip install mitmproxy
```

工作台会按顺序找 `WORKBENCH_MITMDUMP`、`backend/.venv-mitm/bin/mitmdump`、当前解释器旁的 `mitmdump`、PATH 上的 `mitmdump`。

### 5. 前端

```sh
cd web-ui
npm install
cd ..
```

### 6. 启动

开两个终端（仓库根目录）：

```sh
# 终端 1：控制面；若存在 deepseek-harness/，默认会拉起 dsh web :3081
backend/.venv/bin/python -m workbench
```

```sh
# 终端 2：工作台 UI
cd web-ui && npm run dev
```

浏览器打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。侧栏「Harness 在线」亮起即可。打开捕获时 Harness 会带新 token 重启，设置页会自动跟上。

健康检查：`curl -sS http://127.0.0.1:8787/health`

### 端口

| 服务 | 默认地址 |
|---|---|
| 工作台 UI | `http://127.0.0.1:5173` |
| 控制面 API | `http://127.0.0.1:8787` |
| DeepSeek Harness | `http://127.0.0.1:3081` |
| 捕获代理（mitm regular） | `http://127.0.0.1:8088` |

Vite 把 `/api` 转到 8787、`/__dsh` 转到 3081。CORS 只放行 `127.0.0.1:5173` / `localhost:5173`。不要把这些端口暴露到公网。

### 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `WORKBENCH_API_HOST` / `WORKBENCH_API_PORT` | `127.0.0.1` / `8787` | 控制面监听 |
| `WORKBENCH_PROXY_HOST` / `WORKBENCH_PROXY_PORT` | `127.0.0.1` / `8088` | mitm 监听 |
| `WORKBENCH_DSH_HOST` / `WORKBENCH_DSH_PORT` | `127.0.0.1` / `3081` | 托管的 `dsh web` |
| `WORKBENCH_DSH_ROOT` | 仓库内 `deepseek-harness/` | Harness 源码根 |
| `WORKBENCH_DSH_HOME` / `DSH_HOME` | `~/.dsh` | Harness 用户目录（画板、凭据、preset） |
| `WORKBENCH_DATA` | `backend/data/` | SQLite / DuckDB / mitm 配置 |
| `WORKBENCH_MANAGE_DSH` | 有 `dsh` 源码则为开 | 是否由工作台启停 Harness |
| `WORKBENCH_MITMDUMP` | （自动查找） | `mitmdump` 可执行文件 |
| `VITE_API_ORIGIN` | `http://127.0.0.1:8787` | 前端开发代理目标 |
| `VITE_DSH_ORIGIN` | `http://127.0.0.1:3081` | 前端探测 Harness 用 |

生产向本机部署时：保持绑定环回地址、把 `WORKBENCH_DATA` 指到可备份目录、不要提交 `.env` / `.env.local`。前端可 `cd web-ui && npm run build`，再用 `npm run preview` 或任意静态服务器托管 `web-ui/dist`，并保证 `/api`、`/__dsh` 仍能转到本机 API 与 Harness。当前仓库没有容器编排；捕获链路依赖本机 spawn 与环回 mitm，不要把工具放在 Docker Desktop 的 Linux VM 里却在 Mac 宿主抓包，时间线会空。

关掉托管的 Harness：

```sh
WORKBENCH_MANAGE_DSH=0 backend/.venv/bin/python -m workbench
```

然后自己在 `deepseek-harness/` 里 `pnpm dsh web --host 127.0.0.1 --port 3081 --no-open`，把打印出的带 token URL 填进设置。

## 使用

1. 打开工作台，确认 Harness 在线；在内嵌页面配置模型。
2. 新会话可选 **Cairn 搜索** preset：Agent 用 `blackboard` 写 `<工作区>/.dsh/blackboards/<主会话 id>.json`，侧栏「画板展示」会列出已登记工作区里的图。
3. **审批**：在页面里加命令或正则规则。匹配到的 `bash` / `pwsh` 会停住，直到你允许一次或拒绝。Hook 由工作台以 `--patch backend/dsh/approval.patch.yml` 挂上。
4. **网络时间线**：开「捕获」后，尊重 `HTTP_PROXY` 的 HTTP(S) 会进 DuckDB。可拦截、丢弃、改草稿重放。忽略代理的工具、裸 TCP/UDP、DNS **不会**出现。证书钉扎可能只有失败的 CONNECT、没有响应体。
5. **代理池**：录入或「从公开源拉取」（测活失败不入库）。池条目只做 **upstream 出口**，不替换 `8088`。池空时 fuzz 仍走本机 IP（若捕获开着则仍过 mitm）。Agent 换 IP：`POST http://127.0.0.1:8787/proxy-pool/agent`（见 `.dsh/skills/proxy-pool/SKILL.md`）。
6. **poc 扫描**：勾选 `backend/pocs/` 下模板，目标填服务根，例如 `http://127.0.0.1:8848`。`proxy_mode` 为 `fallback`（默认）、`pool`、`direct`。捕获开启时扫描请求会写入时间线（`source=poc`）。这不是完整 nuclei：不支持 DSL、raw、flow、extractors 等字段。

更细的捕获与代理池约定见 [报告.md](./报告.md)、[代理池.md](./代理池.md)、[backend/pocs/README.md](./backend/pocs/README.md)。

### 可选：本地 Nacos 靶场

仅用于你自己机器上的授权实验：

```sh
cd vulhub-nacos-cve-2021-29441/nacos/CVE-2021-29441
docker compose up -d
```

控制台：`http://127.0.0.1:8848/nacos/`。测完：`docker compose down -v`。

## 测试

```sh
cd backend
.venv/bin/pytest
```

需要本机 `mitmdump` 的捕获冒烟：`tests/test_smoke_macos.py`。PoC 经真实本地代理打 Nacos 的脚本：`PYTHONPATH=src .venv/bin/python scripts/smoke_poc_proxy.py`（Nacos 需在 8848 监听）。

Cairn 插件：

```sh
cd dsh-cairn-search && npm test
```

## 范围与限制

- 捕获 MVP：**只记录经代理的 HTTP(S)**，且只在 macOS 上实现围栏。
- 时间线不是 Scope 引擎，也不是全包 / DNS / 连接仓库。
- 免费公开代理不是生产出口；测活通过也不等于稳定或合法。
- 「证据」页仍是占位。
- DeepSeek Harness 处于开发者预览，接口可能不兼容升级。

## 许可与安全

`deepseek-harness/` 与 `vulhub-nacos-cve-2021-29441/` 各有上游许可证。本工作台只应在授权范围内使用；不要对未授权系统扫描或利用。
