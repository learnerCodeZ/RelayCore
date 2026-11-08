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

## 6. 追加发现（2026-11-08 深入解剖）

- **版本变化**：DSH 于 11-04 自动更新（182MB→213MB），包结构由 `dsh/node_modules` 平铺保持不变（新增 forge/action-cards 等）；`dshCliPath`、console shim、ACP 链路在新版本下经真实验收确认兼容。
- **第三方 bundle 已能被内核加载**：手写 bundle（含 `dsh.bundle.patch` 与 `dsh.client.platform: "web"` 声明）放入 profile 的 `node_modules` 并登记 `dsh.profile.bundles` 后，DSH 启动成功激活（首次失败报缺 `dsh.bundle` 声明——报错信息直接指明缺失字段，调试体验良好）。
- **卡点（下一步分析点）**：浏览器端 `__ModuleLoader__` 的插件清单来自启动注入行（`index injection rows`：global/script/script-src/style/html 五种，由 Host 渲染进 index.html 或经 Desktop 壳注入）。官方 client-ui bundle 的 `client.js`（`window.__ModuleLoader__.load(...)`）经此链交付；第三方 bundle 的 client.js 进入该清单的确切聚合点尚未定位——候选位置：`dsh-web-app/lib/startup.js`、`dsh-cordis-client-runner`、host-frontend-static 的 index 渲染。已解压分析材料保留在 `Temp/dsh-research/`（web-main.js、webserver/web-app/inventory 源码）。
- **无关发现**：acp 会话对 Desktop/Web GUI 不可见的根因方向——acp profile 的会话查询服务为 `:memory:` 不持久（无列表数据源），与 Desktop 列表分库。
