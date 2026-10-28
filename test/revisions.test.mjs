import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { openCore } from '../src/core.mjs';

const contract = { title: 'Versioned task', objective: 'Prepare the first candidate.', acceptance: 'Keep the source unchanged.',
  allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 10, maxModelTurns: 2 } };
const approval = () => ({ expiresAt: new Date(Date.now() + 60000).toISOString(), allowUnknownCost: true });

async function withVersions(action, costMode) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-revision-test-'));
  const state = { root, calls: 0 };
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    state.core = await openCore(root, costMode ? async (task, context) => {
      state.calls++;
      context.beginModelTurn('dsh');
      return { handoff: `# Local fake result for revision ${task.contract.revision}` };
    } : null, costMode ? { maxDurationSeconds: 20, maxModelTurns: 2, costMode } : undefined);
    await action(state);
  } finally {
    state.core?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

test('task revisions keep old contracts, workspaces and snapshots while starting fresh drafts', async () => {
  await withVersions(async (state) => {
    const parent = await state.core.create({ ...contract, executionLimits: undefined });
    const taskPath = join(state.root, '.RelayCore', '.agent-tasks', parent.id, 'TASK.md');
    const originalMarkdown = await readFile(taskPath, 'utf8');
    const candidate = await state.core.prepareWorkspace(parent.id);
    await writeFile(join(candidate.workspace, 'message.txt'), 'first candidate\n');
    const snapshot = await state.core.prepareReviewWorkspace(parent.id);
    const child = await state.core.createRevision(parent.id, { expectedRevision: 1, reason: 'Clarify the goal.', objective: 'Prepare the second candidate.' });
    assert.notEqual(child.id, parent.id);
    assert.equal(child.state, 'DRAFT');
    assert.equal(child.contract.revision, 2);
    assert.equal(child.contract.executionLimits, null);
    assert.equal(child.executionAuthorization, undefined);
    assert.equal(child.result, null);
    assert.deepEqual(child.sessions, []);
    assert.deepEqual(state.core.reviewSnapshots(child.id), []);
    assert.equal(child.revisionInfo.parentTaskId, parent.id);
    assert.equal(child.revisionInfo.rootTaskId, parent.id);
    assert.equal(child.revisionInfo.parentContractSha256, createHash('sha256').update(JSON.stringify(parent.contract)).digest('hex'));
    assert.deepEqual(state.core.get(parent.id).contract, parent.contract);
    assert.equal(state.core.get(parent.id).supersededBy, child.id);
    assert.equal(await readFile(taskPath, 'utf8'), originalMarkdown);
    assert.equal(await readFile(join(candidate.workspace, 'message.txt'), 'utf8'), 'first candidate\n');
    assert.equal((await state.core.verifyReviewedWorkspace(parent.id, snapshot.snapshotId)).revision, 1);
    const nextCandidate = await state.core.prepareWorkspace(child.id);
    assert.equal(await readFile(join(nextCandidate.workspace, 'message.txt'), 'utf8'), 'pending\n');
    await writeFile(join(nextCandidate.workspace, 'message.txt'), 'second candidate\n');
    const nextSnapshot = await state.core.prepareReviewWorkspace(child.id);
    assert.equal((await state.core.verifyReviewedWorkspace(child.id, nextSnapshot.snapshotId)).revision, 2);
    const latest = await state.core.createRevision(child.id, { expectedRevision: 2, reason: 'Set a new acceptance.', acceptance: 'Check the second candidate.' });
    assert.equal(latest.contract.revision, 3);
    const markdown = await readFile(join(state.root, '.RelayCore', '.agent-tasks', child.id, 'TASK.md'), 'utf8');
    assert.match(markdown, /修订：2/);
    assert.ok(markdown.includes(parent.id));
    const versions = state.core.taskVersions(latest.id).map(({ taskId, revision }) => ({ taskId, revision }));
    assert.deepEqual(versions, [{ taskId: parent.id, revision: 1 }, { taskId: child.id, revision: 2 }, { taskId: latest.id, revision: 3 }]);
    state.core.close();
    state.core = undefined;
    state.core = await openCore(state.root);
    assert.deepEqual(state.core.taskVersions(parent.id).map(({ taskId, revision }) => ({ taskId, revision })), versions);
    assert.equal(state.core.get(latest.id).revisionInfo.reason, 'Set a new acceptance.');
    assert.equal(state.core.events(parent.id).some((event) => event.kind.startsWith('model_turn.requested.')), false);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
  });
});

test('revisions cannot inherit authorization or execute a superseded draft', async () => {
  await withVersions(async (state) => {
    const parent = await state.core.create(contract);
    const originalGrant = state.core.authorizeExecution(parent.id, approval());
    const child = await state.core.createRevision(parent.id, { expectedRevision: 1, reason: 'A new objective needs a new approval.', objective: 'Do the revised work.' });
    assert.equal(state.calls, 0);
    assert.throws(() => state.core.dispatch(parent.id), /newer revision/);
    assert.throws(() => state.core.authorizeExecution(parent.id, approval()), /newer revision/);
    assert.throws(() => state.core.dispatch(child.id), /local execution authorization/);
    assert.throws(() => state.core.authorizeExecution(child.id, { expiresAt: approval().expiresAt }), /Unknown execution cost/);
    assert.deepEqual(state.core.get(parent.id).executionAuthorization, originalGrant);
    assert.equal(state.core.get(child.id).executionAuthorization, undefined);
    const nextGrant = state.core.authorizeExecution(child.id, approval());
    assert.notEqual(nextGrant.id, originalGrant.id);
    state.core.dispatch(child.id);
    for (let attempt = 0; attempt < 100 && ['QUEUED', 'RUNNING'].includes(state.core.get(child.id).state); attempt++) await setTimeout(5);
    assert.equal(state.core.get(child.id).state, 'COMPLETED');
    assert.equal(state.calls, 1);
    assert.equal(state.core.get(parent.id).executionAuthorization.consumedAt, null);
    assert.equal(state.core.events(parent.id).some((event) => event.kind === 'task.dispatched'), false);
    const next = await state.core.createRevision(child.id, { expectedRevision: 2, reason: 'Follow-up work.', objective: 'A separate follow-up.' });
    assert.equal(next.state, 'DRAFT');
    assert.equal(next.contract.revision, 3);
    assert.equal(next.result, null);
    assert.deepEqual(next.sessions, []);
    assert.equal(next.executionAuthorization, undefined);
  }, 'unknown');
});

test('invalid, stale and unknown-state revision requests leave no new task or workspace', async () => {
  await withVersions(async (state) => {
    const parent = await state.core.create(contract);
    const valid = { expectedRevision: 1, reason: 'Revised goal.', objective: 'A new goal.' };
    for (const input of [null, [], {}, { ...valid, expectedRevision: 0 }, { ...valid, expectedRevision: 2 },
      { ...valid, expectedRevision: Number.MAX_SAFE_INTEGER }, { ...valid, reason: ' ' }, { ...valid, objective: null },
      { ...valid, allowedPaths: ['../outside'] }, { ...valid, executionLimits: { maxDurationSeconds: 0, maxModelTurns: 1 } },
      { ...valid, revision: 9 }, { ...valid, state: 'COMPLETED' }, { ...valid, parentTaskId: 'forged' },
      { ...valid, executionAuthorization: { allowUnknownCost: true } }, { expectedRevision: 1, reason: 'No contract change.' }]) {
      await assert.rejects(state.core.createRevision(parent.id, input));
    }
    const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
    try {
      for (const status of ['QUEUED', 'RUNNING', 'RECOVERY_REQUIRED']) {
        database.prepare('UPDATE tasks SET state=? WHERE id=?').run(status, parent.id);
        await assert.rejects(state.core.createRevision(parent.id, valid), /inactive task with known state/);
      }
      database.prepare("UPDATE tasks SET state='DRAFT' WHERE id=?").run(parent.id);
    } finally { database.close(); }
    assert.equal(state.core.list().length, 1);
    assert.deepEqual(await readdir(join(state.root, '.RelayCore', '.agent-tasks')), [parent.id]);
    state.core.stop(parent.id);
    const revised = await state.core.createRevision(parent.id, valid);
    assert.equal(revised.contract.revision, 2);
    assert.equal(state.core.get(parent.id).state, 'CANCELED');
  });
});

test('concurrent revisions create one successor and clean the losing draft directory', async () => {
  await withVersions(async (state) => {
    const parent = await state.core.create(contract);
    const requests = await Promise.allSettled(['First update.', 'Second update.'].map((objective) =>
      state.core.createRevision(parent.id, { expectedRevision: 1, reason: 'Concurrent edit.', objective })));
    assert.equal(requests.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(requests.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(state.core.taskVersions(parent.id).length, 2);
    assert.equal(state.core.list().length, 2);
    assert.equal((await readdir(join(state.root, '.RelayCore', '.agent-tasks'))).length, 2);
    assert.equal(state.core.events(parent.id).filter((event) => event.kind === 'task.revision_created').length, 1);
    await assert.rejects(state.core.createRevision(parent.id, { expectedRevision: 1, reason: 'Repeated request.', objective: 'Another update.' }), /newer revision/);
    assert.equal(state.core.get(parent.id).contract.revision, 1);
  });
});

test('failed revision registration rolls back task, lineage, events and its new directory', async () => {
  await withVersions(async (state) => {
    const parent = await state.core.create(contract);
    const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
    try {
      database.exec("CREATE TRIGGER reject_revision BEFORE INSERT ON task_revisions BEGIN SELECT RAISE(ABORT, 'revision registry unavailable'); END;");
      await assert.rejects(state.core.createRevision(parent.id, { expectedRevision: 1, reason: 'Failed update.', objective: 'A new goal.' }), /revision registry unavailable/);
      assert.equal(state.core.list().length, 1);
      assert.equal(state.core.get(parent.id).supersededBy, undefined);
      assert.deepEqual(state.core.events(parent.id).map((event) => event.kind), ['task.created']);
      assert.deepEqual(await readdir(join(state.root, '.RelayCore', '.agent-tasks')), [parent.id]);
      database.exec('DROP TRIGGER reject_revision');
    } finally { database.close(); }
    const revised = await state.core.createRevision(parent.id, { expectedRevision: 1, reason: 'Retry the local save.', objective: 'A new goal.' });
    assert.equal(revised.contract.revision, 2);
  });
});

test('older task databases get an empty revision registry without changing existing tasks', async () => {
  await withVersions(async (state) => {
    const parent = await state.core.create(contract);
    state.core.close();
    state.core = undefined;
    const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
    try { database.exec('DROP TABLE task_revisions'); }
    finally { database.close(); }
    state.core = await openCore(state.root);
    assert.deepEqual(state.core.get(parent.id).contract, parent.contract);
    assert.deepEqual(state.core.events(parent.id).map((event) => event.kind), ['task.created']);
    assert.equal(state.core.taskVersions(parent.id).length, 1);
    const child = await state.core.createRevision(parent.id, { expectedRevision: 1, reason: 'After an additive upgrade.', objective: 'The next goal.' });
    assert.equal(child.contract.revision, 2);
    assert.equal(child.revisionInfo.rootTaskId, parent.id);
  });
});
