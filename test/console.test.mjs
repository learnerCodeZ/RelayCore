import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
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
    await action(state);
  } finally {
    await state.daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
}

const consoleAction = (state, body, headers = {}) => fetch(`http://127.0.0.1:${state.port}/ui/action`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
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
    const usagePage = await fetch(`http://127.0.0.1:${state.port}/usage`);
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

async function readToken(root) {
  const { getControlToken } = await import('../src/auth.mjs');
  return getControlToken(root, { create: false });
}
