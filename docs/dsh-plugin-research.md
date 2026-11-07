# DSH 插件系统调研报告（Web Host 界面扩展可行性）

日期：2026-11-08。基线：本机安装 213MB app.asar（11-04 自动更新的新版本，包结构完整）。全部证据来自本机安装包只读解剖，零模型调用。

## 1. 结论

**在 DSH 网页版界面里加入自定义面板（展示 RelayCore 的任务编排全景）技术可行**，路径是 DSH 官方插件系统，不需要修改 DSH 安装包。三个未知数中两个已在解剖中确认，剩"插件分发格式"一个需要原型验证。

## 2. 插件体系结构（实测确认）

- **两级结构**：bundle（`package.json` 的 `dsh.profile.bundles` 有序列表）+ 行覆盖（profile 的 `cordis.patch.yml`，按 entry id 记录偏离）。
- **前端插件**：`window.__ModuleLoader__.load({ id, factory })` 注册浏览器端 React 模块；CSS 以 `<style data-plugin-css>` 注入。官方几十个 `dsh-client-ui-*` 包全部是此形态——现成的结构模板。
- **服务端插件**：cordis 服务（Node 侧），可挂服务/工具。
- **管理通道**：Web 侧边栏有官方 Plugins 页（ui-plugin-manager）；agent 还有 `plugin_manager` 工具可在会话中启停/安装（需 danger-full-access 或逐次批准）。HMR 开启时配置热生效。
- **安装要求**：pnpm 在 PATH（或显式 pnpmCommand）。

## 3. RelayCore 面板插件的设想

一个装进 web profile 的插件：前端渲染"任务编排"页——从 RelayCore（127.0.0.1:8765，同机 Bearer）实时读取：GPT 指令/合约、DSH 收到的提示与产出、审查意见、用量分账。效果即"看见 GPT 操控 DSH 的全景"，位于 DSH 自己的界面内。

## 4. 待验证（PoC 阶段）

1. bundle 分发格式：`dsh.profile.bundles` 能否引用本地路径/file: 包（官方页面走 npm registry）；本地 file: 安装到 profile 的 pnpm 行为。
2. 页面挂载点：client-ui 插件可注册的 slot 清单（侧栏页/会话标签/更多菜单已有先例；整页注册模式需再解剖 1-2 个 settings-* 插件）。
3. `__ModuleLoader__` 与内部 API 的版本稳定性（预览版迭代快，插件需随版本适配）。
4. CORS/信任边界：插件前端 fetch 127.0.0.1:8765 是否受 DSH web 信任栅栏影响（同机回环，预计可带 Bearer 直连）。

## 5. 与既有安全边界的关系

插件代码运行在 DSH 进程内（用户级权限），安装本身等效于"在机器上运行新代码"——需要用户逐个确认安装（官方管理页已内置确认流）。RelayCore 插件只**读取** RelayCore 的 API 做展示，不放大任何权限；DSH 执行侧的受控提案/候选副本/独立审查边界不受影响。
