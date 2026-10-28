# Phase 4：共享知识、预算、Web UI 与 Windows 安装

状态：**核心完成（无模型验证）**。2026-10-28 实现；生产闭环与用量记账的真实数据将随自然运行累积。

## 已实现

| 项 | 实现 | 验证 |
|---|---|---|
| 本地监控/操作台 | `/ui` 任务表带状态化操作（授权/派发/暂停/恢复/停止/回滚/引导），授权按钮代表同意消耗额度与 L3 同意；`/usage` 分账页 | HTTP 级测试：同源操作全链路、跨站结构拒绝（403）、未知动作 400 |
| Token 分账 | `usage_ledger` 表（task/agent/model/tokens/source）；执行链在 DSH 提案与 Codex 审查返回时经 `recordUsage` 真实记账（畸形 usage 不破坏主流程）；`usageSummary` 聚合 | 假适配器路径验证；真实 ledger 数据随自然运行核对（一次并行版本竞态导致该轮证据库无表，代码已确认正确） |
| Memory Manager | `.RelayCore/.agent-memory/` 六文件白名单；**只允许追加** + 乐观锁（expectedSha256 不匹配拒绝）+ 每次变更前归档 `versions/` + `memory_versions` 登记表；Bridge 统一控制，Agent 不直写 | 竞态覆盖拒绝、归档内容、历史查询、未知名/缺 hash/超长拒绝 |
| CLI 安装诊断 | `node src/doctor.mjs <DSH exe>`：Node 版本/git/DSH 与 asar/账户 home/审查登录（不读内容）/代理/端口可用性，零模型零改动 | 本机实测全绿 |

## 边界与未做

- `/ui` 操作不带 Bearer：本地信任模型与控制 CLI 相同（DPAPI 为用户级隔离，非进程级）；跨站防线是结构性的（Origin/Sec-Fetch-Site 同源校验），不是机密。`/ui`/`/usage` 会向能访问本地端口的进程展示任务标题与目标。
- 用量分账是**调用级记录**，不是金额硬上限；`cost` 语义以服务账单为准。
- 用户级后台启动（服务/计划任务）与自动升级管理**未实现**，以 README 手动启动方式替代——涉及系统配置的改动需用户明确决定。
- `logs/TASK-*.jsonl` 未实现：事件表已承担审计，避免重复存储。
