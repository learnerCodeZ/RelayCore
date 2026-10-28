import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openCore } from './core.mjs';
import { getControlToken } from './auth.mjs';
import { runDshReviewTask } from './dsh.mjs';

const port = Number(process.env.RELAYCORE_PORT ?? 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RELAYCORE_PORT');

// Production execution stays disabled unless the operator explicitly opts in
// through the environment: RELAYCORE_EXECUTION=account wires the DSH account
// route behind the same authorization, budget and recovery gates the
// diagnostics use. Any other value keeps external execution disabled.
export function productionExecution(root) {
  if (process.env.RELAYCORE_EXECUTION !== 'account') return { executor: null, executionPolicy: undefined, note: 'external execution disabled' };
  const executable = process.env.RELAYCORE_DSH_EXE?.trim();
  if (!executable) throw new Error('RELAYCORE_EXECUTION=account requires RELAYCORE_DSH_EXE');
  const workspace = process.env.RELAYCORE_ACCOUNT_WORKSPACE?.trim();
  if (!workspace) throw new Error('RELAYCORE_EXECUTION=account requires RELAYCORE_ACCOUNT_WORKSPACE');
  const accountHome = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE ?? '', '.dsh');
  const executionLimits = {
    maxDurationSeconds: Number(process.env.RELAYCORE_MAX_DURATION ?? 600),
    maxModelTurns: Number(process.env.RELAYCORE_MAX_TURNS ?? 2)
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
    const url = new URL(request.url, 'http://127.0.0.1');
    // When the OS picked the port, only the Host header knows the real one.
    const localOrigin = `http://${request.headers.host ?? `127.0.0.1:${listenPort}`}`;
    const sameOrigin = (request.headers.origin ?? '') === '' || request.headers.origin === localOrigin;
    const fetchSite = request.headers['sec-fetch-site'];
    const browserSafe = sameOrigin && (fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none');
    // The read-only task view needs no token: the daemon only listens on the
    // loopback interface and the page carries no data beyond the task list.
    if (request.method === 'GET' && url.pathname === '/ui') {
      const tasks = core.list();
      const rows = tasks.map((entry) => {
        let contract = {};
        try { contract = core.get(entry.id).contract; } catch { }
        const risk = contract.riskLevel ?? 'E1';
        const stateActions = {
          DRAFT: `<button data-action="authorize" data-id="${entry.id}">授权</button>` +
            `<button data-action="dispatch" data-id="${entry.id}">派发</button>` +
            `<button data-action="stop" data-id="${entry.id}">取消</button>`,
          QUEUED: `<button data-action="stop" data-id="${entry.id}">停止</button>`,
          RUNNING: `<button data-action="pause" data-id="${entry.id}">暂停</button>` +
            `<button data-action="stop" data-id="${entry.id}">停止</button>`,
          PAUSED: `<button data-action="resume" data-id="${entry.id}">恢复</button>` +
            `<button data-action="stop" data-id="${entry.id}">取消</button>`,
          RECOVERY_REQUIRED: `<button data-action="pause" data-id="${entry.id}">转人工暂停</button>`,
          COMPLETED: `<button data-action="rollback" data-id="${entry.id}">回滚整合</button>`
        }[entry.state] ?? '';
        return `<tr><td>${entry.id}</td><td>${entry.state}</td><td>${risk}</td>` +
          `<td>${escapeHtml(contract.title ?? '')}</td><td>${escapeHtml(contract.objective ?? '')}</td>` +
          `<td>${stateActions}</td>` +
          `<td><input type="text" placeholder="追加引导" data-guide="${entry.id}" size="18">` +
          `<button data-action="guide" data-id="${entry.id}">引导</button></td></tr>`;
      }).join('');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>RelayCore 控制台</title>` +
        `<style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.35rem .6rem;font-size:.85rem}` +
        `button{margin:.1rem}#msg{white-space:pre-wrap;color:#333;margin-top:1rem}</style>` +
        `<h1>RelayCore 控制台</h1>` +
        `<p>授权与派发代表同意消耗模型额度；授权默认接受未知费用（E2 任务同时视为 L3 同意）。操作仅限本机。</p>` +
        `<table><tr><th>ID</th><th>状态</th><th>风险</th><th>标题</th><th>目标</th><th>操作</th><th>引导</th></tr>${rows}</table>` +
        `<p><button id="refresh">刷新</button> <a href="/usage">用量分账</a></p><div id="msg"></div>` +
        `<script>
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  const body = { id, action };
  if (action === 'authorize') body.allowUnknownCost = true, body.e2Approved = true;
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
        </script>`);
    }
    // Console actions are form posts from the locally served page: they carry
    // no bearer token, so cross-site requests must be structurally impossible.
    if (request.method === 'POST' && url.pathname === '/ui/action') {
      if (!browserSafe) return reply(403, { error: 'Cross-origin console actions are refused' });
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 32768) throw new Error('Request too large');
      }
      const input = body ? JSON.parse(body) : {};
      const { id, action } = input ?? {};
      if (typeof id !== 'string' || !/^TASK-[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid task ID');
      const dispatchAction = async () => {
        switch (action) {
          case 'authorize': return core.authorizeExecution(id, {
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            allowUnknownCost: input.allowUnknownCost === true, e2Approved: input.e2Approved === true });
          case 'dispatch': return core.dispatch(id);
          case 'pause': return core.pause(id);
          case 'resume': return core.resume(id);
          case 'stop': return core.stop(id);
          case 'guide': return core.guide(id, input.text);
          case 'rollback': return core.rollbackIntegration(id);
          default: throw new Error('Unknown console action');
        }
      };
      try { return reply(200, await dispatchAction()); }
      catch (error) { return reply(400, { error: error.message }); }
    }
    if (request.method === 'GET' && url.pathname === '/usage') {
      const totals = core.usageSummary();
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>RelayCore 用量</title>` +
        `<style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.35rem .6rem;font-size:.85rem}</style>` +
        `<h1>用量分账</h1><p>DSH 的 context 列为上下文窗口占用（1M 窗口），不是费用；金额以服务账单为准。</p>` +
        `<p><a href="/ui">返回控制台</a></p>` +
        `<table><tr><th>任务</th><th>Agent</th><th>模型</th><th>输入 tokens</th><th>输出 tokens</th><th>上下文占用</th><th>记录时间</th></tr>` +
        `${totals.entries.map((entry) => `<tr><td>${entry.taskId}</td><td>${entry.agent}</td><td>${escapeHtml(entry.model ?? '默认')}</td>` +
          `<td>${entry.inputTokens}</td><td>${entry.outputTokens}</td><td>${entry.contextTokens ?? '—'}</td><td>${entry.recordedAt}</td></tr>`).join('')}</table>`);
    }
    const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
    const expected = Buffer.from(token);
    const authentic = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (!authentic || request.headers.origin) return reply(403, { error: 'Forbidden' });
    try {
      const parts = url.pathname.split('/').filter(Boolean);
      let input = {};
      if (request.method === 'POST') {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 32768) throw new Error('Request too large');
        }
        input = body ? JSON.parse(body) : {};
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
      reply(error.message === 'Task not found' ? 404 : 400, { error: error.message });
    }
  });
  try {
    await new Promise((done, fail) => { server.once('error', fail); server.listen(listenPort, '127.0.0.1', done); });
  } catch (error) {
    core.close();
    await releaseLock();
    throw error;
  }
  return { server, core, close: async () => {
    await new Promise((done) => server.close(done));
    core.close();
    await releaseLock();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.env.RELAYCORE_ROOT ?? process.cwd();
  const production = productionExecution(root);
  const daemon = await startDaemon(root, { executor: production.executor, executionPolicy: production.executionPolicy });
  process.stderr.write(`RelayCore control server on 127.0.0.1:${port}; ${production.note}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => daemon.close().then(() => process.exit()));
}
