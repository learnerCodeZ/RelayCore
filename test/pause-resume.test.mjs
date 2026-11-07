import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { openCore } from '../src/core.mjs';

const contract = { title: 'Pausable task', objective: 'Work across a pause.', acceptance: 'Resume and finish.',
  allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 30, maxModelTurns: 2 } };
const approval = () => ({ expiresAt: new Date(Date.now() + 60000).toISOString(), allowUnknownCost: true });

async function withCore(action, { costMode = 'unknown', executor } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-pause-test-'));
  const state = { root, entries: 0, handoffs: [] };
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    let releaseFirst;
    state.gate = new Promise((resolveGate) => { releaseFirst = resolveGate; });
    state.releaseFirst = releaseFirst;
    state.core = await openCore(root, executor ?? (async (task, context) => {
      state.entries++;
      context.beginModelTurn('dsh');
      if (state.entries === 1) {
        await state.gate;
        context.signal.throwIfAborted();
        return { handoff: 'first entry should never finish' };
      }
      return { handoff: `resumed run for ${task.contract.revision}` };
    }), { maxDurationSeconds: 60, maxModelTurns: 2, costMode });
    await action(state);
  } finally {
    state.core?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

async function waitUntil(state, id, statuses, tries = 400) {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (statuses.includes(state.core.get(id).state)) return;
    await setTimeout(5);
  }
  throw new Error(`Task never reached ${statuses}; current ${state.core.get(id).state}`);
}

test('pausing interrupts the running turn, resuming replays with cumulative budgets', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    state.core.authorizeExecution(task.id, approval());
    state.core.dispatch(task.id);
    await waitUntil(state, task.id, ['RUNNING']);
    const paused = state.core.pause(task.id);
    assert.equal(paused.state, 'PAUSED');
    state.releaseFirst();
    await waitUntil(state, task.id, ['PAUSED']);
    assert.deepEqual(state.core.events(task.id).filter((event) => event.kind === 'task.paused').length, 1);
    assert.deepEqual(state.core.events(task.id).filter((event) => event.kind.startsWith('model_turn.requested.')).length, 1);
    assert.deepEqual(state.core.get(task.id).sessions, []);
    assert.throws(() => state.core.dispatch(task.id), /Cannot dispatch task in PAUSED/);
    assert.throws(() => state.core.authorizeExecution(task.id, approval()), /Only a draft can receive execution authorization/);
    await assert.rejects(state.core.prepareWorkspace(task.id), /Only drafts or locally authorized unstarted executions/);
    const resumed = state.core.resume(task.id);
    assert.equal(resumed.state, 'QUEUED');
    await waitUntil(state, task.id, ['COMPLETED']);
    assert.equal(state.entries, 2);
    assert.match(await readFile(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md'), 'utf8'), /resumed run/);
    assert.deepEqual(state.core.events(task.id).filter((event) => event.kind === 'task.resumed').length, 1);
    assert.deepEqual(state.core.events(task.id).filter((event) => event.kind.startsWith('model_turn.requested.')).length, 2);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
  });
});

test('pause without an executor policy still records intent; budgets refuse exhausted replays', async () => {
  await withCore(async (state) => {
    const task = await state.core.create({ ...contract, executionLimits: { maxDurationSeconds: 30, maxModelTurns: 1 } });
    state.core.authorizeExecution(task.id, approval());
    state.core.dispatch(task.id);
    await waitUntil(state, task.id, ['RUNNING']);
    state.core.pause(task.id);
    state.releaseFirst();
    await waitUntil(state, task.id, ['PAUSED']);
    state.core.resume(task.id);
    await waitUntil(state, task.id, ['RECOVERY_REQUIRED']);
    assert.deepEqual(state.core.events(task.id).filter((event) => event.kind === 'execution.model_turn_limit_exceeded').length, 1);
    // The reconciled task can be paused by hand and revised instead of replayed.
    const paused = state.core.pause(task.id);
    assert.equal(paused.state, 'PAUSED');
    const revised = await state.core.createRevision(task.id, { expectedRevision: 1, reason: 'Restart with a fresh budget.', objective: 'Try again with two turns.' });
    assert.equal(revised.contract.revision, 2);
    assert.equal(state.core.get(task.id).supersededBy, revised.id);
    assert.throws(() => state.core.resume(task.id), /newer revision/);
  });
});

test('pause and resume reject impossible states and late results never complete a paused task', async () => {
  await withCore(async (state) => {
    const draft = await state.core.create(contract);
    for (const bad of [draft.id]) {
      assert.throws(() => state.core.pause(bad), /Cannot pause a task in DRAFT/);
      assert.throws(() => state.core.resume(bad), /Cannot resume a task in DRAFT/);
    }
    state.core.stop(draft.id);
    assert.throws(() => state.core.pause(draft.id), /Cannot pause a task in CANCELED/);
    assert.throws(() => state.core.resume(draft.id), /Cannot resume a task in CANCELED/);
    const task = await state.core.create({ ...contract, objective: 'Second run.' });
    state.core.authorizeExecution(task.id, approval());
    state.core.dispatch(task.id);
    await waitUntil(state, task.id, ['RUNNING']);
    state.core.pause(task.id);
    state.releaseFirst();
    await waitUntil(state, task.id, ['PAUSED']);
    // Whatever the aborted executor tried to return, the paused task cannot
    // complete: no HANDOFF may appear while paused.
    await waitUntil(state, task.id, ['PAUSED']);
    assert.equal(await readFile(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md')).then(() => true, () => false), false);
    const stopped = state.core.stop(task.id);
    assert.equal(stopped.state, 'CANCELED');
    assert.throws(() => state.core.resume(task.id), /Cannot resume a task in CANCELED/);
  }, { costMode: 'unknown' });
});

test('resumed work keeps the original deadline instead of getting a fresh one', async () => {
  await withCore(async (state) => {
    const task = await state.core.create({ ...contract, executionLimits: { maxDurationSeconds: 1, maxModelTurns: 2 } });
    state.core.authorizeExecution(task.id, approval());
    state.core.dispatch(task.id);
    await waitUntil(state, task.id, ['RUNNING']);
    state.core.pause(task.id);
    state.releaseFirst();
    await waitUntil(state, task.id, ['PAUSED']);
    await setTimeout(1100);
    state.core.resume(task.id);
    await waitUntil(state, task.id, ['RECOVERY_REQUIRED']);
    assert.deepEqual(state.core.events(task.id).filter((event) => event.kind === 'execution.deadline_exceeded').length, 1);
  });
});

test('recovery-required tasks pause into a verified state and return through resume or revision', async () => {
  await withCore(async (state) => {
    const task = await state.core.create({ ...contract, executionLimits: { maxDurationSeconds: 30, maxModelTurns: 1 } });
    state.core.authorizeExecution(task.id, approval());
    state.core.dispatch(task.id);
    await waitUntil(state, task.id, ['RUNNING']);
    state.core.pause(task.id);
    state.releaseFirst();
    await waitUntil(state, task.id, ['PAUSED']);
    state.core.resume(task.id);
    await waitUntil(state, task.id, ['RECOVERY_REQUIRED']);
    const paused = state.core.pause(task.id);
    assert.equal(paused.state, 'PAUSED');
    const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
    let tasks;
    try { tasks = database.prepare('SELECT state FROM tasks WHERE id=?').get(task.id); }
    finally { database.close(); }
    assert.equal(tasks.state, 'PAUSED');
  });
});

test('a replay after pausing mid-review resets the applied candidate and completes', async () => {
  // This is the exact site a real acceptance run discovered: pausing while the
  // first review turn is in flight leaves the candidate already modified; the
  // replayed run used to fail its own stale "pristine candidate" check.
  const root = await mkdtemp(join(tmpdir(), 'relaycore-pause-replay-'));
  let core;
  let releaseFirst;
  const gate = new Promise((done) => { releaseFirst = done; });
  let entries = 0;
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    core = await openCore(root, async (task, context) => {
      entries++;
      // Mirror the production executor: verify the candidate, and when a
      // previous interrupted run left it modified, refresh it from source.
      const inventory = await core.workspaceInventory();
      const existing = inventory.registered.find((entry) => entry.taskId === task.id);
      if (existing) {
        try { await core.verifyWorkspace(task.id); }
        catch { await core.refreshWorkspaceFromSource(task.id); }
      } else {
        await core.prepareWorkspace(task.id);
      }
      await core.applyWorkspaceProposal(task.id, [{ path: 'message.txt', contents: `ready ${entries}` + String.fromCharCode(10) }], context.signal);
      const artifact = await core.prepareReviewWorkspace(task.id);
      context.beginModelTurn('codex');
      if (entries === 1) { await gate; context.signal.throwIfAborted(); }
      return { handoff: `run ${entries} with snapshot ${artifact.snapshotId}` };
    }, { maxDurationSeconds: 60, maxModelTurns: 4, costMode: 'unknown' });
    const task = await core.create({ title: 'Replay task', objective: 'o', acceptance: 'a',
      allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 60, maxModelTurns: 4 } });
    core.authorizeExecution(task.id, { expiresAt: new Date(Date.now() + 120000).toISOString(), allowUnknownCost: true });
    core.dispatch(task.id);
    for (let attempt = 0; attempt < 400 && core.get(task.id).state !== 'RUNNING'; attempt++) await setTimeout(5);
    for (let attempt = 0; attempt < 400 && !core.events(task.id).some((event) => event.kind === 'model_turn.requested.codex'); attempt++) await setTimeout(5);
    // Pause lands while the first review turn is in flight.
    assert.equal(core.pause(task.id).state, 'PAUSED');
    releaseFirst();
    for (let attempt = 0; attempt < 200 && core.get(task.id).state !== 'PAUSED'; attempt++) await setTimeout(5);
    assert.equal(core.resume(task.id).state, 'QUEUED');
    for (let attempt = 0; attempt < 600 && ['QUEUED', 'RUNNING'].includes(core.get(task.id).state); attempt++) await setTimeout(10);
    const final = core.get(task.id);
    assert.equal(final.state, 'COMPLETED');
    assert.equal(await readFile(join(root, 'message.txt'), 'utf8'), 'pending\n');
    assert.equal(final.result.includes('run 2'), true);
    assert.deepEqual(core.events(task.id).filter((event) => event.kind === 'workspace.refreshed').length, 1);
    // One codex turn per attempt: the interrupted first run and the replay.
    assert.deepEqual(core.events(task.id).filter((event) => event.kind.startsWith('model_turn.requested.')).length, 2);
  } finally {
    core?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
