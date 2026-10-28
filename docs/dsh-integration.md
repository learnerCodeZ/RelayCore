# DSH 任务接入：数据提案与独立验收

更新：2026-10-26，Phase 1 已由用户确认，Phase 2 进行中。普通生产 Daemon 不传执行器，用户 Desktop 配置不开放派发；隔离 MCP→Daemon 有一次真实成功，不代表稳定性。Phase 2 快照守卫仅无模型验证。

## 认证方式：可以走账号，不必先申请 API Key

DSH 官方将两种模型路由分开：[`deepseek-account`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek-account/README.md) 使用官方账号服务提供的授权；[`deepseek-official`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek-api-key/README.md) 使用 API Key。账号路由不退回 Key，账号登录也不会替 API 路由补 Key。账号可用模型和访问资格仍由服务及客户端版本决定，不能推断为免费或无限。

**本项目已实现账户与可选 Key 两条实验路线。** `runDshProposal()` 接受互斥的 `accountHome` 或 `apiKey`；账户模式让原生 DSH 服务消费已有登录，不由 Bridge 读取或复制凭据。早期隔离 Key 探针报缺 Key，只说明当时选了 API 路由，不能解释为 DSH 不支持账户。

本机账户无模型检查、一次受限提案和一次完整闭环均有已保存证据；只有账号的用户不必为此新申请 Key 或重复登录。换机器、Home 或账户状态变化时仍须重新核对原生账户模型选择，不能假设 Desktop 登录会进入全新 Home。需要重新授权时由用户亲自操作；不抓取 Cookie、不复制令牌，也不把账户令牌当作 API Key。账号服务边界见[官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/deepseek-account/README.md)。

本机此前静态核对安装版本为 `0.2.1-rc.2`，包含账户相关组件；组件存在本身不证明登录。ACP 的 `authMethods: []` 与立即成功的 `authenticate()` 仅表示 stdio 连接不要求认证，不是 DeepSeek 登录。账户可用性的证据来自后续原生模型选择和真实诊断，不能用 no-op authenticate 替代。

## 哪些已经接上

| 层次 | 当前事实 |
|---|---|
| ACP 协议连接 | `src/acp.mjs` 可初始化、新建会话、发送提示、处理事件、取消及关闭 |
| 真实 DSH 进程 | 本机 `--check-only` 创建并关闭独立会话通过，没有模型提示 |
| 真实最小文本 | 之前用户报告过 `OK`、一次只读拒写及一次在途提示取消的单点结果 |
| 内部任务组合 | `src/dsh.mjs` 可串联 DSH 数据提案、Core 候选写入、SDK Review 与交接；真实 ACP 子进程协议加假模型的测试通过 |
| 真实结构化提案 | 账户模式已有一次精确 JSON 提案、源文件未变、未应用；可选 Key 提案入口保留 |
| 真实双模型闭环 | 已保存一次账户 DSH→候选→SDK 批准→未合并 HANDOFF；早期 SDK 超时记录保留，单点不代表稳定性 |
| 隔离受控调度 | 一次性本地授权、MCP→Daemon→账户提案→候选主机检查→SDK 批准→HANDOFF 已单次真实通过；源未变、未合并 |
| 生产 MCP→Daemon→DSH | 未接入，不因内部模拟成功而打开 |

## 为什么先用数据提案

尚未完成 DSH 工具执行的 Windows 权限与费用边界验证，因此先选择较窄的实验通道，而不是允许它在项目中任意运行命令：

```text
Task Contract + 已声明文件内容
  → DSH ACP：独立会话、只读、仅返回 JSON，不使用工具
  → Core：校验文件范围、大小、基线、运行状态及停止信号
  → 仅写入候选副本
  → 可信宿主检查候选，复核检查期间源/候选未变
  → 新 REVIEW.json：原始/候选内容与绑定候选 hash 的 testEvidence
  → Codex SDK：独立线程，只读 Review
  → approved 后写 HANDOFF.md；不合并回主项目
```

这不是“DSH 直接编辑工作区”的通道，也不证明 DSH 工具沙箱安全。文件变化由 Bridge 按任务声明写入副本，不能把该进展描述成生产自动执行完成。

## 代码对应

- `runDshProposal()`：账户模式使用指定原生账户 Home，Key 模式使用显式测试 Key 与全新 Home；两种环境均仅保留必要系统/代理变量，不转发 RelayCore 控制口令或 OpenAI Key。所有 DSH 启动点必须使用 `dshAcpArgs()`，不能绕过 console shim。
- Key 模式在专用 Home 下的空 `Workspace` 启动；账户模式在显式测试工作区（本机 `D:\MYCODE\RCtest`）创建新只读会话。两者都不把候选目录交给 DSH，源码作为 JSON 数据输入；账户工作区不是空目录，不能声称不会加载其原生项目上下文。
- `accountModelChoice()` 要求唯一的 `id: model` 选择项、正确的 category/type、唯一的 `deepseek-account` 分组及合法无重复 opaque 选项；`selectAccountModel()` 发送原生配置后复核账户目录与 currentValue。重复选择项、API 确认、确认失败或选择期间取消都不能预留 prompt、发模型请求或切换 Key。新增异常回归只用假 ACP，不证明真实服务一定不会返回异常。
- 提示前调用 `beginModelTurn('dsh')`，原生会话创建后调用 `recordSession()`。DSH 与 Review 共享合约中的提示额度；这不等于原生 Agent 内部模型循环数。
- 只接受正常 `end_turn` 和有界 JSON。工具、权限请求、错误会话、超限回复会失败；关闭会话期间的迟到工具事件也不能变成成功提案。
- `core.applyWorkspaceProposal()`：先验证全部替换条目，只接受声明文件、无重复、无 NUL 的文本，合计不超过 256 KiB；核对原项目基线及候选未变，任务仍运行且未停止时才写副本。
- `runDshReviewTask()`：提案后可先调用可信 `verifyCandidate()`，再生成带检查证据并持久登记的独立快照；旧入口不传验证器时明确显示未记录检查。Review 拒绝、失败或未知时不交接；批准必须对应等待前捕获的 hash，再复核登记、快照、候选及源基线。交接引用 Snapshot ID、revision 与 Review/Candidate hash，元数据从核对后的快照取值。普通生产 Daemon 没有调用它；当前新增快照守卫仅用假适配器验证，见[阶段二状态](phase-2-status.md)。

适配器处理停止信号时尝试 ACP 取消并关闭连接；这不是远端停止确认或跨进程树强制终止的保证。同步候选写入没有跨文件原子事务，部分磁盘失败会留下待对账副本；同权限路径替换竞态、完整 OS 隔离、Token/金额硬预算和真实恢复仍未解决。

### 中途断连与非法协议帧

`src/acp.mjs` 不只检查能否 `JSON.parse`，还要求每行根值为非数组对象且 `jsonrpc` 为 `2.0`。`null`、数组、标量、缺少版本和错误版本都按固定错误拒绝并关闭子进程，不在事件回调里抛出未捕获 TypeError。这是基础帧头检查，不是完整 JSON-RPC/ACP 字段模式验证。

首次致命传输故障后忽略同一缓冲区里剩余的更新，不让迟到消息继续触发观察者。任一请求超时经共用 `fail()` 立即拒绝所有待办、清掉计时器并锁定失败状态；之后的请求/取消不能再发送。错误分类只保存脱敏固定文本，不输出原始帧或凭据。

新增零模型集成回归在真实 Node 假 ACP 子进程中制造三种 prompt 中断：没有回复、部分 JSON 回复、完整提案文本但没有 `session/prompt` 的正常终态。三者均不得触发 SDK Review、候选写入或 HANDOFF；SQLite 保留一次 DSH prompt 意图及会话，任务为 `RECOVERY_REQUIRED`。两次重开不重播、不重复恢复事件。**完整 JSON 文本不等于模型回合已确认完成。** 这些测试不调用 DSH 安装程序或账户服务，也不能证明真实模型服务已取消或停止计费。

## 经 MCP 的受控调度验收

`npm run check:dispatch` 在独立项目和系统分配端口验证 MCP→HTTP→Daemon 的真实控制路径，用假适配器完成提案/审查，真实模型提示为 0。`--run-task` 另需明确单次授权和 `--allow-unknown-cost`；只走已有账户，不复用原对话、不要求 API Key、不重启用户 Daemon。授权和最小预算在调用前检查，没有 MCP 自行批准入口，不能把两次桥接提示/240 秒上限当作金额硬封顶。详见[受控调度验收](controlled-dispatch.md)。

2026-10-26 用户当次批准后只运行一次真实模式：`reviewed-not-merged`、`COMPLETED`，DSH/Codex 各一次桥接提示意图、双 session、主机精确文本检查通过；源样例保持 `pending\n`，候选为 `ready\n`。另从 SQLite 与文件独立核对授权消费、Review hash、HANDOFF 和候选一致，未自动重试。该入口仍只有一次真实成功；费用未知，旧账户账单不代表本次金额。生产执行和 Phase 2 均未因此自动开启。

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

`--run-task` 要求专用 Codex 审查账号已登录；未设置 DeepSeek Key 时走 DSH 已登录账户，设置 Key 时走可选 Key 模式。显式合约为总时长 240 秒、最多两个桥接提示，调用前意图和会话 ID 写入一次性项目的 SQLite。只有 SDK 独立批准、源文件未变和样例内容匹配，脚本才报告 `reviewed-not-merged`；不直接修改本项目，也不连接正在运行的生产 Daemon。

已保存的一次成功不替代稳定性与安全验收，也不授权自动重跑。真实调用前必须说明单次目的与预算并获当前授权，失败不自动重试；模型 Review 不等于执行项目测试，`COMPLETED` 只描述实验合约结果，不授权合并。2026-10-26 最新全量无模型测试 57/57 通过；较早全量运行曾因随机端口命中 Windows 保留范围而失败，后续通过不能掩盖该测试环境不稳定因素。
