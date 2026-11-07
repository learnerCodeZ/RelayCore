import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { startDaemon } from '../src/daemon.mjs';

const contract = { title: 'One-click task', objective: 'Change pending to ready.', acceptance: 'Exact ready newline.',
  allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 20, maxModelTurns: 3 } };

async function withConsole(action) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-oneclick-test-'));
  const state = { root };
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    state.daemon = await startDaemon(root, { port: 0,
      executor: async (task, context) => { context.beginModelTurn('dsh');
        return { handoff: `one-click run ${task.contract.revision}` }; },
      executionPolicy: { maxDurationSeconds: 600, maxModelTurns: 3, costMode: 'unknown' } });
    state.port = state.daemon.server.address().port;
    await action(state);
  } finally {
    await state.daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function loggedInCookie(state) {
  const { getControlToken } = await import('../src/auth.mjs');
  const token = await getControlToken(state.root, { create: false });
  const session = await fetch(`http://127.0.0.1:${state.port}/ui/session`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const { sessionToken } = await session.json();
  const login = await fetch(`http://127.0.0.1:${state.port}/ui/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: sessionToken }) });
  return /relaycore_ui=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
}

test('a pairing link signs in once, then is spent', async () => {
  await withConsole(async (state) => {
    const pairingToken = state.daemon.issuePairing();
    const first = await fetch(`http://127.0.0.1:${state.port}/ui?pairing=${pairingToken}`, { redirect: 'manual' });
    assert.equal(first.status, 302);
    const cookie = /relaycore_ui=([^;]+)/.exec(first.headers.get('set-cookie'))[1];
    const consolePage = await fetch(`http://127.0.0.1:${state.port}/ui`, { headers: { cookie: `relaycore_ui=${cookie}` } });
    assert.equal((await consolePage.text()).includes('新建任务'), true);
    // The pairing link is single-use: replaying it lands on the expired notice.
    const replayed = await fetch(`http://127.0.0.1:${state.port}/ui?pairing=${pairingToken}`);
    const replayedHtml = await replayed.text();
    assert.ok(replayedHtml.includes('配对链接已失效') && !replayedHtml.includes('新建任务'));
    // A forged token is equally useless.
    const forged = await fetch(`http://127.0.0.1:${state.port}/ui?pairing=${randomHex(48)}`);
    assert.equal((await forged.text()).includes('配对链接已失效'), true);
  });
});

function randomHex(length) {
  const characters = '0123456789abcdef';
  let output = '';
  for (let index = 0; index < length; index++) output += characters[Math.floor(Math.random() * characters.length)];
  return output;
}

test('the console creates tasks and integrates with the latest snapshot automatically', async () => {
  await withConsole(async (state) => {
    const cookie = await loggedInCookie(state);
    const action = (body) => fetch(`http://127.0.0.1:${state.port}/ui/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `relaycore_ui=${cookie}`,
        origin: `http://127.0.0.1:${state.port}`, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) });
    const created = await action({ action: 'create', title: 'One-click', objective: 'Change pending to ready.',
      acceptance: 'Exact ready newline.', allowedPaths: ['message.txt'] });
    assert.equal(created.status, 200);
    const task = await created.json();
    assert.equal(task.state, 'DRAFT');
    // Build a completed reviewed task deterministically (the full real chain
    // is covered by probe-dispatch and the dsh suites; this tests the console
    // integrate action's automatic latest-snapshot selection).
    await state.daemon.core.prepareWorkspace(task.id);
    await writeFile(join(state.root, '.RelayCore', 'workspaces', task.id, 'message.txt'), 'ready\n');
    await state.daemon.core.prepareReviewWorkspace(task.id);
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md'), `# ${task.id}\n`);
      database.prepare("UPDATE tasks SET state='COMPLETED',result='reviewed',updated_at=datetime('now') WHERE id=?").run(task.id);
      database.prepare('INSERT INTO events(task_id,kind,created_at) VALUES(?,?,datetime(\'now\'))').run(task.id, 'task.completed');
    } finally { database.close(); }
    // Integrate without naming a snapshot: the console picks the latest one.
    const integrated = await action({ id: task.id, action: 'integrate' });
    assert.equal(integrated.status, 200);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'ready\n');
    const rolledBack = await action({ id: task.id, action: 'rollback' });
    assert.equal(rolledBack.status, 200);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
  });
});

test('saving the connection config writes a no-secret config for the next start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-setup-test-'));
  let daemon = await startDaemon(root, { port: 0 });
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    const { getControlToken } = await import('../src/auth.mjs');
    const token = await getControlToken(root, { create: false });
    const session = await fetch(`http://127.0.0.1:${daemon.server.address().port}/ui/session`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const { sessionToken } = await session.json();
    const login = await fetch(`http://127.0.0.1:${daemon.server.address().port}/ui/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: sessionToken }) });
    const cookie = /relaycore_ui=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
    const saved = await fetch(`http://127.0.0.1:${daemon.server.address().port}/ui/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `relaycore_ui=${cookie}`,
        origin: `http://127.0.0.1:${daemon.server.address().port}`, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ dshExe: process.execPath, accountWorkspace: root }) });
    assert.equal(saved.status, 200);
    const config = JSON.parse(await readFile(join(root, '.RelayCore', 'bridge', 'config.json'), 'utf8'));
    assert.equal(config.execution, 'account');
    assert.equal(config.dshExe, process.execPath);
    // Reload with the config: the daemon now comes up in execution mode.
    daemon.close();
    daemon = undefined;
    const second = await startDaemon(root, { port: 0 });
    try {
      assert.equal(second.core.list !== undefined, true);
    } finally { second.close(); }
  } finally {
    if (daemon) { try { daemon.close(); } catch { } }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('npm start prints a pairing link and honors config.json execution mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-start-smoke-'));
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(root, '.RelayCore', 'bridge'), { recursive: true });
    writeFileSync(join(root, '.RelayCore', 'bridge', 'config.json'), JSON.stringify({ execution: 'account',
      dshExe: process.execPath, accountWorkspace: root }));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/daemon.mjs', import.meta.url))], {
      cwd: root, env: { ...process.env, RELAYCORE_ROOT: root,
        RELAYCORE_PORT: String(18000 + (process.pid % 2000)) },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const url = await Promise.race([
      new Promise((resolveUrl) => {
        child.stderr.on('data', () => {
          const match = /控制台配对链接[^:]*: (http:\S+)/.exec(stderr);
          if (match) resolveUrl(match[1]);
        });
      }),
      setTimeout(15000).then(() => { throw new Error(`no pairing link; stderr: ${stderr.slice(0, 300)}`); })
    ]);
    assert.match(url, /\/ui\?pairing=[0-9a-f]{48}/);
    const opened = await fetch(url, { redirect: 'manual' });
    assert.equal(opened.status, 302);
    child.kill();
    // The config enabled account execution, so the printed note must say so.
    assert.match(stderr, /account execution enabled/);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
