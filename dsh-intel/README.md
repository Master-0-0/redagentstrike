# dsh-intel：Cairn 执行期间的双向情报工具

当前 Cairn 会话加载两个工具，无需另开模式或模型会话：

- `query_intel_lib` 查询本执行工作区的资产、身份、凭据；指定 ID 才返回原值或详细来源。
- `save_intel` 即时写入发现和关系；无需等待 fact 或任务结束。

工具不操作黑板、不调度任务、不执行探测、不改变完成条件。主、子会话使用同一个执行目录时共享情报；每次观察保留真实执行会话及可解析的主会话。fork 与原会话若使用同一目录也共享库，但保留各自来源。

## 安装

先更新后端依赖并构建：

```sh
backend/.venv/bin/pip install -e './backend[dev]'
npm install --prefix dsh-intel
npm run build --prefix dsh-intel
cd deepseek-harness
pnpm dsh plugin --profile web add ../dsh-intel
cd ..
npm run link-peers --prefix dsh-intel
npm run install-preset --prefix dsh-intel
npm run build --prefix web-ui
```

安装器只追加 `intel-library` 插件条目及独立 skill，修改前备份已有文件；重复执行不覆盖自定义 apiUrl。支持 `DSH_HOME`，peer profile 可由 `DSH_INTEL_PROFILE` 指定。待当前任务结束后重启后端和 Harness；现有进程不会自动获得新增工具。卸载只需从安装的 Cairn preset 移除 `intel-library` 条目与 skill，已有情报不受影响。

## 前端

情报资产库内左侧显示工作区导航，进入后顶部为资产关联、凭证关联、身份、Agent 读写。工作台主导航收窄为图标栏。支持搜索、分类/状态筛选、分页、对象详情、关联跳转、手工新增和编辑、关系添加、来源历史及读写日志。每 5 秒更新，页面隐藏时停止轮询；新增记录不抢走已选详情。原值在单独请求成功后显示，30 秒或切换详情/隐藏页面后收起，不写浏览器持久存储。

工作区绑定本机现有目录。已登记的 Harness 目录自动出现；Agent 首次调用也可自动创建目录对应的情报工作区。UI 新建可指定名称及已有目录，随后在相同 cwd 运行的 Agent 自动命中它。

## 存储与边界

- `WORKBENCH_DATA/intel.sqlite`：独立 SQLite 数据库，工作区、对象、关系、观察、幂等提交及审计。
- `WORKBENCH_DATA/intel.key`：Fernet 密钥，权限 0600；数据库与密钥须一起备份。密钥丢失时服务报错，绝不生成新密钥覆盖旧数据。
- 凭据原值、备注和证据说明加密；身份字段、资产标识、会话 ID 等元数据不是加密字段。加密不能防止已获得本机用户权限的进程访问密钥。
- `${DSH_HOME:-~/.dsh}/intel-outbox/<workspace-hash>/`：AES-GCM 加密提交副本、0600 密钥。成功副本保留供显式 retry 使用，当前没有自动清理；勿提交、分享或删除未完成请求的目录。
- 按工作区 + 类型 + 所属域 + 规范化标识 + 敏感值指纹去重。域名大小写和尾点、IP 表示归一化；不模糊合并不同身份。账号和姓名必须给所属域。
- 凭据轮换产生新对象；同对象新观察追加历史。人工状态不会被自动写入覆盖，Agent 的不同结论仍保留在观察历史中。
- 关系可以单独保存，端点必须来自同一工作区；关系依据区分实际观察、配置声明、推断。
- API、工具只面向当前项目的本机信任边界。插件仅允许环回 HTTP，拒绝远程地址和重定向。执行来源由插件 runtime 注入，服务端按目录与对象所属工作区校验；这不是多用户鉴权协议，不能把此 API 暴露到远端。

## API

浏览器经 `/api` 代理；直接请求后端不加 `/api`：

| 路径 | 用途 |
|---|---|
| `GET/POST /intel/workspaces` | 列出 / 创建目录绑定 |
| `POST /intel/workspaces/{id}/query` | 分页查询，显式 ID 读取原值 |
| `POST /intel/workspaces/{id}/save` | 幂等批量保存对象 / 关系 |
| `GET/PATCH /intel/workspaces/{id}/entities/{eid}` | 详情 / 带 version 的人工编辑 |
| `GET /intel/workspaces/{id}/activity` | 分页审计 |
| `POST /intel/agent/query` | runtime context + 查询参数 |
| `POST /intel/agent/save` | runtime context + 保存参数 |

完整工具契约见 [skill](skills/intel-library/SKILL.md)。查询默认摘要，分页上限 100 条；原值请求最多 20 个显式 ID；详情请求最多 5 个 ID，各返回最近 3 条观察和最多 20 条关系并标注截断。UI 详情最多显示最近 50 条观察与 100 条关系，数据库不删除旧历史。提交上限 1 MiB、50 个对象、100 条关系。证据以说明和来源引用保存；本插件不读取或自动快照证据文件，不调用外部情报源。

审计包含操作、执行/主会话、实际对象 ID、类别/类型/分页等条件、是否带搜索词和结果。搜索原文、敏感原值、自由文本和原始工具参数不会写入审计；在无法解析有效 workspace/context 前拒绝的请求无法归属到工作区日志。客户端连接失败保留本地 outbox，服务端没有收到的请求不会出现在服务端日志中。

默认主动读写由独立工具指引驱动，不能保证模型每次都调用。当前没有全工具输出拦截、自动秘密提取器或远程部署认证。失败返回错误和 submission_key，不后台无限重试、不阻断 Cairn。

## 验证

```sh
backend/.venv/bin/python -m pytest backend/tests/test_intel.py -q
npm test --prefix dsh-intel
npm test --prefix dsh-cairn-search
npm run build --prefix web-ui
PYTHONPATH=backend/src backend/.venv/bin/python backend/scripts/smoke_intel.py
```

最后一项启动隔离的 API、Vite 与 Chromium，并通过本机已有 Harness 依赖跑真实 preset、工具注册和子代理 runtime。LLM 使用确定性 fixture，无模型网络请求、目标探测或真实凭据。写入测试截图和回执到 `docs/verification/intel/`；所有测试服务在退出时停止。
