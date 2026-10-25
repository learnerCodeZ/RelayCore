# Phase 1 实现状态

状态：**进行中，未达到 MVP 验收标准**。截至 2026-10-25，已实现本地控制骨架、内部时限/回合守卫、独立验收材料，以及 DSH 数据提案→受控副本写入→SDK Review 的内部组合执行器。无模型测试 50/50 通过（含账户路由与 console shim 测试）；账号路线无模型检查 `npm run check:dsh-account` 通过，一次受限账户真实提案首次成功（`DeepSeek-V4.1-Flash`、1 轮、提案未应用、源文件未变、用量 unknown）。DSH Desktop 的只读拒写、工作区内写入和默认越界拒写，以及 ACP 只读拒写和提示取消各有单点证据。SDK 专用账号已登录，首次真实验收诊断取得线程 ID，但超时未得到结论和用量。完整 Windows 权限边界、提权审批、工具执行中取消、双模型闭环和远端 Git 状态仍未验证。用户要求连续推进，不等于放行未验证的生产自动写入。

## 已实现与验证

| 能力 | 当前事实 | 证据 |
|---|---|---|
| 独立 Daemon | 用户手动启动的 Node 进程监听 `127.0.0.1`；MCP 进程退出不影响 Daemon | `test/protocol.test.mjs` 启动两个独立进程 |
| MCP stdio | `initialize`、`tools/list`、`tools/call` 支持草稿创建、列表、状态、事件、停止；执行请求会被拒绝 | 本地协议集成测试；2026-10-25 当前 Desktop 聊天实际完成创建、状态/事件查询与取消 |
| Windows 本地控制口令 | 未设置显式口令时，Daemon 用 DPAPI 当前用户范围加密保存随机口令，MCP/CLI 从同项目文件解密；不再依赖 Desktop 继承临时环境变量 | `test/auth.test.mjs` 和无口令环境变量的独立进程协议测试；主机本地查询及重新加载后的 Desktop `list_tasks` 均成功 |
| SQLite | `tasks`、`events`、`sessions` 表，WAL 模式；单进程写入；草稿和事件重启后可读 | `test/core.test.mjs`；未做并发/压力测试 |
| Task Contract | 每个草稿写入 `.RelayCore/.agent-tasks/TASK-*/TASK.md`，保存目标、验收文字、可选 `allowedPaths` 与 `executionLimits` 声明 | 文件及 MCP 测试覆盖字段保存和无效值拒绝；内部有执行器时派发必须声明上限，生产执行和 Token 预算仍缺失 |
| MCP 草稿生命周期 | 独立诊断客户端和当前 Desktop 聊天均对用户运行的 Daemon 完成创建、状态、事件与取消 | `scripts/smoke-task-lifecycle.mjs` 真实运行结果及当前聊天五个原生 MCP 工具实测，任务留为已取消的审计记录 |
| 内部执行限制 | 派发事件决定总时限，含排队；超时/用户停止立即进入 `RECOVERY_REQUIRED` 并发取消信号；每次适配器提示前可事务预留跨 Agent 回合并记调用意图 | 注入执行器测试覆盖超限、未知结果、排队过期、停止后拒绝新回合及重启保留意图；尚未验证真实外部进程的停止 |
| 独立验收材料与 SDK 入口 | 原始/候选文本封装为独立 `REVIEW.json`；SDK 入口隔离 home、禁用工具并检查哈希、结构化结论和用量 | 快照/冲突/体积测试、假 SDK 事件测试、原生 CLI 和 `--check-only` 检查；首次真实诊断取得线程 ID 后 30 秒超时，无完成/用量证据，未接生产 Daemon |
| SDK 独立账号登录入口 | `npm run login:review` 调用随包 CLI 登录，使用专用 home；另支持显式测试 API Key，不读取或复制 Desktop 凭据 | 用户浏览器授权成功后，主机当前用户实测 `authenticated:true`；目录 ACL 已核对仅当前用户和 SYSTEM。缓存登录成功不等于模型可用性已通过 |
| DSH 数据提案与组合执行器 | DSH 只返回声明文件的完整替换文本；Core 在运行任务中检查范围、基线及停止信号后只写候选，另生成 Review 快照，独立批准后才产生交接 | `test/dsh.test.mjs` 使用真实 ACP 子进程协议、假 DSH 和假 SDK 验证内部成功链及工具/权限/迟到工具、错误会话、无效/越界提案、停止、拒绝与共享额度；新入口的真实 DSH 无模型连接通过，真实提案未测 |
| DSH 账号认证 | 官方支持 `deepseek-account`，与 API Key 的 `deepseek-official` 分离；`src/dsh-account.mjs` 实现账户环境白名单与原生模型选择，账户参数与 API Key 禁止混用 | 2026-10-25 无模型检查首次通过（账户插件 stdout 日志污染由 `--import` 预加载 console shim 修复）；一次受限真实提案首次成功：`deepseek-account` / `DeepSeek-V4.1-Flash`、恰好 1 轮、精确 JSON 提案、源文件未变、未应用、0 SDK 调用；单点样本，用量 unknown，稳定性未证 |
| 非 Git 文件副本与变更清单 | 内部 `prepareWorkspace` 复制声明文件并保存基线；`verifyWorkspace` 检查原样副本；`inspectWorkspaceChanges` 列出副本变化；`inspectSourceConflicts` 对比主项目已声明文件 | 测试覆盖复制范围、目录/链接拒绝、失败清理、副本内容变化、主项目改动/删除、缺失/额外项、超限文件和基线不匹配；未接入 Daemon/MCP/DSH，不是 OS 沙箱或独立验收 |
| 状态与停止 | 草稿/排队任务可取消；运行任务停止立即标为 `RECOVERY_REQUIRED`，发 AbortSignal，禁止新回合或迟到结果完成 | 注入测试执行器测试；不是实际 DSH 取消能力的证明；不响应取消的执行器未结束前仍占用串行队列 |
| 崩溃恢复 | 启动时把遗留 `RUNNING` 转为 `RECOVERY_REQUIRED`，不自动重播 | 手工模拟遗留状态的测试 |
| 关闭与交接写入 | 关闭后才返回的模拟结果不得写交接；不超过 1 MiB 的 `HANDOFF.md` 与数据库完成事务之间不再让出 JS 事件循环 | 定向回归测试；进程崩溃或磁盘/数据库故障仍可能留下孤立文件，启动时仅标记待对账 |
| 孤立交接启动对账 | 若未完成任务已有 `HANDOFF.md`，启动时转为 `RECOVERY_REQUIRED` 并记一次对账事件，不读取结果、不自动完成或删除文件 | 草稿模拟孤立文件与重复启动测试；尚未覆盖跨进程并发篡改或真实执行器 |
| 单实例与任务领取 | 同一项目第二个 Daemon 在打开状态库前被锁文件拒绝；领取排队任务与记录开始事件使用同一事务 | 进程级双实例测试、事件计数测试 |
| DSH ACP 诊断连接 | 连接层支持会话生命周期、取消通知、单段文本提示、更新事件；收到 ACP 权限请求时默认返回取消 | 假服务测试覆盖提示/更新、运行中提示取消和协议异常；无模型生命周期探测通过；真实文本提示得到 `OK`；随后一次真实提示取消返回 `cancelled`；未接入 Daemon |
| ACP 只读拒写单点探针 | 显式 `--probe-readonly` 在一次性工作区请求建一个文件、记录工具与权限事件，并核对目标是否存在 | 用户报告真实回合 `toolCalls:1`、工具状态 `failed`、`permissionRequests:0`、`denialReported:true`、`targetExists:false`；仅为这一条拒写的单点证据，不计入完整安全验收 |
| DSH Desktop 只读拒写 | 一次工作区内建文件操作被报告为沙箱拒绝，文件未出现 | 用户提供错误文字；随后独立检查 `D:\MYCODE\RCtest` 为空。未验证 ACP 或完整 Windows 边界 |
| DSH Desktop 受控写入 | 一次工作区内建文件成功，当前目录只有该文件 | 独立核对 `relaycore-write-probe.txt` 是 5 字节 `probe`；此项只验证工作区内写入 |
| DSH Desktop 默认拒绝越界写入 | 一次写入工作区兄弟目录的尝试被报告为沙箱拒绝；未请求提权 | 独立核对 `D:\MYCODE\RCtest-boundary` 为空；不能外推到所有路径、提权流程或 ACP |

生产 Daemon 没有传入执行器。`src/acp.mjs` 可发送单段文本 `session/prompt`，`src/dsh.mjs` 的内部组合执行器已可串联提案、候选写入与 Review，但只供测试和显式隔离诊断，未接入生产 Daemon。模拟链路验证控制流程，不替代真实模型与安全实测。即便收到 `dispatch_task`，生产 Daemon 也会拒绝；生产路径不会发起模型调用、修改项目源码或产生模型费用。

Task Contract 现可保存最多 32 个 `allowedPaths`，仅接受无 `.`、`..`、反斜杠、绝对前缀或 Windows 设备名的项目相对路径，并拒绝以 `.git`、`.RelayCore`、`local` 为首段的路径及大小写重复项。省略时为 `[]`。这只是**草稿中的意图声明**，不会在外部工具调用或合并时强制核对；不能把它当作安全边界。副本准备会检测当时的符号链接，但尚未解决检查后路径变化。下一步需做副本与基线复核，再决定执行通道。

草稿可保存 `executionLimits`，包含正整数 `maxDurationSeconds` 和 `maxModelTurns`，两者须一起提供；省略时为 `null`。内部有执行器时，派发须声明上限，时长不能超过 Node 定时器技术上限 2147483 秒。从持久化派发事件计算截止时间，排队也计入，启动后已过期的排队任务不会交给执行器。适配器通过 `beginModelTurn(agent)` 在外部提示前事务预留额度并写 `model_turn.requested.dsh/codex` 事件；超限或停止后拒绝新预留。测试验证了这些内部守卫，但**没有真实适配器接入、Token/金额预算、远端取消确认或 Agent 提示内部的模型循环计量**。执行器必须使用接口并处理 AbortSignal；未知执行仍未结束时不领取下一项。产品默认阈值仍待确定。

内部的非 Git 副本准备现只接受显式文件路径：逐段检查目录及最终普通文件，拒绝检测到的符号链接，限制单文件 8 MiB、合计 32 MiB；只将声明文件复制到忽略的 `.RelayCore/workspaces/`，在任务材料目录另存路径、大小和 SHA-256。`verifyWorkspace` 可复核原样副本；`inspectWorkspaceChanges` 返回副本中声明文件的变化路径，并拒绝缺失/额外项、链接和超限文件；`inspectSourceConflicts` 发现主项目已声明文件相对基线的修改或删除。它们**不是内容 Review、diff 或合并许可**，也不检查未声明主项目文件。方法均没有对外执行入口，基线文件不具防篡改能力，检查后也有竞态；仍未处理 Windows 重解析点/大小写别名、受控进程权限或结果整合，因此**尚不能称为安全的执行工作区**。下一步要明确执行通道的运行时限制与合并规则。

用户连续指示后，使用隔离 home/工作区、进程级只读模式和默认拒绝权限请求，共发送三次最短文本提示。前两次 DSH 返回 `ACP -32603`，原因含 `EPERM realpath 'C:\Users\weixing'`；第二次已将 `USERPROFILE` 等变量指向隔离 home，仍失败。当前终端直接解析原路径成功，故具体拒绝源尚不明。第三次将一次性目录及临时变量放入忽略的 `local/` 后，没有再出现该路径错误，而是返回 `llm-deepseek: no API key for provider route "deepseek-official"`。这只说明该配置下请求走到了凭据检查；不能判定哪项路径改动起作用，也不能证明模型调用、用量或沙箱安全。三次均无成功模型文本及可靠用量数据；没有提权或借用 Desktop 凭据。诊断脚本现对 `--run-model` 增加测试 Key 预检；客户端默认拒绝权限请求仍不能阻止所有无需审批的读操作、网络或工具副作用。

随后用户自行在 PowerShell 当前会话设置测试 Key，运行第四次显式 `--run-model`，并提供终端输出 `{"stopReason":"end_turn","reply":"OK","toolCalls":0,"cost":"unknown"}`。这是**用户提供的诊断结果**，不是 RelayCore Daemon 派发或 Codex Review；脚本的 `toolCalls` 仅统计收到的 `tool_call` 更新事件，不能代替完整工具审计。`cost` 未得到数值，需由用户在提供方账单核对；也不能从一条无工具提示推断只读沙箱生效。一次探测后发现项目 `local/` 下遗留一个临时 home 目录，已按固定名称和父目录核对后手工清理；残留原因尚未复现。

单点 ACP 权限试验使用全新一次性工作区，要求创建 `relaycore-readonly-probe.txt`，进程级设置 `DSH_PERMISSION_MODE=read-only`，权限请求自动取消，第二次工具调用会发取消通知。用户提供的输出为 `{"stopReason":"end_turn","promptFailed":false,"replyObserved":true,"toolCalls":1,"toolStatuses":[{"event":"tool_call","status":"in_progress","kind":"other"},{"event":"tool_call_update","status":"failed","kind":null}],"permissionRequests":0,"denialReported":true,"targetExists":false,"outcome":"read-only-denied","cost":"unknown"}`。该 `denialReported` 由脚本从工具事件中匹配只读拒写标识得到，原始工具输入/输出未留存；文件未出现经脚本检查，我独立只读核对 `local/` 清理后只剩 `notes`。这支持这次 ACP 写入拒绝，但**不证明完整 Windows 边界、权限升级、网络限制或取消效果**。用户的 PowerShell 不支持 `Read-Host -MaskInput`；该设置命令报错后探针仍运行，说明启动前环境变量已有非空值，具体来源未核实。`finally` 已在用户终端执行删除变量的命令；用户随后确认 `[bool]$env:DEEPSEEK_API_KEY` 为 `False`。这只核对了该终端当前进程的变量，不证明其他存储位置没有 Key。

`--probe-cancel` 单点诊断在隔离会话发送无工具文本提示，等待一秒；若原提示仍未结束，则发送 `session/cancel` 通知，并等待原 `session/prompt` 的终态。用户提供的真实运行汇总为 `{"pendingAtCancel":true,"cancelSent":true,"stopReason":"cancelled","promptFailed":false,"replyObserved":true,"toolCalls":0,"permissionRequests":0,"outcome":"prompt-cancelled","cost":"unknown"}`；随后 `[bool]$env:DEEPSEEK_API_KEY` 返回 `False`。我独立核对运行后的 `local/` 只剩 `notes`，未见探针临时目录。该结果支持**这一条 ACP 提示回合接受了取消**；`replyObserved:true` 说明取消前或取消过程中已收到文本更新，但不证明模型网络请求何时开始或停止。它也不证明工具执行中取消、副作用撤销、生产任务恢复或费用为零。

## 安全边界与已知缺口

- Daemon 使用显式至少 32 字符的 `RELAYCORE_TOKEN`，或在 Windows 自动生成并以当前用户 DPAPI 密文保存本地随机口令，只绑定 IPv4 回环地址，并拒绝带 `Origin` 的请求。它没有用户级权限分层；同账号进程可解密本地凭据，拿到口令的同机进程可以查询任务和请求停止。不要把明文口令写入 Git、共享配置或公开日志。加解密文件的路径检查没有消除检查后的竞态。
- 当前 `TASK.md` 是可读草稿，不是可安全执行的权限清单；路径检查和文件副本只覆盖准备阶段。内部已实现时限和桥接提示回合守卫，但未实现真实执行通道的运行时路径约束、Token/费用调用前预算或子进程取消对账。故生产外部执行没有可用开关。
- 本地状态机能阻止同一草稿重复入队，**不能**证明外部 Agent 调用恰好一次。真实适配器必须先持久化调用意图，再做会话对账；不确定时暂停。
- 锁文件在进程崩溃后可能保留，系统不会自动猜测它已失效。人工核实进程后才能移除；手动误删锁或多个进程用不同路径指向同一状态目录的异常环境，仍需后续专项验证。
- `COMPLETED`/`HANDOFF.md` 目前只在测试注入执行器时可达，尚无独立 Review，也不能作为产品验收证据。
- 尚未建立本地 Git 关联；远端不可达/未鉴权的原因见 Phase 0 记录。`local/` 与 `.RelayCore/` 已列入根 `.gitignore`，但未能通过真实 Git 仓库的跟踪检查。

## Phase 2 启动门槛

**现在不能宣称 Phase 1 已完成，也没有可信的完成日期。**计划书要求先验收单任务“DSH 执行 → Codex SDK 独立 Review → 状态/MD 交接”的真实闭环，并确认停止、预算、权限和未知结果处理；Phase 2 才扩展隔离与恢复。当前逐项如下：

| 门槛 | 当前证据 | 结论 |
|---|---|---|
| Codex Desktop 实际调用本项目 MCP | 2026-10-25 新增工具加载后，当前聊天实际创建草稿、查询状态/事件并取消，最终从列表和事件核对已取消。未调用模型或派发 | MCP 草稿生命周期通过 |
| DSH 在受控副本执行真实任务 | ACP 文本、只读拒写、在途提示取消各有单点证据；内部提案→候选→Review 组合链路通过模拟测试，新入口的真实无模型连接通过；真实提案和完整权限边界待测 | 内部已接线，真实闭环未通过 |
| Codex SDK 在独立副本完成只读 Review | SDK 0.162.1 原生依赖、配置及专用账号登录通过检查；首次真实诊断已记录线程 ID，但 30 秒超时，无结论/用量，未重试 | 登录和线程启动有证据，真实验收未通过 |
| 调用前限制及运行中停止 | 内部已有计时、回合预留/调用意图、停止信号和未知状态保护；尚无 Token/费用硬预算、真实适配器用量来源与外部停止对账 | 内部守卫通过测试，生产门槛未通过 |
| 故障注入与端到端验收 | 内部超时/停止/重启与调用意图持久化通过测试；真实外部会话崩溃对账和 DSH→SDK 闭环仍无证据 | 未通过 |

另有仓库准备事项：当前项目目录仍无 `.git`，远端状态未知；这不等于功能验收，但在声称交付或进入依赖 Git worktree 的工作前必须解决。上述门槛全部得到可复核证据、Phase 1 笔记与文档更新并由用户验收后，再开始 Phase 2。单点探针通过不替代端到端验收；不要为了赶阶段把生产派发提前打开。

## 继续本阶段的顺序

1. Desktop MCP 草稿生命周期、SDK 专用登录及真实 DSH 无模型连接已通过。用户希望使用已登录的 DSH 账号，优先核对本机官方 `deepseek-account` 通道、ACP 模型选择和授权范围；不要求先申请 API Key，也不读取或复制账号令牌。随后再做[结构化提案实测](dsh-integration.md)，不把探针成功当生产接入。
2. SDK 首次真实验收结果未知，先保留并核查请求意图和线程记录，不自动重试或把超时解释成零消耗；账号额度与诊断范围见[验收说明](codex-review.md)。同时补 DSH 运行时权限、取消与 Token/费用调用前预算。
3. 内部组合执行器已记录双 Agent 会话与请求意图；待各通道实测通过后，再显式诊断完整 DSH→独立 Review→交接，不自动合并，也不提前打开生产派发。
4. 端到端演示单任务执行→验收→交接，并注入重复事件、进程崩溃、停止及权限失败；全部通过且用户验收后才将 Phase 1 标记完成。

## 参考协议

- [MCP stdio 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)：JSON-RPC 按换行分隔；标准输出只能发送协议消息。
- [MCP 生命周期规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)：初始化协商和能力声明。
- [Node.js SQLite API](https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html)：内置 `DatabaseSync` 与参数化语句。
