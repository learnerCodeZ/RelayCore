# Phase 3：受控执行接线

状态：**进行中，未完成真实生产链路验收**。现有 Daemon 默认不配置外部执行器；只有显式设置账户模式及必要路径时才接入 DSH 和独立 Review。环境变量开关本身不是执行授权。

## 已实现及本次修复

- MCP 支持创建、查询、派发、暂停、恢复和停止；任务授权、整合、回滚与工作区清理由持控制令牌的本地 HTTP/CLI 执行，MCP 没有授予授权的工具。
- 对未知费用的授权，HTTP 请求必须显式提供 `allowUnknownCost: true`；CLI 显式传 `--allow-unknown-cost`，空请求或没有该选项不能悄悄授权。授权仍绑定合约、预算及期限。
- 生产执行器先检查已有登记工作区：已存在时复核候选，未登记时准备新副本，启动模型前再复核用户源基线；不匹配或缺失的现场不自动覆盖。真实在途暂停后恢复未验证，已变更的候选仍须人工核查。
- `scripts/probe-production.mjs` 修复任务变量、子进程清理、临时端口、快照字段及提示计数；它仍会调用真实模型，只能按用户已授权的范围使用。脚本的真模型全链路尚未通过，不应把语法检查或假适配器测试当成真实验收。
- 本地 `/ui` 为未携带令牌的只读任务表，会展示任务标题和目标；不要把它当作对同机其他进程保密的视图。完整的网页审批和阶段三其他路线仍未完成。

## 验证和限制

2026-10-27 有时限全量无模型测试 **122/122、0 skip**；其中隔离临时项目使用假 DSH/Review，验证 MCP 建任务→未经授权拒绝→CLI 明确授权→MCP 派发→快照→CLI 整合→回滚。假适配器的两次提示意图不是实际模型请求。

本轮一次真实生产诊断在专用 Review 登录状态检查处退出，报告未调用模型；原因未确认。随后独立 DSH 账户提案诊断在发起模型请求前报告 ACP 进程退出，记录 `requestedTurns: 0`，现场为 `local/relaycore-dsh-account-8Xr51C/DIAGNOSTIC.json`。这两项未自动重试，不能判定账号、网络或安装哪一项有问题。

首次前置检查调用的是旧登录状态包装逻辑，它会尝试修改专用登录目录及已有凭据文件的 ACL；该调用失败，是否已改动权限无法确认。包装脚本现已修复：`--status` 不主动建目录或设置 ACL，并以假凭据 fixture 测试；真实登录动作仍保留原有 ACL 保护逻辑。没有读取或复制凭据内容。

历史 Phase 2 的一次真实提案/审查/整合/回滚记录不证明当前生产入口可用。多文件回滚中途写入失败的状态保护、真实在途暂停/恢复语义、并发文件替换及真实生产双模型闭环仍待验证；不能把测试数量当作生产就绪证明。

## 2026-10-28 续：三项修复与生产链路的额度停止点

- **多文件回滚中途失败保护**（交接 19.5 首要项）：`rollbackIntegration` 恢复循环逐文件容错，部分失败时记 `integration.rollback_failed`、任务转 `RECOVERY_REQUIRED`、抛出带已恢复清单的错误；备份目录保留供人工对账。真实只读注入回归覆盖混合现场与事件一致性。
- **生产 daemon 审查登录 Home**：不再绑定被服务项目目录（部署到其他项目必挂），默认解析安装目录，`RELAYCORE_REVIEW_AUTH_HOME` 可覆盖；补齐 daemon 缺失的 `fileURLToPath` import。
- **drain 失败日志**：executor 异常不再被静默吞掉，stderr 记录任务恢复原因（探针把 daemon stderr 全文落盘到证据目录），恢复决策不再盲猜。
- **真实生产链路验收现状**：生产形态 daemon + MCP/CLI 全链路至 Codex 审查启动均真实通过（双 session 登记、快照守卫生效）；审查在远端被账号额度拒绝（`try again at 12:28 AM`），失败路径按设计工作（精确记录、RECOVERY_REQUIRED、无自动重试）。最后一步（审查通过→整合→回滚）待额度恢复后重跑 `scripts/probe-production.mjs` 完成验收。本轮真实调用：DSH 提案 2 次、Codex 审查尝试 2 次。
- 有时限全量无模型回归 **123/123、0 skip**。仍未验证：真实在途暂停/恢复语义、并发文件替换竞态、网页审批；`/ui` 仍为本地只读视图。

## 2026-10-28 续二：真实生产闭环 + 真实在途暂停验收完成

额度重置后，`scripts/probe-production-pause.mjs`（真实在途暂停诊断）完成首次全链路验收（证据 `local/relaycore-pause-prod-eUC9N0`）：真实 DSH 第 1 轮在途时 `pause` 落地 → `resume` 后 drain 重新领取、真实重放 DSH 第 2 轮 → 审查快照 → 真实 Codex 审查批准 → `COMPLETED`；经 CLI 整合（源 pending→ready）与回滚（恢复 pending）。暂停重放消耗真实预算的语义得到验证（`model_turn_limit_exceeded` 的预算耗尽路径在假服务测试中覆盖）；CLI 本地授权要求显式 `--allow-unknown-cost`。完整回归 123/123。剩余：并发替换竞态、网页审批、多次运行稳定性。

## 2026-10-28 续三：Phase 3 收束——并发竞态、引导队列与风险路由

按计划书第 15 节 Phase 3 验收四条对照：

- **紧急停止不依赖模型回复**：`stop`/`pause` 直接改状态并 abort，已验证（含与完成的竞态）。
- **无授权 E2 操作无法执行**：合约新增可选 `riskLevel`（E0/E1/E2，默认 E1），`dispatch` 对 E2 要求授权内 `e2Approved: true`（显式 L3 同意），否则拒绝；派发成功写 `ROUTING.json`（executionLevel/adapterKind/riskReason）并记 `task.routed` 事件。路由记录只对真实派发生成（拒绝尝试不留痕，重派覆盖更新）。
- **普通引导不强制中断当前回合**：新增 `guide(taskId, text)`（DRAFT/QUEUED/RUNNING/PAUSED 可引导，终态拒绝）——仅追加 `GUIDANCE.md` 并记 `task.guided`；executor 在下一次真实 prompt 前经 `consumeGuidance` 读出并入 `userGuidance` 字段，归档为审计文件、恰好消费一次（暂停重放不会重复并入）。已接入 HTTP（POST /tasks/:id/guide）、CLI（`guide ID TEXT`）与 MCP（`guide_task`）。
- **能力不足自动拒绝**：当前仅一条已验证账户 ACP 通道，不满足强制要求的任务类型天然拒绝；`/ui` 提供只读任务视图。

并发竞态回归（`test/concurrency.test.mjs`）：同任务三路并发 prepare 恰好一胜且零残留；串行队列实测峰值并发 = 1；12 轮 pause-vs-complete 竞态终态恒为 COMPLETED 或 PAUSED 之一且事件/HANDOFF 一致。调试期间 drain 失败日志与探针 stderr 落盘直接定位了 `readFileSync` 缺失与 `ROUTING.json` 过早写入（拒绝尝试残留）两处问题。

完整回归 **129/129、0 skip**。Phase 3 计划书范围到此收束；网页完整审批交互与 Token 分账属 Phase 4。
