import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { access, mkdir, open, lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openCore } from './core.mjs';
import { getControlToken } from './auth.mjs';
import { runDshReviewTask } from './dsh.mjs';

const port = Number(process.env.RELAYCORE_PORT ?? 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RELAYCORE_PORT');

// Production execution stays disabled unless the operator explicitly opts in
// through the environment or the project config file: RELAYCORE_EXECUTION=account
// wires the DSH account route behind the same authorization, budget and
// recovery gates the diagnostics use. Anything else keeps external execution
// disabled. Environment variables win over config.json.
export function productionExecution(root, config = {}) {
  const fromEnv = process.env.RELAYCORE_EXECUTION === 'account';
  const fromConfig = config.execution === 'account' && config.dshExe && config.accountWorkspace;
  if (!fromEnv && !fromConfig) return { executor: null, executionPolicy: undefined, note: 'external execution disabled' };
  const executable = process.env.RELAYCORE_DSH_EXE?.trim() || config.dshExe;
  if (!executable) throw new Error('Account execution requires RELAYCORE_DSH_EXE or config.dshExe');
  const workspace = process.env.RELAYCORE_ACCOUNT_WORKSPACE?.trim() || config.accountWorkspace;
  if (!workspace) throw new Error('Account execution requires RELAYCORE_ACCOUNT_WORKSPACE or config.accountWorkspace');
  const accountHome = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE ?? '', '.dsh');
  const executionLimits = {
    maxDurationSeconds: Number(process.env.RELAYCORE_MAX_DURATION ?? config.maxDurationSeconds ?? 600),
    maxModelTurns: Number(process.env.RELAYCORE_MAX_TURNS ?? config.maxModelTurns ?? 2)
  };
  if (!Number.isSafeInteger(executionLimits.maxDurationSeconds) || executionLimits.maxDurationSeconds < 1 ||
    !Number.isSafeInteger(executionLimits.maxModelTurns) || executionLimits.maxModelTurns < 1) {
    throw new Error('RELAYCORE_MAX_DURATION and RELAYCORE_MAX_TURNS require positive integers');
  }
  const executionPolicy = { ...executionLimits, costMode: 'unknown' };
  // The dedicated review login lives next to the RelayCore installation, not
  // inside whichever project the daemon serves; override with an explicit path
  // when the operator keeps it elsewhere.
  const reviewAuthHome = process.env.RELAYCORE_REVIEW_AUTH_HOME?.trim() ||
    join(fileURLToPath(new URL('..', import.meta.url)), '.RelayCore', 'codex-review-home');
  const executor = async (task, context, core) => {
    context.signal.throwIfAborted();
    const inventory = await core.workspaceInventory();
    const existing = inventory.registered.find((entry) => entry.taskId === task.id);
    if (existing) {
      if (!existing.present || existing.kind !== 'copy') throw new Error('Existing task workspace is unavailable or incompatible');
      await core.verifyWorkspace(task.id);
    } else {
      await core.prepareWorkspace(task.id);
    }
    if (!(await core.inspectSourceConflicts(task.id)).matchesBaseline) throw new Error('Source changed before execution');
    context.signal.throwIfAborted();
    return runDshReviewTask({ core, task, context, executable, accountHome, accountWorkspace: workspace,
      authHome: reviewAuthHome });
  };
  return { executor, executionPolicy, note: `account execution enabled (limits ${executionLimits.maxDurationSeconds}s/${executionLimits.maxModelTurns} turns)` };
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 32768) {
      request.resume();
      throw Object.assign(new Error('Request too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  return bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

export async function startDaemon(root = process.cwd(), { executor = null, executionPolicy, port: listenPort = port } = {}) {
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new Error('Invalid daemon port');
  if ((executor !== null && typeof executor !== 'function') || (executor && executionPolicy === undefined) || (!executor && executionPolicy !== undefined)) throw new Error('An injected executor requires an explicit execution policy');
  const projectRoot = resolve(root);
  const bridgeDir = join(projectRoot, '.RelayCore', 'bridge');
  await mkdir(bridgeDir, { recursive: true });
  const lockPath = join(bridgeDir, 'daemon.lock');
  const lockContents = JSON.stringify({ id: randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), port: listenPort });
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Daemon lock exists at ${lockPath}; verify no process is using this project before removing it`);
    throw error;
  }
  const releaseLock = async () => {
    if (await readFile(lockPath, 'utf8').catch(() => '') === lockContents) await unlink(lockPath);
  };
  try {
    await lock.writeFile(lockContents);
  } catch (error) {
    await lock.close();
    await unlink(lockPath).catch(() => {});
    throw error;
  }
  await lock.close();
  let core;
  let token;
  // Console sessions live only in this process: a daemon restart invalidates
  // every issued session, and the long-lived control token never reaches the
  // browser, the page or any log line.
  const consoleSessions = new Map();
  const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
  // Pairing links printed at startup let the operator sign in with one click;
  // each link is single-use and expires quickly.
  const pairingTokens = new Map();
  const PAIRING_TTL_MS = 10 * 60 * 1000;
  const issuePairing = () => {
    const token = randomBytes(24).toString('hex');
    pairingTokens.set(token, { expiresAt: Date.now() + PAIRING_TTL_MS });
    return token;
  };
  const sessionCookie = (request) => {
    for (const part of String(request.headers.cookie ?? '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === 'relaycore_ui') return rest.join('=');
    }
    return null;
  };
  const sessionValid = (request) => {
    const supplied = sessionCookie(request);
    if (!supplied) return false;
    const session = consoleSessions.get(supplied);
    return session?.kind === 'browser' && session.expiresAt > Date.now();
  };
  const establishSession = (response, expiresAt) => {
    const cookieToken = randomBytes(24).toString('hex');
    consoleSessions.set(cookieToken, { kind: 'browser', expiresAt });
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    response.setHeader('Set-Cookie', `relaycore_ui=${cookieToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
    return cookieToken;
  };
  const grantFromPairing = (url, request, response) => {
    const pairingToken = url.searchParams.get('pairing');
    if (!pairingToken) return false;
    const pairing = pairingTokens.get(pairingToken);
    if (!pairing || pairing.expiresAt <= Date.now()) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>RelayCore</title>` +
        `<style>body{font-family:system-ui;margin:2rem}</style><h1>配对链接已失效</h1>` +
        `<p>链接只能使用一次且 10 分钟内有效。重新运行 <code>npm start</code> 获取新链接，` +
        `或在运行 Daemon 的终端执行 <code>node src/control.mjs ui-session</code> 手动登录。</p>` +
        `<p><a href="/ui">返回登录页</a></p>`);
      return true;
    }
    pairingTokens.delete(pairingToken);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    establishSession(response, expiresAt);
    response.writeHead(302, { Location: '/ui' });
    response.end();
    return true;
  };
  try {
    token = await getControlToken(projectRoot, { create: true });
    core = await openCore(projectRoot, executor, executionPolicy);
  } catch (error) {
    core?.close();
    await releaseLock();
    throw error;
  }
  const server = createServer(async (request, response) => {
    const reply = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    try {
      const actualPort = server.address().port;
      const host = request.headers.host;
      if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host)) {
        return reply(403, { error: 'Untrusted Host' });
      }
      const localOrigin = `http://${host}`;
      const url = new URL(request.url, localOrigin);
      if (url.origin !== localOrigin) return reply(403, { error: 'Untrusted request target' });
      // A valid pairing link signs the browser in directly (single use).
      if (request.method === 'GET' && url.pathname === '/ui' && grantFromPairing(url, request, response)) return;
      const sameOrigin = (request.headers.origin ?? '') === '' || request.headers.origin === localOrigin;
      const fetchSite = request.headers['sec-fetch-site'];
      const browserSafe = sameOrigin && (fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none');
      // This local console authenticates through a short-lived session issued
      // to the control-token holder; unauthenticated visitors see only the
      // login form, never task content.
      if (request.method === 'POST' && url.pathname === '/ui/session') {
        const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
        const expected = Buffer.from(token);
        const authentic = supplied.length === expected.length && timingSafeEqual(supplied, expected);
        if (!authentic || request.headers.origin) return reply(403, { error: 'Forbidden' });
        const sessionToken = randomBytes(24).toString('hex');
        const expiresAt = Date.now() + SESSION_TTL_MS;
        consoleSessions.set(sessionToken, { kind: 'login', expiresAt });
        return reply(200, { sessionToken, expiresAt: new Date(expiresAt).toISOString() });
      }
      if (request.method === 'POST' && url.pathname === '/ui/login') {
        if (!browserSafe) return reply(403, { error: 'Cross-origin console login is refused' });
        const input = await readJsonBody(request);
        const session = consoleSessions.get(String(input?.token ?? ''));
        if (session?.kind !== 'login' || session.expiresAt <= Date.now()) return reply(401, { error: 'Invalid or expired console session token' });
        consoleSessions.delete(String(input.token));
        const cookieToken = randomBytes(24).toString('hex');
        const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
        consoleSessions.set(cookieToken, { kind: 'browser', expiresAt: session.expiresAt });
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
          'Set-Cookie': `relaycore_ui=${cookieToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` });
        return response.end(JSON.stringify({ loggedIn: true, expiresAt: new Date(session.expiresAt).toISOString() }));
      }
      const consoleAuthorized = sessionValid(request);
      if (request.method === 'POST' && url.pathname === '/ui/setup') {
        if (!browserSafe) return reply(403, { error: 'Cross-origin console actions are refused' });
        if (!consoleAuthorized) return reply(401, { error: 'Console session required; log in at /ui' });
        const input = await readJsonBody(request);
        const dshExe = String(input?.dshExe ?? '').trim();
        const accountWorkspace = String(input?.accountWorkspace ?? '').trim();
        if (!dshExe || !accountWorkspace) throw new Error('Both the DSH executable path and the account workspace are required');
        await access(dshExe);
        const workspaceInfo = await lstat(accountWorkspace);
        if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) throw new Error('Account workspace must be an existing plain directory');
        const bridgeDir = join(projectRoot, '.RelayCore', 'bridge');
        await mkdir(bridgeDir, { recursive: true });
        const config = { execution: 'account', dshExe, accountWorkspace,
          maxDurationSeconds: Number(input.maxDurationSeconds ?? 600),
          maxModelTurns: Number(input.maxModelTurns ?? 3), savedAt: new Date().toISOString() };
        await writeFile(join(bridgeDir, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx' });
        return reply(200, { saved: true, restart: 'Re-run npm start to enable execution with the saved configuration.' });
      }
      if (request.method === 'GET' && url.pathname === '/ui') {
        if (!consoleAuthorized) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>RelayCore 登录</title>` +
            `<style>body{font-family:system-ui;margin:2rem}#msg{color:#a00}</style><h1>RelayCore 控制台登录</h1>` +
            `<p>在运行 Daemon 的同一用户终端执行 <code>node src/control.mjs ui-session</code> 获取一次性会话令牌，粘贴到这里。` +
            `令牌 8 小时内有效；Daemon 重启后需重新获取。</p>` +
            `<form id="f"><input type="password" id="token" size="60" placeholder="会话令牌" autocomplete="off"> <button>登录</button></form>` +
            `<div id="msg"></div><script>
document.getElementById('f').addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch('/ui/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: document.getElementById('token').value.trim() }) });
  const data = await response.json().catch(() => ({}));
  if (response.ok) location.reload();
  else document.getElementById('msg').textContent = '❌ ' + (data.error ?? '登录失败');
});
          </script>`);
        }
        const tasks = core.list();
        const executionEnabled = Boolean(executor);
        const rows = tasks.map((entry) => {
          let contract = {};
          try { contract = core.get(entry.id).contract; } catch { }
          const risk = contract.riskLevel ?? 'E1';
          const stateActions = {
            DRAFT: `<details><summary>授权…</summary><label><input type="checkbox" data-consent-cost="${entry.id}">同意未知费用（必勾）</label><br>` +
              `<label><input type="checkbox" data-consent-e2="${entry.id}">E2 高危 L3 同意（仅 E2 任务）</label><br>` +
              `<button data-action="authorize" data-id="${entry.id}">确认授权</button></details> ` +
              `<button data-action="dispatch" data-id="${entry.id}">派发</button>` +
              `<button data-action="stop" data-id="${entry.id}">取消</button>`,
            QUEUED: `<button data-action="stop" data-id="${entry.id}">停止</button>`,
            RUNNING: `<button data-action="pause" data-id="${entry.id}">暂停</button>` +
              `<button data-action="stop" data-id="${entry.id}">停止</button>`,
            PAUSED: `<button data-action="resume" data-id="${entry.id}">恢复</button>` +
              `<button data-action="stop" data-id="${entry.id}">取消</button>`,
            RECOVERY_REQUIRED: `<button data-action="pause" data-id="${entry.id}">转人工暂停</button>`,
            COMPLETED: `<button data-action="integrate" data-id="${entry.id}">整合</button> ` +
              `<button data-action="rollback" data-id="${entry.id}">回滚</button>`
          }[entry.state] ?? '';
          return `<tr><td>${entry.id}</td><td>${entry.state}</td><td>${risk}</td>` +
            `<td>${escapeHtml(contract.title ?? '')}</td><td>${escapeHtml(contract.objective ?? '')}</td>` +
            `<td>${stateActions}</td>` +
            `<td><input type="text" placeholder="追加引导" data-guide="${entry.id}" size="18">` +
            `<button data-action="guide" data-id="${entry.id}">引导</button></td></tr>`;
        }).join('');
        const setupWizard = executionEnabled ? '' :
          `<details open><summary>首次设置：连接 DSH 账户执行</summary>` +
          `<p>填写后保存，然后<b>关闭本程序并重新运行 <code>npm start</code></b> 以启用执行。保存的配置不含任何密钥。</p>` +
          `<p>DSH 可执行文件：<input type="text" id="setup-dsh" size="52" value="D:\\DeepSeekHarness\\DeepSeek Harness.exe"><br>` +
          `DSH 账户工作区：<input type="text" id="setup-workspace" size="52" value="D:\\MYCODE\\RCtest"><br>` +
          `<button id="setup-save">保存连接配置</button></p></details>`;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>RelayCore 控制台</title>` +
          `<style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.35rem .6rem;font-size:.85rem}` +
          `button{margin:.1rem}#msg{white-space:pre-wrap;color:#333;margin-top:1rem}details{display:inline-block;vertical-align:top}` +
          `fieldset{margin:1rem 0;border:1px solid #ccc}input[type=text]{margin:.15rem 0}</style>` +
          `<h1>RelayCore 控制台</h1>` +
          `<p>执行状态：<b>${executionEnabled ? '已启用（账户路线）' : '未启用——请在下方完成首次设置'}</b>。` +
          `授权需要逐项确认：消耗模型额度须勾选"同意未知费用"；E2 高危任务另需单独勾选 L3 同意。操作仅限本机。</p>` +
          `${setupWizard}` +
          `${executionEnabled ? `<details><summary>新建任务</summary><fieldset>` +
            `标题：<input type="text" id="new-title" size="40"><br>目标：<input type="text" id="new-objective" size="60"><br>` +
            `验收标准：<input type="text" id="new-acceptance" size="60"><br>` +
            `允许路径（逗号分隔，如 message.txt,src/a.js）：<input type="text" id="new-paths" size="40"><br>` +
            `<button id="create-task">创建草稿</button></fieldset></details>` : ''}` +
          `<table><tr><th>ID</th><th>状态</th><th>风险</th><th>标题</th><th>目标</th><th>操作</th><th>引导</th></tr>${rows}</table>` +
          `<p><button id="refresh">刷新</button> <a href="/usage">用量分账</a></p><div id="msg"></div>` +
          `<script>
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const id = button.dataset.id;
    const action = button.dataset.action;
    const body = { id, action };
    if (action === 'authorize') {
      body.allowUnknownCost = document.querySelector('[data-consent-cost="' + id + '"]').checked;
      body.e2Approved = document.querySelector('[data-consent-e2="' + id + '"]').checked;
    }
    if (action === 'guide') body.text = document.querySelector('[data-guide="' + id + '"]').value;
    const message = document.getElementById('msg');
    try {
      const response = await fetch('/ui/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      message.textContent = (response.ok ? '✅ ' : '❌ ') + id + ' ' + action + ': ' + JSON.stringify(data).slice(0, 400);
      if (response.ok) setTimeout(() => location.reload(), 600);
    } catch (error) { message.textContent = '❌ ' + error.message; }
  });
  document.getElementById('refresh').addEventListener('click', () => location.reload());
  const setupSave = document.getElementById('setup-save');
  if (setupSave) setupSave.addEventListener('click', async () => {
    const message = document.getElementById('msg');
    try {
      const response = await fetch('/ui/setup', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dshExe: document.getElementById('setup-dsh').value.trim(),
          accountWorkspace: document.getElementById('setup-workspace').value.trim() }) });
      const data = await response.json();
      message.textContent = response.ok ? '✅ 已保存。请关闭本程序（Ctrl+C）并重新运行 npm start 以启用执行。'
        : '❌ ' + (data.error ?? '保存失败');
    } catch (error) { message.textContent = '❌ ' + error.message; }
  });
  const createTask = document.getElementById('create-task');
  if (createTask) createTask.addEventListener('click', async () => {
    const message = document.getElementById('msg');
    const body = { action: 'create',
      title: document.getElementById('new-title').value,
      objective: document.getElementById('new-objective').value,
      acceptance: document.getElementById('new-acceptance').value,
      allowedPaths: document.getElementById('new-paths').value.split(',').map((p) => p.trim()).filter(Boolean) };
    try {
      const response = await fetch('/ui/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      message.textContent = response.ok ? '✅ 任务已创建：' + data.id : '❌ ' + (data.error ?? '创建失败');
      if (response.ok) setTimeout(() => location.reload(), 600);
    } catch (error) { message.textContent = '❌ ' + error.message; }
  });
          </script>`);
      }
      // Browser actions must match the validated local origin, fetch metadata,
      // and hold a valid console session.
      if (request.method === 'POST' && url.pathname === '/ui/action') {
        if (!browserSafe) return reply(403, { error: 'Cross-origin console actions are refused' });
        if (!consoleAuthorized) return reply(401, { error: 'Console session required; log in at /ui' });
        const input = await readJsonBody(request);
        const { id, action } = input ?? {};
        if (action !== 'create' && (typeof id !== 'string' || !/^TASK-[0-9a-f-]{36}$/.test(id))) throw new Error('Invalid task ID');
        const dispatchAction = async () => {
          switch (action) {
            case 'create': {
              const title = String(input.title ?? '').trim();
              const objective = String(input.objective ?? '').trim();
              const acceptance = String(input.acceptance ?? '').trim();
              const paths = Array.isArray(input.allowedPaths) ? input.allowedPaths : [];
              return core.create({ title, objective, acceptance, allowedPaths: paths,
                executionLimits: { maxDurationSeconds: 600, maxModelTurns: 3 } });
            }
            case 'authorize': {
              // Separate consents, validated server-side in repair order:
              // the cost consent first, then the E2 L3 consent on top.
              if (input.allowUnknownCost !== true) throw new Error('Unknown execution cost requires explicit consent');
              const task = core.get(id);
              if ((task.contract.riskLevel ?? 'E1') === 'E2' && input.e2Approved !== true) {
                throw new Error('E2 operations require the separate L3 consent checkbox at authorization time');
              }
              return core.authorizeExecution(id, {
                expiresAt: new Date(Date.now() + 3600_000).toISOString(),
                allowUnknownCost: input.allowUnknownCost === true, e2Approved: input.e2Approved === true });
            }
            case 'dispatch': return core.dispatch(id);
            case 'pause': return core.pause(id);
            case 'resume': return core.resume(id);
            case 'stop': return core.stop(id);
            case 'guide': return core.guide(id, input.text);
            case 'rollback': return core.rollbackIntegration(id);
            case 'integrate': {
              // The console picks the latest registered snapshot automatically;
              // an explicit snapshotId from the API still wins.
              const snapshots = core.reviewSnapshots(id);
              const snapshotId = input.snapshotId ?? snapshots.at(-1)?.snapshotId;
              if (!snapshotId) throw new Error('No review snapshot registered for this task');
              return core.integrateWorkspace(id, snapshotId);
            }
            default: throw new Error('Unknown console action');
          }
        };
        try { return reply(200, await dispatchAction()); }
        catch (error) { return reply(400, { error: error.message }); }
      }
      if (request.method === 'GET' && url.pathname === '/usage') {
        if (!consoleAuthorized) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>RelayCore 用量</title>` +
            `<style>body{font-family:system-ui;margin:2rem}</style><h1>用量分账</h1>` +
            `<p>需要<a href="/ui">登录控制台</a>后查看。</p>`);
        }
        const totals = core.usageSummary();
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>RelayCore 用量</title>` +
          `<style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.35rem .6rem;font-size:.85rem}</style>` +
          `<h1>用量分账</h1><p>上下文占用与容量不是单次输入/输出 tokens。— 表示未提供或旧记录口径未确认，不代表零消耗；记录可能不完整，金额以服务账单为准。</p>` +
          `<p><a href="/ui">返回控制台</a></p>` +
          `<table><tr><th>任务</th><th>Agent</th><th>模型</th><th>输入 tokens</th><th>输出 tokens</th><th>上下文占用</th><th>上下文容量</th><th>记录口径</th><th>记录时间</th></tr>` +
          `${totals.entries.map((entry) => `<tr><td>${entry.taskId}</td><td>${entry.agent}</td><td>${escapeHtml(entry.model ?? '默认')}</td>` +
            `<td>${entry.inputTokens ?? '—'}</td><td>${entry.outputTokens ?? '—'}</td><td>${entry.contextTokens ?? '—'}</td>` +
            `<td>${entry.contextCapacity ?? '—'}</td><td>${escapeHtml(entry.usageKind)}</td><td>${entry.recordedAt}</td></tr>`).join('')}</table>`);
      }
      const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
      const expected = Buffer.from(token);
      const authentic = supplied.length === expected.length && timingSafeEqual(supplied, expected);
      if (!authentic || request.headers.origin) return reply(403, { error: 'Forbidden' });
      const parts = url.pathname.split('/').filter(Boolean);
      let input = {};
      if (request.method === 'POST') {
        input = await readJsonBody(request);
      }
      if (request.method === 'GET' && url.pathname === '/tasks') return reply(200, core.list());
      if (request.method === 'GET' && url.pathname === '/inventory') return reply(200, await core.workspaceInventory());
      if (request.method === 'POST' && url.pathname === '/tasks') return reply(201, await core.create(input));
      if (parts[0] === 'tasks' && parts.length >= 2) {
        const id = parts[1];
        if (request.method === 'GET' && parts.length === 2) return reply(200, core.get(id));
        if (request.method === 'GET' && parts[2] === 'events') return reply(200, core.events(id));
        if (request.method === 'GET' && parts[2] === 'inventory') return reply(200, await core.workspaceInventory());
        if (request.method === 'POST' && parts.length === 3) {
          if (parts[2] === 'dispatch') return reply(200, core.dispatch(id));
          if (parts[2] === 'stop') return reply(200, core.stop(id));
          if (parts[2] === 'pause') return reply(200, core.pause(id));
          if (parts[2] === 'resume') return reply(200, core.resume(id));
          if (parts[2] === 'guide') return reply(200, core.guide(id, input.text));
          if (parts[2] === 'authorize') {
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid local execution authorization');
            // The control-token holder is trusted, but an E2 authorization
            // still requires its consent flag to arrive explicitly.
            if ((core.get(id).contract.riskLevel ?? 'E1') === 'E2' && input.e2Approved !== true) {
              throw new Error('E2 operations require the separate --e2-approved consent at authorization time');
            }
            const authorization = { expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...input };
            return reply(200, core.authorizeExecution(id, authorization));
          }
          if (parts[2] === 'integrate') return reply(200, await core.integrateWorkspace(id, input.snapshotId));
          if (parts[2] === 'rollback') return reply(200, await core.rollbackIntegration(id));
          if (parts[2] === 'discard-workspace') return reply(200, await core.discardWorkspace(id));
        }
      }
      return reply(404, { error: 'Not found' });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        reply(error.statusCode ?? (error.message === 'Task not found' ? 404 : 400), { error: error.message });
      } else if (!response.destroyed) response.destroy();
    }
  });
  try {
    await new Promise((done, fail) => { server.once('error', fail); server.listen(listenPort, '127.0.0.1', done); });
  } catch (error) {
    core.close();
    await releaseLock();
    throw error;
  }
  return { server, core, issuePairing, close: async () => {
    await new Promise((done) => server.close(done));
    core.close();
    await releaseLock();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.env.RELAYCORE_ROOT ?? process.cwd();
  await mkdir(join(root, '.RelayCore', 'bridge'), { recursive: true });
  const configPath = join(root, '.RelayCore', 'bridge', 'config.json');
  const config = await readFile(configPath, 'utf8').then((text) => JSON.parse(text), () => ({}));
  const production = productionExecution(root, config);
  const daemon = await startDaemon(root, { executor: production.executor, executionPolicy: production.executionPolicy });
  const actualPort = daemon.server.address().port;
  process.stderr.write(`RelayCore control server on 127.0.0.1:${actualPort}; ${production.note}\n`);
  // One-click sign-in: the printed pairing link is single-use and expires in
  // ten minutes; opening it in the browser lands directly on the console.
  const pairingUrl = `http://127.0.0.1:${actualPort}/ui?pairing=${daemon.issuePairing()}`;
  process.stderr.write(`控制台配对链接（10 分钟内点击有效）: ${pairingUrl}\n`);
  if (!process.env.RELAYCORE_NO_OPEN && process.platform === 'win32') {
    const { exec } = await import('node:child_process');
    exec(`start "" "${pairingUrl}"`, () => {});
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => daemon.close().then(() => process.exit()));
}
