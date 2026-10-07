# 情报资产库交付验证

验证日期：2026-10-07。所有情报均为本机临时工作区内的虚构 fixture，无模型网络请求、目标扫描或真实凭据。

## 交付范围

- 工作区目录绑定，左侧工作区导航，顶部资产关联 / 凭证关联 / 身份 / Agent 读写。
- 分页查询、筛选、手工新增、状态维护、关系添加、跨分类关联跳转、来源历史及轮询更新。
- 独立 `dsh-intel` 工具在原 Cairn 会话内查询 / 保存；无需先生成 fact。
- 敏感值按显式 ID 读取，数据库中的敏感字段与重试副本加密，审计不保存敏感原值或搜索原文。
- 幂等提交、跨工作区拒绝、原子回滚、凭据轮换、人工状态保留。

## 检查结果

| 检查 | 结果 |
|---|---|
| `pytest backend/tests/test_intel.py -q` | 8 项通过 |
| `npm test --prefix dsh-intel` | 4 项通过 |
| `npm test --prefix dsh-cairn-search` | 34 项通过 |
| `npm run build --prefix dsh-intel` | 通过 |
| `npm run build --prefix web-ui` | TypeScript 与 Vite 构建通过 |
| `PYTHONPATH=backend/src backend/.venv/bin/python backend/scripts/smoke_intel.py` | 实际 Harness 与 Chromium 验收通过 |
| `pytest backend/tests -q` | 125 通过，1 失败，见下文 |

全量后端唯一失败是原有 `test_smoke_macos.py::test_proxy_inject_http_then_stop`：向 example.com 探测后网络时间线 count 为 0。已从实现前的基线 `25947f7` 导出未修改的 backend，并使用同一 mitmdump 路径单独运行该测试，复现同样失败。此项不涉及情报接口，不把它记为通过。

真实 Harness 验收使用已构建插件、preset loader、工具注册、skill loader、实际子代理 runtime，仅 LLM transport 替换为确定性 adapter。证明工具限定在 preset 内、子代理继承工具与指引、子代理保存后父会话能立即查询、显式获取凭据、测试黑板文件字节不变。仓库 `dsh-cairn-search/` 和 `deepseek-harness/` 没有此次修改。

浏览器验收覆盖工作区隔离、列表和详情、按 ID 展示敏感值、人工编辑、新建身份、关系创建、关联跳转、运行中新增数据出现且保留选中详情、接口失败时保留旧列表、恢复后刷新、空结果、日志不含原值和移动端无横向溢出。`pageerror` 为空。机器回执见 [verification.json](verification.json)，截图见 [资产与关联](assets.png)、[Agent 读写](activity.png)、[移动端](mobile.png)。

## 本机接入状态

已执行 web profile 的插件安装、peer 链接及增量 preset 安装。安装器已为原有 `agent.cordis.yml` 保留时间戳备份；没有替换原 Cairn composition。隔离验收服务已关闭。

随后按用户要求重启了工作台后端（8787）、Harness（3081）与前端（5173），并恢复此前开启的网络捕获。直接访问 `/intel/workspaces` 以及通过前端代理访问 `/api/intel/workspaces` 均返回 200；健康检查、Harness 审批连接恢复正常。真实运行页面已再次通过浏览器加载检查：工作区导航显示、无接口错误提示、JavaScript 错误数为 0。安装与备份说明见 [dsh-intel README](../../../dsh-intel/README.md)。
