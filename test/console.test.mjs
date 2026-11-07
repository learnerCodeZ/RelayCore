import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { request } from 'node:http';
import { startDaemon } from '../src/daemon.mjs';

const contract = { title: 'Console task', objective: 'Change pending to ready.', acceptance: 'Exact ready newline.',
  allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 20, maxModelTurns: 3 } };

async function withConsole(action) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-console-test-'));
  const state = { root };
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    state.daemon = await startDaemon(root, { port: 0,
      executor: async (task, context) => { context.beginModelTurn('dsh');
        return { handoff: `console run ${task.contract.revision}` }; },
      executionPolicy: { maxDurationSeconds: 30, maxModelTurns: 3, costMode: 'unknown' } });
    state.port = state.daemon.server.address().port;
    // Console actions and pages require a session issued to the control-token
    // holder; every test below logs in once through the real flow.
    const { getControlToken } = await import('../src/auth.mjs');
    const token = await getControlToken(state.root, { create: false });
    const session = await fetch(`http://127.0.0.1:${state.port}/ui/session`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(session.status, 200);
    const { sessionToken } = await session.json();
    const login = await fetch(`http://127.0.0.1:${state.port}/ui/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: sessionToken }) });
    assert.equal(login.status, 200);
    state.cookie = `relaycore_ui=${/relaycore_ui=([^;]+)/.exec(login.headers.get('set-cookie'))[1]}`;
    await action(state);
  } finally {
    await state.daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
}

const consoleAction = (state, body, headers = {}) => fetch(`http://127.0.0.1:${state.port}/ui/action`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: state.cookie, ...headers },
  body: JSON.stringify(body)
});

test('the console page drives authorize, dispatch, integration rollback and guidance', async () => {
  await withConsole(async (state) => {
    const created = await fetch(`http://127.0.0.1:${state.port}/tasks`, { method: 'POST',
      headers: { authorization: `Bearer ${await readToken(state.root)}`, 'content-type': 'application/json' },
      body: JSON.stringify(contract) });
    const task = await created.json();
    const authorize = await consoleAction(state, { id: task.id, action: 'authorize', allowUnknownCost: true, e2Approved: true });
    assert.equal(authorize.status, 200);
    const guided = await consoleAction(state, { id: task.id, action: 'guide', text: 'console guidance' });
    assert.equal(guided.status, 200);
    const dispatched = await consoleAction(state, { id: task.id, action: 'dispatch' });
    assert.equal(dispatched.status, 200);
    for (let attempt = 0; attempt < 300 && ['QUEUED', 'RUNNING'].includes(state.daemon.core.get(task.id).state); attempt++) {
      await setTimeout(10);
    }
    assert.equal(state.daemon.core.get(task.id).state, 'COMPLETED');
    assert.equal((await state.daemon.core.consumeGuidance(task.id)).includes('console guidance'), true);
    const usagePage = await fetch(`http://127.0.0.1:${state.port}/usage`, { headers: { cookie: state.cookie } });
    assert.equal(usagePage.status, 200);
  });
});

test('console actions refuse cross-site requests structurally', async () => {
  await withConsole(async (state) => {
    const task = await state.daemon.core.create(contract);
    const crossOrigin = await consoleAction(state, { id: task.id, action: 'authorize', allowUnknownCost: true },
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(crossOrigin.status, 403);
    const crossSiteFetch = await consoleAction(state, { id: task.id, action: 'authorize', allowUnknownCost: true },
      { 'sec-fetch-site': 'cross-site' });
    assert.equal(crossSiteFetch.status, 403);
    const sameOrigin = await consoleAction(state, { id: task.id, action: 'authorize', allowUnknownCost: true, e2Approved: true },
      { origin: `http://127.0.0.1:${state.port}`, 'sec-fetch-site': 'same-origin' });
    assert.equal(sameOrigin.status, 200);
    assert.equal(state.daemon.core.get(task.id).executionAuthorization.allowUnknownCost, true);
    const unknownAction = await consoleAction(state, { id: task.id, action: 'detonate' },
      { 'sec-fetch-site': 'same-origin' });
    assert.equal(unknownAction.status, 400);
  });
});

test('console-created tasks use the active policy defaults and can be authorized', async () => {
  await withConsole(async (state) => {
    const response = await consoleAction(state, { ...contract, executionLimits: undefined, action: 'create' });
    assert.equal(response.status, 200);
    const task = await response.json();
    assert.deepEqual(task.contract.executionLimits, { maxDurationSeconds: 30, maxModelTurns: 3 });
    assert.equal((await consoleAction(state, { id: task.id, action: 'authorize', allowUnknownCost: true })).status, 200);
    const explicit = await consoleAction(state, { ...contract, action: 'create',
      executionLimits: { maxDurationSeconds: 12, maxModelTurns: 1 } });
    assert.equal(explicit.status, 200);
    assert.deepEqual((await explicit.json()).contract.executionLimits, { maxDurationSeconds: 12, maxModelTurns: 1 });
  });
});

test('missing limits can be repaired in a new draft without inheriting execution consent', async () => {
  await withConsole(async (state) => {
    const parent = await state.daemon.core.create({ ...contract, riskLevel: 'E2', executionLimits: undefined });
    const missing = await consoleAction(state, { id: parent.id, action: 'authorize', allowUnknownCost: true, e2Approved: true });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /Declare executionLimits/);
    for (const executionLimits of [null, { maxDurationSeconds: 0, maxModelTurns: 1 },
      { maxDurationSeconds: 31, maxModelTurns: 1 }, { maxDurationSeconds: 10, maxModelTurns: 4 }]) {
      const invalid = await consoleAction(state, { id: parent.id, action: 'limits', expectedRevision: 1, executionLimits });
      assert.equal(invalid.status, 400);
      assert.equal(state.daemon.core.list().length, 1);
    }
    const limits = { maxDurationSeconds: 10, maxModelTurns: 2 };
    const saved = await consoleAction(state, { id: parent.id, action: 'limits', expectedRevision: 1, executionLimits: limits });
    assert.equal(saved.status, 200);
    const task = await saved.json();
    assert.notEqual(task.id, parent.id);
    assert.equal(task.state, 'DRAFT');
    assert.deepEqual(task.contract, { ...parent.contract, executionLimits: limits, revision: 2 });
    assert.equal(task.executionAuthorization, undefined);
    assert.equal(state.daemon.core.get(parent.id).contract.executionLimits, null);
    const oldGrant = await consoleAction(state, { id: parent.id, action: 'authorize', allowUnknownCost: true, e2Approved: true });
    assert.equal(oldGrant.status, 400);
    assert.match((await oldGrant.json()).error, /newer revision/);
    assert.equal((await consoleAction(state, { id: task.id, action: 'dispatch' })).status, 400);
    assert.equal((await consoleAction(state, { id: task.id, action: 'authorize' })).status, 400);
    assert.equal((await consoleAction(state, { id: task.id, action: 'authorize', allowUnknownCost: true })).status, 400);
    assert.equal(state.daemon.core.get(task.id).executionAuthorization, undefined);
    const page = await fetch(`http://127.0.0.1:${state.port}/ui`, { headers: { cookie: state.cookie } });
    const html = await page.text();
    assert.ok(html.includes(`data-limit-seconds="${task.id}"`));
    assert.ok(html.includes(`data-limit-turns="${task.id}"`));
    assert.ok(!html.includes(`data-action="authorize" data-id="${parent.id}"`));
    assert.match(html, /执行策略上限：30 秒 \/ 3 轮/);
    const { Script } = await import('node:vm');
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script);
    assert.equal((await consoleAction(state, { id: task.id, action: 'authorize', allowUnknownCost: true, e2Approved: true })).status, 200);
  });
});

async function readToken(root) {
  const { getControlToken } = await import('../src/auth.mjs');
  return getControlToken(root, { create: false });
}

test('malformed and oversized requests return errors without stopping the daemon', async () => {
  await withConsole(async (state) => {
    const url = `http://127.0.0.1:${state.port}`;
    for (const [body, status] of [['{', 400], ['null', 400], ['{"id":"invalid"}', 400],
      [JSON.stringify({ text: '中'.repeat(12000) }), 413]]) {
      const response = await fetch(`${url}/ui/action`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: state.cookie }, body
      });
      assert.equal(response.status, status);
      assert.equal(typeof (await response.json()).error, 'string');
      assert.equal((await fetch(`${url}/ui`, { headers: { cookie: state.cookie } })).status, 200);
    }
    const rejected = await fetch(`${url}/tasks`, {
      method: 'POST', headers: { authorization: `Bearer ${await readToken(state.root)}` },
      body: JSON.stringify({ text: '中'.repeat(12000) })
    });
    assert.equal(rejected.status, 413);
    assert.equal((await fetch(`${url}/ui`, { headers: { cookie: state.cookie } })).status, 200);
  });
});

test('untrusted Host cannot read pages or authorize even with a matching Origin', async () => {
  await withConsole(async (state) => {
    const task = await state.daemon.core.create(contract);
    const send = (host, path, body) => new Promise((done, fail) => {
      const pending = request({ hostname: '127.0.0.1', port: state.port, path,
        method: body ? 'POST' : 'GET', headers: { host, origin: `http://${host}`,
          'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie: state.cookie } }, (response) => {
        response.resume();
        response.on('end', () => done(response.statusCode));
      });
      pending.on('error', fail);
      pending.end(body ? JSON.stringify(body) : undefined);
    });
    const approval = { id: task.id, action: 'authorize', allowUnknownCost: true };
    for (const host of [`audit.example:${state.port}`, `localhost:${state.port + 1}`, `127.0.0.1.evil:${state.port}`]) {
      for (const path of ['/ui', '/usage', '/tasks']) assert.equal(await send(host, path), 403);
      assert.equal(await send(host, '/ui/action', approval), 403);
    }
    assert.equal(state.daemon.core.get(task.id).executionAuthorization, undefined);
    assert.equal(await send(`localhost:${state.port}`, '/ui'), 200);
    assert.equal(await send(`localhost:${state.port}`, '/ui/action', approval), 200);
  });
});
