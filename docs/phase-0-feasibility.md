# Phase 0 可行性记录

状态：**进行中，准入未通过**。本记录区分本机实测、官方文档与待验证事项。用户已要求开始 Phase 1；生产控制骨架仍不触发外部 Agent，独立诊断探针已做有限模型实测，不代表下列自动执行准入条件已满足。

## 本机环境与已验证事实

| 项目 | 结果 | 证据与限制 |
|---|---|---|
| 本地仓库 | 当前项目目录没有 `.git` | `git status` 报告不是 Git 仓库；尚未确认远端内容或建立关联 |
| GitHub 连接 | 未连通 | 对用户提供的 `https://github.com/learnerCodeZ/RelayCore.git` 执行 `git ls-remote`，普通与提升权限环境均无法连接 443 端口；`gh repo view` 返回 HTTP 401，提示 GitHub CLI 尚需认证。不能据此判断远端仓库是否为空或私有 |
| Windows 工具 | Git 2.54.0、Node.js 24.15.0、npm 11.12.1 | 本机命令返回版本；只证明工具可启动 |
| Codex | CLI 0.162.0-alpha.17.2；`codex exec` 和 `codex mcp` 帮助可用 | 证明本机有非交互调用及 MCP 配置入口；未验证 RelayCore MCP 服务接入、SDK 模型回合、用量或后台验收 |
| Codex app-server | 独立临时 `CODEX_HOME` 下的 JSON-RPC `initialize` 成功 | 证明本机控制进程可启动并响应协议；未创建任务线程或发起模型请求。临时 home 需先存在，否则进程会提前退出 |
| DSH | 桌面程序运行中；其内置 CLI 版本为 0.2.0-rc.2 | `headless --help`、`web --help`、`acp --help` 均成功；只证明通道命令存在，未运行模型任务 |
| DSH 默认配置 | Headless、ACP 配置包含 Windows PowerShell 沙箱及默认 `workspace-write` | 通过 `--dump-default-config` 核对；配置存在不等于当前 Windows 环境的隔离已生效 |
| DSH ACP 无模型生命周期 | 初始化、创建并关闭会话、跨进程列出与恢复会话均通过；无活动任务时已发送取消通知 | `scripts/probe-dsh-acp.mjs` 用独立临时 DSH home 和一次性工作区可重复验证初始化、创建、发送取消通知、关闭；先前另做过跨进程列出与恢复实验，未固化为脚本。此脚本未发送 `session/prompt`；取消通知无回执，不证明真实任务取消或工具权限 |
| ACP 最小文本探测 | 前三次 `session/prompt` 未成功；第四次由用户运行并报告 `OK` / `end_turn` | 每次只发送一条短提示，使用隔离 home/工作区、进程级 `DSH_PERMISSION_MODE=read-only`、默认拒绝 ACP 权限请求和 30 秒超时。前两次报 `EPERM realpath 'C:\Users\weixing'`；第三次在把一次性目录和临时变量移到忽略的 `local/` 后，报 `deepseek-official` 缺少 API Key。用户在自己终端设置测试 Key 后，第四次输出 `{"stopReason":"end_turn","reply":"OK","toolCalls":0,"cost":"unknown"}`；没有把 Key 发到聊天或复制 Desktop 凭据。成功回复只验证此诊断文本回合；路径错误来源、用量、ACP 有效只读、工具边界和生产调度仍未知 |
| ACP 只读写入单点 | 用户报告一次真实 `--probe-readonly` 得到 `outcome:"read-only-denied"` | 输出含 `toolCalls:1`、`tool_call_update` 状态 `failed`、`permissionRequests:0`、`denialReported:true`、`targetExists:false`。脚本在一次性工作区只请求一个 `probe` 文件，设置 `DSH_PERMISSION_MODE=read-only`，并在会话后独立核对目标不存在；这是脚本的布尔结论和用户提供的终端输出，未取得 DSH 原始工具日志。只支持这一条 ACP 写入被拒，不能外推到其他工具/路径、网络或 Windows ACL 的全面隔离；用量未知 |
| ACP 在途提示取消单点 | 用户报告一次真实 `--probe-cancel` 得到 `outcome:"prompt-cancelled"` | 输出含 `pendingAtCancel:true`、`cancelSent:true`、`stopReason:"cancelled"`、`replyObserved:true`、`toolCalls:0`、`permissionRequests:0`、`cost:"unknown"`。支持这一条 ACP 提示回合接受取消；未验证工具执行中取消、网络请求时序、副作用撤销或生产任务恢复。用户随后确认当前终端 Key 环境变量为 `False` |
| DSH Desktop 文本连接 | 用户报告在独立空工作区 `D:\MYCODE\RCtest` 选择“只读”后，模型按最小提示回复“连接测试成功” | 属于用户转述，不是 Bridge/ACP 调用记录；本机随后只读检查该目录仍为空。只说明 Desktop 文本对话至少曾得到响应，不证明只读沙箱、工具执行、费用、取消或后台接入 |
| DSH Desktop 单点只读拒写 | 用户报告在同一只读工作区尝试创建 `relaycore-readonly-probe.txt` 时得到 `[sandbox: file access denied under read-only mode]`，未申请提权或换目录 | 随后独立只读检查：目标文件不存在，工作区为空。支持“此模式下这一次工作区内写入被拒绝”；不证明所有写入方式、工作区外边界、底层 Windows ACL 或 ACP 通道同样安全 |
| DSH Desktop 单点工作区内写入 | 用户报告切到“工作区内修改”后创建 `D:\MYCODE\RCtest\relaycore-write-probe.txt`，无额外授权，并称此前文件不存在 | 随后独立读取：目标文件存在，长度 5 字节，十六进制 `70726F6265`（`probe`）；当前工作区目录只有该文件。此前是否存在、是否经过其他临时操作只由用户/DSH 报告；本项不涉及工作区外或 ACP 写入 |
| DSH Desktop 单点工作区外拒写 | 用户报告保持 `workspace-write` 时，尝试写入空的兄弟目录 `D:\MYCODE\RCtest-boundary\outside-probe.txt` 得到 `[sandbox: file access denied under workspace-write mode]`；错误同时提示可申请更宽权限，用户未申请 | 随后独立只读检查：兄弟目录存在但为空，目标文件不存在。支持“默认权限下这一次工作区外写入被拒绝”；不证明其他路径/工具、提权审批或 ACP 后台通道的边界 |
| 依赖与许可证 | 已编写本地项目代码，当前使用 Node.js 内置模块，无新增第三方包依赖；未复制第三方代码 | 远端仓库内容与许可证未核对；后续引入依赖和引用代码时逐项记录来源及许可 |

早期自动化检查只运行版本、帮助、默认配置与无模型协议实验；后来另做四次隔离 ACP 最小文本探测，以及只读拒写和提示取消的单点探测，结果如上。均未读取 DSH Desktop 凭据或改动用户现有 DSH 配置。用户此前自行在 DSH Desktop 发起一次最小文本请求；这些调用的实际用量均未核对。ACP 和 Codex 的无模型协议实验使用独立临时 home，避免把测试会话混入用户日常记录。

可复现的无模型 ACP 检查：`node scripts/probe-dsh-acp.mjs "D:\DeepSeekHarness\DeepSeek Harness.exe"`。2026-10-13 本机输出 `ACP initialize/new/close: PASS (0.0.1); cancel notification sent without acknowledgement`；括号内是协议返回的 Agent 版本，不等同于 DSH 安装包版本。直接使用默认用户 DSH home 的尝试因当前 Codex 文件沙箱拒绝写入而失败，不能据此判断 DSH 本身不可用；改用隔离临时 home 后通过。

## 官方资料支持的能力与边界

- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)文档说明可启动、继续和恢复本地线程；目标环境中的鉴权、审批中断、用量回传与只读 Review 仍需实测。
- [DSH Python SDK 指南](https://deepseek-harness.github.io/deepseek-harness/en/guide/python-sdk)描述了 Windows x64、隔离工作区与独立 Harness home 的用法，同时指出最小 profile 的 shell 不会仅因设置工作目录就自动受限。RelayCore 不应把这个 profile 直接当作安全执行通道。
- [DSH ACP 协议说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)列出创建、查询、恢复、取消和关闭会话的接口，也说明 ACP 不提供 DSH 专用的展示信息。本机已验证无模型会话生命周期；用户另提供了文本提示、只读拒写和在途提示取消的单点结果，其他权限行为仍未知。
- [ACP v1 概览](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx)将 `session/cancel` 定义为无响应通知；写入本地管道不等于目标会话确已停止。独立探针又观察到一次原 `session/prompt` 返回 `cancelled`，但未验证工具执行中取消或副作用处理。
- [DSH CLI 参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)说明 `DSH_PERMISSION_MODE` 可改变进程默认权限模式；设置环境变量不等于已经实测 ACP 会话的实际权限效果。
- [DSH 沙箱说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sandbox.md)把文件写入限制与网络、进程可见性分开，并将 Windows ACL 后端的执行完整性标为部分约束。RelayCore 需按实际任务要求验证，不能只看模式名称。
- [DSH 进程沙箱参考](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox)说明 `read-only` 也只约束文件效果，网络和进程可见性另计；Windows ACL 后端报告部分执行完整性。无回执的取消通知和客户端拒绝权限请求都不能替代这些边界。
- [DSH Web Host 连接说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)描述了浏览器会话鉴权、Host/Origin 检查及 RPC 传输。现有桌面窗口与外部 Bridge 是否能安全共享或新建会话，仍需在本机单独验证；不读取或复用用户浏览器凭据来绕过鉴权。

另有上游用户报告 [DSH Desktop 0.2.0-rc.2 的 Windows ACL 工作区问题](https://github.com/deepseek-ai/deepseek-harness/discussions/8421)。这不是本机已复现的结论，但与当前安装版本相同，应把一次性目录的写入/拒绝写入测试放在 Phase 1 前，不在现有项目目录尝试危险权限实验。

名称检索发现其他使用 RelayCore 名称的项目，例如 [relaycraft/relay-core](https://github.com/relaycraft/relay-core) 和 [totooss/relaycore](https://github.com/totooss/relaycore)。这只说明名称并非独有，不构成商标结论；对外发布前仍需核对品牌与仓库命名。

## Phase 1 前必须完成

1. 连接并核对用户提供的远端仓库，确认默认分支和现有文件，再建立本地 Git 关联；不得覆盖远端或本地已有内容。
2. 在一次性工作区和独立 DSH home 中，实测至少一个 DSH 通道的会话创建、任务执行、事件/结果查询、取消及恢复。验证只读与写入边界，尤其是工作区外写入、网络和子进程行为；保存版本及失败证据。
3. 用最小样例验证 Codex Desktop 能调用本项目 MCP、后台 Codex SDK 能在独立会话完成验收，并核对权限、取消、用量和异常返回。
4. 形成通道能力矩阵：每个测试项标注 `通过`、`失败` 或 `未知`。明确最低受控通道和 Phase 1 的停止、预算策略；无法证明安全的自动写入通道不放行。

若模型调用产生费用，应先在一次性项目中限定请求范围、回合数与用量。用户已在 DSH Desktop 发起一次最小文本请求，费用与用量未核对；这不代表端到端链路可用。
