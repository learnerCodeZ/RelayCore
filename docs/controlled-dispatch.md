# 受控调度验收

这份文档说明 Phase 1 的隔离调度入口及 Phase 2 新增的快照复核，不是开启生产执行的说明。普通 `npm start` 仍不挂执行器；现有用户 Daemon 不需要重启。

## 默认检查：不调用模型

```powershell
npm run check:dispatch
```

脚本 `scripts/probe-dispatch.mjs` 在 `local/relaycore-dispatch-probe-*` 创建独立样例项目，以端口 `0` 请求系统分配回环端口，启动自己的 Daemon，并通过独立 MCP 子进程调度任务。它不连接用户已有 Daemon，不启动 DSH 或原生 Codex，不读取账户凭据。省略脚本参数也只执行这个模式。

```text
MCP create_task → DRAFT
  → 未经授权的 dispatch_task 被拒绝
可信本地宿主 authorizeExecution → 一次性授权
MCP dispatch_task → HTTP → Daemon → Core
  → 准备候选副本 → 假提案 → Bridge 只写候选
  → 主机精确文本检查 → 带 testEvidence 的 REVIEW.json
  → 假审查批准 → COMPLETED / HANDOFF.md（未合并）
```

样例源文件为 `pending\n`，只有候选副本可变成 `ready\n`。结果必须标为 `simulated-reviewed-not-merged`：两个桥接提示意图来自内存假适配器，`realModelPrompts: 0`，不能算真实双模型验收。

## 授权和预算如何生效

- `startDaemon(root, { executor, executionPolicy, port: 0 })` 只供可信宿主显式注入执行器；注入时必须同时声明运行时策略，不能用 MCP 参数或环境变量打开普通 CLI 的生产执行。
- `core.authorizeExecution()` 由可信本地宿主或持控制令牌的本地 HTTP/CLI 调用，MCP 本身不提供授权工具。授权绑定草稿合约 SHA-256、时长/提示上限、费用模式和有效期，保存到 SQLite 的 `execution_grants`；未知费用须在请求中明确提供 `allowUnknownCost: true`，CLI 使用 `--allow-unknown-cost`。
- 派发在同一事务中消费授权、记录事件并入队；授权不能重复使用。启动执行器和每次提示前复核授权、时限与共享提示额度。过期、合约变化或费用未知却未明确同意时拒绝。
- 时限从派发开始计算，含排队；授权过期可进一步缩短期限。取消、超限或结果未知时停止正常完成路径，进入 `RECOVERY_REQUIRED`，不自动重播。停止前已写入的候选会保留用于核查，不能假称没有任何候选变化。
- 预算约束的是 **Bridge 提示次数和时长**，不是原生 Agent 内部请求次数、Token 或金额硬封顶。SDK 内部传输重连也不能据此解释成零额外消耗；脚本不做外层自动重试。

## 主机检查不是模型自报

`verifyCandidate()` 由可信宿主提供，本样例直接读取候选，检查完整文本是否精确等于 `ready\n`，不执行候选提供的命令。Core 在检查后再次核对候选和源文件，生成 `origin: relaycore-host` 的检查记录、候选 SHA-256 和时间戳，并将其放进独立 `REVIEW.json`。文件变化、检查失败、畸形报告或取消都不能正常进入审查。

Review 快照本身另有 SHA-256；HANDOFF 必须引用同一快照，并说明候选检查结果。`COMPLETED` 仅表示此任务产生了未合并交接，不代表已修改主项目、已获用户验收或 Phase 1 自动完成。

Phase 2 起，新快照还登记到 SQLite `review_snapshots`，绑定任务/revision、完整合约 hash 与快照 hash。组合执行器在 Review 返回后比对事先捕获的 hash，再复核登记、快照文件、当前候选和源基线；HANDOFF 引用 Snapshot ID 与候选 hash。不信任适配器事后改写的输入元数据。旧无登记快照不自动补信任；登记和校验也不等于 approved 或合并许可。该新增守卫目前只做零模型验证，详见[阶段二状态](phase-2-status.md)。

## 真实账户验收：必须另获单次同意

**不要把下面命令当成无模型检查。** 它使用已登录的 DSH 账户和独立 Codex Review 登录，可能产生费用或消耗账户额度。单次任务时限为 240 秒，最多 DSH 提案一次、Codex Review 一次桥接提示；不能保证金额硬封顶，失败不自动重试。测试前说明目的和预算，按用户已有的明确授权执行。

```powershell
node .\scripts\probe-dispatch.mjs --run-task 'D:\DeepSeekHarness\DeepSeek Harness.exe' 'D:\MYCODE\RCtest' --allow-unknown-cost
```

真实模式缺少 `--allow-unknown-cost` 会在调用前拒绝。它只走账户模式，不因环境中存在 Key 就切换 API 路由。原生 DSH 读取已有账户授权，Bridge 不读取或复制凭据；Review 先检查已有专用登录，不自动重新登录。账户 Home 为 `DSH_HOME` 或当前用户 `.dsh`，本机需要在运行它的终端保留 `HTTP_PROXY` / `HTTPS_PROXY` 本地代理；控制连接应绕过代理。

真实模式仍使用独立样例项目和临时 Daemon，只在指定 `RCtest` 账户工作区创建新的只读 ACP 会话，不复用既有对话；DSH 启动经 `dshAcpArgs()` 加载 console shim。账户工作区可能加载原生项目上下文，不能把它描述成空目录。DSH 不运行工具、不直接编辑候选，检查完成后才由独立 SDK 线程 Review；不合并回源码，不改变生产执行状态。

## 证据与清理

独立运行保留 `DIAGNOSTIC.json`、SQLite 任务/授权/事件/会话记录、基线、候选、Review 和可能生成的 HANDOFF。诊断区分模式、真实提示与模拟意图、源文件是否不变、候选是否正确、授权是否消费及审查快照哈希；失败也保留已知状态，不保存原始错误帧或账户凭据内容。会话和原生运行材料仍按敏感信息对待，不分享整个目录。

自动化测试会清理它自己创建的检查现场；手动检查保留结果用于学习和核查。需要清理时只删明确确认过的独立现场，保留学习笔记、交接和关键验收证据。`local/` 不进入 Git，但忽略规则不是加密或敏感信息检查。

当前副本和哈希不构成 OS 沙箱，也不防同账号篡改状态库。Phase 2 已实现工作区、快照和受控整合增量，但完整隔离、恢复和费用策略仍未完成；基本授权、停止和未知结果保护不能省略。生产接线现状见 [阶段三状态](phase-3-status.md)。
