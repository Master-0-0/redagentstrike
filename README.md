# 渗透 Agent 工作台

单机渗透测试 Agent 工作台：把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 嵌进侧栏，并补上审批、画板、HTTP 网络时间线、PoC 扫描和出口代理池。

MVP 面向 **macOS / Linux 本机自用**。控制面与 Web 默认只绑 `127.0.0.1`，不是多用户远程产品。仅在你有权测试的环境上使用。

## 它做什么

| 页面 | 作用 |
|---|---|
| Agent 工作台 | iframe 嵌入本地 `dsh web`（默认 `127.0.0.1:3081`） |
| 画板展示 | 读取 Cairn 搜索会话的 fact-intent 图 |
| 审批 | 高危 shell 命令进队，人工允许一次或拒绝 |
| 情报资产库 | 按工作区管理资产、凭据、身份及关联，Cairn 执行期间双向读写 |
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
dsh-intel/             Cairn 独立情报读写工具（query_intel_lib / save_intel）
.dsh/skills/proxy-pool/        Agent 换 IP 的 skill（启动 API 时复制到 ~/.dsh）
```

本地数据默认写在 `backend/data/`（已 gitignore）：`control.sqlite`、`net.duckdb`、mitm CA、`dsh-web.log`。

## 环境要求

- macOS 或 Linux（网络捕获需要 mitmdump；其他平台返回 `capture_platform_unsupported`）
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

完成上述首次安装后，可直接运行根目录的启停脚本：

```sh
./start.sh
./stop.sh
```

`start.sh` 后台启动后端与前端，等待健康检查通过后打印访问地址；关闭终端后服务继续运行。可以从任意目录使用脚本的绝对路径启动。重复启动不会重复创建服务，启动失败会清理本次新启动的服务。

日志保存在 `.run/backend.log`、`.run/frontend.log`，进程记录也位于 `.run/`（不提交）。`stop.sh` 只停止该脚本记录的服务，并通过后端退出流程关闭捕获代理和托管的 Harness，不删除项目数据。脚本设置 `WORKBENCH_STOP_DSH_ON_EXIT=1` 以启用 Harness 退出清理；手动启动保持原有行为。若已有手动启动的服务占用端口，请先在原终端停止，再使用脚本。

也可以手动启动：

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

仅用于你自己机器上的授权实验。本仓库不收录靶场文件，请自行从 [Vulhub](https://github.com/vulhub/vulhub) 拉取 `nacos/CVE-2021-29441`：

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/vulhub/vulhub.git
cd vulhub
git sparse-checkout set nacos/CVE-2021-29441
cd nacos/CVE-2021-29441
docker compose up -d
```

控制台：`http://127.0.0.1:8848/nacos/`。测完：`docker compose down -v`。

## 测试

```sh
cd backend
.venv/bin/pytest
```

需要本机 `mitmdump` 的捕获冒烟：`tests/test_smoke_capture.py`。PoC 经真实本地代理打 Nacos 的脚本：`PYTHONPATH=src .venv/bin/python scripts/smoke_poc_proxy.py`（Nacos 需在 8848 监听）。

Cairn 插件：

```sh
cd dsh-cairn-search && npm test
```

## 范围与限制

- 捕获 MVP：**只记录经代理的 HTTP(S)**，支持 macOS 与 Linux。
- 时间线不是 Scope 引擎，也不是全包 / DNS / 连接仓库。
- 免费公开代理不是生产出口；测活通过也不等于稳定或合法。
- DeepSeek Harness 处于开发者预览，接口可能不兼容升级。

## 许可与安全

`deepseek-harness/` 有上游许可证。本工作台只应在授权范围内使用；不要对未授权系统扫描或利用。


### 情报资产库与执行期读写

进入「情报资产库」，左侧选择工作区，顶部切换「资产关联 / 凭证关联 / 身份 / Agent 读写」。支持对象搜索筛选、关联跳转、手工维护、来源历史和执行期间自动更新。工作区绑定执行目录；Cairn 主会话和子代理可以在探索中读取已有资产及凭据，并即时保存新发现，无需等待画板事实或任务结束。

独立 `dsh-intel` 插件仅追加到 Cairn preset，不修改 blackboard、调度、fact、画板协议或终止条件。安装、数据备份、工具契约和边界见 [dsh-intel](dsh-intel/README.md)。存储为 `WORKBENCH_DATA/intel.sqlite` 与 `intel.key`；敏感值按需读取，日志不含原值。当前实现面向本机，不提供远程多用户认证。

### 漏洞成果库与证据归档

工作台「漏洞成果库」支持手工新增、证据预览/下载、人工复核、修复状态及审计历史；画板事实详情和 PoC 扫描结果提供归档入口。Cairn 的独立 `archive_finding` 工具支持 create/append/retry，核心画板协议不变。

安装插件并更新已有 Cairn preset 的步骤见 [dsh-findings 安装说明](dsh-findings/README.md)。该步骤会保留用户配置并备份修改文件。成果数据存放在 `WORKBENCH_DATA/findings.sqlite` 与 `findings/`，重启或清理源网络记录不删除已归档证据。测试回执与 UI 验证见 [交付验证记录](docs/verification/findings/README.md)。

#### 默认自动归档

Cairn preset 内的独立归档指引要求每次授权测试加载 `finding-archive`，将已有证据支持的漏洞候选自动保存为待复核成果。探索子代理在原有 JSON fact 的 description 内带回归档 ID，父代理复用该 ID 追加材料；原始搜索协议和完成条件不变。普通进度事实、失败检查及画板完成本身不会当作漏洞。可在任务中明确要求停用自动归档。

PoC 页的「命中后自动归档」默认开启，选择保存在当前浏览器；只对之后启动的扫描生效，每个命中生成待复核卡片。归档模板、扫描输出、已有响应/响应截图和明确的网络事件引用；缺失证据如实标记。模板命中不等于漏洞已确认，最终结论和修复状态仍由人工填写。

PoC 自动归档队列和待提交文件副本保存在当前站点的浏览器 IndexedDB 中，刷新后可从记录中重试；重试复用同一提交，不重复建卡。成功后清除本地材料副本。浏览器存储不可用会明确报错；此时不要关闭页面。刷新后不会无限自动重试，需要点击「重试归档」。不同浏览器或端口不共享队列。Cairn 则使用执行工作区的磁盘 outbox。自动归档验证见 [验证记录](docs/verification/findings-autoarchive/README.md)。

#### 导出成果报告

在「漏洞成果库」点击「手工新增」旁的「导出报告」，搜索并勾选需要的成果，选择 DOCX 或 PDF 后下载。支持跨页保留选择、全选本页和清空选择，单次最多 100 项，合并为一份报告。导出包括漏洞说明、复现步骤、人工复核与修复状态、文本及图片证据、证据索引和缺口。文本正文展示前 64 KiB，超限明确提示；PNG/JPEG 图片嵌入正文。其他附件仍在成果详情中下载，导出不改变状态，也不遮盖保存的凭据。

后端新增依赖 `python-docx` 与 `reportlab`，更新后安装 `backend/pyproject.toml` 中的依赖并重启后端。PDF 嵌入中文 TrueType 字体：macOS 默认读取 `/Library/Fonts/Arial Unicode.ttf`；其他环境可设置 `WORKBENCH_REPORT_FONT`，或使用系统中的文泉驿正黑/宋体。缺少字体时明确报错。DOCX 使用 Arial Unicode MS 字体样式，阅读器可按本机字体替换。
