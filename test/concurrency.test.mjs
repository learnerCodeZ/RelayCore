import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { openCore } from '../src/core.mjs';

const contract = { title: 'Concurrency', objective: 'Work once.', acceptance: 'Single execution.',
  allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 20, maxModelTurns: 2 } };

async function withCore(action, executor) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-concurrency-test-'));
  const state = { root };
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    state.core = await openCore(root, executor ?? null, executor
      ? { maxDurationSeconds: 40, maxModelTurns: 2, costMode: 'unknown' } : undefined);
    await action(state);
  } finally {
    state.core?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

test('concurrent workspace preparations produce exactly one registered site', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    const attempts = await Promise.allSettled([
      state.core.prepareWorkspace(task.id), state.core.prepareWorkspace(task.id),
      state.core.prepareWorkspace(task.id)
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, 'exactly one preparation may win');
    assert.equal(fulfilled[0].value.registered, true);
    const inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.registered.map(({ taskId }) => taskId), [task.id]);
    assert.deepEqual(inventory.leftoverTemp, []);
    assert.deepEqual(inventory.unregistered, []);
    assert.deepEqual(await readdir(join(state.root, '.RelayCore', 'workspaces')), [task.id]);
    assert.equal((await state.core.verifyWorkspace(task.id)).matchesBaseline, true);
    const events = state.core.events(task.id).filter((event) => event.kind === 'workspace.prepared').length;
    assert.equal(events, 1);
  });
});

test('queued tasks execute strictly one at a time', async () => {
  const runs = [];
  let concurrent = 0;
  let peak = 0;
  await withCore(async (state) => {
    const ids = [];
    for (let index = 0; index < 3; index++) {
      const task = await state.core.create({ ...contract, title: `Task ${index}`, objective: `Run ${index}.` });
      state.core.authorizeExecution(task.id, { expiresAt: new Date(Date.now() + 60000).toISOString(), allowUnknownCost: true });
      ids.push(task.id);
    }
    for (const id of ids) state.core.dispatch(id);
    for (let attempt = 0; attempt < 800 && ids.some((id) => ['QUEUED', 'RUNNING'].includes(state.core.get(id).state)); attempt++) {
      await setTimeout(10);
    }
    for (const id of ids) assert.equal(state.core.get(id).state, 'COMPLETED');
    assert.equal(peak, 1, 'the serial queue never runs two executors at once');
    assert.deepEqual(runs, ids);
  }, async (task) => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    runs.push(task.id);
    await setTimeout(40);
    concurrent--;
    return { handoff: `done ${task.contract.title}` };
  });
});

test('pausing against a finishing task lands in exactly one consistent terminal state', async () => {
  for (let round = 0; round < 12; round++) {
    const root = await mkdtemp(join(tmpdir(), 'relaycore-pause-race-'));
    try {
      await writeFile(join(root, 'message.txt'), 'pending\n');
      let finish;
      const gate = new Promise((done) => { finish = done; });
      const core = await openCore(root, async () => {
        await gate;
        return { handoff: 'raced completion' };
      }, { maxDurationSeconds: 30, maxModelTurns: 2, costMode: 'unknown' });
      try {
        const task = await core.create(contract);
        core.authorizeExecution(task.id, { expiresAt: new Date(Date.now() + 30000).toISOString(), allowUnknownCost: true });
        core.dispatch(task.id);
        for (let attempt = 0; attempt < 400 && core.get(task.id).state !== 'RUNNING'; attempt++) await setTimeout(5);
        // Fire both transitions concurrently; SQLite serializes them.
        const pauseAttempt = Promise.resolve().then(() => {
          try { core.pause(task.id); return 'paused'; }
          catch (error) { return error.message; }
        });
        finish();
        const pauseOutcome = await pauseAttempt;
        for (let attempt = 0; attempt < 400 && ['QUEUED', 'RUNNING'].includes(core.get(task.id).state); attempt++) await setTimeout(5);
        const finalState = core.get(task.id).state;
        assert.ok(['COMPLETED', 'PAUSED'].includes(finalState), `round ${round}: ${finalState}`);
        if (finalState === 'PAUSED') {
          assert.equal(pauseOutcome, 'paused');
          assert.equal(core.events(task.id).filter((event) => event.kind === 'task.paused').length, 1);
          assert.equal(core.events(task.id).filter((event) => event.kind === 'task.completed').length, 0);
          const handoff = await lstat(join(root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md')).then(() => true, () => false);
          assert.equal(handoff, false, 'a paused race must not keep a completed handoff');
        } else {
          assert.equal(core.events(task.id).filter((event) => event.kind === 'task.completed').length, 1);
          assert.equal(core.events(task.id).filter((event) => event.kind === 'task.paused').length, 0);
        }
      } finally { core.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
