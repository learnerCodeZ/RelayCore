// No real models are called. All task/source mutations are isolated in temp directories.
// Run: node workflow-repro.mjs D:\MYCODE\RelayCore
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repository = resolve(process.argv[2] ?? 'D:/MYCODE/RelayCore');
const { openCore } = await import(pathToFileURL(join(repository, 'src/core.mjs')).href);
const { productionExecution } = await import(pathToFileURL(join(repository, 'src/daemon.mjs')).href);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const contract = { title: 'Isolated release audit', objective: 'Change the selected files.',
  acceptance: 'Use the proposed replacement contents.', allowedPaths: ['message.txt'] };

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-release-audit-'));
  const state = { root };
  try { return await action(state); }
  finally {
    state.core?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function completedCandidate(state, replacements) {
  const task = await state.core.create({ ...contract, allowedPaths: Object.keys(replacements) });
  const candidate = await state.core.prepareWorkspace(task.id);
  for (const [path, contents] of Object.entries(replacements)) await writeFile(join(candidate.workspace, path), contents);
  const snapshot = await state.core.prepareReviewWorkspace(task.id);
  await writeFile(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md'), 'Audit fixture: reviewed proposal.\n');
  // Same completion fixture method used by test/integration.test.mjs; bypass models only.
  const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
  try { database.prepare("UPDATE tasks SET state='COMPLETED' WHERE id=?").run(task.id); }
  finally { database.close(); }
  return { task, snapshot };
}

async function concurrentIntegration() {
  let reproduced = 0;
  let first;
  for (let iteration = 0; iteration < 12; iteration++) await fixture(async (state) => {
    await writeFile(join(state.root, 'message.txt'), 'pending\n');
    state.core = await openCore(state.root);
    const candidates = [];
    for (const after of ['one\n', 'two\n']) candidates.push(await completedCandidate(state, { 'message.txt': after }));
    const results = await Promise.allSettled(candidates.map(({ task, snapshot }) =>
      state.core.integrateWorkspace(task.id, snapshot.snapshotId)));
    if (results.every((result) => result.status === 'fulfilled')) {
      reproduced++;
      first ??= { iteration, final: await readFile(join(state.root, 'message.txt'), 'utf8'),
        completedEvents: candidates.map(({ task }) => state.core.events(task.id).filter((event) => event.kind === 'integration.completed').length) };
    }
  });
  return { name: 'Concurrent integration silently overwrites another completed integration', reproduced, iterations: 12, first };
}

async function interruptedRollbackDiskState() {
  return fixture(async (state) => {
    await writeFile(join(state.root, 'a.txt'), 'before-a');
    await writeFile(join(state.root, 'b.txt'), 'before-b');
    state.core = await openCore(state.root);
    const { task, snapshot } = await completedCandidate(state, { 'a.txt': 'after-a', 'b.txt': 'after-b' });
    await state.core.integrateWorkspace(task.id, snapshot.snapshotId);
    // Simulate the exact disk/journal state after rollback's first write but before
    // its second write and final journal commit. This is not an actual power-cut test.
    await writeFile(join(state.root, 'a.txt'), 'before-a');
    state.core.close();
    state.core = await openCore(state.root);
    let rollbackError;
    try { await state.core.rollbackIntegration(task.id); }
    catch (error) { rollbackError = error.message; }
    return { name: 'Interrupted rollback disk-state simulation', stateAfterRestart: state.core.get(task.id).state,
      files: [await readFile(join(state.root, 'a.txt'), 'utf8'), await readFile(join(state.root, 'b.txt'), 'utf8')], rollbackError };
  });
}

async function productionResumeAfterProposal() {
  return fixture(async (state) => {
    await writeFile(join(state.root, 'message.txt'), 'pending\n');
    const executionLimits = { maxDurationSeconds: 60, maxModelTurns: 3 };
    state.core = await openCore(state.root, async (task, context, core) => {
      await core.prepareWorkspace(task.id);
      context.beginModelTurn('dsh'); // Reservation only; no model or executable is started.
      await core.applyWorkspaceProposal(task.id, [{ path: 'message.txt', contents: 'ready\n' }], context.signal);
      core.pause(task.id);
      return { handoff: 'Interrupted after proposal.' };
    }, { ...executionLimits, costMode: 'unknown' });
    const task = await state.core.create({ ...contract, executionLimits });
    state.core.authorizeExecution(task.id, { expiresAt: new Date(Date.now() + 60000).toISOString(), allowUnknownCost: true });
    state.core.dispatch(task.id);
    for (let attempt = 0; attempt < 200 && state.core.get(task.id).state !== 'PAUSED'; attempt++) await sleep(10);
    await sleep(20);
    const pausedState = state.core.get(task.id).state;
    assert.equal(pausedState, 'PAUSED');
    state.core.close();
    const production = productionExecution(state.root, { execution: 'account', dshExe: 'D:/fake/not-started.exe',
      accountWorkspace: state.root, ...executionLimits });
    state.core = await openCore(state.root, production.executor, production.executionPolicy);
    state.core.resume(task.id);
    for (let attempt = 0; attempt < 200 && ['QUEUED', 'RUNNING'].includes(state.core.get(task.id).state); attempt++) await sleep(10);
    return { name: 'Production resume after an applied proposal', pausedState, afterResume: state.core.get(task.id).state,
      eventKinds: state.core.events(task.id).map((event) => event.kind),
      note: 'Production execution fails at verifyWorkspace before any real model or child executable.' };
  });
}

for (const reproduce of [concurrentIntegration, interruptedRollbackDiskState, productionResumeAfterProposal]) {
  console.log(JSON.stringify(await reproduce(), null, 2));
}
