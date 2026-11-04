# RelayCore

RelayCore 计划作为 Windows 本地优先的双 Agent 协作工具：Codex 负责规划和验收，DeepSeek Harness（DSH）负责执行，独立的 Bridge 负责持久化任务、调度与安全控制。Codex 通过 MCP 接入 Bridge；本地网页计划用于监控和审批。

[English](README.en.md) · [使用说明](docs/使用说明.md) · [项目审视与改进报告](docs/项目审视与改进报告-2026-10-28.md) · [安全说明](SECURITY.md) · [贡献指南](CONTRIBUTING.md)

**当前状态：主要流程已实现，仍在开发与验收阶段，适合隔离试用。** 隔离诊断中有真实双模型提案、审查与整合/回滚成功记录；在途暂停诊断记录了暂停与恢复，但在提取快照 ID 时失败，未完成该次整合/回滚验收。2026-10-28 审视发现并修复 HTTP 异常、Host 校验、用量接线和记忆目录竞态；最新有时限全量无模型测试 **138/138、0 skip**。生产执行默认关闭，环境变量显式启用；完整 OS 隔离、金额硬封顶和长期稳定性尚未验证。

## 开发阶段

| 阶段 | 目标 | 状态 |
|---|---|---|
| 0 | 仓库准备、关键接口与 Windows 安全能力验证 | 未通过准入，继续补证据 |
| 1 | 单任务受控执行与独立验收闭环 | 受控数据提案路线验收通过，用户确认结项 |
| 2 | 工作区隔离、暂停恢复与安全整合 | 已实现核心；独立整合/回滚有真实记录，暂停后的同次完整链路待验收 |
| 3 | 执行通道路由、中途引导与权限审批 | 已实现引导、风险标签、E2 闸门和停止；E0 独立只读路线等仍待补齐 |
| 4 | 共享知识、预算、网页与安装 | 核心已实现并修复已知缺陷；真实记账、控制台身份边界与诊断配置一致性待验收 |
| 5 | 端到端测试与发布准备 | 进行中：双语、安全和贡献文档已补；准入和发布验证未完成 |

Phase 0 的实测结果和未通过项见 [可行性记录](docs/phase-0-feasibility.md)；Phase 1 的验收范围见 [阶段一状态](docs/phase-1-status.md)；当前增量见 [阶段二状态](docs/phase-2-status.md)、[阶段三状态](docs/phase-3-status.md) 和 [阶段五状态](docs/phase-5-status.md)；详细设计见 [项目架构与开发计划书](docs/RelayCore%20项目架构与开发计划书.md)。阶段完成不代表所有后续安全能力已具备。

## 运行当前控制骨架

需要 Node.js 24.15.0 或更新的 24.x 版本。项目依赖安装在本目录的 `node_modules/`，已加入 `.gitignore`；`package.json` 和 `package-lock.json` 记录固定版本。首次运行或换机器时在项目根目录执行 `npm ci --include=optional --ignore-scripts`，包含 SDK 所需的平台原生程序。在 Windows PowerShell 的项目目录中启动 Daemon：

```powershell
Set-Location -LiteralPath 'D:\MYCODE\RelayCore'
Remove-Item Env:\RELAYCORE_TOKEN -ErrorAction SilentlyContinue
npm start
```

Daemon 只监听 `127.0.0.1:8765`。未指定 `RELAYCORE_TOKEN` 时，Windows 上首次启动会生成随机控制口令，用 DPAPI 的当前用户范围加密保存到忽略的 `.RelayCore/bridge/control-token.dpapi`。同一 Windows 用户运行的 MCP 和命令行会读取此文件，不再要求 Desktop 从指定 PowerShell 继承口令。不会输入或保存 DeepSeek API Key；密文损坏时拒绝使用，不自动覆盖。DPAPI 不能阻止同账号进程读取口令。

保持 Daemon 终端打开。在同账号的另一个项目终端执行 `node src/control.mjs list` 可查询任务；已知 ID 时可执行 `status ID`、`events ID` 或 `stop ID`。MCP stdio 入口仍是 `node src/mcp.mjs`。显式设置的 `RELAYCORE_TOKEN` 优先于文件，保留供测试或非 Windows 环境使用；不要将这两种方式混用。MCP 默认按脚本所在项目查找凭据，其他项目需明确设置 `RELAYCORE_ROOT`。

连接方向是 **Codex Desktop → RelayCore MCP → Daemon → DSH ACP**。账户执行器通过 ACP 接入，默认关闭、须显式配置；MCP 可派发已经本地授权的任务，但不能自行批准授权。它不是把 DSH 的 MCP 作为插件装入 Codex。已有隔离真实闭环记录，生产入口及暂停后完整整合链路仍需继续验证。

注册状态、无口令配置样例与首次验证步骤见 [Codex Desktop MCP 手动连接](docs/codex-mcp-manual-setup.md)。

同一项目同时只允许一个 Daemon：第二个进程会因 `.RelayCore/bridge/daemon.lock` 拒绝启动。若进程异常退出，锁文件可能保留；先核对其中的进程 ID、启动时间及当前系统进程，确认原 Daemon 已停止后再手动移除。不要仅因端口无响应就盲删锁；重启后遗留运行任务会转入 `RECOVERY_REQUIRED`，不会自动重做。

若启动时发现尚未完成的任务目录里已有 `HANDOFF.md`，任务也会转入 `RECOVERY_REQUIRED`，并记录一次待对账事件；系统不会把这个文件当作已验收结果，也不会自动删除它。

运行 `node --test --test-reporter=tap --test-timeout=12000` 可验证无模型的本地流程。`create_task` 可选填 `allowedPaths`（最多 32 个项目相对路径，例如 `src/core.mjs`）；省略时为空，表示尚未声明可改动路径。它进入草稿和 `TASK.md`，**不是文件权限或沙箱**；默认 Daemon 拒绝外部执行，显式配置账户路线后还需本地授权。

`create_task` 还可选填 `executionLimits: { maxDurationSeconds, maxModelTurns }`，两项都须为正整数；省略表示未声明。内部调度器有执行器时，派发必须提供限制，时长技术上限为 2147483 秒，以避免 Node 定时器溢出，不代表建议的产品阈值。从持久化派发事件开始计时，含排队时间；超时会发 AbortSignal 并转 `RECOVERY_REQUIRED`。适配器须在每次外部提示调用前使用 `context.beginModelTurn('dsh'|'codex')`，事务中先记录调用意图并消耗跨 Agent 共用的回合额度。超限或停止后禁止新回合，迟到结果不能完成任务；不响应取消的执行器未结束前，队列不会领取下一项。

可信宿主可给 Daemon 显式配置执行器和 `executionPolicy`，再通过本地 CLI、控制台或受控制令牌保护的 HTTP 写入绑定合约、预算与有效期的一次性授权。派发事务消费授权，每次提示前复核；MCP 不提供授权工具。费用未知时须明确许可，否则调用前拒绝。这些守卫不能强制杀死任意外部进程，也不计量 Agent 一次提示内部的模型循环；Token/金额硬预算和远端停止对账仍未实现。

内部的 `core.prepareWorkspace(taskId)` 可为草稿，或本地已授权且尚无提示意图的运行任务，生成一次性**非 Git 文件副本**：仅复制 `allowedPaths` 中明确列出的普通文件，拒绝目录和符号链接，单文件不超过 8 MiB、总计不超过 32 MiB，并在任务材料目录另存 SHA-256 基线。没有声明路径或副本已存在时会拒绝；失败时清理未完成副本。组合执行器在隔离验收中调用它，未作为独立 MCP 工具开放；文件清单和哈希不是运行时权限边界，也不处理 Windows 重解析点竞态或结果合并。

内部的 `core.verifyWorkspace(taskId)` 可复核**尚未执行前的原样副本**：对照任务合约与基线检查文件哈希、缺失项、额外项、目录和链接。它只回答“此刻看起来是否仍与基线一致”，不适合验收 Agent 的预期改动；基线自身不防同权限篡改，检查后也可能再次变化。

内部的 `core.inspectWorkspaceChanges(taskId)` 则允许已声明文件的内容变化，并返回变化路径；额外/缺失文件、额外目录、链接及超出大小上限仍会拒绝。它只产生**静态变更清单**，不生成 diff、不审查内容、不复制回主项目，也不代表通过独立验收。

内部的 `core.inspectSourceConflicts(taskId)` 再对照同一基线检查**主项目中已声明的文件**：若它们在创建副本后被修改或删除，返回冲突路径，不会覆盖主项目。它不检查未声明文件，也不锁定文件；即便此刻无冲突，之后仍可能变化，因此不构成合并许可。

内部的 `core.prepareReviewWorkspace(taskId)` 会核对源文件仍匹配基线，再将原始内容与候选内容封装成独立目录的 `REVIEW.json`，限制为 UTF-8 文本和合计 256 KiB。验收入口 `src/review.mjs` 使用独立 Codex home 和新线程、只读模式、禁止审批、禁用 shell/连接器/网页工具，并在模型调用前申请回合额度；输入哈希前后不一致、出现工具事件、缺少用量或结论格式错误都会拒绝结果。审查函数本身不合并；账户执行路线可显式接入生产 Daemon，历史隔离诊断已有单点证据。

可信宿主还可提供 `verifyCandidate()`，先检查候选真实内容；Core 复核检查期间源/候选未变，将主机来源的 `testEvidence` 和候选 SHA-256 写入 Review 快照。`npm run check:dispatch` 会用独立 MCP、临时 Daemon 和假适配器验证整条调度链，保存现场到 `local/`，**不调用模型**。真实账户模式另需单次同意和显式费用未知许可；流程、边界及命令见 [受控调度验收](docs/controlled-dispatch.md)。

Phase 2 为每份新 Review 登记所属任务/revision、合约 hash 和快照 hash，并在交接前复核快照、候选及源基线。任务修订创建独立草稿，不继承旧授权、候选或批准；工作区登记、独立测试仓库 worktree、暂停恢复及受控整合/回滚已有实现。阶段三现有 HTTP/CLI 本地授权和整合入口；未知费用必须显式同意，MCP 不能自行授予执行授权。登记或校验通过不是批准或合并许可，相关限制见 [阶段三状态](docs/phase-3-status.md)。

保持 Daemon 运行时，`npm run smoke:tasks` 可重复验证 MCP 草稿生命周期，每次留下一个已取消的诊断任务，不调用模型。`npm run check:review` 检查 SDK 原生程序可定位、独立验收材料可生成，并清理一次性项目，不调用模型。SDK 验收支持 `npm run login:review` 单独登录 ChatGPT 账号，也支持测试 API Key；不复制 Desktop 凭据。账号权限、额度与真实诊断步骤见 [Codex SDK 验收说明](docs/codex-review.md)。

DeepSeek 内部适配器及分层诊断见 [DSH 任务接入](docs/dsh-integration.md)。DSH 只读接收 JSON 文件数据并返回提案，Bridge 核对范围后仅写候选副本。账户探针 `probe-dsh-account.mjs --run-proposal` 已有单次成功，不要求 API Key；`probe-dsh-task.mjs --run-proposal` 保留为可选 Key 入口。后者的 `--run-task` 在无 Key 时使用已登录账户，已有一次双模型闭环成功。所有 DSH 子进程统一经 `dshAcpArgs()` 预加载 console shim；账户选择必须原生确认且无歧义。本机模型服务依赖代理，真实调用须按用户授权明确目的和预算，失败不自动重试；账户执行需显式启用和授权，不自动合并。

隔离 ACP 最小文本探测曾得到一次成功回复：用户在自己的终端设置测试用 `DEEPSEEK_API_KEY` 后，报告 `{"stopReason":"end_turn","reply":"OK","toolCalls":0,"cost":"unknown"}`。此前三次真实提示中，前两次报 `realpath EPERM`，第三次报缺少 API Key；几次无 Key 预检失败没有发出模型提示。成功结果仅证明独立诊断脚本的这一条文本通路可用；工具调用数是脚本观察到的更新事件计数，费用未知，ACP 有效只读和完整沙箱边界未验证。`node scripts/probe-dsh-prompt.mjs "D:\DeepSeekHarness\DeepSeek Harness.exe" --check-only` 可做无模型检查；`--run-model` 要求当前终端预先设置测试用 Key，不要在聊天中发送 Key 或借用 Desktop 凭据。

`node scripts/probe-dsh-prompt.mjs "D:\DeepSeekHarness\DeepSeek Harness.exe" --probe-readonly` 已由用户在本机运行一次：输出 `toolCalls:1`、工具状态 `failed`、`permissionRequests:0`、`denialReported:true`、`targetExists:false`、`outcome:"read-only-denied"`、`cost:"unknown"`。这支持**这一条 ACP 工具写入在只读模式下被拒绝**；不证明其他工具、路径、网络或 Windows 沙箱全面隔离，也不是生产派发。运行脚本需要当前终端的测试 Key，可能产生模型费用，不要在聊天中发送 Key。Windows PowerShell 5.1 不支持 `Read-Host -MaskInput`；如需再次输入 Key，请改用 `Read-Host -AsSecureString`，并在测试后删除当前终端环境变量。

`--probe-cancel` 已由用户在本机运行一次：原提示仍在等待时发送了 `session/cancel`，返回 `stopReason:"cancelled"`、`toolCalls:0`、`permissionRequests:0`、`outcome:"prompt-cancelled"`。这支持**这一条 ACP 提示回合被取消**，但不证明取消时模型网络请求已开始、工具副作用可撤销或生产任务可恢复；费用仍为 `unknown`。用户随后确认当前 PowerShell 的 `DEEPSEEK_API_KEY` 已清除。再次运行仍需测试 Key，可能产生模型费用，不建议仅为重复确认而运行。

仅在明确需要再次运行付费探针时，可在 Windows PowerShell 5.1 的**同一个窗口**临时设置 Key；下面不会打印 Key，但运行中的 DSH 子进程会收到该环境变量：

```powershell
$secret = Read-Host -Prompt '输入测试用 API Key' -AsSecureString
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
try {
  node .\scripts\probe-dsh-prompt.mjs 'D:\DeepSeekHarness\DeepSeek Harness.exe' --probe-cancel
} finally {
  Remove-Item Env:\DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  $secret.Dispose()
}
```

可选诊断：`node scripts/probe-dsh-acp.mjs "D:\DeepSeekHarness\DeepSeek Harness.exe"` 在临时目录使用本机 DSH 安装的 ACP CLI，只做初始化、新建会话、发送一次无活动任务的取消通知、关闭会话，不发送模型提示。取消通知没有成功回执，不能据此认定真实任务可被取消。安装路径仅是本机示例；该 CLI 位于 DSH 安装包内部，升级后路径可能变化。

## 目录约定

- `docs/`：需要随仓库保存的设计、验证记录和使用文档。
- `local/notes/`：每阶段的学习笔记，不进入 Git；请自行备份。
- `.RelayCore/`：程序的项目运行数据，不进入 Git。它与学习笔记用途不同。

`local/`、`.RelayCore/`、`node_modules/` 均不跟踪。运行时工作区和本地笔记不会随 Git 克隆获得；切换或清理工作区前请确认需要保留的文件。

## 生产模式与 Web 控制台

默认 `npm start` 启动的 Daemon **外部执行保持禁用**（日志显示 `external execution disabled`）。显式通过环境变量启用账户执行路线后，同一 Daemon 获得 MCP 派发、CLI 操作与本地控制台的全部能力：

| 环境变量 | 含义 |
|---|---|
| `RELAYCORE_EXECUTION=account` | 启用 DSH 账户执行路线；任何其他值保持禁用 |
| `RELAYCORE_DSH_EXE` | DSH 可执行文件绝对路径（启用时必填） |
| `RELAYCORE_ACCOUNT_WORKSPACE` | DSH 账户路线的测试工作区绝对路径（启用时必填） |
| `RELAYCORE_MAX_DURATION` / `RELAYCORE_MAX_TURNS` | 任务总时长（默认 600 秒）与模型回合上限（默认 2） |
| `RELAYCORE_REVIEW_AUTH_HOME` | 独立审查登录目录；默认取安装目录的 `.RelayCore/codex-review-home` |
| `RELAYCORE_ROOT` / `RELAYCORE_PORT` / `RELAYCORE_TOKEN` | 项目根、监听端口（默认 8765）、显式控制口令 |

派发仍受**本地授权闸门**约束：先 `node src/control.mjs authorize TASK-ID 600 --allow-unknown-cost`（E2 任务还须加 `--e2-approved`；两者都是分项同意，服务端校验缺一拒绝），再 `dispatch TASK-ID`；授权一次性、绑定合约哈希并计入有效期。任务运行中可用 `guide TASK-ID 文本` 追加指导（不中断当前回合，并入下一次真实提示）、`pause`/`resume`（预算跨暂停累计）、`stop`、以及审查批准后的 `integrate TASK-ID SNAPSHOT`（整合）与 `rollback TASK-ID`（一次性回滚）。`node src/doctor.mjs <DSH exe>` 做零模型安装自检。

浏览器打开 `http://127.0.0.1:8765/ui` 是本地控制台，**需要登录**：先在运行 Daemon 的同一用户终端执行 `node src/control.mjs ui-session` 获取一次性会话令牌（8 小时有效，Daemon 重启即失效），粘贴到登录页换发 HttpOnly 会话 cookie；长期控制口令不会进入网页、cookie 或日志。登录后可见任务列表与状态化操作按钮（授权为逐项 checkbox、追加引导）；`/usage` 将 DSH 上下文占用/容量与 Codex 输入/输出 tokens 分开显示，`—` 表示未知，不代表零消耗，金额以服务账单为准。HTTP Host 只接受真实监听端口的 `127.0.0.1` 或 `localhost`，浏览器动作另校验 Origin/Sec-Fetch-Site。未登录访问者只能看到登录页，任务内容零暴露；已登录会话仍受"同机其他进程可达本地端口"的边界限制。关掉网页不影响后台任务。

任务完成（审查批准）后候选不会自动合并：整合是显式操作，整合前自动备份每个源文件到 `PRE-INTEGRATION/`，写失败自动恢复并转 `RECOVERY_REQUIRED`；回滚是一次性的，且源文件在整合后被再次修改时拒绝执行。

## 兼容与故障排查

- **运行环境**：Windows + Node.js ≥24.15.0 <25；git（worktree 路线需要）；本机模型服务可达（本机示例依赖 `HTTP(S)_PROXY=127.0.0.1:7890` 类本地代理）。`node src/doctor.mjs` 逐项自检。
- **端口/锁**：8765 被占用时换 `RELAYCORE_PORT`；异常退出后的 `daemon.lock` 先核对进程再手动删除；重启后遗留 RUNNING 转入 `RECOVERY_REQUIRED`，不自动重放。
- **额度**：Codex 审查账号有服务端额度（用尽时任务如实转 `RECOVERY_REQUIRED`，错误落盘，恢复时间由服务端提示）；DSH 账户另有独立额度。失败不自动重试。
- **DSH 升级**：CLI 位于 `app.asar` 归档内，路径变化时以 `dshAcpArgs()` 为唯一启动入口自行适配；账户插件的 console 日志已由 shim 隔离，不要直接修改 DSH 安装包。
- **已知边界**：候选副本与 worktree 都不是 OS 级沙箱；文件系统与 SQLite 之间没有跨资源原子事务；模型回合上限不等于金额上限；取消只保证本地终态，不保证远端立即停止。

## 备份与卸载

`local/` 的笔记、诊断现场和 `.RelayCore/` 的任务数据不随 Git 保存。备份前先停止属于本项目的 Daemon，并确认数据库没有写入；SQLite 使用 WAL 时，不要只复制运行中的数据库主文件。需要在线备份时使用 SQLite 官方备份机制并验证恢复。备份和导出前检查其中的会话、候选、日志、令牌及登录资料，按需脱敏，不要公开分享凭据。

卸载依赖或删除项目目录前，先确认不再需要运行中的任务、未提交代码、本地笔记和运行数据，并自行保存所需材料。删除 `.RelayCore/` 会移除本项目任务状态和专用审查登录资料；不要通过批量结束进程或盲删锁文件来完成卸载。
