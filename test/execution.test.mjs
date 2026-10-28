import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openCore } from '../src/core.mjs';
import { startDaemon } from '../src/daemon.mjs';

const contract = { title: 'Authorized task', objective: 'Inspect declared data.', acceptance: 'Return a reviewed handoff.',
  executionLimits: { maxDurationSeconds: 10, maxModelTurns: 2 } };
const approval = () => ({ expiresAt: new Date(Date.now() + 60000).toISOString() });

async function withPolicy(action, costMode = 'no-model') {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-execution-test-'));
  const state = { root, calls: 0, core: undefined, policy: { maxDurationSeconds: 30, maxModelTurns: 2, costMode } };
  state.executor = async (task, context, api) => {
    state.calls++;
    assert.equal(api, state.core);
    context.beginModelTurn('dsh');
    context.beginModelTurn('codex');
    return { handoff: '# Local fake execution, not merged' };
  };
  try {
    state.core = await openCore(root, state.executor, state.policy);
    await action(state);
  } finally {
    state.core?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

async function terminal(core, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = core.get(id);
    if (!['QUEUED', 'RUNNING'].includes(task.state)) return task;
    await setTimeout(5);
  }
  throw new Error('Execution did not settle');
}

test('local authorization is consumed with dispatch and persists without replay', async () => {
  await withPolicy(async (state) => {
    const task = await state.core.create(contract);
    assert.throws(() => state.core.dispatch(task.id), /local execution authorization/);
    const grant = state.core.authorizeExecution(task.id, approval());
    assert.equal(grant.costMode, 'no-model');
    assert.equal(grant.allowUnknownCost, false);
    assert.equal(grant.consumedAt, null);
    assert.throws(() => state.core.authorizeExecution(task.id, approval()), /already exists/);
    state.core.dispatch(task.id);
    assert.ok(state.core.get(task.id).executionAuthorization.consumedAt);
    assert.equal((await terminal(state.core, task.id)).state, 'COMPLETED');
    assert.equal(state.calls, 1);
    const events = state.core.events(task.id).map((entry) => entry.kind);
    assert.deepEqual(events.slice(0, 4), ['task.created', 'execution.authorized', 'execution.authorization_consumed', 'task.dispatched']);
    assert.equal(events.filter((kind) => kind === 'model_turn.requested.dsh').length, 1);
    assert.equal(events.filter((kind) => kind === 'model_turn.requested.codex').length, 1);
    state.core.close();
    state.core = undefined;
    state.core = await openCore(state.root, state.executor, state.policy);
    await setTimeout(0);
    assert.equal(state.core.get(task.id).executionAuthorization.id, grant.id);
    assert.equal(state.calls, 1);
    assert.throws(() => state.core.dispatch(task.id), /Cannot dispatch/);
  });
});

test('missing, forged and over-budget approvals cannot dispatch or reserve prompts', async () => {
  await withPolicy(async (state) => {
    const forged = await state.core.create({ ...contract, executionAuthorization: { allowUnknownCost: true } });
    assert.throws(() => state.core.dispatch(forged.id), /local execution authorization/);
    for (const executionLimits of [undefined, { maxDurationSeconds: 31, maxModelTurns: 2 }, { maxDurationSeconds: 10, maxModelTurns: 3 }]) {
      const task = await state.core.create({ ...contract, executionLimits });
      assert.throws(() => state.core.authorizeExecution(task.id, approval()), /policy budget/);
      assert.equal(state.core.get(task.id).state, 'DRAFT');
      assert.deepEqual(state.core.events(task.id).map((entry) => entry.kind), ['task.created']);
    }
    for (const invalid of [{ expiresAt: 'invalid' }, { expiresAt: '2000-01-01' },
      { ...approval(), allowUnknownCost: 'true' }, { ...approval(), extra: true }]) {
      assert.throws(() => state.core.authorizeExecution(forged.id, invalid), /Invalid local/);
    }
    assert.equal(state.calls, 0);
  });
});

test('unknown provider cost is refused unless explicitly accepted by the local host', async () => {
  await withPolicy(async (state) => {
    const task = await state.core.create(contract);
    assert.throws(() => state.core.authorizeExecution(task.id, approval()), /explicit local consent/);
    assert.throws(() => state.core.dispatch(task.id), /local execution authorization/);
    assert.equal(state.calls, 0);
    state.core.authorizeExecution(task.id, { ...approval(), allowUnknownCost: true });
    state.core.dispatch(task.id);
    assert.equal((await terminal(state.core, task.id)).state, 'COMPLETED');
    assert.equal(state.core.get(task.id).executionAuthorization.allowUnknownCost, true);
  }, 'unknown');
});

test('expired grants and changed contracts fail before any executor call', async () => {
  await withPolicy(async (state) => {
    for (const scenario of ['expired', 'changed-contract']) {
      const task = await state.core.create(contract);
      state.core.authorizeExecution(task.id, approval());
      const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
      try {
        if (scenario === 'expired') {
          const row = database.prepare('SELECT authorization FROM execution_grants WHERE task_id=?').get(task.id);
          const authorization = JSON.parse(row.authorization);
          authorization.expiresAt = '2000-01-01T00:00:00.000Z';
          database.prepare('UPDATE execution_grants SET authorization=? WHERE task_id=?').run(JSON.stringify(authorization), task.id);
        } else {
          database.prepare('UPDATE tasks SET contract=? WHERE id=?').run(JSON.stringify({ ...task.contract, objective: 'Changed after approval.' }), task.id);
        }
      } finally { database.close(); }
      assert.throws(() => state.core.dispatch(task.id), scenario === 'expired' ? /expired/ : /does not match/);
      assert.equal(state.core.get(task.id).state, 'DRAFT');
      assert.equal(state.core.get(task.id).executionAuthorization.consumedAt, null);
    }
    assert.equal(state.calls, 0);
  });
});

test('an authorized task still cannot exceed its shared prompt budget', async () => {
  await withPolicy(async (state) => {
    const task = await state.core.create({ ...contract, executionLimits: { maxDurationSeconds: 10, maxModelTurns: 1 } });
    state.core.authorizeExecution(task.id, approval());
    state.core.dispatch(task.id);
    assert.equal((await terminal(state.core, task.id)).state, 'RECOVERY_REQUIRED');
    const events = state.core.events(task.id).map((entry) => entry.kind);
    assert.deepEqual(events.filter((kind) => kind.startsWith('model_turn.requested.')), ['model_turn.requested.dsh']);
    assert.equal(events.includes('task.completed'), false);
  });
});

test('consumed authorization is rechecked before queued work resumes', async () => {
  await withPolicy(async (state) => {
    const task = await state.core.create(contract);
    state.core.authorizeExecution(task.id, approval());
    state.core.dispatch(task.id);
    state.core.close();
    state.core = undefined;
    const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
    try {
      const row = database.prepare('SELECT authorization FROM execution_grants WHERE task_id=?').get(task.id);
      const authorization = JSON.parse(row.authorization);
      authorization.expiresAt = '2000-01-01T00:00:00.000Z';
      database.prepare('UPDATE execution_grants SET authorization=? WHERE task_id=?').run(JSON.stringify(authorization), task.id);
    } finally { database.close(); }
    state.core = await openCore(state.root, state.executor, state.policy);
    assert.equal((await terminal(state.core, task.id)).state, 'RECOVERY_REQUIRED');
    assert.equal(state.calls, 0);
    assert.equal(state.core.events(task.id).some((entry) => entry.kind.startsWith('model_turn.requested.')), false);
  });
});

test('host verification evidence binds the unchanged candidate and rejects failed or interrupted checks', async () => {
  for (const scenario of ['passed', 'failed', 'malformed', 'candidate-changed', 'source-changed', 'cancelled']) {
    await withPolicy(async (state) => {
      await writeFile(join(state.root, 'message.txt'), 'pending\n');
      const task = await state.core.create({ ...contract, allowedPaths: ['message.txt'] });
      const candidate = await state.core.prepareWorkspace(task.id);
      await writeFile(join(candidate.workspace, 'message.txt'), 'ready\n');
      const controller = new AbortController();
      const verifyCandidate = async ({ files, signal }) => {
        assert.equal(signal, controller.signal);
        assert.equal(files[0].after, 'ready\n');
        files[0].after = 'This must not mutate the review packet.';
        if (scenario === 'candidate-changed') await writeFile(join(candidate.workspace, 'message.txt'), 'changed\n');
        if (scenario === 'source-changed') await writeFile(join(state.root, 'message.txt'), 'changed\n');
        if (scenario === 'cancelled') controller.abort(new Error('Verification cancelled'));
        return { checker: 'exact-message', checks: [{ name: 'Exact candidate text', passed: scenario === 'malformed' ? 'true' : scenario !== 'failed' }] };
      };
      const pending = state.core.prepareReviewWorkspace(task.id, { verifyCandidate, signal: controller.signal });
      if (scenario === 'passed') {
        const artifact = await pending;
        const packet = JSON.parse(await readFile(artifact.inputPath, 'utf8'));
        assert.equal(packet.files[0].after, 'ready\n');
        assert.equal(packet.testEvidence.origin, 'relaycore-host');
        assert.equal(packet.testEvidence.checks[0].passed, true);
      } else {
        await assert.rejects(pending, /verification failed|changed during verification|conflict during verification|Verification cancelled/, scenario);
      }
      assert.equal(state.calls, 0);
    });
  }
});

test('daemon executor injection requires a policy while the normal entry remains disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-daemon-policy-'));
  let daemon;
  try {
    await assert.rejects(startDaemon(root, { executor: async () => {}, port: 0 }), /explicit execution policy/);
    daemon = await startDaemon(root, { port: 0 });
    assert.ok(daemon.server.address().port > 0);
    const task = await daemon.core.create(contract);
    assert.throws(() => daemon.core.authorizeExecution(task.id, approval()), /unavailable/);
    assert.throws(() => daemon.core.dispatch(task.id), /disabled/);
  } finally {
    await daemon?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
