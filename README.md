# RelayCore

RelayCore 计划作为 Windows 本地优先的双 Agent 协作工具：Codex 负责规划和验收，DeepSeek Harness（DSH）负责执行，独立的 Bridge 负责持久化任务、调度与安全控制。Codex 通过 MCP 接入 Bridge；本地网页计划用于监控和审批。

**当前状态：Phase 1 进行中，生产外部执行关闭且不可配置为启用。** 已有本地 Daemon、MCP 草稿入口、SQLite 任务/事件记录和独立状态查询；内部新增 DSH 数据提案→受控副本写入→SDK 独立验收→交接的组合执行器，模拟链路通过，尚未接入生产 Daemon。真实 ACP 文本、只读拒写和提示取消各有单点结果；SDK 账号已登录，但首次验收诊断超时，结论及用量未知。完整双模型端到端测试和 Phase 0 安全准入仍未通过。

## 开发阶段

| 阶段 | 目标 | 状态 |
|---|---|---|
| 0 | 仓库准备、关键接口与 Windows 安全能力验证 | 未通过准入，继续补证据 |
| 1 | 单任务受控执行与独立验收闭环 | 进行中：内部 DSH→Review 组合链路已测试，真实闭环待验收 |
| 2 | 工作区隔离、暂停恢复与安全整合 | 未开始 |
| 3 | 执行通道路由、中途引导与权限审批 | 未开始 |
| 4 | 共享知识、预算、网页与安装 | 未开始 |
| 5 | 端到端测试与发布准备 | 未开始 |

Phase 0 的实测结果和未通过项见 [可行性记录](docs/phase-0-feasibility.md)；Phase 1 的实现、缺口及 Phase 2 启动门槛见 [阶段状态](docs/phase-1-status.md)；详细设计和验收标准见 [项目架构与开发计划书](docs/RelayCore%20项目架构与开发计划书.md)。Phase 1 未验收完成前，不进入 Phase 2。

## 运行当前控制骨架

需要 Node.js 24.15.0 或更新的 24.x 版本。项目依赖安装在本目录的 `node_modules/`，已加入 `.gitignore`；`package.json` 和 `package-lock.json` 记录固定版本。首次运行或换机器时在项目根目录执行 `npm ci --include=optional --ignore-scripts`，包含 SDK 所需的平台原生程序。在 Windows PowerShell 的项目目录中启动 Daemon：

```powershell
Set-Location -LiteralPath 'D:\MYCODE\RelayCore'
Remove-Item Env:\RELAYCORE_TOKEN -ErrorAction SilentlyContinue
npm start
```

Daemon 只监听 `127.0.0.1:8765`。未指定 `RELAYCORE_TOKEN` 时，Windows 上首次启动会生成随机控制口令，用 DPAPI 的当前用户范围加密保存到忽略的 `.RelayCore/bridge/control-token.dpapi`。同一 Windows 用户运行的 MCP 和命令行会读取此文件，不再要求 Desktop 从指定 PowerShell 继承口令。不会输入或保存 DeepSeek API Key；密文损坏时拒绝使用，不自动覆盖。DPAPI 不能阻止同账号进程读取口令。

保持 Daemon 终端打开。在同账号的另一个项目终端执行 `node src/control.mjs list` 可查询任务；已知 ID 时可执行 `status ID`、`events ID` 或 `stop ID`。MCP stdio 入口仍是 `node src/mcp.mjs`。显式设置的 `RELAYCORE_TOKEN` 优先于文件，保留供测试或非 Windows 环境使用；不要将这两种方式混用。MCP 默认按脚本所在项目查找凭据，其他项目需明确设置 `RELAYCORE_ROOT`。

计划的连接方向是 **Codex Desktop → RelayCore MCP → Daemon → DSH ACP**。`src/acp.mjs` 已供独立探针与 DSH 通信，尚未接入生产 Daemon；不是把 DSH 的 MCP 当作插件装入 Codex。用户级 MCP 配置不含口令，允许草稿创建、列表、状态、事件和取消，不开放派发工具。2026-10-25 独立 MCP 诊断客户端及当前 Desktop 聊天均已完成草稿创建→状态/事件查询→取消；实际记录保留为 `CANCELED`。DSH 受控执行及真实 SDK 验收仍需验证。

注册状态、无口令配置样例与首次验证步骤见 [Codex Desktop MCP 手动连接](docs/codex-mcp-manual-setup.md)。

同一项目同时只允许一个 Daemon：第二个进程会因 `.RelayCore/bridge/daemon.lock` 拒绝启动。若进程异常退出，锁文件可能保留；先核对其中的进程 ID、启动时间及当前系统进程，确认原 Daemon 已停止后再手动移除。不要仅因端口无响应就盲删锁；重启后遗留运行任务会转入 `RECOVERY_REQUIRED`，不会自动重做。

若启动时发现尚未完成的任务目录里已有 `HANDOFF.md`，任务也会转入 `RECOVERY_REQUIRED`，并记录一次待对账事件；系统不会把这个文件当作已验收结果，也不会自动删除它。

运行 `npm test` 可验证无模型的本地流程。`create_task` 可选填 `allowedPaths`（最多 32 个项目相对路径，例如 `src/core.mjs`）；省略时为空，表示尚未声明可改动路径。它只会进入草稿和 `TASK.md`，**不是文件权限或沙箱**；现阶段 `dispatch_task` 仍明确拒绝外部执行。这不是已完成的 AI 协作产品。

`create_task` 还可选填 `executionLimits: { maxDurationSeconds, maxModelTurns }`，两项都须为正整数；省略表示未声明。内部调度器有执行器时，派发必须提供限制，时长技术上限为 2147483 秒，以避免 Node 定时器溢出，不代表建议的产品阈值。从持久化派发事件开始计时，含排队时间；超时会发 AbortSignal 并转 `RECOVERY_REQUIRED`。适配器须在每次外部提示调用前使用 `context.beginModelTurn('dsh'|'codex')`，事务中先记录调用意图并消耗跨 Agent 共用的回合额度。超限或停止后禁止新回合，迟到结果不能完成任务；不响应取消的执行器未结束前，队列不会领取下一项。

这些守卫已通过注入执行器测试，尚未接入生产 DSH。它们不能强制杀死任意外部进程，也不计量 Agent 一次提示内部的模型循环；Token/费用硬预算和外部会话停止对账仍未实现。计划书尚未确定产品默认阈值，生产派发继续关闭。

内部的 `core.prepareWorkspace(taskId)` 可为草稿生成一次性**非 Git 文件副本**：仅复制 `allowedPaths` 中明确列出的普通文件，拒绝目录和符号链接，单文件不超过 8 MiB、总计不超过 32 MiB，并在任务材料目录另存 SHA-256 基线。没有声明路径或副本已存在时会拒绝；失败时清理未完成副本。该方法尚未通过 MCP/Daemon 开放，更未接入 DSH；文件清单和哈希不是运行时权限边界，也不处理源文件并发变化、Windows 重解析点竞态或结果合并。

内部的 `core.verifyWorkspace(taskId)` 可复核**尚未执行前的原样副本**：对照任务合约与基线检查文件哈希、缺失项、额外项、目录和链接。它只回答“此刻看起来是否仍与基线一致”，不适合验收 Agent 的预期改动；基线自身不防同权限篡改，检查后也可能再次变化。生产派发仍关闭。

内部的 `core.inspectWorkspaceChanges(taskId)` 则允许已声明文件的内容变化，并返回变化路径；额外/缺失文件、额外目录、链接及超出大小上限仍会拒绝。它只产生**静态变更清单**，不生成 diff、不审查内容、不复制回主项目，也不代表通过独立验收。

内部的 `core.inspectSourceConflicts(taskId)` 再对照同一基线检查**主项目中已声明的文件**：若它们在创建副本后被修改或删除，返回冲突路径，不会覆盖主项目。它不检查未声明文件，也不锁定文件；即便此刻无冲突，之后仍可能变化，因此不构成合并许可。

内部的 `core.prepareReviewWorkspace(taskId)` 会核对源文件仍匹配基线，再将原始内容与候选内容封装成独立目录的 `REVIEW.json`，限制为 UTF-8 文本和合计 256 KiB。验收入口 `src/review.mjs` 使用独立 Codex home 和新线程、只读模式、禁止审批、禁用 shell/连接器/网页工具，并在模型调用前申请回合额度；输入哈希前后不一致、出现工具事件、缺少用量或结论格式错误都会拒绝结果。模型结论不会自动合并或标记任务完成。入口尚未接入生产 Daemon，真实 SDK 模型回合未验证。

保持 Daemon 运行时，`npm run smoke:tasks` 可重复验证 MCP 草稿生命周期，每次留下一个已取消的诊断任务，不调用模型。`npm run check:review` 检查 SDK 原生程序可定位、独立验收材料可生成，并清理一次性项目，不调用模型。SDK 验收支持 `npm run login:review` 单独登录 ChatGPT 账号，也支持测试 API Key；不复制 Desktop 凭据。账号权限、额度与真实诊断步骤见 [Codex SDK 验收说明](docs/codex-review.md)。

DeepSeek 内部适配器及分层诊断见 [DSH 任务接入](docs/dsh-integration.md)。目前让 DSH 在独立空目录、只读模式下返回 JSON 提案，由 Bridge 核对范围后仅写候选副本，不让 DSH 直接操作项目。真实连接的 `--check-only` 已通过；`--run-proposal` 只测一个 DeepSeek 提案，`--run-task` 才尝试双模型链路。当前这两个真实诊断模式只实现 API Key 认证，这是本项目的实现限制；DSH 官方另支持 `deepseek-account` 账号路由，接下来优先验证，不要求只有账号的用户先申请 Key。所有诊断均不打开生产派发，也不自动合并。

隔离 ACP 最小文本探测现已得到一次成功回复：用户在自己的终端设置测试用 `DEEPSEEK_API_KEY` 后，报告 `{"stopReason":"end_turn","reply":"OK","toolCalls":0,"cost":"unknown"}`。此前三次真实提示中，前两次报 `realpath EPERM`，第三次报缺少 API Key；几次无 Key 预检失败没有发出模型提示。成功结果仅证明独立诊断脚本的这一条文本通路可用；工具调用数是脚本观察到的更新事件计数，费用未知，ACP 有效只读和完整沙箱边界未验证。`node scripts/probe-dsh-prompt.mjs "D:\DeepSeekHarness\DeepSeek Harness.exe" --check-only` 可做无模型检查；`--run-model` 要求当前终端预先设置测试用 Key，不要在聊天中发送 Key 或借用 Desktop 凭据。生产派发仍关闭。

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

本地目录尚无 `.git`，远端 GitHub 内容和默认分支也尚未核对；当前文件尚未推送到用户仓库。
