# Phase 2：工作区隔离与可靠恢复

状态：**核心能力已实现，安全边界仍需验证**。此前记录了一次隔离真实调度、整合与回滚；2026-10-27 后续发现并修复多文件整合和备份保护问题。Phase 3 已开始生产接线，默认执行仍关闭，见 [阶段三状态](phase-3-status.md)。

## 分步范围

| 步骤 | 内容 | 状态 |
|---|---|---|
| 2.1 | 持久化候选审查快照、绑定任务版本、交接前复核审查对象 | 完成（无模型验证 + 真实调度验收） |
| 2.2 | Git worktree / 非 Git 副本管理，任务修订与快照生命周期 | 完成：修订、工作区登记/盘点/受控清理、Git worktree 准备/变更检查/清理均已验证（worktree 仅在独立临时仓库演练） |
| 2.3 | 暂停/恢复、崩溃核查、重复副作用保护 | 完成：PAUSED 状态、pause/resume、预算跨暂停累计、重复副作用守卫（无模型验证） |
| 2.4 | 受控整合、回滚和冲突保护 | 完成：integrateWorkspace（备份前置 + 失败恢复 + RECOVERY）与 rollbackIntegration（防覆盖新改动），真实调度验收整合→回滚 |

先复用已有 `REVIEW.json` 的完整 before/after 与检查记录作为快照，不再复制一套同样的文件。它不是 Git worktree、文件系统快照或 OS 沙箱。

## 2.1：审查和交接绑定同一份内容

Phase 1 已核对源文件与审查快照，但缺少完整的交接前候选复核。本轮新增回归实际发现四种情况仍被旧实现标成 `COMPLETED`：审查期间候选被改动、候选新增未声明文件、适配器替换快照并修改其内存 hash、适配器返回不同的快照 hash。它们均不应该产生正常交接。

现将检查集中到 Core，并使用持久化登记：

1. `prepareReviewWorkspace()` 写入独立 `REVIEW.json` 后，在 SQLite `review_snapshots` 保存 `snapshot_id`、任务 ID、合约 revision、完整合约 SHA-256、快照 SHA-256 和创建时间；登记与 `review.snapshot_created` 事件同事务提交。登记失败会清理该次未完成目录。
2. `reviewSnapshots(taskId)` 供可信本地宿主查询登记，不增加 MCP/HTTP 审批、派发或合并权限。
3. `verifyReviewedWorkspace(taskId, snapshotId)` 按登记定位快照，检查任务合约/版本、目录/文件与大小、快照 hash、候选清单及完整内容、源文件基线，最后再次核对快照文件。拒绝跨任务、伪造路径、未登记或已变化的快照。
4. `runDshReviewTask()` 在等待 Review 前捕获快照 ID/hash，Review 返回后要求其 hash 相同，再调用上述校验；交接字段取自核对过的登记和快照，不从可变的适配器输入对象重新取检查结论。失败进入原有 `RECOVERY_REQUIRED`，不写正常 HANDOFF。
5. 新 HANDOFF 包含 Snapshot ID、任务 revision、Review SHA-256 和 Candidate SHA-256，后续核查有明确的对象引用。

**登记存在与校验通过都不等于模型批准，也不是合并许可。** 方法只报告“当前内容与登记快照一致”；正常任务仍需要独立 approved 和原有授权/预算/状态守卫。一次校验后文件可能再变化，未来整合前必须重新核对；已完成任务的历史状态也不是候选永远不变的保证。

## 2.2：修订创建新草稿，不覆盖旧现场

新增可信宿主 API `createRevision(taskId, input)`、`taskVersions(taskId)`，不增加 HTTP/MCP 入口或生产执行权限。任务 revision 不是 Git 分支或提交：每次修订产生新任务 ID 和 `DRAFT`，旧合约、TASK.md、候选、快照、会话、授权及结果保留在原任务下。

- 输入必须包含 `expectedRevision`、非空 `reason`，并实际改变至少一个合约字段；只允许修改 title、objective、acceptance、allowedPaths、executionLimits。不接受注入状态、授权或父任务 ID。
- 只能修订链末尾的 `DRAFT`、`CANCELED` 或 `COMPLETED`；`QUEUED`、`RUNNING`、`RECOVERY_REQUIRED` 拒绝修订。未知执行结果先核查，不借修订绕过恢复。
- 新草稿只继承经过校验的合约字段，不继承候选、快照、执行授权、会话、结果或批准。后续工作区准备从用户当前源目录重新建立基线，仍需单独授权和审查。
- 旧任务状态不改写；有后继的旧草稿通过 `supersededBy` 拒绝新授权和派发，包括已有未消费授权的情况。旧授权保留作历史记录，不续用。
- SQLite `task_revisions` 保存父任务、根任务、版本、父合约 hash、理由及创建时间。一个父任务最多有一个后继；创建时复核父状态、版本、合约 hash，与新任务、关联事件同事务提交。并发或失败不会留下第二个后继；失败时清理本次未完成的新目录，不删除父任务现场。
- `taskVersions()` 可从链中任意任务查询顺序历史，关闭重开后保留。相同合约的再次执行不是修订；当时的后续开发后来增加暂停/恢复和工作区清理/整合，Attempt 与完整恢复仍未完成。

## 持久化和旧数据

- 新表是增量创建，不重写已有任务、会话、调用意图或授权。
- 重开 Core 后可按登记继续核对，但不自动调用模型、不重播、不自动把任务改成完成。
- 旧快照或孤立文件没有登记时，拒绝当作新链路的有效登记；不扫描文件后自动补信任，也不删除历史证据。
- 既有任务作为独立 revision 1 根任务保留；新表不重写旧合约、不自动推断旧任务之间的父子关系。新的修订链按新任务 ID 分隔快照，不把父任务的批准绑定到新版本。
- hash 和 SQLite 登记不防同账号篡改数据库，不消除 Windows 重解析点/并发替换竞态，也不提供跨文件或文件/数据库的完整原子事务。

## 验证与限制

2026-10-26：2.1 的 Core/快照/DSH/调度定向 **43/43、0 skip**，当时完整回归 **80/80、0 skip**。加入任务修订后，最新有时限的完整回归：

```powershell
node --test --test-reporter=tap --test-timeout=12000
```

**86/86、0 skip**。原有覆盖包括上述四个回归、适配器改写检查元数据仍不影响真实交接记录、多快照/重开核对、跨任务拒绝、候选缺失/额外项/链接、快照被改/缺失/链接、合约/版本变化、用户源修改、旧数据不自动收编及登记事务失败清理。

新增 `test/revisions.test.mjs` 的六个测试覆盖历史保留及重开、授权不继承/旧草稿禁派发、非法输入与在途状态拒绝、并发唯一后继、SQL 失败回滚及目录清理、既有数据库增量建表。首次包含修订的定向回归 **38/39**，六个新测试均通过，旧测试出现 `Local credential protection failed; use the same Windows user and profile`。一次后续提权测试工具调用被中断，没有有效结果；再后来的普通完整运行 86/86 通过。没有修改凭据保护逻辑或降低校验，不能据此认定该次失败根因已解决。

中间一轮无逐测试时限的完整回归在 55 秒整体超时，未取得足以归因的日志；后续有时限运行通过。项目曾有随机端口命中 Windows 保留范围的旧波动，但**不能断言本次超时也是该原因或已经修复**，没有修改系统端口设置或用产品代码掩盖失败。

`check:dispatch` 另完成一次独立的假适配器调度及落盘，关闭后重开 Core 再核对登记、快照/候选 hash，事件数未增加；该检查不发模型提示。本轮新增真实模型请求 **0**，没有使用 Phase 1 已消费的真实验收授权；新快照守卫未重新付费验收。生产 Daemon、DSH 安装包和凭据内容均未动，没有提交/推送或新建分支。

## 2026-10-27 续：工作区登记、遗留识别与受控清理

2.2 工作区生命周期增量（全部无模型验证，接手核验 `RC-HANDOFF-20261026-02` 后经用户确认范围执行）：

- **登记**：新增 SQLite `workspaces` 表（task_id 主键、revision、baseline_sha256、created_at，增量建表）。`prepareWorkspace` 在临时目录改名成功后同事务登记并记 `workspace.prepared` 事件；已有登记时再次 prepare 拒绝。注册失败不删现场，抛 `Workspace prepared but registration failed` 留待对账——rename 后的目录与基线是真实现场，不进旧 catch 的清理路径。
- **基线完整性**：登记记录 `BASELINE.json` 内容 hash；有登记时 `readBaseline` 校验基线未被篡改（含 revision 一致性）。无登记的既有工作区保持原行为，兼容旧库。
- **遗留识别**：`workspaceInventory()` 只读对照登记与文件系统，返回 registered（含目录缺失 present:false）、unregistered（崩溃于注册前或旧数据）、leftoverTemp（`<taskId>-tmp-*`）、unexpected（其他名字，不解释不动）。启动时不扫描不写状态，按需计算。
- **受控清理**：`discardWorkspace(taskId)` 仅接受 `DRAFT`（含被修订取代的旧草稿）、`CANCELED`、`COMPLETED`；`QUEUED`/`RUNNING`/`RECOVERY_REQUIRED` 拒绝。删除工作区目录、该任务 tmp 遗留与基线，事务删登记并记 `workspace.discarded`；路径校验沿用既有防线（普通目录、dirname 限定）。无任何可清对象时拒绝。两 API 均为可信宿主内部，不新增 MCP/HTTP 入口。
- **边界**：RUNNING 期间注册失败留下的现场在该任务进入终态前不可 discard（刻意 fail-closed）；discard 后该任务的 `verifyReviewedWorkspace` 不再可用（候选已删），HANDOFF 与快照登记仍是证据；新表与 hash 不防同账号篡改，不是跨资源原子事务。

新增 `test/workspace-lifecycle.test.mjs` 八个测试覆盖上述全部行为（登记/拒绝、零残留、未登记现场兼容与清理、基线篡改、missing、状态前置、修订旧现场保留与源不回写、tmp 清扫、异常名字）。有时限完整回归 **94/94、0 skip**。再次确认：不带 `--test-timeout` 的完整回归会整体挂起（本轮复现一次），完整回归必须带时限。本轮真实模型请求 0，未提交、未推送，未动 Daemon/锁/安装包/凭据。

该增量当时的下一步是 2.2 剩余 Git worktree 支持及 2.3、2.4；后续结果见下一节。提交/推送仍须用户明确指示，真实模型测试按用户已有授权和预算执行。

## 2026-10-27 完结：worktree、暂停恢复、受控整合与真实调度验收

用户授权自主连续推进并允许小额真实模型调用后，Phase 2 四步全部完成：

- **Git worktree（2.2 收尾）**：`workspaces` 表增量加 `kind`/`metadata` 列；`prepareGitWorktree()` 直接在最终路径 `git worktree add --detach`（**不能**先加临时目录再改名——git 内部登记指向旧名，改名后 `worktree remove` 报 "not a working tree"，这是本轮实测踩到的真实坑）；`inspectWorktreeChanges()` 以 `status --porcelain -z` + `diff <baseCommit>` 报变更；`discardWorkspace` 对 worktree 走 `remove --force`，失败则物理删除后 `prune`（**prune 必须在目录删除之后**，否则留下死登记）；copy 语义 API 对 worktree 明确拒绝。ref 以白名单字符集校验并 `rev-parse --verify` 解析，参数数组执行无 shell 注入面。演练全部在独立临时 git 仓库，主工作区未创建任何 worktree/分支/提交。
- **暂停/恢复（2.3）**：新增 `PAUSED` 状态与 `pause()`/`resume()`。`pause` 对 RUNNING **先事务置 PAUSED 再 abort**——drain 的失败路径只改仍处 RUNNING 的任务，因此中断被记为有意暂停而非未知故障；RECOVERY_REQUIRED 经人工核查后也可 pause。`resume` 重新入队并要求原授权仍有效；模型轮次按事件表累计、总时长从首次 dispatch 起算——**预算跨暂停累计，不给新预算**（实测 1 秒时限任务暂停 1.1 秒后 resume 立即 deadline_exceeded）。PAUSED 不可 dispatch/授权/准备工作区，可 stop 转 CANCELED、可修订（计划书第 9 节：实质变更需暂停+revision）。
- **受控整合与回滚（2.4）**：`integrateWorkspace(id, snapshotId)` 仅接受 COMPLETED 且 `verifyReviewedWorkspace` 全通过；先把每个源文件备份到任务目录 `PRE-INTEGRATION/`（manifest 含 before/after hash），备份阶段全部成功才开始写入，写入失败逐文件尽力恢复并转 `RECOVERY_REQUIRED`（真实只读注入实测：恢复也可能被拒，此时如实报告 restored 数并交人工）；`rollbackIntegration` 校验当前源仍等于整合后内容（不覆盖用户新改动）、备份未被改动，一次性回滚。
- **真实验收（`scripts/probe-dispatch.mjs --run-task`，已获用户授权）**：真实账户 DSH 提案 → 真实 Codex 审查批准 → 快照守卫 → **整合（源真实变为 ready）→ 回滚（源恢复 pending）**，outcome `reviewed-integrated-rolled-back`，2 轮真实调用。首次真实跑曾零成本失败于 executor 早期（当时 probe catch 吞错；已修为落盘 errorDetail，证据保留 `local/relaycore-dispatch-probe-2GhoHR`，重跑完整通过，根因未归因）。
- 当时完整回归 **110/110、0 skip**。真实模型调用合计 2 轮，证据 `local/relaycore-dispatch-probe-QGz0qI`。仍为单点真实验收：多次稳定性、真实在途暂停的远端语义未验收。当时生产 Daemon 未挂执行器，后续阶段三增加显式开关和 HTTP 整合入口；未提交未推送。

## 2026-10-27 续：多文件整合安全修复

- 原实现每写完一个文件就把全部源文件与原始基线比较，下一次检查会把自己刚写的文件误判为冲突。新增多文件回归先复现“写入 1 个文件后失败并恢复”，修复后按已写入/未写入分别核对预期内容，两文件整合并回滚通过。
- 备份目录原先已经存在时，创建失败的清理路径可能删除那个已有对象；现只清理本次成功创建的目录。回归确认已有文件未被删除。
- 回滚先完整验证所有备份，再开始写入，防止后一个备份损坏时已先恢复前一个文件。整合失败恢复时，如果先前写入的文件又被外部修改，不自动覆盖该修改。
- 最新有时限全量无模型回归 **122/122、0 skip**。多文件真实模型验收、并发修改和真实在途暂停仍未验证；当前文件系统与数据库也不构成跨资源原子事务。回滚写入中途出错的状态处理仍需专门验证和改进。
