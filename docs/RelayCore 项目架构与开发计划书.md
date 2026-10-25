# RelayCore 项目架构与开发计划书

> **GitHub 仓库：** `learnerCodeZ/RelayCore`（用户提供；远端内容待连通核对）  
> **文档版本：** V1.1 设计修订（2026-10-13）  
> **阶段：** Phase 0 可行性验证进行中；尚未编写 RelayCore 服务或验证实际端到端能力  
> **项目名称：** RelayCore（品牌名暂定）；英文展开名称尚未定稿  
> **本文目的：** 作为后续交给 Codex 实施项目的设计依据；文中“已确认”与“建议默认／待确认”须严格区别。

## 1. 项目定位与范围

RelayCore 是**Windows 本地优先、轻量级、事件驱动**的双 Agent 协作工具。**Codex Desktop 是主要人机交互界面和项目级决策入口**；Codex SDK 负责每个任务的委派技术决策、独立验收和返工指导；DeepSeek Harness（DSH）负责执行；Bridge 后台守护进程负责可靠协调和安全控制；本地 Web UI 只作为辅助监控、配置和正式审批界面。

**核心使用流程：** 用户在 Codex Desktop 提出需求 → Codex 拆分任务并经 MCP 派发 → Bridge 持久化任务并调度 DSH → DSH 执行、输出结果/问题 → Bridge 按需调用对应任务的 Codex SDK 会话决策或验收 → 必要时返工 → 确认验收后提交共享知识和交接摘要 → 用户从 Codex Desktop 查询结果。

### 1.1 明确目标

- 不依赖复制粘贴实现 Agent 间任务交接；控制与记录均可追溯。
- **异步自动接力**：DSH 执行期间 Codex 不需要保持模型推理；任务完成后 Bridge 主动发起新的 Codex SDK 模型回合。
- 按任务风险选择 DSH 执行通道；可视化优先但不得绕开强制的安全边界。
- 通过工作区中的 Markdown 建立可审阅、可迁移的项目记忆与任务沟通记录。
- 支持中途追加指导、方案修改、暂停、恢复、取消及紧急停止。
- 用户主要使用 Codex Desktop；网页辅助显示 Agent 状态、Token 使用、异常、权限审批。
- 核心调度尽可能低资源占用；不内置模型、不因为打开监控网页就产生模型推理 Token。

### 1.2 V1 范围与非目标

**V1：** Windows 用户级部署；单项目、按任务串行，自动调度时同一时刻最多运行一个 DSH 或 Codex SDK 模型回合；Git worktree 优先、非 Git 受控副本备选；本地 SQLite + Markdown；轻量 Web UI。用户主动使用 Desktop 时的短时并行活动按第 9 节处理。

**非目标：** 任意多 Agent 并行／分布式集群；完全替代 Codex Desktop 或 DSH GUI；同步其原生对话数据库；在未得到确认时自动部署、推送代码、删除重要数据；保证用户关闭 Windows 会话/设备关机后继续运行；在桌面原聊天窗口中强行插入后台执行结果。插件/适配器扩展可在 V2 后展开。

## 2. 方案定稿状态

### 2.1 用户已明确确认

| 设计问题 | 最终方案 | 状态 |
|---|---|---|
| 仓库地址 | `https://github.com/learnerCodeZ/RelayCore` | 用户本轮提供；远端内容待核对 |
| 技术路线 | **独立开发、模块化借鉴** GitHub 项目，不直接整仓 Fork | 已确认 |
| 主从关系 | Codex Desktop 主控；Codex SDK 任务级决策及验收；DSH 执行 | 已确认的整体架构 |
| 会话模型 | Desktop 项目主会话、SDK 每任务独立会话、DSH 每任务会话；由 Session Registry 关联 | 已确认的整体架构 |
| 协作与唤醒 | Bridge 异步调度，DSH 完成后按事件调用 Codex SDK 验收 | 已确认的整体架构 |
| Bridge 运行形态 | **独立后台调度进程 + MCP 控制入口** | 已确认 |
| 执行策略 | **按任务风险选择执行通道**，DSH 原窗口优先，不能满足控制要求时转受控通道 | 已确认 |
| DSH 可视化 | DSH 原生界面优先；不具备条件时独立监控作为回退 | 已确认的整体架构 |
| 暂停恢复 | **C：优先恢复原 Session，失败时核查后新建** | 已确认 |
| 工作区隔离 | **C：Git worktree 优先；非 Git 项目使用受控副本** | 已确认 |
| 崩溃恢复 | **C：自动检查现场，能够证明安全才恢复；不确定则暂停人工处理** | 已确认 |
| MD 管理 | **C：任务 MD 由分工指定 Agent 写入；长期记忆由 Bridge 审核版本后集中提交** | 已确认 |
| 工作区数据根目录 | `<项目根>/.RelayCore/`，替代旧方案中的运行数据 `local/`；与开发笔记 `local/notes/` 不同，默认 Git 忽略 | 已确认 |
| 操作界面 | Codex Desktop 日常主界面，RelayCore Web UI 辅助监控管理 | 已确认 |
| 开发阶段 | 按 Phase 0–5 逐阶段推进；每阶段交付学习笔记并等待用户决定是否继续 | 用户本轮更新 |

### 2.2 建议作为默认值，用户尚未正式逐项确认

| 问题 | 建议默认值 | 开发前确认点 |
|---|---|---|
| Token 预算 | C：软阈值提醒、硬阈值阻止**新**模型回合 | 阈值、按模型计量粒度、缺失数据如何处理 |
| 开源安装方式 | C：CLI 安装/诊断 + 本地 Web 监控及配置 | 安装器形式、Node 依赖版本、离线支持 |
| L3 审批 | C：Bridge 本地可信界面形成权威审批记录，Codex 负责说明 | 授权有效期、身份鉴别、审批超时 |
| Windows 启动 | 登录后自动启动的**用户级后台进程** | 是否默认开启自启动 |
| DSH 执行通道回退 | 首次从原生可视化切换至受控通道时提醒确认，后续按项目偏好 | 确认范围与失效条件 |
| 项目英文展开名 | RelayCore 品牌暂定 | 正式发布前查重、许可证及商标风险评估 |

以上待确认项不得在代码、README 或用户说明中描述为“用户最终拍板”。

本节“已确认”沿用此前计划书记录的项目选择，表示产品方向，不表示相应第三方接口已验证或用户确认了具体实现参数。Phase 0 如发现必要能力缺失，应记录证据、影响和备选方案，再由项目负责人决定缩减范围、替换通道或调整设计；不得把技术假设自动升级为已确认承诺。

## 3. 总体架构与职责

```text
                         用户
                          │
                  Codex Desktop 主会话
           项目规划 / 任务拆分 / 普通引导 / 查询结果
                          │ MCP 工具请求
                          ▼
                  RelayCore MCP Gateway
                提交/查询/修改/停止控制入口
                          │ 本地受鉴权 IPC
                          ▼
┌────────────────────── RelayCore Daemon ──────────────────────┐
│ Task Orchestrator + Durable Event Queue + State Machine     │
│ Session Registry + Decision Policy (L0–L3)                 │
│ Execution Router (E0–E2) + Approval Gate + Budget Manager  │
│ Workspace Manager + Memory Manager + Recovery + Audit      │
└─────────────────┬─────────────────────────┬──────────────────┘
                  │                         │
          Codex SDK Adapter           DSH Adapter
         每任务决策/验收会话     Web Host / ACP / Headless
                  │                         │
                  └──────────┬──────────────┘
                             ▼
            .RelayCore/ (MD + SQLite + Logs)
                             ▲
                      Local Web Console
               监控 / Token / 配置 / L3 审批
```

**权责边界：** 用户具有最高决策权；Codex Desktop 对项目级设计与任务边界负责；Codex SDK 可在被委派范围内执行 L2 技术判断及验收；DSH 仅在已授权范围内执行；Bridge 不是 AI 决策主体，而是凭借状态机、权限和事务记录强制落实控制。

**交付承诺边界：** “自动调用 Codex SDK”指 Bridge 主动发起一个**新的模型请求**，不表示系统可在 Codex Desktop 原聊天中自动生成一条回复。Desktop 需借助 MCP 查询、MD 交接或经过支持的通知机制读取结果；不能依赖未证实的桌面注入接口。

**集成边界：** [OpenAI 官方 Codex SDK 文档](https://learn.chatgpt.com/docs/codex-sdk)说明可启动、继续及恢复本地线程，尚不足以证明 RelayCore 所需的无人值守鉴权、审批处理、只读 Review、用量上报和异常恢复在目标 Windows 环境都可用。Phase 0 应固定测试版本，逐项用最小样例验证。若 SDK 无法满足必要控制，可评估[官方 app-server 接口](https://learn.chatgpt.com/docs/app-server)或收缩自动验收范围；替换接口须重新验证权限、生命周期和成本，不能仅因接口名称相近就直接迁移。

## 4. 核心技术模块

| 模块 | 主要职责 | 关键约束 |
|---|---|---|
| MCP Gateway | `create_task`, `dispatch_task`, `task_status`, `guide_task`, `revise_task`, `pause_task`, `resume_task`, `cancel_task`, `emergency_stop`, `takeover` | MCP 进程退出不应终止 Daemon 任务；全部命令可审计、鉴权 |
| Daemon / Orchestrator | 事件调度、任务状态、执行锁、失败与重试策略 | 非模型进程；不得推理替代 Codex 决策；单项目串行 |
| Session Registry | 项目、任务、Codex Desktop、SDK、DSH 原生 Session IDs 的映射 | 不直接读写 `.codex/sessions`、Codex 原生数据库和 DSH 内部存储 |
| DSH Adapter | 能力探测、执行、事件订阅、会话恢复、取消及审计 | 不能把同名命令当作等价安全能力；未知状态不可自动重放 |
| Codex SDK Adapter | 会话启动与继续、L2 回答、独立 Review、返工方案 | 技术决策范围受任务授权限定；不得改写项目级目标 |
| Execution Router | 按 E0–E2 风险与实际适配器能力选择执行通道 | 强制策略优先于桌面显示体验；不足则阻止执行 |
| Workspace Manager | worktree／非 Git 副本、现场快照、变更校验、验收后安全集成 | 禁止未审查直接覆盖主项目；保护未提交变更 |
| Memory Manager | MD 记忆建议、版本检查、原子提交、来源追踪 | 重要记忆须经 Codex 审核及 Bridge 授权写入 |
| Approval Manager | L3 操作申请、可视化说明、用户批准、限时令牌、复核 | 未获有效批准不得执行受保护操作 |
| Budget Manager | Codex SDK／DSH 分开统计与调用预算 | 计量来源/估算/未知必须显式标注 |
| Web Console | 辅助监控、任务控制、Token 面板、审批、日志、设置 | 不承接日常 AI 聊天；本地访问也须授权 |
| Recovery Manager | 断线、重启、重复事件、执行状态不明时恢复 | 先核实文件和进程，再决定恢复；副作用不明暂停 |

**最小实现顺序：** MVP 可把上述职责实现在同一后台进程中，用明确的数据接口分隔，不要求每个模块独立进程。先打通一个受控执行通道与单任务闭环；多通道路由、完整网页和高级记忆在基础链路经过验证后再扩展。

## 5. 决策级别、执行风险与安全约束

### 5.1 决策权级别 L0–L3

| 等级 | 决策主体 | 例子 |
|---|---|---|
| L0 | DSH 自主处理只读、低风险行为 | 浏览已授权文件、分析测试日志 |
| L1 | DSH 在任务边界内自主处理局部修改 | 修改允许的代码文件并解释原因 |
| L2 | Codex SDK 处理跨模块取舍、技术歧义；越权上报 Desktop／用户 | 需权衡公共接口兼容性及架构调整 |
| L3 | 用户通过 Bridge 认可具体高风险操作 | 删除重要数据、系统设置、真实部署、涉及凭据的危险行为 |

### 5.2 执行风险 E0–E2（与 L0–L3 独立）

| 等级 | 行为 | 默认执行约束 |
|---|---|---|
| E0 | 只读分析 | Web Host 优先，但必须具有真实只读强制边界；没有边界则选择可强制只读的通道 |
| E1 | 隔离代码修改、运行测试 | worktree／受控副本 + 受限制工具/目录/网络；按能力选 Web Host 或 ACP/Headless |
| E2 | 受保护写入或外部副作用 | 默认拒绝，必要时逐操作 L3 审批 + 环境强制限制 + 审计 |

**重要：** Git worktree 是版本控制级工作树隔离，不是 OS 安全沙箱。仅靠提示词、允许路径列表或 Git wrapper 也不能保证阻止越权文件读写、网络访问或命令执行。可用的强隔离需实测 Windows 进程令牌、ACL、子进程控制、网络权限和具体执行通道边界；必要时禁止某类任务运行。

**执行边界必须覆盖两个 Agent：** DSH 执行、Codex SDK 决策/Review 及其调用的测试命令都要分别限定目录、网络、可见凭据和可调用工具。仓库文件、任务 MD 和模型输出均视为不可信输入；高风险操作在实际工具执行入口复核授权，不能只依赖 Agent 遵守提示词。Codex 的[Windows 沙箱文档](https://learn.chatgpt.com/docs/windows/windows-sandbox)仅说明 Codex 自身可用的隔离方式，不能推断 DSH Web Host 也继承同一边界。

### 5.3 风险路由规则

1. Codex 形成 Task Contract，标注决策范围、允许路径、禁止操作和建议风险等级。
2. Bridge 校验真实适配器能力：建立会话／事件、指定工作区、取消、恢复、强制文件权限、审计等。
3. 若 Web Host 满足任务强制要求，优先选它以保留 DSH 可视化；否则选择能够实际满足控制的 ACP/Headless 或拒绝启动。
4. 记录 `adapter_kind`, `adapter_version`, `capability_snapshot`, `execution_level`, `risk_reason`, `approval_refs`。
5. 任务已开始执行后，不允许未经现场核实就切换通道并重发。新通道意味着新的 Attempt，并先检查前一个 Attempt 的副作用。
6. 首次通道回退提示确认属于**建议默认**，而不是正式审批的替代；即使用户同意切换，也不能绕开 E2/L3 强制要求。

## 6. 会话模型与 Session Registry

实体包括：`Project`, `Task`, `TaskRevision`, `ExecutionAttempt`, `NativeSession`, `DecisionTurn`, `Review`, `MemoryVersion`, `Event`, `Approval`。

- `project_id`：项目唯一标识；路径需进行 canonicalization，防止同一项目被错误注册两次。
- `task_id`：稳定任务标识，如 `TASK-001`。
- `revision`：任务需求版本；普通 Guidance 不必增加主需求版本，实质方案变更必须增加。
- `attempt_id`：执行尝试标识；重试和通道切换均新建 Attempt。
- `codex_desktop_session_id`：尽力关联项目主会话；宿主不暴露时记为未知。
- `codex_sdk_session_id`：每任务独立，任务内部复用，损坏时创建新会话并交接。
- `dsh_session_id`：尽力恢复原 Session，无效时凭检查点创建新会话。
- `workspace_ref`：worktree 或受控副本路径与基准版本。
- `lease_owner`, `lease_expiry`, `fencing_token`：防止多个进程同时接管同一执行尝试。

SQLite 保存任务状态、版本、事件、审批和调用结果的权威记录；Markdown 是可审阅的任务材料与交接视图。重启时以数据库和工作区现场共同核对 MD，不能仅凭某份 MD 文本推进状态。面向 Agent 的任务输入要包含稳定的任务/版本/尝试标识，返回结果要区分完成、失败、请求决策、状态未知，并保存可核对的证据位置。

**隔离边界：** Codex Desktop 与 Codex SDK 的本机配置目录可能存在兼容性或关联性，但不应以共享原生历史文件作为 Bridge 的必需功能，也不应自行篡改任意 Agent 的私有会话文件。

## 7. 共享目录、Markdown 和 Git 策略

```text
MyProject/
├── AGENTS.md                       # 仓库跟踪：共享短规则与 RelayCore 入口说明
├── .gitignore                      # 必须忽略 /.RelayCore/ 与 /local/
├── local/notes/                    # 开发学习笔记；整个 /local/ 不进入 Git
├── src/
└── .RelayCore/                    # 用户选定的唯一项目数据目录
    ├── .agent-memory/
    │   ├── INDEX.md
    │   ├── PROJECT.md
    │   ├── ARCHITECTURE.md
    │   ├── DECISIONS.md
    │   ├── PROGRESS.md
    │   └── LESSONS.md
    ├── .agent-tasks/
    │   └── TASK-001/
    │       ├── TASK.md             # Codex 创建／修订
    │       ├── GUIDANCE.md         # 中途指导记录
    │       ├── QUESTIONS.md        # DSH 提问
    │       ├── RESULT.md           # DSH 结果与证据
    │       ├── REVIEW.md           # Codex SDK 审查
    │       ├── REPAIR-001.md       # 审查失败后的返工 Overlay
    │       └── HANDOFF.md          # Desktop 可读取的简短交接
    ├── bridge/
    │   ├── state.sqlite           # WAL 模式、事件及 Registry
    │   └── config.json            # 非密钥项目配置
    └── logs/
        └── TASK-001.jsonl
```

默认 `.gitignore` 包含 `/.RelayCore/` 和 `/local/`。用户选择运行数据目录大小写为 `.RelayCore`；`local/notes/` 单独保存每阶段学习笔记，不作为运行时数据目录。跨平台实现需要避免仅依赖 Windows 不区分大小写的行为。

由于该目录默认不进入 Git，项目迁移与灾难恢复不能依靠代码仓库：安装和卸载流程应提供用户可选择的导出、备份与恢复路径，说明哪些数据包含任务历史和敏感内容。SQLite 使用 WAL 时应通过一致性备份机制生成快照，不直接复制运行中的单个数据库文件；日志和任务材料需设置可配置的保留与清理规则，导出前提示脱敏风险。

**重要目录隔离问题：** Git worktree 不自动共享主工作区中 Git 忽略的 `.RelayCore/`；也不应该为所有 worktree 偷偷创建具有任意写权限的目录链接。推荐 Bridge 从主项目的 canonical `.RelayCore/` **生成最小权限知识包**到受控执行区，按角色映射任务 MD 写入权限；状态库、审批记录、核心长期记忆仍由 Bridge 统一控制。非 Git 受控副本遵循相同原则。

工作区创建前检查未提交改动、被忽略文件、符号链接／Windows 重解析点、仓库元数据及副本体积；复制与合并时重新检查实际路径和变更范围，防止目录穿越及检查后路径变化。记录任务基线、文件清单与大小上限；无法安全处理的大型或特殊项目先拒绝自动执行，由用户选择缩小范围。

### 7.1 文档职责及最小内容

- `TASK.md`：目标、上下文、允许/禁止路径、完成标准、验收步骤、风险级别、预算、当前 revision。
- `GUIDANCE.md`：补充要求、来源、接收序号、`queued/delivered/acknowledged` 状态；实质改方案需触发 revision。
- `QUESTIONS.md`：问题、可选方案、阻塞点、决策请求 ID、L2/L3 判定。
- `RESULT.md`：完成内容、改动清单、实际测试及退出状态、未完成项、执行证据。
- `REVIEW.md`：Codex SDK 验收结论、独立测试、风险、修复要求、是否批准合并。
- `REPAIR-nnn.md`：增量返工指示及失败项，不隐式删减原任务验收条件。
- `HANDOFF.md`：可在 Desktop 重读的简短总结、状态、文件位置、待用户事项。

### 7.2 记忆提交规则

任务期的指定 MD 文件可由相应 Agent 在授权目录写入；长期项目记忆由 Codex SDK 或 Desktop 提出结构化更新建议，Bridge 检查提交者、来源、引用任务、基准版本和并发冲突后原子写入。`DECISIONS.md` 应特别标注决定者、适用范围与生效日期；用户/项目主会话决定高于任务 SDK 的委派技术判断。未经 Review 批准的执行结果不得自动成为权威长期记忆。

## 8. 任务状态机与可靠异步协议

建议状态流：

```text
DRAFT → QUEUED → PREPARING → RUNNING_DSH → REVIEW_PENDING
                          │              │         │
                          │              ▼         ▼
                          │        WAITING_DECISION  RUNNING_CODEX_REVIEW
                          │              │           │
                          │              └─ RESUME    ├─ APPROVED → INTEGRATING → COMPLETED
                          │                          └─ REJECTED → REWORK_QUEUED → RUNNING_DSH
                          ▼
                    PAUSED / BLOCKED / RECOVERY_REQUIRED / CANCELED / FAILED
```

实现时将控制状态（暂停请求、取消请求、执行回合）与业务状态分离，避免单字段复杂分支。审批等待 `WAITING_APPROVAL` 应使自动执行停止，审批过期不得自动通过。

**事件 envelope 建议：** `event_id`, `project_id`, `task_id`, `revision`, `attempt_id`, `session_ref`, `producer`, `type`, `timestamp`, `payload`, `idempotency_key`, `sequence`。

关键事件：`task.created`, `task.dispatched`, `execution.started`, `guidance.queued`, `guidance.delivered`, `decision.requested`, `decision.resolved`, `execution.completed`, `review.started`, `review.approved`, `review.rejected`, `approval.requested`, `approval.granted`, `task.recovery_required`, `task.completed`。

可靠性规则：SQLite WAL/事务；至少一次消息投递时消费端幂等；原子状态迁移及乐观版本检查；同一 `attempt_id` 的重复完成事件只创建一条待 Review 记录，外部 Review 调用结果未知时暂停对账；队列状态必须区分**已保存、已送达、已处理**；每个自动模型调用遵循预算和控制权检查；日志与 MD 对外投递须脱敏。

**崩溃窗口：** Bridge 可能在外部 Agent 已接受调用、但本地尚未记录返回结果时退出。事件去重只能防止本地重复入队，不能证明外部调用只发生一次。每次调用先持久化请求 ID、已知目标会话或会话创建意图及调用状态，再发起调用；恢复时优先按外部会话/请求标识查询并对账。若目标接口无法查询或幂等重试，标记 `RECOVERY_REQUIRED`，不得自动重发可能产生费用或文件副作用的回合。验收目标改为“重复事件不自动产生重复 Review 副作用”，并用故障注入验证该边界。

## 9. 中途引导、暂停和紧急控制

**普通引导：** 用户在 Codex Desktop 使用正常的「引导」或补充对话，Codex 需要**显式调用 RelayCore MCP** 才能将指导发送给 Bridge；不能默认 Desktop UI 的每句补充会神奇同步到 DS。Bridge 先持久化，不中断 DSH 的活跃回合，待适配器允许的安全时机再投递并追踪 ACK。

**实质方案变更：** 若修改范围或验收目标，Codex/Bridge 要求停止继续使用旧版本任务，执行暂停或取消，核查现场，增加 `revision`，再由 Codex 产生新指示。旧版本未完成结果不能直接批准合并。

**暂停：** 发起 pause → 尝试适配器级暂停／取消当前回合 → 确认文件和子进程现场 → 创建 Checkpoint → 视情况 `PAUSED` 或 `RECOVERY_REQUIRED`。不要假设 DSH 每个工具都支持即时暂停。

**紧急停止：** 本地 Web 和直接 Bridge 控制接口优先，绕开模型推理；发送取消、必要时终止可确认属主的进程树，记录执行状态。**停止推理不等于撤销已写入文件，也不等于所有外部命令已终止**。不明副作用应进入 `RECOVERY_REQUIRED`。

**同时推理原则：** 自动调度默认不同时启动 Codex 和 DS；用户主动使用 Desktop 补充或接管时可以存在短时间并行模型活动，但不可让两个 Agent 同时写入同一个隔离执行区域。

## 10. 任务恢复与工作区合并

### 10.1 正常恢复

1. 读取最新 Task Revision、Session Registry、Checkpoint、MD、Event Journal。
2. 检查 DSH 原 Session 还在不在、是否有活动请求/子进程、工作区是否与记录一致。
3. 安全时优先原 Session 继续；无法恢复但现场可解释时新建 DSH Session 并发送最新 Task + 已完成项 + 未完成项摘要。
4. 不得重复已经发生不可逆副作用的命令；不确定时进入 `RECOVERY_REQUIRED` 等待人工。

### 10.2 Windows 意外退出恢复

启动后执行持久锁/租约检查、孤儿子进程检查、已有 worktree 差异审计、适配器事件断点查询、预算和任务版本核对。先判定“仍在运行／已完成／失败／状态未知”，再决定接管、重新订阅、进入验收、暂停。禁止一律从头重跑。

### 10.3 整合至主工作区

Codex 审查通过只是必要条件，Bridge 在合并前还需复查工作区基线、Git 状态、变更范围、外部改动、冲突和敏感文件；不能自动覆盖用户尚未提交的修改。非 Git 受控副本应先有可还原快照、文件清单及差异预览。`commit`、`push`、`deploy` 等与本地文件集成不同，须独立授权。

Review 必须对照 Task Contract 检查实际 diff、失败/跳过的测试及新引入的风险。若 Codex SDK 需要运行验证命令，应在独立的受控验证副本中进行，并记录它产生的变化；不能把 DSH 的自述或同一个可写工作区里的测试输出当作独立验收证据。自动整合只覆盖明确允许的本地文件变更；边界不清或目标工作区已变化时暂停并交用户处理。

## 11. Token 统计、预算与成本

**建议默认（待用户正式确认）：** 为 Codex SDK、DSH 和任务总量分别设置软预警及硬阈值。软阈值提醒；硬阈值限制**后续模型回合**，而不是假装总能中途抢断正在执行的模型请求。支持最大自动返工轮次、最长任务时长、最大 L2 决策轮次等非 Token 守护。

即使预算管理完整界面留到 Phase 4，MVP 启动前也要有可配置的回合数、返工次数和运行时间上限，以及手动停止入口。用量未知时不能声称满足 Token 硬阈值；应按已确认策略停止自动续跑或转人工。预算在外部调用前检查，并为正在进行的回合保留可能超支的提示，避免把硬阈值描述成精确费用上限。

**数据来源分级：** `reported`（官方接口确实报告）、`estimated`（明确估算方法）、`unknown`（无法获取）。保留输入、输出、缓存相关 Token（存在时）、模型名、会话、任务、时间、是否累计值等字段；处理 SDK 返回累计数据导致重复计数的风险。费用仅在定价模式清楚时估算，不能把 Token 总数与真实账单混为一谈。

**核心承诺：** 分别查看 Codex SDK 和 DSH 的自动任务用量，并尽可能查看各自细目。Codex Desktop **日常原生聊天**的完整 Token 可能未通过官方接口暴露，不能承诺把整个 Desktop 的一切使用全部准确计算进 RelayCore 面板。界面必须明确“纳入 Bridge 的调用”与“外部桌面客户端活动”的统计边界。

## 12. Windows 运行、安装与本地网页

### 12.1 部署形态

**已确认：** 独立 Daemon + MCP Gateway。**建议默认（待确认）：** 用户登录后自动启动的用户权限进程；不默认要求管理员权限安装 Windows Service。Daemon 独立于 MCP 会话存活，空闲时不调用模型；Codex Desktop 可关闭当前回合，后台按事件继续调度。

用户退出登录、系统休眠/关机、DSH Host 退出时不能保证任务继续；重新启动须执行恢复检查。Daemon 无界面模式也要提供事件日志、状态查询和紧急停止入口。

### 12.2 安装流程

**建议默认（待确认）：** CLI 完成安装、更新、诊断、卸载；首次配置向导校验 Codex SDK/CLI、DSH Web Host、Node/运行时、Git、工作目录、MCP 注册、文件访问权限；必要时提供包管理/依赖检查指导，不静默覆盖现有 Codex/DSH 配置。安装版本、用户项目数据、SQLite 备份和升级迁移相互隔离，支持回滚。

### 12.3 Web 控制台定位

建议 Web UI 仅监听 `127.0.0.1`，即使在 localhost 也要防止跨站请求、恶意网页跨源访问及未经授权的敏感控制。敏感操作必须具备本地访问凭证、请求源校验、CSRF 防护、权限检查及审计；端口冲突/代理/防火墙情况应诊断清楚。

Web UI 主要页面：**总览**（Codex/DSH 状态、活动任务）、**任务**（事件、失败、暂停/恢复）、**用量**（两个 Agent 分开 Token/费用）、**审批**（L3 可信记录）、**配置**（连接与权限）、**诊断**（版本、日志、恢复记录）。不把它定位成替代 Codex Desktop 的聊天应用。

### 12.4 轻量化验收

- 常驻只有必要调度与事件监听，不通过频繁轮询或常驻模型会话模拟后台工作。
- 不内嵌大模型；SQLite 本地使用，不要求独立数据库服务。
- Web 控制台尽量按需加载、可关闭不影响 Daemon 的正常任务。
- 要通过实测记录空闲 CPU、内存、启动时间、日志磁盘增长以及任务延迟；正式发布前再制定具体数值阈值，**不虚构性能指标**。

## 13. GitHub 参考项目：可借鉴部分与不能照搬的部分

采用**独立研发、模块化借鉴**。以下为截至 2026-10-13 公开仓库说明所展示的能力，部分由作者声明，尚未经过 RelayCore 本机实证；具体代码复用须进一步进行源码审计、许可证核验和 Windows 集成验证。

### 13.1 jony5933/codex-dsh-bridge

- 地址：https://github.com/jony5933/codex-dsh-bridge
- 重点学习：DSH Web Host Workspace/Session 创建、mux/host 事件订阅、运行 evidence、兼容探测与 fail-closed；`web-direct` 可视化和 `web-guarded` 工作区／Task Contract／独立检查的设计。
- 明确局限：Web Host 实时显示的测试说明不等价于对所有 Windows DSH 原生 Electron 窗口的承诺；Web Host 与 Headless 的权限／每会话环境能力不必然相同；不能把 worktree 当作 OS 沙箱。
- RelayCore 自行实现：能力驱动风险路由、Daemon、Session Registry、自动 Codex SDK 验收、受控记忆、可靠暂停恢复和用户审批。

### 13.2 WebisityStudio/claude-codex-mcp-bridge

- 地址：https://github.com/WebisityStudio/claude-codex-mcp-bridge
- 重点学习：SQLite WAL mailbox、消息幂等键与 ACK、独立后台 Codex Worker、持久 Run 状态、异常退出后的接管、只读 Review、版本化运行时及回滚。
- 明确局限：其主要协作组合为 Claude 与 Codex；某些桌面唤醒路径基于 macOS 观察到的本地接口，不等于 Windows 官方稳定接口；“消息投递”并不自动让任意 Desktop 原生会话开始模型回合。
- RelayCore 自行实现：Windows 用户级 Daemon、DSH 生命周期统一控制、按风险切换执行通道、桥接状态机与长期共享记忆。

### 13.3 knottttt/codex-dsh-bridge

- 地址：https://github.com/knottttt/codex-dsh-bridge
- 重点学习：Codex MCP 到 DSH WebUI HTTP RPC 的任务下发、插件与安装脚本组织、轻量协作 Skill。
- 明确局限：它不应被直接认定为具备完整的后台调度、持久恢复、L0–L3、安全工作区和验收闭环；需要以实际代码为准。

### 13.4 引用与许可证规范

每个项目在未来 `docs/references.md` 保留：URL、所参照组件、版本/Commit、许可证、是否引用代码、审计结果、兼容性测试和适配状态。技术思想借鉴与复制具体代码是不同事项；如复制或修改 MIT 代码，需遵守原始版权及许可证通知。对每项能力标注 `已验证`、`作者声明`、`待验证`，禁止用 README 描述替代 Windows 本机安全测试。

## 14. 重要风险清单及专项验证

| 风险 | 影响 | 必须验证的事项 |
|---|---|---|
| DSH Web Host 与 Windows 原 GUI 不完全互通 | 无法原窗口显示 | 会话是否出现、实时事件、Workspace 归属、断线重连 |
| Web Host 权限弱于 Headless | E1/E2 可能越权 | 真实目录/工具/网络边界；失败必须拒绝或换受控通道 |
| Windows 用户会话及子进程管理 | 进程孤儿、注销中断 | 用户级后台启动、进程树控制、休眠/关机重启恢复 |
| Codex Desktop 不提供后台回写 UI API | 主聊天不自动出现完成消息 | MCP 查询及 HANDOFF 读取作为可靠替代 |
| Agent 完成事件重复/丢失 | 重复验收或漏验 | event idempotency、重放、SQLite 事务、超时核查 |
| 非 Git 项目受控复制 | 文件权限/链接/大文件风险 | 文件筛选、快照、差异、取消、恢复与合并校验 |
| Git 忽略 `.RelayCore/` 跨 worktree 不共享 | DS 无法读取共享记忆 | Bridge 生成受限知识包，不暴露 state.sqlite |
| L3 审批被绕过 | 数据损坏或泄露 | 授权与每种工具调用绑定，后端验权，审计 |
| Token 口径不一致 | 误报和超预算 | reported/estimated/unknown、累计数据去重 |
| 升级破坏持久状态 | 丢失任务 | 数据备份、模式迁移、回滚和版本冲突检测 |
| 外部调用结果未知后自动重试 | 重复扣费、重复执行或重复 Review | 请求标识、外部对账能力、崩溃窗口故障注入；无法确认时暂停 |
| SDK Review 与执行区共享写权限 | 验收证据被污染或越权修改 | 独立受控验证副本、测试输出和验证区差异审计 |
| MVP 先于安全门槛落地 | 早期任务在无预算/权限控制下运行 | Phase 0 验证可行方案；Phase 1 实现并验证基础限制后才放行自动写入 |

## 15. 分阶段开发路线与验收标准

> 这是**未来开发路线**，不是表示已实际实施。每阶段均需通过测试与演示才能认为完成。

Phase 0 已开始，当前事实与未通过项记录在 `docs/phase-0-feasibility.md`。每阶段完成后，在不入库的 `local/notes/phase-N.md` 写清目标、所做操作、核心概念、实测证据、失败与下一步；必须入库的设计、接口、验证和使用文档放在 `docs/`。README 从 Phase 0 开始维护，并始终标明已实现与计划中的功能。完成一阶段后先交付验收结果，再由用户决定是否进入下一阶段。

### Phase 0 — 可行性验证与安全基础

验证 Windows Codex Desktop MCP 调用可行性、Codex SDK 会话/鉴权/审批能力、DSH Web Host/ACP/Headless 真正可用的接口、Token 报告、工作区隔离及子进程取消行为；建立版本兼容表与最低安全条件；完成许可证与依赖审查。将 SDK、DSH、Windows、鉴权方式和执行通道版本写入测试记录；对每项能力标注官方文档、第三方声明或本机实测，并记录复现步骤和失败样例。

**验收：** 每项必要能力有通过/失败/未知结论及证据；对于无法满足权限要求的通道能安全拒绝执行；确认 Desktop 回写和 Token 可见范围。Phase 1 的准入条件是至少一个 DSH 通道可在目标 Windows 环境受控执行、Codex 后台调用可独立完成验收，并且最小停止、权限和用量限制有可实现且可测试的方案；这些限制在 Phase 1 完成前不得放行自动写入任务。若任一条件不满足，先调整范围与设计。

### Phase 1 — 最小可靠闭环（MVP）

完成 Daemon + MCP + SQLite 事件队列 + Registry + MD Task Contract；让 Codex Desktop 提交最小任务、DSH 执行、Codex SDK 独立验收、生成 HANDOFF。初期只接入一个已验证的 DSH 受控通道和受控任务工作区，同时实现最小权限边界、任务数量/时间限制、调用前预算检查、手动停止和未知状态暂停；完整风险路由和审批界面仍按后续阶段扩展。

**验收：** Codex 调度后无需继续推理等待；单任务自动完成执行→Review→状态/MD 更新；重复事件或崩溃恢复不会在结果未知时自动重复外部调用；用户能查询任务状态，并在不依赖模型回复的情况下阻止新回合、尝试取消当前回合，取消结果不明时进入 `RECOVERY_REQUIRED`。Review 在受控验证副本中检查真实变更与测试证据。

### Phase 2 — 工作区隔离与可靠恢复

完善 worktree、非 Git 副本、快照、任务版本、暂停/恢复、崩溃现场核查、重复副作用保护、回滚/冲突检查、受控合并；扩展 Phase 1 的基础隔离实现。

**验收：** 进程崩溃后不盲目重放写操作；未知结果进入 `RECOVERY_REQUIRED`；独立验收失败不得合并；未提交用户修改不会被无提示覆盖。

### Phase 3 — 执行通道路由、引导与权限

接入 Web Host 可视化与 ACP/Headless 的能力探测；普通引导队列、方案版本修订、完整 L0–L3 / E0–E2 路由、紧急停止、可信 L3 审批接口；扩展 Phase 1 的停止与权限能力。

**验收：** 低风险可视化任务在兼容环境可展示；能力不足自动拒绝或转已验证通道；普通引导不强制中断当前 DSH 回合；紧急停止不依赖模型回复；无授权 E2 操作无法执行。

### Phase 4 — 共享知识、预算、Web UI 与 Windows 安装

实现版本化 Memory Manager、Token 分账和完整预算策略、本地监控/审批网页、CLI 安装诊断、用户级后台启动、日志与升级管理；扩展 Phase 1 的基础预算限制。

**验收：** 长期记忆并发更新防覆盖；Codex SDK 与 DSH 用量分别展示并注明可见范围；仅打开监控页不产生模型调用；关掉网页不会影响后台任务；升级失败可回滚并保留用户项目数据。

### Phase 5 — V1.0 发布准备

进行自动化单元、集成、故障注入、安全边界、真实双 Agent 端到端实验；完善英文/中文 README、安装/卸载、安全政策、兼容矩阵、贡献指南、许可与引用归档。

**验收：** Windows 全流程可复现；高风险路径无已知绕权；关键失败恢复可解释；性能测量符合预先公开指标；仓库无敏感数据；文档与实际功能一致。

## 16. 推荐的后续工作规则

1. **先验证再开发**：不要依据第三方 README 假设当前 DSH Windows 版本的所有能力都存在。
2. **每个模块独立可测试**：Adapter、Queue、Registry、Approval、Memory、Budget 之间用清晰契约交互。
3. **MCP 与调度进程分离**：Codex Desktop 断开不代表取消任务。
4. **先实现安全的单任务闭环**：避免提前为多 Agent 并发引入复杂状态争用。
5. **所有外部写操作以可观察证据为准**：DS 自我报告不得替代 Git diff、测试输出和 Bridge 记录。
6. **默认拒绝高风险未知能力**：未知兼容性、审批失效、执行状态不明时不自动升级权限或重复执行。
7. **日常用户体验尽可能一站式**：主交互留在 Codex Desktop；Web Console 只是必要时打开。
8. **开源代码必须有明确版权及依赖边界**：任何复制/修改第三方实现均附来源与许可。

## 17. 最终设计摘要

RelayCore 的核心不是让两个 AI 同时持续推理，而是**让 Codex 负责计划和验收、DSH 负责实施、Bridge 负责可靠接力**。用户主要留在 Codex Desktop；项目记录位于 `.RelayCore/`；后台以事件而不是持续推理驱动工作。执行通道按安全能力选择；任务和共享记忆保留可追溯版本；恢复时先验证现场，不能确定就停下来。V1 聚焦 Windows 单项目串行闭环，确认稳定后再考虑跨平台与多 Agent 扩展。

---

**注意：** 本文件是设计/计划文档，不代表 RelayCore 已完成安装、编写、运行或安全验证。第二节中标记为“建议默认／待确认”的项目仍应在开始相应开发阶段前由项目负责人正式确认。
