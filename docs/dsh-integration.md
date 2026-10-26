# DSH 任务接入：数据提案与独立验收

更新：2026-10-25，仍属 Phase 1。生产 Daemon 不传执行器，MCP 不开放派发。

## 认证方式：可以走账号，不必先申请 API Key

DSH 官方将两种模型路由分开：[`deepseek-account`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek-account/README.md) 使用官方账号服务提供的授权；[`deepseek-official`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek-api-key/README.md) 使用 API Key。账号路由不退回 Key，账号登录也不会替 API 路由补 Key。账号可用模型和访问资格仍由服务及客户端版本决定，不能推断为免费或无限。

**本项目当前探针只实现了 API 模式，不是 DSH 只支持 API。** `runDshProposal()` 检查 `apiKey`，脚本检查 `DEEPSEEK_API_KEY`；同时创建全新 `DSH_HOME`，没有 Desktop 的登录状态。之前隔离探针报 `deepseek-official` 缺 Key，只说明当时选了 API 路由，不能证明账号不可用。此前让只有账号的用户先准备 Key 的指引不够准确，现纠正。

下一步优先验证官方账号通道，而不是要求用户为了 RelayCore 新申请 Key。需要核对本机版本、ACP 模型选择和受控授权范围；Desktop 登录不会自动进入新建的隔离进程。目前账号接入尚未完成，不能保证现有登录立即可复用。若需要独立浏览器授权，应由用户亲自完成；不抓取 Cookie、不复制令牌，也不把账号令牌冒充 `DEEPSEEK_API_KEY`。账号服务的边界见[官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/deepseek-account/README.md)。

本机只读检查已确认安装版本为 `0.2.1-rc.2`，包含 `dsh-deepseek-account`、`dsh-deepseek-account-platform` 和 `dsh-llm-deepseek-account`。这证明组件已随包安装，不证明后台已经登录。另核对当前 ACP 实现的 `authMethods: []` 和立即成功的 `authenticate()`，与[官方 ACP 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)一致：ACP 连接本身无需认证，该方法并不是 DeepSeek 账号登录。因此不能靠补发 ACP `authenticate` 就宣称账号已接通。下一步应使用 DSH 官方账号授权入口，并验证授权后的后台模型选择；尚未要求用户重新登录或执行新的 Key 命令。

## 哪些已经接上

| 层次 | 当前事实 |
|---|---|
| ACP 协议连接 | `src/acp.mjs` 可初始化、新建会话、发送提示、处理事件、取消及关闭 |
| 真实 DSH 进程 | 本机 `--check-only` 创建并关闭独立会话通过，没有模型提示 |
| 真实最小文本 | 之前用户报告过 `OK`、一次只读拒写及一次在途提示取消的单点结果 |
| 内部任务组合 | `src/dsh.mjs` 可串联 DSH 数据提案、Core 候选写入、SDK Review 与交接；真实 ACP 子进程协议加假模型的测试通过 |
| 真实结构化提案 | API 模式入口已准备，尚未真实运行；官方账号模式待接入，不要求只有账号的用户先申请 Key |
| 真实双模型闭环 | 未通过；首次独立 SDK 诊断超时，不能自动重试掩盖未知结果 |
| 生产 MCP→Daemon→DSH | 未接入，不因内部模拟成功而打开 |

## 为什么先用数据提案

尚未完成 DSH 工具执行的 Windows 权限与费用边界验证，因此先选择较窄的实验通道，而不是允许它在项目中任意运行命令：

```text
Task Contract + 已声明文件内容
  → DSH ACP：独立空工作目录、只读、仅返回 JSON，不使用工具
  → Core：校验文件范围、大小、基线、运行状态及停止信号
  → 仅写入候选副本
  → 新 REVIEW.json：原始内容与候选内容
  → Codex SDK：独立线程，只读 Review
  → approved 后写 HANDOFF.md；不合并回主项目
```

这不是“DSH 直接编辑工作区”的通道，也不证明 DSH 工具沙箱安全。文件变化由 Bridge 按任务声明写入副本，不能把该进展描述成生产自动执行完成。

## 代码对应

- `runDshProposal()`：只向子进程显式传 DeepSeek 测试 Key、必要系统/代理变量及全新 home；不继承 RelayCore 控制口令或 OpenAI Key。原有提示探针也复用同一环境和 CLI 路径助手。
- 原生工作目录是专用 home 下的空 `Workspace`，不是候选目录，源码作为 JSON 数据输入，避免直接加载候选目录中的项目配置。
- 提示前调用 `beginModelTurn('dsh')`，原生会话创建后调用 `recordSession()`。DSH 与 Review 共享合约中的提示额度；这不等于原生 Agent 内部模型循环数。
- 只接受正常 `end_turn` 和有界 JSON。工具、权限请求、错误会话、超限回复会失败；关闭会话期间的迟到工具事件也不能变成成功提案。
- `core.applyWorkspaceProposal()`：先验证全部替换条目，只接受声明文件、无重复、无 NUL 的文本，合计不超过 256 KiB；核对原项目基线及候选未变，任务仍运行且未停止时才写副本。
- `runDshReviewTask()`：提案后重新生成独立快照，Review 拒绝、失败或未知时不交接；批准后再核对源冲突，返回未合并交接。生产 Daemon 没有调用它。

适配器处理停止信号时尝试 ACP 取消并关闭连接；这不是远端停止确认或跨进程树强制终止的保证。同步候选写入没有跨文件原子事务，部分磁盘失败会留下待对账副本；同权限路径替换竞态、完整 OS 隔离、Token/金额硬预算和真实恢复仍未解决。

## 无模型连接检查

```powershell
node .\scripts\probe-dsh-task.mjs 'D:\DeepSeekHarness\DeepSeek Harness.exe' --check-only
```

2026-10-25 本机实测返回 `ACP isolated session: PASS; no model prompt sent`。它不要求 API Key，不派发任务，不修改源项目。

## 账号路线无模型检查

```powershell
npm run check:dsh-account
```

2026-10-25 实测通过：`account-route-selected`，原生 `session/set_config_option` 确认 `deepseek-account` 分组与模型（本机当前为 `DeepSeek-V4.1-Flash`），`requestedTurns: 0`（零 prompt、零模型调用）。它复用用户已登录的 DSH Home（`DSH_HOME` 或 `%USERPROFILE%\.dsh`），新建独立只读诊断会话，不向既有对话发消息，不读取或复制凭据。

该检查曾连续三次卡在 `session/new` 报 `ACP returned invalid JSON`。根因：安装包内 `dsh-llm-deepseek-account` 插件用 `console.info` 输出模型目录日志，而 Node 的 console 默认写 stdout，与 DSH 自身 `dsh-sdk-jsonrpc-server` "stdout 只允许协议帧"的约定冲突；`session/new` 加载账户插件时污染协议通道。修复：`src/dsh.mjs` 的 `dshAcpArgs()` 统一以 `--import` 预加载 `src/dsh-console-shim.mjs`，把 console 的 log/info/debug/dir 重定向到 stderr；协议本身、严格 JSON 校验与 DSH 安装包均未改动。

2026-10-25 又执行了一次受限真实提案（`scripts/probe-dsh-account.mjs --run-proposal`）并首次成功：`account-proposal-validated-not-applied`——账户模型 `DeepSeek-V4.1-Flash` 恰好 1 轮 prompt 返回精确 JSON 替换提案，无工具/权限事件，源文件复核未变，提案未应用、0 次 SDK 调用，证据落盘 `local/`。`cost` 仍为 unknown：这是单点样本，不构成账户路线稳定性、费用边界或生产接入的结论。

同日**完整账户闭环首次成功**：`scripts/probe-dsh-task.mjs --run-task` 在未设置 `DEEPSEEK_API_KEY` 时自动走账户模式（`runDshReviewTask` 传 `accountHome` 与账户工作区，默认 `D:\MYCODE\RCtest`，可用第三个参数覆盖；设置 Key 则保留 Key 模式）。结果 `reviewed-not-merged`：`COMPLETED`、恰好 2 轮（DSH 提案 1 + Codex 审查 1）、双 session、源文件未变、候选更新、`HANDOFF.md` 未合并且含审查快照 SHA-256；总时长预算 240 秒。SDK 侧超时根因（代理剥离 + 重连误判）见 `docs/codex-review.md`。单点成功不构成稳定性或费用结论；生产 Daemon 仍不挂执行器。

2026-10-26 补充**账户取消诊断**：`scripts/probe-dsh-account.mjs --probe-cancel` 发一次真实 prompt 后取消，成功判定为取消通知送达且原 prompt 返回 `stopReason:"cancelled"`、无工具/权限事件。实测 `account-prompt-cancelled`（证据 `local/relaycore-dsh-account-Ocy49V`）。注意 `DeepSeek-V4.1-Flash` 会把整个回复作为单个 chunk 一次性下发，取消窗口须在发出后立即把握（脚本用 250ms）。同轮捕获到 `usage_update`：`{"used":6646,"size":1048576}`——`size` 是 1M 上下文窗口，`used` 是上下文占用 token 量，**不是金额**；费用以账户账单为准（用户核对：当日 3 次请求合计 < ¥0.01，为用户报告口径）。

## 已有 API Key 提案诊断：可选通道

以下仅供已经选择 API Key 方式的测试，不是账号接入的必做步骤。只有账号的用户暂不执行这段命令，优先验证账号路线。结构化接口不再只要求模型回复 `OK`：一次性样例中 `message.txt` 为 `pending` 加换行，要求返回改成 `ready` 加换行的提案。脚本保存 JSON 并核对准确内容，**不应用提案、不调用 SDK**，任务保持 `DRAFT`。最多一次桥接提示，30 秒取消信号；原生消耗和费用仍需核对。

Key 只在用户自己的终端输入，不发送到聊天。Windows PowerShell 5.1 可执行：

```powershell
Set-Location -LiteralPath 'D:\MYCODE\RelayCore'
$secret = Read-Host -Prompt '输入 DeepSeek 测试 API Key' -AsSecureString
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
try {
  node .\scripts\probe-dsh-task.mjs 'D:\DeepSeekHarness\DeepSeek Harness.exe' --run-proposal
} finally {
  Remove-Item Env:\DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  $secret.Dispose()
}
```

只回传最终诊断汇总即可，不回传 Key 或登录链接。脚本不主动保存 Key，但原生 home 和会话日志仍按敏感运行资料对待，不要分享整个目录。当前代理进程没有 DeepSeek Key；用户其他终端曾设置的临时变量不会自动进入这里，不能推断用户从未配置过 Key。

预期 `outcome:"proposal-validated-not-applied"`；模型返回错误格式、尝试工具或超时都不是成功。`local/relaycore-dsh-task-*` 保留请求意图、会话 ID、提案及诊断结果；失败可能只留下部分证据，先核查，不盲目重复。

## 后续完整诊断入口

`--run-task` 在专用账号已登录、DeepSeek Key 本机可用时，才尝试完整实验任务。显式合约为总时长 60 秒、最多两个桥接提示，调用前意图和会话 ID 写入一次性项目的 SQLite。只有 SDK 独立批准、源文件未变和样例内容匹配，脚本才报告 `reviewed-not-merged`；不直接修改本项目，也不连接正在运行的生产 Daemon。

目前不把它列为已通过项，也没有在 SDK 首次结果未知后自动运行它。模型 Review 不等于执行了项目测试，`COMPLETED` 也只描述实验合约的执行结果，不授权合并。全量无模型测试 50/50 通过仍不能替代真实双模型与安全验收。
