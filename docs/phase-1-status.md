# Phase 1 实现状态

状态：**Phase 1 已获用户确认结项，2026-10-26 开始 Phase 2**。本阶段在旧实验闭环的单点成功之外，完成一次经 MCP→独立 Daemon 的真实账户调度：本地一次性授权→DSH 提案→候选主机检查→Codex SDK 批准→未合并 HANDOFF。恰好两次桥接提示意图、双 session、源样例未变；SQLite、授权消费、候选、Review SHA-256 与 HANDOFF 已独立核对。当前开发状态及新快照守卫见[阶段二状态](phase-2-status.md)，不将后续无模型测试冒充本阶段真实验收。

本阶段验收时的全量无模型测试为 **72/72、0 skip**，调度/执行定向 **15/15**；覆盖最小预算、一次性授权、主机检查、审查拒绝/中断、停止与未知态。默认零模型检查另已落盘，真实模式在用户明确批准目的、最多两次桥接提示、240 秒及费用未知风险后只执行一次，没有重试；旧用户 Daemon PID 51512 的启动时间前后相同，未停止或重启。步骤见[受控调度验收](controlled-dispatch.md)。

真实调度入口仍只有一次成功，不构成稳定性或完整安全证明。账户及 Key 取消已有单点证据；硬杀恢复使用挂起假执行器，不是真实模型在途崩溃。DSH 旧账单“当日 3 次合计 < ¥0.01”为用户报告，旧 Codex 审查有 10920/56 token 记录；**本次金额仍未知**，不能把旧金额/用量套用过来。Token/金额硬预算、远端停止及完整恢复仍未验证，生产普通 CLI 不挂执行器。随机端口曾命中 Windows 保留范围的旧测试波动未修复；本次新隔离实例用系统分配端口，不能把全通过当成稳定性证明。

## 已实现与验证

| 能力 | 当前事实 | 证据 |
|---|---|---|
| 独立 Daemon | 用户手动启动的 Node 进程监听 `127.0.0.1`；MCP 进程退出不影响 Daemon | `test/protocol.test.mjs` 启动两个独立进程 |
| MCP stdio | 支持草稿创建、列表、状态、事件、停止；普通实例拒绝执行，显式隔离实例只接受已由本地宿主授权的派发 | 进程级协议/调度测试；Desktop 草稿生命周期已有实测，新受控入口真实验收通过 |
| Windows 本地控制口令 | 未设置显式口令时，Daemon 用 DPAPI 当前用户范围加密保存随机口令，MCP/CLI 从同项目文件解密；不再依赖 Desktop 继承临时环境变量 | `test/auth.test.mjs` 和无口令环境变量的独立进程协议测试；主机本地查询及重新加载后的 Desktop `list_tasks` 均成功 |
| SQLite | `tasks`、`events`、`sessions`、`execution_grants` 表，WAL 模式；持久化一次性授权和消费记录 | Core/执行测试及真实调度证据；未做并发/压力测试 |
| Task Contract | 每个草稿写入 `.RelayCore/.agent-tasks/TASK-*/TASK.md`，保存目标、验收文字、可选 `allowedPaths` 与 `executionLimits` 声明 | 文件及 MCP 测试覆盖字段保存和无效值拒绝；内部有执行器时派发必须声明上限，生产执行和 Token 预算仍缺失 |
| MCP 草稿生命周期 | 独立诊断客户端和当前 Desktop 聊天均对用户运行的 Daemon 完成创建、状态、事件与取消 | `scripts/smoke-task-lifecycle.mjs` 真实运行结果及当前聊天五个原生 MCP 工具实测，任务留为已取消的审计记录 |
| 内部执行限制 | 派发事件决定总时限，含排队；超时/用户停止立即进入 `RECOVERY_REQUIRED` 并发取消信号；每次适配器提示前可事务预留跨 Agent 回合并记调用意图 | 注入执行器测试覆盖超限、未知结果、排队过期、停止后拒绝新回合及重启保留意图；真实 ACP 取消有单点证据，不证明远端停止或费用封顶 |
| 调用前授权与最小预算 | 可信宿主签发绑定合约哈希、费用模式、有效期与上限的一次性授权；MCP 不能自批，未知费用须明确同意；派发原子消费，执行和提示前复核 | `test/execution.test.mjs`、`test/dispatch.test.mjs`；过期、变约、重复消费、额度耗尽拒绝；真实调度授权消费已核对，不是金额硬上限 |
| 主机候选检查 | 可信验证器先检查候选，Core 复核源/候选并将带候选 hash 的 `testEvidence` 写入独立 Review；HANDOFF 引用该 Review hash | 模拟失败、畸形、变化、取消回归；真实调度样例精确文本检查及独立 Review 批准通过 |
| 隔离调度验收入口 | `check:dispatch` 默认假适配器零模型；`--run-task` 需显式费用未知许可，只走账户，独立端口/项目/会话，不动用户 Daemon | 2026-10-26 无模型结果 `simulated-reviewed-not-merged`；用户批准后的单次真实结果 `reviewed-not-merged`，双会话、两次意图、源未变、未合并 |
| 独立验收材料与 SDK 入口 | 原始/候选文本封装为独立 `REVIEW.json`；SDK 入口隔离 home、禁用工具并检查哈希、结构化结论和用量 | 早期真实诊断超时记录保留；代理和重连处理修复后，独立审查有 rejected + usage，完整闭环有 approved + HANDOFF 的单点证据，未接生产 Daemon |
| SDK 事件序列守卫 | 拒绝切换线程、重复回合开始、终态后的线程/回合/条目事件及线程建立前的输出；完整 verdict 缺少完成事件、事件流抛错都失败 | `test/review.test.mjs` 用假 SDK 覆盖 6 种错序以及截断/断连；切换线程回归修复前实际未拒绝，现拒绝并中止 signal、关闭迭代器；没有新增真实 SDK 调用 |
| SDK 独立账号登录入口 | `npm run login:review` 调用随包 CLI 登录，使用专用 home；另支持显式测试 API Key，不读取或复制 Desktop 凭据 | 用户浏览器授权成功后，主机当前用户实测 `authenticated:true`；目录 ACL 已核对仅当前用户和 SYSTEM。缓存登录成功不等于模型可用性已通过 |
| DSH 数据提案与组合执行器 | DSH 只返回声明文件的完整替换文本；Core 在运行任务中检查范围、基线及停止信号后只写候选，另生成 Review 快照，独立批准后才产生交接 | 假 DSH/SDK 覆盖成功、工具/权限、迟到事件、无效提案、停止、拒绝和共享额度；真实账户提案及一次双模型闭环已有本地证据，不证明稳定性或全部权限边界 |
| 账户模型异常拒绝 | 模型选择项 ID 唯一且 category/type 正确，账户分组与 opaque 选项合法唯一，原生确认后才预留 prompt | `test/dsh-account.test.mjs` 覆盖 15 种异常目录与成功/失败/取消的 8 条提案场景；修复前重复 selector 的回归失败，修复后通过；仅假 ACP，不新增真实模型请求 |
| ACP 致命故障处理 | 非对象/数组/错误版本帧受控拒绝；首次致命错误后不再分发缓冲更新；任一请求超时立即使所有待办和后续调用失败 | `test/acp.test.mjs` 覆盖 5 类合法 JSON 但非法帧头、错误后缓冲通知、并行超时和后续调用；修复前 `null` 帧会令客户端崩溃，后两类守卫回归也实际失败 |
| 提案中途进程退出 | 无回复、部分回复、完整提案但缺少 prompt 终态时，保留 DSH 调用意图与会话，任务进入 `RECOVERY_REQUIRED`，不审查、不写 HANDOFF | `test/dsh.test.mjs` 真实启动假 ACP 子进程并在 prompt 中退出；两次重开状态库不重复恢复事件、不自动重播，源和候选均未改；不是真实账户模型在途崩溃证据 |
| DSH 账号认证 | 官方支持 `deepseek-account`，与 API Key 的 `deepseek-official` 分离；`src/dsh-account.mjs` 实现账户环境白名单与原生模型选择，账户参数与 API Key 禁止混用 | 2026-10-25 无模型检查首次通过（账户插件 stdout 日志污染由 `--import` 预加载 console shim 修复）；一次受限真实提案首次成功：`deepseek-account` / `DeepSeek-V4.1-Flash`、恰好 1 轮、精确 JSON 提案、源文件未变、未应用、0 SDK 调用；单点样本，用量 unknown，稳定性未证 |
| 非 Git 文件副本与变更清单 | 内部 `prepareWorkspace` 复制声明文件并保存基线；`verifyWorkspace` 检查原样副本；`inspectWorkspaceChanges` 列出副本变化；`inspectSourceConflicts` 对比主项目已声明文件 | 测试覆盖范围、链接、清理、内容变化、冲突、缺失/额外项、大小和基线；已由实验组合执行器使用，未开放生产 Daemon/MCP；副本不是 OS 沙箱，变更清单也不是独立 Review |
| 状态与停止 | 草稿/排队任务可取消；运行任务停止立即标为 `RECOVERY_REQUIRED`，发 AbortSignal，禁止新回合或迟到结果完成 | 注入测试执行器测试；不是实际 DSH 取消能力的证明；不响应取消的执行器未结束前仍占用串行队列 |
| 崩溃恢复 | 启动时把遗留 `RUNNING` 转为 `RECOVERY_REQUIRED`，不自动重播 | 状态模拟测试和 `diagnose:crash` 的真实子进程硬杀、重复重开证据；执行器是注入挂起函数，未杀真实模型在途请求 |
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

草稿可保存 `executionLimits`，包含正整数 `maxDurationSeconds` 和 `maxModelTurns`，两者须一起提供；省略时为 `null`。内部有执行器时，派发须声明上限，时长不能超过 Node 定时器技术上限 2147483 秒。从持久化派发事件计算截止时间，排队也计入，启动后已过期的排队任务不会交给执行器。适配器通过 `beginModelTurn(agent)` 在外部提示前事务预留额度并写 `model_turn.requested.dsh/codex` 事件；超限或停止后拒绝新预留。实验适配器已有单点真实执行，但**生产仍未接入执行器，也没有 Token/金额硬预算、远端取消确认或 Agent 提示内部的模型循环计量**。执行器必须使用接口并处理 AbortSignal；未知执行仍未结束时不领取下一项。产品默认阈值仍待确定。

内部的非 Git 副本准备现只接受显式文件路径：逐段检查目录及最终普通文件，拒绝检测到的符号链接，限制单文件 8 MiB、合计 32 MiB；只将声明文件复制到忽略的 `.RelayCore/workspaces/`，在任务材料目录另存路径、大小和 SHA-256。`verifyWorkspace` 可复核原样副本；`inspectWorkspaceChanges` 返回副本中声明文件的变化路径，并拒绝缺失/额外项、链接和超限文件；`inspectSourceConflicts` 发现主项目已声明文件相对基线的修改或删除。它们**不是内容 Review、diff 或合并许可**，也不检查未声明主项目文件。方法均没有对外执行入口，基线文件不具防篡改能力，检查后也有竞态；仍未处理 Windows 重解析点/大小写别名、受控进程权限或结果整合，因此**尚不能称为安全的执行工作区**。下一步要明确执行通道的运行时限制与合并规则。

用户连续指示后，使用隔离 home/工作区、进程级只读模式和默认拒绝权限请求，共发送三次最短文本提示。前两次 DSH 返回 `ACP -32603`，原因含 `EPERM realpath 'C:\Users\weixing'`；第二次已将 `USERPROFILE` 等变量指向隔离 home，仍失败。当前终端直接解析原路径成功，故具体拒绝源尚不明。第三次将一次性目录及临时变量放入忽略的 `local/` 后，没有再出现该路径错误，而是返回 `llm-deepseek: no API key for provider route "deepseek-official"`。这只说明该配置下请求走到了凭据检查；不能判定哪项路径改动起作用，也不能证明模型调用、用量或沙箱安全。三次均无成功模型文本及可靠用量数据；没有提权或借用 Desktop 凭据。诊断脚本现对 `--run-model` 增加测试 Key 预检；客户端默认拒绝权限请求仍不能阻止所有无需审批的读操作、网络或工具副作用。

随后用户自行在 PowerShell 当前会话设置测试 Key，运行第四次显式 `--run-model`，并提供终端输出 `{"stopReason":"end_turn","reply":"OK","toolCalls":0,"cost":"unknown"}`。这是**用户提供的诊断结果**，不是 RelayCore Daemon 派发或 Codex Review；脚本的 `toolCalls` 仅统计收到的 `tool_call` 更新事件，不能代替完整工具审计。`cost` 未得到数值，需由用户在提供方账单核对；也不能从一条无工具提示推断只读沙箱生效。一次探测后发现项目 `local/` 下遗留一个临时 home 目录，已按固定名称和父目录核对后手工清理；残留原因尚未复现。

单点 ACP 权限试验使用全新一次性工作区，要求创建 `relaycore-readonly-probe.txt`，进程级设置 `DSH_PERMISSION_MODE=read-only`，权限请求自动取消，第二次工具调用会发取消通知。用户提供的输出为 `{"stopReason":"end_turn","promptFailed":false,"replyObserved":true,"toolCalls":1,"toolStatuses":[{"event":"tool_call","status":"in_progress","kind":"other"},{"event":"tool_call_update","status":"failed","kind":null}],"permissionRequests":0,"denialReported":true,"targetExists":false,"outcome":"read-only-denied","cost":"unknown"}`。该 `denialReported` 由脚本从工具事件中匹配只读拒写标识得到，原始工具输入/输出未留存；文件未出现经脚本检查，我独立只读核对 `local/` 清理后只剩 `notes`。这支持这次 ACP 写入拒绝，但**不证明完整 Windows 边界、权限升级、网络限制或取消效果**。用户的 PowerShell 不支持 `Read-Host -MaskInput`；该设置命令报错后探针仍运行，说明启动前环境变量已有非空值，具体来源未核实。`finally` 已在用户终端执行删除变量的命令；用户随后确认 `[bool]$env:DEEPSEEK_API_KEY` 为 `False`。这只核对了该终端当前进程的变量，不证明其他存储位置没有 Key。

`--probe-cancel` 单点诊断在隔离会话发送无工具文本提示，等待一秒；若原提示仍未结束，则发送 `session/cancel` 通知，并等待原 `session/prompt` 的终态。用户提供的真实运行汇总为 `{"pendingAtCancel":true,"cancelSent":true,"stopReason":"cancelled","promptFailed":false,"replyObserved":true,"toolCalls":0,"permissionRequests":0,"outcome":"prompt-cancelled","cost":"unknown"}`；随后 `[bool]$env:DEEPSEEK_API_KEY` 返回 `False`。我独立核对运行后的 `local/` 只剩 `notes`，未见探针临时目录。该结果支持**这一条 ACP 提示回合接受了取消**；`replyObserved:true` 说明取消前或取消过程中已收到文本更新，但不证明模型网络请求何时开始或停止。它也不证明工具执行中取消、副作用撤销、生产任务恢复或费用为零。

## 安全边界与已知缺口

- Daemon 使用显式至少 32 字符的 `RELAYCORE_TOKEN`，或在 Windows 自动生成并以当前用户 DPAPI 密文保存本地随机口令，只绑定 IPv4 回环地址，并拒绝带 `Origin` 的请求。它没有用户级权限分层；同账号进程可解密本地凭据，拿到口令的同机进程可以查询任务和请求停止。不要把明文口令写入 Git、共享配置或公开日志。加解密文件的路径检查没有消除检查后的竞态。
- 当前 `TASK.md` 是可读草稿，不是运行时权限清单。受控入口已有一次性授权、提示/时长与费用未知许可的最小调用前闸门，主机也检查候选；没有完整 OS 路径隔离、Token/金额硬封顶或远端取消对账。普通生产 CLI 仍没有执行开关；不防同账号篡改数据库或路径竞态。
- 本地状态机能阻止同一草稿重复入队，**不能**证明外部 Agent 调用恰好一次。真实适配器必须先持久化调用意图，再做会话对账；不确定时暂停。
- 锁文件在进程崩溃后可能保留，系统不会自动猜测它已失效。人工核实进程后才能移除；手动误删锁或多个进程用不同路径指向同一状态目录的异常环境，仍需后续专项验证。
- `COMPLETED`/`HANDOFF.md` 在隔离真实双模型诊断中已有一次证据，不代表生产可用或允许合并；真实模型在途故障与稳定性仍缺少验证。
- 接手时本地 `main`、本地 `origin/main` 均为 `a69fbc8`，工作区干净；`git ls-files local .RelayCore` 为空，忽略规则生效。此前推送为交接记录，本轮未联网复核远端，也未提交或推送。

## Phase 2 启动门槛

**本次受控调度验收通过后，用户回复“开始”，已确认进入 Phase 2。**以下保留本阶段门槛和验收范围；Phase 2 继续扩展隔离与恢复，不把后续能力倒写成 Phase 1 已验证。

**阶段边界纠偏：** 对照开发计划书第 15 节，完整 worktree/快照/恢复/受控合并属于 Phase 2，完整 Token 分账与预算策略属于 Phase 4。真实模型在途崩溃、多次连续运行的统计稳定性、OpenAI 账单金额仍需后续核对，但不能不加区分地把它们全部升级为 Phase 1 前置。Phase 1 仍必须有基本隔离、停止/未知态保护和最小调用前预算检查，不能以阶段划分为由取消这些基础闸门。

| 门槛 | 当前证据 | 结论 |
|---|---|---|
| Codex Desktop 实际调用本项目 MCP | 2026-10-25 新增工具加载后，当前聊天实际创建草稿、查询状态/事件并取消，最终从列表和事件核对已取消。未调用模型或派发 | MCP 草稿生命周期通过 |
| DSH 在受控副本执行真实任务 | 新隔离 MCP→Daemon→账户 DSH 提案→Bridge 候选写入已真实通过；不是 DSH 工具直接编辑副本 | 本次受控入口通过，非稳定性证明 |
| Codex SDK 在独立副本完成只读 Review | 主机检查绑定候选 hash，Review 独立批准；快照 hash 与 HANDOFF、数据库一致 | 本次变更/检查证据与独立审查通过 |
| 调用前限制及运行中停止 | 最小一次性授权/提示/时长/费用未知许可已接线；调度停止、超限回归和旧真实取消单点保留 | 基础闸门通过，不是金额硬上限或远端停止证明 |
| 基础故障与结果未知保护 | 调度回归覆盖检查失败、审查拒绝/中断、额度耗尽、停止；未知态不交接、不重播 | 基础保护已纳入本地调度验收；完整恢复扩展归 Phase 2 |

阶段进入的依据是用户在收到上述验收结果后明确同意，不是模型 approved 或测试数量。后续开发沿用生产执行关闭、现有 Daemon 不动和真实调用单次审批的约束，不把阶段结项当成生产可用证明。

## 继续本阶段的顺序

1. 已完成默认关闭的隔离接线、最小预算/授权、候选检查证据、故障回归与单次真实调度验收，不为扩大样本重复付费运行。
2. 已更新 docs、同一份 Phase 1 笔记及 DSH 连接讲解；用户在收到验收结果后确认阶段结项。
3. Phase 2 已开始，按计划推进工作区隔离、快照/任务版本、暂停恢复、幂等/崩溃对账与受控整合，学习记录统一在 `local/notes/phase-2.md`。
4. 始终不自动合并、不重启用户 Daemon、不擅自开启生产执行，不提交或推送未获授权的代码。

## 参考协议

- [MCP stdio 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)：JSON-RPC 按换行分隔；标准输出只能发送协议消息。
- [MCP 生命周期规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)：初始化协商和能力声明。
- [Node.js SQLite API](https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html)：内置 `DatabaseSync` 与参数化语句。
