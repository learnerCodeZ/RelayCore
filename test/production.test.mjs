import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { productionExecution, startDaemon } from '../src/daemon.mjs';
import { runDshReviewTask } from '../src/dsh.mjs';
import { openMcpClient } from '../src/mcp-client.mjs';

const original = { ...process.env };
const runFile = promisify(execFile);
const restoreEnv = () => {
  for (const name of Object.keys(process.env)) {
    if (!(name in original)) delete process.env[name];
    else process.env[name] = original[name];
  }
};

const contract = { title: 'Production wiring', objective: 'Change pending to ready.', acceptance: 'Exact ready newline.',
  allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 20, maxModelTurns: 2 } };

test('production execution stays disabled by default and requires full account configuration', () => {
  delete process.env.RELAYCORE_EXECUTION;
  const disabled = productionExecution('/somewhere');
  assert.equal(disabled.executor, null);
  assert.match(disabled.note, /disabled/);
  process.env.RELAYCORE_EXECUTION = 'account';
  assert.throws(() => productionExecution('/somewhere'), /RELAYCORE_DSH_EXE/);
  process.env.RELAYCORE_DSH_EXE = 'D:/DeepSeekHarness/DeepSeek Harness.exe';
  assert.throws(() => productionExecution('/somewhere'), /RELAYCORE_ACCOUNT_WORKSPACE/);
  process.env.RELAYCORE_ACCOUNT_WORKSPACE = 'D:/MYCODE/RCtest';
  const enabled = productionExecution('/somewhere');
  assert.equal(typeof enabled.executor, 'function');
  assert.equal(enabled.executionPolicy.costMode, 'unknown');
  assert.match(enabled.note, /account execution enabled/);
  process.env.RELAYCORE_MAX_TURNS = '0';
  assert.throws(() => productionExecution('/somewhere'), /require positive integers/);
  restoreEnv();
});

test('production execution rechecks an existing workspace instead of preparing it again', async () => {
  try {
    process.env.RELAYCORE_EXECUTION = 'account';
    process.env.RELAYCORE_DSH_EXE = 'D:/DeepSeekHarness/DeepSeek Harness.exe';
    process.env.RELAYCORE_ACCOUNT_WORKSPACE = 'D:/MYCODE/RCtest';
    const execution = productionExecution('/somewhere');
    const calls = [];
    const task = { id: 'TASK-resume-test' };
    const core = {
      async workspaceInventory() { calls.push('inventory'); return { registered: [{ taskId: task.id, kind: 'copy', present: true }] }; },
      async prepareWorkspace() { calls.push('prepare'); throw new Error('unexpected preparation'); },
      async verifyWorkspace() { calls.push('verify'); throw new Error('verification checkpoint'); }
    };
    await assert.rejects(execution.executor(task, { signal: new AbortController().signal }, core), /verification checkpoint/);
    assert.deepEqual(calls, ['inventory', 'verify']);
  } finally { restoreEnv(); }
});

test('production execution refuses changed source before starting a model', async () => {
  try {
    process.env.RELAYCORE_EXECUTION = 'account';
    process.env.RELAYCORE_DSH_EXE = 'D:/DeepSeekHarness/DeepSeek Harness.exe';
    process.env.RELAYCORE_ACCOUNT_WORKSPACE = 'D:/MYCODE/RCtest';
    const execution = productionExecution('/somewhere');
    const calls = [];
    const task = { id: 'TASK-source-test' };
    const core = {
      async workspaceInventory() { calls.push('inventory'); return { registered: [] }; },
      async prepareWorkspace() { calls.push('prepare'); },
      async inspectSourceConflicts() { calls.push('source'); return { matchesBaseline: false }; }
    };
    await assert.rejects(execution.executor(task, { signal: new AbortController().signal }, core), /Source changed before execution/);
    assert.deepEqual(calls, ['inventory', 'prepare', 'source']);
  } finally { restoreEnv(); }
});

async function withProductionDaemon(action, { executor } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-production-test-'));
  const state = { root };
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    state.core = await startDaemon(root, { port: 0, executor: executor ?? (async (task, context) => {
      context.beginModelTurn('dsh');
      return { handoff: `completed for ${task.contract.revision}` };
    }), executionPolicy: { maxDurationSeconds: 20, maxModelTurns: 2, costMode: 'unknown' } });
    await action(state);
  } finally {
    await state.core?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('the production daemon HTTP surface exposes authorize, pause, resume, integrate and rollback', async () => {
  await withProductionDaemon(async (state) => {
    const core = state.core.core;
    // Drive through the HTTP endpoints exactly as the control CLI would.
    const call = async (method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${state.core.server.address().port}${path}`, {
        method, headers: { authorization: `Bearer ${await readToken(state.root)}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      return { status: response.status, body: await response.json() };
    };
    const created = await call('POST', '/tasks', contract);
    assert.equal(created.status, 201);
    const unauthorized = await call('POST', `/tasks/${created.body.id}/dispatch`);
    assert.equal(unauthorized.status, 400);
    assert.match(unauthorized.body.error, /local execution authorization/);
    const implicitCost = await call('POST', `/tasks/${created.body.id}/authorize`, {});
    assert.equal(implicitCost.status, 400);
    assert.match(implicitCost.body.error, /Unknown execution cost requires explicit local consent/);
    const authorized = await call('POST', `/tasks/${created.body.id}/authorize`, { allowUnknownCost: true });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.body.costMode, 'unknown');
    const dispatched = await call('POST', `/tasks/${created.body.id}/dispatch`);
    assert.equal(dispatched.body.state, 'QUEUED');
    for (let attempt = 0; attempt < 200 && ['QUEUED', 'RUNNING'].includes(core.get(created.body.id).state); attempt++) await setTimeout(5);
    assert.equal(core.get(created.body.id).state, 'COMPLETED');
    const inventory = await call('GET', '/inventory');
    assert.equal(inventory.status, 200);
    assert.equal(inventory.body.registered.length, 0, 'the minimal fake executor prepares no workspace');
    const paused = await call('POST', `/tasks/${created.body.id}/pause`);
    assert.equal(paused.status, 400);
    assert.match(paused.body.error, /Cannot pause a task in COMPLETED/);
  });
});

test('the control CLI requires explicit consent for unknown execution cost', async () => {
  try {
    process.env.RELAYCORE_TOKEN = 'relaycore-production-test-token-only';
    await withProductionDaemon(async (state) => {
      const task = await state.core.core.create(contract);
      const script = fileURLToPath(new URL('../src/control.mjs', import.meta.url));
      const env = { ...process.env, RELAYCORE_ROOT: state.root, RELAYCORE_PORT: String(state.core.server.address().port) };
      await assert.rejects(runFile(process.execPath, [script, 'authorize', task.id, '30'], { env, timeout: 5000, windowsHide: true }),
        /Unknown execution cost requires explicit local consent/);
      const result = await runFile(process.execPath, [script, 'authorize', task.id, '30', '--allow-unknown-cost'],
        { env, timeout: 5000, windowsHide: true });
      assert.equal(JSON.parse(result.stdout).allowUnknownCost, true);
    });
  } finally { restoreEnv(); }
});

test('MCP dispatch and control CLI integrate and roll back an isolated reviewed task', async () => {
  try {
    process.env.RELAYCORE_TOKEN = 'relaycore-production-test-token-only';
    const executor = async (task, context, core) => {
      await core.prepareWorkspace(task.id);
      return runDshReviewTask({ core, task, context, executable: 'unused', authHome: 'unused' }, {
        async propose({ context }) {
          context.beginModelTurn('dsh');
          context.recordSession('dsh', 'fake-dsh-session');
          return { sessionId: 'fake-dsh-session', summary: 'Prepare the candidate.', files: [{ path: 'message.txt', contents: 'ready\n' }] };
        },
        async review({ review, context }) {
          context.beginModelTurn('codex');
          context.recordSession('codex', 'fake-review-session');
          return { sessionId: 'fake-review-session', verdict: 'approved', packetSha256: review.sha256, rationale: 'Fake approval for isolated testing.' };
        }
      });
    };
    await withProductionDaemon(async (state) => {
      const port = state.core.server.address().port;
      const client = openMcpClient({ root: state.root, port, token: process.env.RELAYCORE_TOKEN });
      try {
        await client.rpc('initialize', { protocolVersion: '2025-11-25' });
        const task = await client.tool('create_task', contract);
        await assert.rejects(client.tool('dispatch_task', { id: task.id }), /local execution authorization/);
        const script = fileURLToPath(new URL('../src/control.mjs', import.meta.url));
        const env = { ...process.env, RELAYCORE_ROOT: state.root, RELAYCORE_PORT: String(port) };
        const runControl = (...args) => runFile(process.execPath, [script, ...args], { env, timeout: 5000, windowsHide: true });
        await runControl('authorize', task.id, '20', '--allow-unknown-cost');
        assert.equal((await client.tool('dispatch_task', { id: task.id })).state, 'QUEUED');
        let status;
        for (let attempt = 0; attempt < 200; attempt++) {
          status = await client.tool('task_status', { id: task.id });
          if (!['QUEUED', 'RUNNING'].includes(status.state)) break;
          await setTimeout(10);
        }
        assert.equal(status.state, 'COMPLETED');
        assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
        const snapshots = state.core.core.reviewSnapshots(task.id);
        assert.equal(snapshots.length, 1);
        await runControl('integrate', task.id, snapshots[0].snapshotId);
        assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'ready\n');
        await runControl('rollback', task.id);
        assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
        const events = await client.tool('task_events', { id: task.id });
        assert.equal(events.filter((entry) => entry.kind.startsWith('model_turn.requested.')).length, 2);
      } finally { await client.close(); }
    }, { executor });
  } finally { restoreEnv(); }
});

test('the read-only task view is reachable without a token and escapes task text', async () => {
  await withProductionDaemon(async (state) => {
    await state.core.core.create({ ...contract, title: '<script>alert(1)</script>', objective: 'objective' });
    const response = await fetch(`http://127.0.0.1:${state.core.server.address().port}/ui`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('&lt;script&gt;'));
    assert.equal(html.includes('<script>alert(1)</script>'), false);
  });
});

test('an unconfigured production daemon keeps external execution disabled', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-default-daemon-'));
  try {
    const script = fileURLToPath(new URL('../src/daemon.mjs', import.meta.url));
    const spawned = spawnSync(process.execPath, [script], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
      env: { ...process.env, RELAYCORE_ROOT: root },
      input: ''
    });
    assert.match(spawned.stderr, /external execution disabled/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function readToken(root) {
  const { getControlToken } = await import('../src/auth.mjs');
  return getControlToken(root, { create: false });
}
