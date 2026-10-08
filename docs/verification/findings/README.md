# Findings v0.1 交付验证

日期：2026-09-24。实现依据：`docs/specs/cairn-findings-archive.md`。

本次交付包含 P1–P4：独立 SQLite/附件归档服务与八类接口、成果页与人工编辑、`dsh-findings` 工具及 outbox、preset/skill 安装更新，以及画板/PoC 的归档入口。

## 实际执行结果

| 验证 | 命令/方式 | 结果 |
|---|---|---|
| 工作台后端全量 | `backend/.venv/bin/python -m pytest backend/tests -q` | **116 passed, 1 skipped**，30.37 秒；包含 13 项 Findings 测试 |
| Cairn 全量回归 | `npm test --prefix dsh-cairn-search` | **34 passed** |
| 插件文件、来源与重试 | `npm test --prefix dsh-findings` | **5 passed** |
| 插件构建 | `npm run build --prefix dsh-findings` | 成功；包含安全读取 helper |
| 前端类型检查与构建 | `npm run build --prefix web-ui` | 成功，49 个模块 |
| 真实 Harness 注册/调用 | `dsh-findings/scripts/smoke-harness.mjs` | 安装包可解析、preset 作用域、子代理继承、skill 加载及提交成功 |
| 浏览器主要交互 | `backend/scripts/smoke_findings_ui.py` | 手工新增、预览遮盖、原字节下载、人工复核/修复、追加、搜索空态、轮询失败保留结果及重试通过 |
| 画板/PoC 入口 | `backend/scripts/smoke_findings_entries.py` | 事实预填/快照、工作台内来源导航、PoC 四份材料复制、响应截图标签、默认待复核通过 |
| 边界差异 | `git diff --exit-code -- dsh-cairn-search/src dsh-cairn-search/preset/skills/state-space-search` | 无差异 |
| 补丁空白检查 | `git diff --check` | 通过 |

未运行外部目标扫描或真实漏洞利用。Harness 集成使用生产 Cordis、preset loader、skill loader、子代理 runtime 和工具执行管线，但 LLM transport 是确定性测试 adapter；证据由本机测试 fixture 产生。PoC 页面验收使用明确的模拟扫描结果，提交和持久化走真实 Findings API。这些结果证明归档链路，不是漏洞成立的证明。

## 工具回执

- [原始工具执行结果](harness-tool-result.json)
- [Harness 验证记录](harness-verification.json)
- finding ID：`c1de48669bef4110ae570643ab046168`
- 执行子会话：`77b340ed-0ade-4d73-9526-cab59b7abf39`
- Owner：`parent`
- 保存 5 份附件：PoC fixture、请求文件、响应文件、工具日志、响应文本图片。
- 状态：`pending`。事实快照关联 `f001`；归档前后画板字节相同。
- 删除上述工作区源文件后，五个归档附件均可读取。另对前一次同类 fixture 在隔离后端重启后检查，5 个附件完整性均为 `ok`。

测试后端使用独立 `WORKBENCH_DATA`、`WORKBENCH_DSH_HOME` 和端口 18789；前端使用 15173 代理至测试后端。测试记录没有写入用户生产成果库。

## 故障与边界覆盖

后端验证了重复 create/commit/PUT、并发 create/append、版本冲突、人工确认后的 Agent 追加、显式解决缺口、分页和字段历史、未知步骤/附件引用、缺口声明、无效网络 ID、Run 不一致、网络源删除后的快照读取、超限与哈希错误、假图片、HTML 惰性展示、64 KiB 预览、数据库损坏隔离以及已提交附件丢失告警。

崩溃注入覆盖：上传未完成；最终目录移动后、事务前；SQLite 写入途中回滚；网络快照文件移动后、阶段更新前。故障后均不暴露半成品；重试复用原 ID 并只产生一次成果。数据库已提交后的回执重试返回原结果。

插件验证了主会话/子代理/fork 的 owner 区分、父链缺失时不读取画板、同 fact ID 的不同快照、缺少上下文、路径穿越、越界及目录符号链接、FIFO、大小限制、相同材料的稳定摘要、occurrence_id、API 断连、30 秒默认截止时间的缩短测试、以及修改/删除原文件后的 outbox 重试。文件 helper 使用逐级目录描述符和已打开对象检查，不仅依赖字符串路径检查。

## UI 记录

- [卡片与筛选](list.png)
- [详情与人工状态](detail.png)
- [空态](empty.png)
- [窄屏布局](mobile.png)
- [PoC 预填归档表单](poc-form.png)
- [主要交互断言](ui-verification.json)
- [画板与 PoC 入口断言](entry-verification.json)

截图已检查；窄屏页面将导航收为图标，成果卡片不再水平裁切。附件内容通过 React 文本节点显示；下载提示包含保存的凭据，截图不承诺脱敏。

## 安装状态和启用

本机已执行 `pnpm dsh plugin --profile web add ../dsh-findings`，并通过 `npm run install-preset --prefix dsh-findings` 对 `~/.dsh/.agent-presets/cairn/` 做增量更新。原 composition 修改前已保存带时间戳的备份；原有配置、Cairn 核心及搜索 skill 均保留。

本次没有重启用户正在使用的主 Harness/后端。现有运行实例需要在合适时机重启后端与 Harness，并刷新工作台前端，才会加载新增 API 和工具。具体安装、更新、停用和数据目录说明见 [插件 README](../../../dsh-findings/README.md)。

产品限制按 spec 保留：不自动确认漏洞、不执行材料、不做自动跨会话合并、不恢复未采集证据、不永久删除归档；手工浏览器表单只在当前页面内保留失败重试材料，插件 outbox 可跨进程恢复。未成功快照化的网络引用仍依赖源事件。

隔离测试后端与前端已在验收后停止；用户主服务未重启。


## 凭据显示更新

上述预览遮盖验证属于此前版本。2026-09-24 按用户要求移除预览遮盖及未使用的 header/URL 遮盖函数；当前行为与验证见 [无遮盖预览验证](../findings-unmasked/README.md)。历史回执保留，不代表当前行为。
