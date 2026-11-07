import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startDaemon } from '../src/daemon.mjs';

const contract = { title: 'Console task', objective: 'Change pending to ready.', acceptance: 'Exact ready newline.',
  allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 20, maxModelTurns: 3 } };
const e2Contract = { ...contract, title: 'E2 console task', riskLevel: 'E2' };

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
    await action(state);
  } finally {
    await state.daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
}

const bearerHeaders = async (state) => ({ authorization: `Bearer ${await readToken(state.root)}`, 'content-type': 'application/json' });

async function readToken(root) {
  const { getControlToken } = await import('../src/auth.mjs');
  return getControlToken(root, { create: false });
}

async function loggedInCookie(state) {
  const { getControlToken } = await import('../src/auth.mjs');
  const token = await getControlToken(state.root, { create: false });
  const session = await fetch(`http://127.0.0.1:${state.port}/ui/session`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal(session.status, 200);
  const { sessionToken } = await session.json();
  const login = await fetch(`http://127.0.0.1:${state.port}/ui/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: sessionToken }) });
  assert.equal(login.status, 200);
  return /relaycore_ui=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
}
const requestSession = async (state) => {
  const response = await fetch(`http://127.0.0.1:${state.port}/ui/session`, {
    method: 'POST', headers: await bearerHeaders(state) });
  assert.equal(response.status, 200);
  return (await response.json()).sessionToken;
};

const login = async (state, sessionToken) => fetch(`http://127.0.0.1:${state.port}/ui/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: sessionToken }) });

const consoleAction = async (state, cookie, body, headers = {}) => fetch(`http://127.0.0.1:${state.port}/ui/action`, {
  method: 'POST', headers: { 'content-type': 'application/json',
    ...(cookie ? { cookie: `relaycore_ui=${cookie}` } : {}), ...headers }, body: JSON.stringify(body) });

test('the console requires a session issued to the control-token holder', async () => {
  await withConsole(async (state) => {
    const task = await state.daemon.core.create(contract);
    // Unauthenticated visitors see a login form, never task content.
    const anonymous = await fetch(`http://127.0.0.1:${state.port}/ui`);
    assert.equal(anonymous.status, 200);
    const anonymousHtml = await anonymous.text();
    assert.ok(anonymousHtml.includes('控制台登录') && !anonymousHtml.includes(task.id));
    const usagePage = await fetch(`http://127.0.0.1:${state.port}/usage`);
    assert.equal((await usagePage.text()).includes(task.id), false);
    const anonymousAction = await consoleAction(state, null, { id: task.id, action: 'dispatch' });
    assert.equal(anonymousAction.status, 401);
    // The session endpoint itself requires the control token.
    const noToken = await fetch(`http://127.0.0.1:${state.port}/ui/session`, { method: 'POST' });
    assert.equal(noToken.status, 403);
    // Login with a wrong token is refused.
    const badLogin = await login(state, randomBytes(24).toString('hex'));
    assert.equal(badLogin.status, 401);    // A real session works end to end.
    const sessionToken = await requestSession(state);
    const pendingAction = await consoleAction(state, sessionToken, { id: task.id, action: 'authorize', allowUnknownCost: true });
    assert.equal(pendingAction.status, 401);
    const pendingPage = await fetch(`http://127.0.0.1:${state.port}/ui`, { headers: { cookie: `relaycore_ui=${sessionToken}` } });
    assert.equal((await pendingPage.text()).includes(task.id), false);
    const loginResponse = await login(state, sessionToken);
    assert.equal(loginResponse.status, 200);
    const setCookie = loginResponse.headers.get('set-cookie');
    assert.match(setCookie, /relaycore_ui=/);
    assert.match(setCookie, /HttpOnly/);
    const cookie = /relaycore_ui=([^;]+)/.exec(setCookie)[1];
    assert.equal((await login(state, cookie)).status, 401);
    const authenticated = await fetch(`http://127.0.0.1:${state.port}/ui`, { headers: { cookie: `relaycore_ui=${cookie}` } });
    assert.equal((await authenticated.text()).includes(task.id), true);
    // Login consumes the one-time session token.
    const replayed = await login(state, sessionToken);
    assert.equal(replayed.status, 401);
    // Same-origin, authenticated action succeeds.
    const ok = await consoleAction(state, cookie, { id: task.id, action: 'authorize', allowUnknownCost: true, e2Approved: true },
      { origin: `http://127.0.0.1:${state.port}`, 'sec-fetch-site': 'same-origin' });
    assert.equal(ok.status, 200);
    // Cross-site stays refused even with a valid session.
    const cross = await consoleAction(state, cookie, { id: task.id, action: 'dispatch' },
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(cross.status, 403);
  });
});

test('a console session does not survive a daemon restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-console-restart-'));
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    const first = await startDaemon(root, { port: 0, executor: async () => ({ handoff: 'run' }),
      executionPolicy: { maxDurationSeconds: 30, maxModelTurns: 3, costMode: 'unknown' } });
    const port = first.server.address().port;
    const sessionToken = await requestSession({ daemon: first, root, port });
    await first.close();
    // A restart invalidates every issued session (sessions live in memory).
    const second = await startDaemon(root, { port: 0, executor: async () => ({ handoff: 'run' }),
      executionPolicy: { maxDurationSeconds: 30, maxModelTurns: 3, costMode: 'unknown' } });
    try {
      const secondPort = second.server.address().port;
      const login = await fetch(`http://127.0.0.1:${secondPort}/ui/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: sessionToken }) });
      assert.equal(login.status, 401);
    } finally { await second.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('console authorization validates the two consents separately, server-side', async () => {
  await withConsole(async (state) => {
    const cookie = await loggedInCookie(state);
    const task = await state.daemon.core.create({ ...contract, riskLevel: 'E2' });
    // No cost consent: core refuses the authorization outright.
    const withoutCost = await consoleAction(state, cookie, { id: task.id, action: 'authorize' });
    assert.equal(withoutCost.status, 400);
    assert.match((await withoutCost.json()).error, /Unknown execution cost/);
    assert.equal(state.daemon.core.get(task.id).executionAuthorization, undefined);
    // Cost consent alone is still not enough for an E2 task.
    const withoutE2 = await consoleAction(state, cookie, { id: task.id, action: 'authorize', allowUnknownCost: true });
    assert.equal(withoutE2.status, 400);
    assert.match((await withoutE2.json()).error, /separate L3 consent/);
    assert.equal(state.daemon.core.get(task.id).executionAuthorization, undefined);
    // Both consents together succeed and persist the granted flags.
    const granted = await consoleAction(state, cookie, { id: task.id, action: 'authorize',
      allowUnknownCost: true, e2Approved: true });
    assert.equal(granted.status, 200);
    const grant = state.daemon.core.get(task.id).executionAuthorization;
    assert.equal(grant.allowUnknownCost, true);
    assert.equal(grant.e2Approved, true);
  });
});

test('an E1 task authorizes with the cost consent alone', async () => {
  await withConsole(async (state) => {
    const cookie = await loggedInCookie(state);
    const task = await state.daemon.core.create(contract);
    const granted = await consoleAction(state, cookie, { id: task.id, action: 'authorize', allowUnknownCost: true });
    assert.equal(granted.status, 200);
    assert.equal(state.daemon.core.get(task.id).executionAuthorization.e2Approved, false);
  });
});
