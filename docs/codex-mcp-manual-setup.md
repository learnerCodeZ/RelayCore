# Codex Desktop 连接 RelayCore MCP

目标仅是验证 **Codex Desktop → RelayCore MCP → Daemon** 的 `list_tasks` 查询，不启动 DSH，不调用 Codex SDK 或模型。当前 `dispatch_task` 仍拒绝执行。

## 先分清接口

- `src/mcp.mjs` 是 **RelayCore 提供给 Codex Desktop 的 MCP stdio 服务**，不是 DSH 插件。
- `src/acp.mjs` 是 RelayCore 将来连接 DSH 的 ACP 客户端；目前只在独立诊断探针中使用，没有接入生产 Daemon。
- 安装 `@openai/codex-sdk` 也不会自动注册 MCP 服务或启动 Daemon。

## Windows 默认连接步骤

2026-10-25 起，默认使用本项目的 DPAPI 加密控制口令，无需手动生成口令或让 Desktop 从指定终端启动。下面操作不需要 DeepSeek API Key。

1. 在自己的 PowerShell 执行：

   ```powershell
   Set-Location -LiteralPath 'D:\MYCODE\RelayCore'
   Remove-Item Env:\RELAYCORE_TOKEN -ErrorAction SilentlyContinue
   npm start
   ```

   正常启动后可看到 `RelayCore control server on 127.0.0.1:8765; external execution disabled`。保持这个终端打开，用 `Ctrl+C` 正常停止。首次启动自动生成随机口令并以当前 Windows 用户的 DPAPI 密文保存；之后复用同一密文，不打印口令。

2. 用户级 `~/.codex/config.toml` 已将本机启动项改为以下形式。已有此表时不要重复添加；换机器要改绝对路径：

   ```toml
   [mcp_servers.relaycore]
   command = 'D:\Node_js\node.exe'
   args = ['D:\MYCODE\RelayCore\src\mcp.mjs']
   cwd = 'D:\MYCODE\RelayCore'
   enabled_tools = ['create_task', 'list_tasks', 'task_status', 'task_events', 'stop_task']
   ```

   配置中不需要 `env` 或旧的 `env_vars = ['RELAYCORE_TOKEN']`。这五个工具只涉及草稿及其生命周期，`dispatch_task` 未开放。在 PowerShell 运行 `codex mcp list` 可核对登记。插件页面未出现同名插件不能说明 MCP 未加载；当前界面里的 MCP 导航入口尚未核实。

3. 如果 MCP 在此次代码更新前已经启动，需要重新加载该进程。可正常退出并重开 Codex Desktop，保留运行 Daemon 的 PowerShell；无需从该终端启动 Desktop，也无需重启 Windows 或 DSH。

4. 回到聊天后测试 `relaycore` 的 `list_tasks`。只有工具实际返回任务列表，才将 Desktop 查询标记通过；`[]` 是合法的空列表。启动日志、注册清单和本地协议测试不能替代这一步。

## 口令放在哪里、由谁读取？

- 文件：`D:\MYCODE\RelayCore\.RelayCore\bridge\control-token.dpapi`，位于已声明忽略的运行目录；内容是密文。
- `src/auth.mjs` 使用系统 Windows PowerShell 调用 DPAPI `CurrentUser` 加解密；数据通过标准输入传递，不放入进程命令行。每次客户端请求都会重新读取并解密，暂未做缓存。
- Daemon 与 MCP 必须使用同一个 Windows 用户和可用的用户配置文件，并指向同一项目。DPAPI 仍允许该账号的其他进程解密，不能充当同账号进程隔离。
- 显式 `RELAYCORE_TOKEN` 仍优先于文件，至少 32 字符。它留给自动化测试或非 Windows 环境；使用默认方式时，应清除 Daemon 启动终端里的旧变量。
- 客户端默认按 RelayCore 脚本所在项目找文件；使用其他项目时，需明确设置 `RELAYCORE_ROOT`。
- 密文损坏、无法解密或检测到链接路径时，程序拒绝继续，不覆盖已有凭据。重置凭据前先正常停止 Daemon、确认项目和用户，避免客户端与运行进程使用不同口令。

DPAPI 行为依据 [Microsoft ProtectedData 文档](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata?view=windowsdesktop-9.0)。它保护的是本地控制口令，DSH/Codex 模型凭据仍由各自执行通道单独管理。

## 本机当前状态

截至 2026-10-25：Windows 加密凭据、独立 MCP 生命周期和 Desktop 草稿生命周期均已通过。开发过程中新增的五个工具随后已加载，无需再次要求用户重启；当前聊天实际调用 `create_task` 创建任务，再用 `task_status`、`task_events` 核对 `DRAFT`/`task.created`，调用 `stop_task` 后由事件及列表确认 `CANCELED`/`task.canceled`。未调用模型或派发任务。DSH 执行及真实 SDK Review 仍未通过。10 月 20 日注册项消失的原因未知；此前导致配置刷新错误的项目级 `.codex/config.toml` 已撤回。

官方参考：[Codex MCP 设置说明](https://learn.chatgpt.com/docs/extend/mcp)。
