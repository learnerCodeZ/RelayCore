import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCore } from '../src/core.mjs';

const contract = { title: 'Integrable task', objective: 'Change pending to ready.', acceptance: 'Exact ready newline.',
  allowedPaths: ['message.txt'] };

// Build a task that looks exactly like a finished reviewed loop: candidate
// changed, review snapshot registered, HANDOFF written, state COMPLETED. The
// completion path itself is covered by test/dsh.test.mjs with fake adapters;
// here the integration and rollback machinery is what is under test.
async function completedTask(state, { objective = contract.objective, candidate = 'ready\n', additionalFile = false } = {}) {
  if (additionalFile) await writeFile(join(state.root, 'second.txt'), 'second pending\n');
  const task = await state.core.create({ ...contract, objective,
    ...(additionalFile ? { allowedPaths: ['message.txt', 'second.txt'] } : {}) });
  const prepared = await state.core.prepareWorkspace(task.id);
  await writeFile(join(prepared.workspace, 'message.txt'), candidate);
  if (additionalFile) await writeFile(join(prepared.workspace, 'second.txt'), 'second ready\n');
  const snapshot = await state.core.prepareReviewWorkspace(task.id);
  state.core.close();
  state.core = undefined;
  const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
  try {
    writeFileSync(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md'), `# ${task.id}\n\nReviewed and not merged.\n`);
    database.prepare("UPDATE tasks SET state='COMPLETED',result=?,updated_at=datetime('now') WHERE id=?").run('reviewed', task.id);
    database.prepare('INSERT INTO events(task_id,kind,created_at) VALUES(?,?,datetime(\'now\'))').run(task.id, 'task.completed');
  } finally { database.close(); }
  state.core = await openCore(state.root);
  return { task, snapshot };
}

async function withCore(action) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-integration-test-'));
  const state = { root };
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    state.core = await openCore(root);
    await action(state);
  } finally {
    state.core?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

test('a completed reviewed task integrates its reviewed candidate into the source', async () => {
  await withCore(async (state) => {
    const { task, snapshot } = await completedTask(state);
    const integration = await state.core.integrateWorkspace(task.id, snapshot.snapshotId);
    assert.equal(integration.integrated, true);
    assert.deepEqual(integration.files, ['message.txt']);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'ready\n');
    const manifest = JSON.parse(await readFile(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'PRE-INTEGRATION', 'manifest.json'), 'utf8'));
    assert.equal(manifest.snapshotId, snapshot.snapshotId);
    assert.deepEqual(state.core.events(task.id).filter((event) => event.kind === 'integration.completed').length, 1);
    await assert.rejects(state.core.integrateWorkspace(task.id, snapshot.snapshotId), /already integrated/);
    // A second review snapshot is not required for rollback; the manifest carries the evidence.
    const rollback = await state.core.rollbackIntegration(task.id);
    assert.deepEqual(rollback.files, ['message.txt']);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
    assert.deepEqual(state.core.events(task.id).filter((event) => event.kind === 'integration.rolled_back').length, 1);
    await assert.rejects(state.core.rollbackIntegration(task.id), /already rolled back/);
  });
});

test('multiple reviewed files integrate and roll back together', async () => {
  await withCore(async (state) => {
    const { task, snapshot } = await completedTask(state, { additionalFile: true });
    const integration = await state.core.integrateWorkspace(task.id, snapshot.snapshotId);
    assert.deepEqual(integration.files, ['message.txt', 'second.txt']);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'ready\n');
    assert.equal(await readFile(join(state.root, 'second.txt'), 'utf8'), 'second ready\n');
    const rollback = await state.core.rollbackIntegration(task.id);
    assert.deepEqual(rollback.files, ['message.txt', 'second.txt']);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
    assert.equal(await readFile(join(state.root, 'second.txt'), 'utf8'), 'second pending\n');
  });
});

test('integration is refused for unreconciled tasks, drifted sources, drifted candidates and wrong snapshots', async () => {
  await withCore(async (state) => {
    const { task, snapshot } = await completedTask(state);
    // Non-completed states cannot integrate.
    const draft = await state.core.create({ ...contract, objective: 'A draft.' });
    await assert.rejects(state.core.integrateWorkspace(draft.id, 'whatever'), /Only a completed task can integrate/);
    // A wrong snapshot id is rejected by the registration check.
    await assert.rejects(state.core.integrateWorkspace(task.id, `${task.id}-nosuch`), /not registered/);
    // Source drift after the review snapshot blocks integration.
    await writeFile(join(state.root, 'message.txt'), 'pending-edited\n');
    await assert.rejects(state.core.integrateWorkspace(task.id, snapshot.snapshotId), /Source conflict after review snapshot/);
    await writeFile(join(state.root, 'message.txt'), 'pending\n');
    // Candidate drift after the review snapshot blocks integration.
    await writeFile(join(state.root, '.RelayCore', 'workspaces', task.id, 'message.txt'), 'tampered\n');
    await assert.rejects(state.core.integrateWorkspace(task.id, snapshot.snapshotId), /Candidate changed after review snapshot/);
    await writeFile(join(state.root, '.RelayCore', 'workspaces', task.id, 'message.txt'), 'ready\n');
    const integration = await state.core.integrateWorkspace(task.id, snapshot.snapshotId);
    assert.equal(integration.integrated, true);
  });
});

test('a failed backup stage never touches the source', async () => {
  await withCore(async (state) => {
    const { task, snapshot } = await completedTask(state);
    // Pre-occupy the backup directory path with a plain file so the backup
    // stage fails before any source write.
    await writeFile(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'PRE-INTEGRATION'), 'occupied');
    await assert.rejects(state.core.integrateWorkspace(task.id, snapshot.snapshotId), /backups failed; no source file was modified/);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
    assert.equal(await readFile(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'PRE-INTEGRATION'), 'utf8'), 'occupied');
    assert.deepEqual(state.core.events(task.id).filter((event) => event.kind.startsWith('integration.')), []);
    // Clean the obstruction and integrate normally afterwards.
    await rm(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'PRE-INTEGRATION'), { force: true });
    await state.core.integrateWorkspace(task.id, snapshot.snapshotId);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'ready\n');
  });
});

test('rollback refuses to overwrite new work that came after the integration', async () => {
  await withCore(async (state) => {
    const { task, snapshot } = await completedTask(state);
    await state.core.integrateWorkspace(task.id, snapshot.snapshotId);
    await writeFile(join(state.root, 'message.txt'), 'ready-plus-human-edit\n');
    await assert.rejects(state.core.rollbackIntegration(task.id), /Source changed after integration; rollback refused/);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'ready-plus-human-edit\n');
    assert.deepEqual(state.core.events(task.id).filter((event) => event.kind === 'integration.rolled_back').length, 0);
  });
});

test('rollback verifies every backup before restoring any file', async () => {
  await withCore(async (state) => {
    const { task, snapshot } = await completedTask(state, { additionalFile: true });
    await state.core.integrateWorkspace(task.id, snapshot.snapshotId);
    await writeFile(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'PRE-INTEGRATION', 'second.txt'), 'tampered\n');
    await assert.rejects(state.core.rollbackIntegration(task.id), /Integration backup changed/);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'ready\n');
    assert.equal(await readFile(join(state.root, 'second.txt'), 'utf8'), 'second ready\n');
  });
});

test('a mid-write failure lands the task in RECOVERY_REQUIRED instead of pretending success', async () => {
  await withCore(async (state) => {
    const { task, snapshot } = await completedTask(state);
    // Windows maps chmod 0444 to the read-only attribute; the source stays
    // readable for backups and snapshots but rejects the integration write.
    await chmod(join(state.root, 'message.txt'), 0o444);
    try {
      const failure = await state.core.integrateWorkspace(task.id, snapshot.snapshotId).then(() => null, (error) => error);
      assert.match(failure.message, /Integration failed after \d+ writes and restored \d+/);
      assert.equal(state.core.get(task.id).state, 'RECOVERY_REQUIRED');
      assert.deepEqual(state.core.events(task.id).filter((event) => event.kind === 'integration.failed').length, 1);
      assert.equal(await readFile(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md')).then(() => true, () => false), true);
    } finally { await chmod(join(state.root, 'message.txt'), 0o644); }
    // Reconciliation is a human decision: the task stays in RECOVERY_REQUIRED.
    await assert.rejects(state.core.rollbackIntegration(task.id), /Only a completed task can roll back/);
  });
});

test('a rollback that fails partway records the mixed state and requires reconciliation', async () => {
  await withCore(async (state) => {
    const { task, snapshot } = await completedTask(state, { additionalFile: true });
    await state.core.integrateWorkspace(task.id, snapshot.snapshotId);
    // The first restore succeeds, the second target refuses the write.
    await chmod(join(state.root, 'second.txt'), 0o444);
    try {
      const failure = await state.core.rollbackIntegration(task.id).then(() => null, (error) => error);
      assert.match(failure.message, /Rollback failed after restoring \d+ of \d+ files/);
      assert.equal(state.core.get(task.id).state, 'RECOVERY_REQUIRED');
      assert.deepEqual(state.core.events(task.id).filter((event) => event.kind === 'integration.rollback_failed').length, 1);
      assert.deepEqual(state.core.events(task.id).filter((event) => event.kind === 'integration.rolled_back').length, 0);
      // The first file is back at its pre-integration content, the second is
      // still integrated: exactly the mixed site the event reports.
      assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
      assert.equal(await readFile(join(state.root, 'second.txt'), 'utf8'), 'second ready\n');
      // The backup directory survives for manual reconciliation.
      assert.equal(await readFile(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'PRE-INTEGRATION', 'manifest.json')).then(() => true, () => false), true);
      // Once writable again, a human can finish the rollback by rerunning it
      // after reconciling the state explicitly.
      await chmod(join(state.root, 'second.txt'), 0o644);
      await assert.rejects(state.core.rollbackIntegration(task.id), /Only a completed task can roll back/);
    } finally { await chmod(join(state.root, 'second.txt'), 0o644); }
  });
});
