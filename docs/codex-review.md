# Codex SDK 独立验收：当前入口与诊断

更新：2026-10-25。当前仍属 Phase 1，生产 Daemon 没有接入执行器或验收器。

## 已实现的路径

1. `core.prepareReviewWorkspace(taskId)` 核对已声明文件和源基线，将 `before`、`after`、目标及验收条件封装为 `.RelayCore/reviews/TASK-.../REVIEW.json`。
2. 材料只接受 UTF-8 文本，源内容加候选内容及最终 JSON 均受 256 KiB 上限约束。文件名和源码保存在 JSON 数据中，不直接复制成可加载的项目配置。
3. `runCodexReview()` 在独立 Codex home 中启动全新线程；账号模式复用专用登录目录但不复用线程，Key 模式为每份材料新建 home 并要求显式模型。只读沙箱、审批策略 `never`、工具网络关闭、网页搜索关闭、shell 和连接器禁用。不读取或复制 Desktop 配置、登录凭据或已登记的 MCP。
4. 调用 SDK 前先调用任务上下文的 `beginModelTurn('codex')`，使用 Core 上下文时在 SQLite 持久化请求意图；收到原生线程 ID 后调用 `recordSession()`。独立诊断脚本另用 `REVIEW-INTENT.json` 和 `REVIEW-SESSION.json` 保留诊断意图与线程 ID，不伪装为生产任务派发。
5. 返回前后核对材料哈希，要求结构化 `approved`/`rejected` 结论、非空理由、输入/输出用量和完成事件。出现工具事件、用量缺失或材料变化就拒绝结果。

目前这些行为由假 SDK 事件测试验证；SDK 原生 CLI 的版本与禁用选项也做了无模型检查。真实模型回合尚未验证。事件观察发生在工具事件到达时，不能撤销已经发生的副作用；只读配置也不能被外推为完整 Windows 隔离。模型结论不会自动合并或完成任务。

官方 [Codex SDK 文档](https://learn.chatgpt.com/docs/codex-sdk)介绍独立线程调用；[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)列出 `features.shell_tool`、`features.apps` 和 MCP 工具过滤。具体 SDK 选项还以本项目锁定的 `@openai/codex-sdk@0.162.1` 类型及实现为准。

## 无模型检查

在项目根目录执行：

```powershell
npm run check:review
```

脚本构造一个一次性加法样例，把候选实现故意改为减法，生成独立验收材料，并确认 SDK 能找到本地原生 CLI。它不调用 `run()`/`runStreamed()`，不需要 API Key；结束时核对路径并清理一次性目录。

已实测随包 CLI 返回 `codex-cli 0.162.1`，并接受验收使用的工具禁用配置。曾出现 SDK 可导入但 Windows 原生可选依赖不完整的情况；通过项目内 `npm install --include=optional --ignore-scripts` 修复并更新锁文件，没有全局安装或更换 SDK 版本。换机器建议执行 `npm ci --include=optional --ignore-scripts` 后再检查，不把“导入成功”当成可执行证明。

## 真实模型诊断

### 优先：专用账号登录

根据官方 [Codex 认证说明](https://learn.chatgpt.com/docs/auth)，Codex 支持 ChatGPT 账号登录和 API Key 两种方式。账号方式取决于订阅、可用权限及额度，不等于无限或免费；DSH 的 DeepSeek 登录不能替代它。

保留 Daemon 终端，另开一个自己的 PowerShell：

```powershell
Set-Location -LiteralPath 'D:\MYCODE\RelayCore'
npm run login:review
```

在官方登录页面完成个人授权，不把授权链接、验证码、令牌或 Key 发到聊天。脚本使用本项目锁定的 CLI、独立的 `CODEX_HOME=.RelayCore/codex-review-home`，不借用 Desktop 的认证缓存。为明确凭据位置，配置 `cli_auth_credentials_store="file"`；CLI 的 `auth.json` 是敏感的原生登录缓存，**不是 DPAPI 密文**。Windows 登录脚本在启动 CLI 前限制该目录及已有凭据文件的 ACL，仅当前 Windows 用户与 SYSTEM 可访问；权限设置失败就停止。不建议用管理员终端替其他账户登录，同账号进程也不构成隔离边界。此目录被 `.gitignore` 忽略，但仍需防备备份或手动分享。

完成后在同一账户下核对并诊断：

```powershell
node .\scripts\login-codex-review.mjs --status
node .\scripts\probe-codex-review.mjs --run-review
```

状态命令只输出 `authenticated` 布尔值，不展示凭据。2026-10-25 用户完成浏览器授权后，主机账户核对为 `authenticated:true`。随后首次真实诊断取得线程 ID，但 30 秒内没有完成或用量事件，详见下节；登录状态不能证明模型请求已成功。账号模式不指定模型时使用原生 CLI/账号默认配置，也可在 `--run-review` 后提供模型名；可用性须实测，程序不保证默认模型必可用。若当前终端残留 `CODEX_REVIEW_API_KEY`，诊断会优先走显式 Key 模式；应先确认并移除不再需要的变量。

### 可选：测试 API Key

若选择按 API 用量计费，使用验收通道的测试专用凭据，不使用 DeepSeek Key。必须明确选择模型；Windows PowerShell 5.1 可在同一个终端运行：

```powershell
$reviewModel = Read-Host -Prompt '输入验收模型名'
$reviewSecret = Read-Host -Prompt '输入验收通道测试 API Key' -AsSecureString
$env:CODEX_REVIEW_API_KEY = [System.Net.NetworkCredential]::new('', $reviewSecret).Password
try {
  node .\scripts\probe-codex-review.mjs --run-review $reviewModel
} finally {
  Remove-Item Env:\CODEX_REVIEW_API_KEY -ErrorAction SilentlyContinue
  $reviewSecret.Dispose()
}
```

独立 home 和受控子进程环境不会继承主程序的 DSH Key 或 RelayCore 控制口令。SDK 将显式传入的验收 Key 交给自己的 CLI 进程进行认证，Key 不写入脚本参数、配置、验收 JSON 或诊断汇总。

### 诊断范围与成本

真实诊断会发送一次 SDK 提示，要求拒绝上述加法回归；诊断时限为 30 秒。时限不保证远端立即停止或零费用，Token/金额硬预算尚未实现。账号模式消耗相应额度，Key 模式需自行限制预算并核对提供方账单。缺少登录或 Key 时，在准备样例和发送提示之前拒绝运行；登录状态命令本身不调用模型。

真实诊断保留 `local/relaycore-review-probe-*` 下的材料和可能取得的线程 ID，便于失败核查；不要因为结果未知就立即重复运行。诊断成功也只证明这一份人工样例的 SDK 验收，不能替代真实 DSH 变更、测试执行、生产任务恢复或 Phase 1 全部验收。

## 2026-10-25 首次真实诊断：结果未知

本地账号状态为 `true` 后，仅运行一次 `--run-review`。记录原生线程 `01a17348-9671-7d72-a48b-7dfb517a3b8b`，会话元数据中的默认模型为 `gpt-6.1-sol`；没有指定或切换模型。30 秒截止时 SDK 返回 `ABORT_ERR`，没有观察到完成事件或 Token 用量事件。

材料保留在 `local/relaycore-review-probe-a4N9Ua/`，包括请求意图、线程 ID 和补记的 `REVIEW-OUTCOME.json`；没有自动重试。当前脚本已增加失败结果汇总，后续诊断失败会保存结果未知、已申请提示数及已知线程号，不把错误堆栈当成功。

不能据此断言网络、账号权限或模型服务哪一项有问题，也不能推断没发生远端推理或零消耗。冷启动、网络、服务延迟及默认推理耗时都是待排查解释；本轮未修改时限来掩盖失败。DeepSeek 提案诊断可独立于 SDK 运行，先补该通道证据，完整双模型诊断仍待验收。
