# dsh-findings

独立、按 preset 注册的 `archive_finding` 工具。只复制已有文件、读取事实和提交归档，不执行 PoC，不调用扫描/重放，不修改 Cairn 画板。协议见 [spec](../docs/specs/cairn-findings-archive.md)，交付验证见 [验证记录](../docs/verification/findings/README.md)。

## 安装与更新

本机 macOS/Linux、Node 22+、`python3`（仅标准库，用于 `openat` 文件边界校验）。后端安装 `backend/pyproject.toml` 的依赖，包括 Pillow。归档服务默认 `http://127.0.0.1:8787`。

从仓库根目录执行：

```sh
(cd dsh-findings && npm install && npm run build)
(cd deepseek-harness && pnpm dsh plugin --profile web add ../dsh-findings)
(cd dsh-findings && npm run link-peers && npm run install-preset)
```

当前 Harness 要求 `plugin --profile web add`，不能省略 `--profile`，也不能把该选项放在 `plugin` 前。插件是空 host patch 的 bundle；安装包本身不会全局注册工具。`install-preset` 仅追加 Cairn 的 `findings-archive` 条目和 `finding-archive` skill；现有 composition 不覆盖，修改前保存带时间戳的 `.bak`。已有自定义 `apiUrl` 保持不变。已有归档 skill 更新前同样备份。

Cairn 尚未安装时，先安装 `dsh-cairn-search` 并把其 `preset/` 复制到新的 `~/.dsh/.agent-presets/cairn/`；不要用整目录复制覆盖已有用户 preset。更新脚本支持 `DSH_HOME`；peer 链接优先读取 `profiles/web/node_modules`，可用 `DSH_FINDINGS_PROFILE` 指定其他 profile，并兼容旧的共享 peers 目录。

在没有正在运行的任务时重启工作台后端和 Harness，并刷新工作台前端。已有运行进程不会因源文件更新自动获得新 API/工具。后续代码更新需重新构建本插件；归档 skill 更新需再次运行安装脚本。

每个执行工作区应把 `.dsh/findings-outbox/` 加入忽略规则。本仓库已加入；脚本仅提示其他工作区，不覆盖已有忽略配置。outbox/证据副本可能包含测试凭据，不应提交到 Git。

停用：从已安装 Cairn 的 `agent.cordis.yml` 移除 `findings-archive` 行组，并移除该 preset 的 `skills/finding-archive/`，然后重启 Harness。后端 SQLite 和证据目录保持可读。无需删除数据库或归档文件。

## 默认归档指引

插件通过 preset 作用域的 systemPrompt section 注入每次测试默认加载 `finding-archive` 的要求，主会话和探索子代理均继承，其他 preset 不受影响。指引要求有证据的候选及时归档、复用 finding_id、失败保留 submission_key 并有限重试、所有成果等待人工复核。它是模型工作指引，不是拦截全部事实的强制事件钩子。子代理继续返回原有单一 JSON fact，回执/证据路径放在 description 内，不改搜索协议。

## 工具与存储

- `create`：结构化说明、已有附件、明确网络事件 ID、缺口；新成果始终 `pending`。
- `append`：`finding_id`、新材料、说明和可选 `resolved_gap_ids`；不覆盖人工状态。
- `retry`：只传 `submission_key`；从当前工作区 outbox 读取此前副本，不读取原始文件。
- 完整字段见 [归档说明](skills/finding-archive/SKILL.md)。复现步骤为 `{id, description, artifact_client_ids?}`；文件项为 `{client_id, kind, path, step_ids?, ...}`。

单次调用默认 30 秒总截止时间，继承调用取消信号，不后台重试；最大 20 个文件、20 条网络引用，每文件 20 MiB、总计 100 MiB、清单 1 MiB。网络快照也计入预算。插件允许的 API 配置仅为本机 HTTP 根地址，拒绝重定向，不保存服务配置到清单。

文件读取 helper 对工作区和相对路径的每层目录使用描述符锚定的 `openat + O_NOFOLLOW`，对已打开的文件检查 `fstat`；严格拒绝所有符号链接（包括工作区内链接）、路径穿越和特殊文件。异步子进程/管道流式复制，副本计算 SHA-256 并刷新磁盘。Node 不调用 shell，也不执行证据中的内容。Python helper 随构建一起发布到 `lib/`。

后端使用 `WORKBENCH_DATA/findings.sqlite`（schema v1）和 `findings/` 不可变目录。数据库损坏时模块返回 503，保留原数据。编辑使用 `version` 乐观锁；失败提交保留 ID、阶段和可重试标记，文件移动后的崩溃可继续提交。网络快照以保存前固定的哈希恢复，不以源记录持续存活为前提。

限制可独立配置：`WORKBENCH_FINDINGS_FILE_LIMIT`、`WORKBENCH_FINDINGS_TOTAL_LIMIT`、`WORKBENCH_FINDINGS_MANIFEST_LIMIT`（字节），`WORKBENCH_FINDINGS_MAX_FILES`、`WORKBENCH_FINDINGS_MAX_NETWORK_REFS`。插件的默认本地上限仍适用。

HTTP 时间线导入统一 `parsed_snapshot/transformed`；普通文件为 `file_bytes/unknown`。预览只展示最多 64 KiB 的文本，按保存内容展示，不遮盖凭据；原字节下载有明确提示。图片仅校验后的 PNG/JPEG 可预览。其他附件、HTML/SVG 下载以 `application/octet-stream` 和 attachment disposition 返回；HTML 文本预览通过 JSON + React 文本节点展示，不执行。

浏览器手工表单在当前打开的页面内保留待提交清单和 File 副本，可重试同一提交；刷新/关闭页面不保留手工待提交表单。插件的磁盘 outbox 则可跨进程重试。尚未被服务端快照化的网络引用仍依赖源事件。

## 验证

```sh
npm test --prefix dsh-findings
npm test --prefix dsh-cairn-search
backend/.venv/bin/python -m pytest backend/tests -q
npm run build --prefix web-ui
```

`backend/scripts/smoke_findings_ui.py` 和 `smoke_findings_entries.py` 用 Playwright 验证真实工作台 API/UI。后者明确以 UI fixture 替代扫描结果，不发起目标扫描。

`scripts/smoke-harness.mjs API_URL ABSOLUTE_WORKSPACE` 通过安装后的插件包、真实 Cordis 注册、preset loader、skill loader、子代理 runtime 和工具执行管线提交材料。LLM transport 为确定性 adapter，避免模型调用和网络测试。运行前在隔离工作区准备一张 `response.png` fixture；其余测试材料由脚本生成。脚本会删除它创建的源文件并验证归档副本，不能对真实测试工作区执行此 smoke。测试生成 `tool-result.json` 和 `verification.json`。后端也应使用独立 `WORKBENCH_DATA` 和 `WORKBENCH_DSH_HOME`。

### Large Cairn boards

Fact references are resolved by streaming the board's facts collection through the anchored file reader. Unrelated historical worker output no longer counts against the 1 MiB fact receipt budget or requires loading the whole board into memory. The receipt limit applies to selected descriptions. Existing snapshots remain immutable when source facts are later superseded.

For `cairn-segments-v1` manifests, the reader follows only fact segments, verifies their SHA-256 content and record counts, and streams them through the same anchored reader. Missing or modified segments fail the archive request rather than producing incomplete evidence.
