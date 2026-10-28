import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCore } from '../src/core.mjs';

const contract = { title: 'Workspace lifecycle', objective: 'Prepare a candidate.', acceptance: 'Keep the source unchanged.',
  allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 10, maxModelTurns: 2 } };

async function withCore(action) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-workspace-test-'));
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

const baselinePath = (state, id) => join(state.root, '.RelayCore', '.agent-tasks', id, 'BASELINE.json');
const workspacePath = (state, id) => join(state.root, '.RelayCore', 'workspaces', id);

test('preparing a workspace registers it, and re-preparation is refused until an explicit discard', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    const candidate = await state.core.prepareWorkspace(task.id);
    assert.equal(candidate.registered, true);
    assert.equal(candidate.baselineSha256, createHash('sha256').update(await readFile(baselinePath(state, task.id))).digest('hex'));
    let inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.registered.map(({ taskId, revision, present }) => ({ taskId, revision, present })),
      [{ taskId: task.id, revision: 1, present: true }]);
    assert.deepEqual(inventory.unregistered, []);
    assert.deepEqual(inventory.leftoverTemp, []);
    assert.deepEqual(inventory.unexpected, []);
    await assert.rejects(state.core.prepareWorkspace(task.id), /already registered; discard it before preparing again/);
    await rm(workspacePath(state, task.id), { recursive: true, force: true });
    await assert.rejects(state.core.prepareWorkspace(task.id), /already registered; discard it before preparing again/);
    await state.core.discardWorkspace(task.id);
    assert.equal(await lstat(baselinePath(state, task.id)).then(() => true, () => false), false);
    inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.registered, []);
    const events = state.core.events(task.id).map((event) => event.kind);
    assert.ok(events.includes('workspace.prepared') && events.includes('workspace.discarded'));
    const again = await state.core.prepareWorkspace(task.id);
    assert.equal(again.registered, true);
    assert.equal((await state.core.verifyWorkspace(task.id)).matchesBaseline, true);
  });
});

test('a failed preparation leaves no directory, baseline, temporary or registration', async () => {
  await withCore(async (state) => {
    const task = await state.core.create({ ...contract, allowedPaths: ['message.txt', 'nested/thing.txt'] });
    await mkdir(join(state.root, 'nested', 'thing.txt'), { recursive: true });
    await assert.rejects(state.core.prepareWorkspace(task.id), /Only explicit files are supported/);
    const inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.registered, []);
    assert.deepEqual(inventory.leftoverTemp, []);
    assert.deepEqual(inventory.unregistered, []);
    assert.deepEqual(await readdir(join(state.root, '.RelayCore', 'workspaces')), []);
    assert.equal(await lstat(baselinePath(state, task.id)).then(() => true, () => false), false);
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
  });
});

test('unregistered sites from a crash or older database stay visible, usable and cleanly discardable', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    // Simulate a crash between rename and registration, or a pre-registration database.
    const prepared = await state.core.prepareWorkspace(task.id);
    const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
    try { database.prepare('DELETE FROM workspaces WHERE task_id=?').run(task.id); }
    finally { database.close(); }
    state.core.close();
    state.core = await openCore(state.root);
    const inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.unregistered, [{ name: task.id, kind: 'directory' }]);
    // Existing flows keep working without auto-trusting the site.
    assert.equal((await state.core.verifyWorkspace(task.id)).matchesBaseline, true);
    await assert.rejects(state.core.prepareWorkspace(task.id), /Workspace already exists/);
    await state.core.discardWorkspace(task.id);
    assert.deepEqual((await state.core.workspaceInventory()).unregistered, []);
    const retry = await state.core.prepareWorkspace(task.id);
    assert.equal(retry.registered, true);  });
});

test('a registered baseline cannot be tampered with, and a missing directory is reported', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    await state.core.prepareWorkspace(task.id);
    const baseline = JSON.parse(await readFile(baselinePath(state, task.id), 'utf8'));
    baseline.files[0].sha256 = '0'.repeat(64);
    await writeFile(baselinePath(state, task.id), JSON.stringify(baseline, null, 2));
    await assert.rejects(state.core.verifyWorkspace(task.id), /baseline changed since registration/);
    await rm(workspacePath(state, task.id), { recursive: true, force: true });
    const inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.registered.map(({ taskId, present }) => ({ taskId, present })), [{ taskId: task.id, present: false }]);
    const discard = await state.core.discardWorkspace(task.id);
    assert.deepEqual(discard, { discarded: true, kind: 'copy', removedRegistration: true, removedLeftovers: 0 });
    assert.deepEqual((await state.core.workspaceInventory()).registered, []);
  });
});

test('discard is refused for unresolved states and for tasks with nothing to discard', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    await assert.rejects(state.core.discardWorkspace(task.id), /No registered workspace/);
    await state.core.prepareWorkspace(task.id);
    const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
    try {
      for (const status of ['QUEUED', 'RUNNING', 'RECOVERY_REQUIRED']) {
        database.prepare('UPDATE tasks SET state=? WHERE id=?').run(status, task.id);
        await assert.rejects(state.core.discardWorkspace(task.id), new RegExp(`while the task is ${status}`));
      }
      database.prepare("UPDATE tasks SET state='CANCELED' WHERE id=?").run(task.id);
    } finally { database.close(); }
    const discard = await state.core.discardWorkspace(task.id);
    assert.deepEqual(discard, { discarded: true, kind: 'copy', removedRegistration: true, removedLeftovers: 0 });
    assert.deepEqual((await state.core.workspaceInventory()).registered, []);
  });
});

test('revisions keep the old site until it is discarded, and never write back to the source', async () => {
  await withCore(async (state) => {
    const parent = await state.core.create(contract);
    const original = await state.core.prepareWorkspace(parent.id);
    await writeFile(join(original.workspace, 'message.txt'), 'first candidate\n');
    const child = await state.core.createRevision(parent.id, { expectedRevision: 1, reason: 'A new goal.', objective: 'Second goal.' });
    assert.equal(await readFile(join(original.workspace, 'message.txt'), 'utf8'), 'first candidate\n');
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
    const second = await state.core.prepareWorkspace(child.id);
    await writeFile(join(second.workspace, 'message.txt'), 'second candidate\n');
    let inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.registered.map(({ taskId }) => taskId).sort(), [parent.id, child.id].sort());
    const discarded = await state.core.discardWorkspace(parent.id);
    assert.deepEqual(discarded, { discarded: true, kind: 'copy', removedRegistration: true, removedLeftovers: 0 });
    inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.registered.map(({ taskId }) => taskId), [child.id]);
    assert.equal(await lstat(workspacePath(state, parent.id)).then(() => true, () => false), false);
    assert.equal(await readFile(join(second.workspace, 'message.txt'), 'utf8'), 'second candidate\n');
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
  });
});

test('leftover temporary directories are identified and swept with their task', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    const temporary = join(state.root, '.RelayCore', 'workspaces', `${task.id}-tmp-ab12cd`);
    await mkdir(temporary, { recursive: true });
    await writeFile(join(temporary, 'message.txt'), 'partial\n');
    let inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.leftoverTemp, [{ name: `${task.id}-tmp-ab12cd`, kind: 'directory' }]);
    await state.core.prepareWorkspace(task.id);
    inventory = await state.core.workspaceInventory();
    assert.equal(inventory.leftoverTemp.length, 1);
    const discarded = await state.core.discardWorkspace(task.id);
    assert.equal(discarded.removedLeftovers, 1);
    inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.leftoverTemp, []);
    assert.deepEqual(inventory.registered, []);
    assert.deepEqual(await readdir(join(state.root, '.RelayCore', 'workspaces')), []);
  });
});

test('unexpected directory names and foreign leftovers stay in the inventory untouched', async () => {
  await withCore(async (state) => {
    const workspaces = join(state.root, '.RelayCore', 'workspaces');
    await mkdir(join(workspaces, 'TASK-not-a-uuid'), { recursive: true });
    await mkdir(join(workspaces, 'TASK-11111111-1111-4111-8111-111111111111-tmp-xx'), { recursive: true });
    await mkdir(join(workspaces, 'stray-notes'), { recursive: true });
    const inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.unexpected.map(({ name }) => name).sort(), ['TASK-not-a-uuid', 'stray-notes'].sort());
    assert.deepEqual(inventory.leftoverTemp.map(({ name }) => name), ['TASK-11111111-1111-4111-8111-111111111111-tmp-xx']);
    assert.deepEqual(await readdir(workspaces).then((entries) => entries.length), 3);
  });
});
