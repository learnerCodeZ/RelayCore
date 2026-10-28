import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCore } from '../src/core.mjs';

const contract = { title: 'Test task', objective: 'Inspect a file', acceptance: 'Return a summary' };
const runnableContract = { ...contract, executionLimits: { maxDurationSeconds: 60, maxModelTurns: 2 } };
const temporaryRoot = () => mkdtemp(join(tmpdir(), 'relaycore-test-'));

test('draft, journal and cancel persist without external calls', async () => {
  const root = await temporaryRoot();
  try {
    const core = await openCore(root);
    const task = await core.create(contract);
    assert.equal(task.state, 'DRAFT');
    assert.deepEqual(task.contract.allowedPaths, []);
    assert.equal(task.contract.executionLimits, null);
    assert.match(await readFile(join(root, '.RelayCore', '.agent-tasks', task.id, 'TASK.md'), 'utf8'), /Inspect a file/);
    assert.throws(() => core.dispatch(task.id), /disabled/);
    assert.deepEqual(core.events(task.id).map((item) => item.kind), ['task.created']);
    assert.equal(core.stop(task.id).state, 'CANCELED');
    core.close();
    const reopened = await openCore(root);
    assert.equal(reopened.get(task.id).state, 'CANCELED');
    assert.deepEqual(reopened.events(task.id).map((item) => item.kind), ['task.created', 'task.canceled']);
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task drafts store declared execution limits without enabling execution', async () => {
  const root = await temporaryRoot();
  try {
    const core = await openCore(root);
    const executionLimits = { maxDurationSeconds: 120, maxModelTurns: 2 };
    const task = await core.create({ ...contract, executionLimits });
    assert.deepEqual(task.contract.executionLimits, executionLimits);
    assert.match(await readFile(join(root, '.RelayCore', '.agent-tasks', task.id, 'TASK.md'), 'utf8'), /最长时长：120 秒；最多模型回合：2/);
    for (const invalid of [{ maxDurationSeconds: 0, maxModelTurns: 2 }, { maxDurationSeconds: 1.5, maxModelTurns: 2 },
      { maxDurationSeconds: 120, maxModelTurns: 0 }, { maxDurationSeconds: 120 },
      { ...executionLimits, extra: true }]) {
      await assert.rejects(core.create({ ...contract, executionLimits: invalid }), /executionLimits/);
    }
    assert.throws(() => core.dispatch(task.id), /disabled/);
    core.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task drafts store only unambiguous declared project paths', async () => {
  const root = await temporaryRoot();
  try {
    const core = await openCore(root);
    const task = await core.create({ ...contract, allowedPaths: ['src/core.mjs', 'docs/计划.md'] });
    assert.deepEqual(task.contract.allowedPaths, ['src/core.mjs', 'docs/计划.md']);
    assert.match(await readFile(join(root, '.RelayCore', '.agent-tasks', task.id, 'TASK.md'), 'utf8'), /允许路径（仅声明，未授权执行）/);
    for (const path of ['../outside', 'src/../outside', '/absolute', 'C:/absolute', 'src\\file', '.git/config', '.RelayCore/state', 'local/notes', 'src//file', 'CON.txt']) {
      await assert.rejects(core.create({ ...contract, allowedPaths: [path] }), /allowedPaths/);
    }
    await assert.rejects(core.create({ ...contract, allowedPaths: ['src/file', 'SRC/FILE'] }), /duplicate/);
    core.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('non-Git workspace copies only declared files and records a separate baseline', async () => {
  const root = await temporaryRoot();
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'input.txt'), 'input');
    await writeFile(join(root, 'src', 'private.txt'), 'private');
    const core = await openCore(root);
    const task = await core.create({ ...contract, allowedPaths: ['src/input.txt'] });
    const prepared = await core.prepareWorkspace(task.id);
    assert.equal(await readFile(join(prepared.workspace, 'src', 'input.txt'), 'utf8'), 'input');
    assert.deepEqual(await readdir(join(prepared.workspace, 'src')), ['input.txt']);
    const baseline = JSON.parse(await readFile(join(root, '.RelayCore', '.agent-tasks', task.id, 'BASELINE.json'), 'utf8'));
    assert.equal(baseline.taskId, task.id);
    assert.equal(baseline.files[0].bytes, 5);
    assert.match(baseline.files[0].sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(await core.inspectWorkspaceChanges(task.id), { workspace: prepared.workspace, changedPaths: [], files: 1 });
    assert.deepEqual(await core.verifyWorkspace(task.id), { workspace: prepared.workspace, matchesBaseline: true, files: 1 });
    assert.deepEqual(await core.inspectSourceConflicts(task.id), { conflictedPaths: [], matchesBaseline: true });
    await assert.rejects(core.prepareWorkspace(task.id), /already registered; discard it before preparing again/);
    assert.throws(() => core.dispatch(task.id), /disabled/);
    core.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source conflict inspection reports edits and deletion without changing the copy', async () => {
  const root = await temporaryRoot();
  try {
    await writeFile(join(root, 'input.txt'), 'input');
    const core = await openCore(root);
    const task = await core.create({ ...contract, allowedPaths: ['input.txt'] });
    const { workspace } = await core.prepareWorkspace(task.id);
    await writeFile(join(root, 'input.txt'), 'other');
    assert.deepEqual(await core.inspectSourceConflicts(task.id), { conflictedPaths: ['input.txt'], matchesBaseline: false });
    assert.deepEqual((await core.inspectWorkspaceChanges(task.id)).changedPaths, []);
    await rm(join(root, 'input.txt'));
    assert.deepEqual(await core.inspectSourceConflicts(task.id), { conflictedPaths: ['input.txt'], matchesBaseline: false });
    assert.equal(await readFile(join(workspace, 'input.txt'), 'utf8'), 'input');
    core.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace verification detects changed, missing and extra files', async () => {
  const root = await temporaryRoot();
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'input.txt'), 'input');
    const core = await openCore(root);
    const task = await core.create({ ...contract, allowedPaths: ['src/input.txt'] });
    const { workspace } = await core.prepareWorkspace(task.id);
    const copy = join(workspace, 'src', 'input.txt');
    await writeFile(copy, 'other');
    assert.deepEqual((await core.inspectWorkspaceChanges(task.id)).changedPaths, ['src/input.txt']);
    assert.equal(await readFile(join(root, 'src', 'input.txt'), 'utf8'), 'input');
    await assert.rejects(core.verifyWorkspace(task.id), /file changed/);
    await writeFile(copy, 'input');
    await writeFile(join(workspace, 'extra.txt'), 'extra');
    await assert.rejects(core.inspectWorkspaceChanges(task.id), /Unexpected workspace file/);
    await assert.rejects(core.verifyWorkspace(task.id), /Unexpected workspace file/);
    await rm(join(workspace, 'extra.txt'));
    await mkdir(join(workspace, 'extra'));
    await assert.rejects(core.inspectWorkspaceChanges(task.id), /Unexpected workspace directory/);
    await rm(join(workspace, 'extra'), { recursive: true });
    await writeFile(copy, Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(core.inspectWorkspaceChanges(task.id), /exceeds 8 MiB/);
    await rm(copy);
    await assert.rejects(core.verifyWorkspace(task.id), /file is missing/);
    core.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace verification rejects a mismatched baseline', async () => {
  const root = await temporaryRoot();
  try {
    await writeFile(join(root, 'input.txt'), 'input');
    const core = await openCore(root);
    const task = await core.create({ ...contract, allowedPaths: ['input.txt'] });
    await core.prepareWorkspace(task.id);
    const baselinePath = join(root, '.RelayCore', '.agent-tasks', task.id, 'BASELINE.json');
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    baseline.revision++;
    await writeFile(baselinePath, JSON.stringify(baseline));
    await assert.rejects(core.verifyWorkspace(task.id), /baseline does not match/);
    core.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace preparation rejects directories and leaves no partial copy', async () => {
  const root = await temporaryRoot();
  try {
    await mkdir(join(root, 'src'));
    const core = await openCore(root);
    const task = await core.create({ ...contract, allowedPaths: ['src'] });
    await assert.rejects(core.prepareWorkspace(task.id), /Only explicit files/);
    assert.deepEqual(await readdir(join(root, '.RelayCore', 'workspaces')), []);
    await assert.rejects(lstat(join(root, '.RelayCore', '.agent-tasks', task.id, 'BASELINE.json')), { code: 'ENOENT' });
    core.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace preparation rejects a linked source path', async (context) => {
  const root = await temporaryRoot();
  try {
    await mkdir(join(root, 'actual'));
    await writeFile(join(root, 'actual', 'file.txt'), 'content');
    try { await symlink(join(root, 'actual'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { context.skip('symbolic links are unavailable'); return; }
      throw error;
    }
    const core = await openCore(root);
    const task = await core.create({ ...contract, allowedPaths: ['linked/file.txt'] });
    await assert.rejects(core.prepareWorkspace(task.id), /Linked path/);
    assert.deepEqual(await readdir(join(root, '.RelayCore', 'workspaces')), []);
    core.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('duplicate dispatch is rejected and interrupted work is not replayed', async () => {
  const root = await temporaryRoot();
  let core;
  let reopened;
  try {
    let resolveWork;
    let executionContext;
    const pending = new Promise((resolve) => { resolveWork = resolve; });
    core = await openCore(root, async (task, context) => {
      executionContext = context;
      context.recordSession('dsh', 'test-session');
      await pending;
      return { handoff: '# Test handoff' };
    });
    const task = await core.create(runnableContract);
    assert.equal(core.dispatch(task.id).state, 'QUEUED');
    assert.throws(() => core.dispatch(task.id), /Cannot dispatch/);
    for (let attempt = 0; attempt < 20 && core.get(task.id).state !== 'RUNNING'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(core.get(task.id).state, 'RUNNING');
    assert.equal(core.events(task.id).filter((item) => item.kind === 'execution.started').length, 1);
    assert.equal(core.get(task.id).sessions[0].sessionId, 'test-session');
    assert.equal(core.stop(task.id).stopRequested, true);
    assert.equal(core.get(task.id).state, 'RECOVERY_REQUIRED');
    assert.throws(() => executionContext.beginModelTurn('codex'), /no longer active/);
    resolveWork();
    for (let attempt = 0; attempt < 20 && core.get(task.id).state !== 'RECOVERY_REQUIRED'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(core.get(task.id).state, 'RECOVERY_REQUIRED');
    core.close();
    core = null;
    reopened = await openCore(root, async () => { throw new Error('must not replay'); });
    assert.equal(reopened.get(task.id).state, 'RECOVERY_REQUIRED');
    reopened.close();
    reopened = null;
  } finally { reopened?.close(); core?.close(); await rm(root, { recursive: true, force: true }); }
});

test('a result arriving after shutdown cannot create a handoff', async () => {
  const root = await temporaryRoot();
  let core;
  try {
    let finishWork;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const work = new Promise((resolve) => { finishWork = resolve; });
    core = await openCore(root, async () => {
      signalStarted();
      await work;
      return { handoff: '# Late result' };
    });
    const task = await core.create(runnableContract);
    core.dispatch(task.id);
    await started;
    core.close();
    core = null;
    finishWork();
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(lstat(join(root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md')), { code: 'ENOENT' });
    core = await openCore(root);
    assert.equal(core.get(task.id).state, 'RECOVERY_REQUIRED');
    assert.equal(core.events(task.id).filter((item) => item.kind === 'task.completed').length, 0);
  } finally { core?.close(); await rm(root, { recursive: true, force: true }); }
});

test('a completed result persists its handoff and state together', async () => {
  const root = await temporaryRoot();
  const core = await openCore(root, async () => ({ handoff: '# Test handoff' }));
  try {
    const task = await core.create(runnableContract);
    core.dispatch(task.id);
    for (let attempt = 0; attempt < 20 && core.get(task.id).state !== 'COMPLETED'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(core.get(task.id).state, 'COMPLETED');
    assert.equal(core.get(task.id).result, '# Test handoff');
    assert.equal(await readFile(join(root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md'), 'utf8'), '# Test handoff');
  } finally { core.close(); await rm(root, { recursive: true, force: true }); }
});

test('an oversized handoff is rejected before synchronous file writing', async () => {
  const root = await temporaryRoot();
  const core = await openCore(root, async () => ({ handoff: 'x'.repeat(1024 * 1024 + 1) }));
  try {
    const task = await core.create(runnableContract);
    core.dispatch(task.id);
    for (let attempt = 0; attempt < 20 && core.get(task.id).state !== 'RECOVERY_REQUIRED'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(core.get(task.id).state, 'RECOVERY_REQUIRED');
    await assert.rejects(lstat(join(root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md')), { code: 'ENOENT' });
  } finally { core.close(); await rm(root, { recursive: true, force: true }); }
});

test('crash marker converts RUNNING to RECOVERY_REQUIRED on startup', async () => {
  const root = await temporaryRoot();
  try {
    const core = await openCore(root);
    const task = await core.create(contract);
    core.close();
    const database = new DatabaseSync(join(root, '.RelayCore', 'bridge', 'state.sqlite'));
    database.prepare("UPDATE tasks SET state='RUNNING' WHERE id=?").run(task.id);
    database.close();
    const reopened = await openCore(root);
    assert.equal(reopened.get(task.id).state, 'RECOVERY_REQUIRED');
    assert.equal(reopened.events(task.id).at(-1).kind, 'task.recovery_required');
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('startup quarantines an orphan handoff without treating it as completed', async () => {
  const root = await temporaryRoot();
  try {
    const core = await openCore(root);
    const task = await core.create(contract);
    core.close();
    const handoffPath = join(root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md');
    await writeFile(handoffPath, '# Uncommitted result');
    const reopened = await openCore(root);
    assert.equal(reopened.get(task.id).state, 'RECOVERY_REQUIRED');
    assert.equal(reopened.get(task.id).result, null);
    assert.deepEqual(reopened.events(task.id).map((item) => item.kind), ['task.created', 'handoff.reconciliation_required']);
    reopened.close();
    const openedAgain = await openCore(root);
    assert.equal(openedAgain.events(task.id).filter((item) => item.kind === 'handoff.reconciliation_required').length, 1);
    assert.equal(await readFile(handoffPath, 'utf8'), '# Uncommitted result');
    openedAgain.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dispatch requires supported execution limits before queuing an executor', async () => {
  const root = await temporaryRoot();
  const core = await openCore(root, async () => { throw new Error('must not execute'); });
  try {
    const missing = await core.create(contract);
    assert.throws(() => core.dispatch(missing.id), /Declare executionLimits/);
    assert.equal(core.get(missing.id).state, 'DRAFT');
    const oversized = await core.create({ ...contract, executionLimits: { maxDurationSeconds: 2147484, maxModelTurns: 1 } });
    assert.throws(() => core.dispatch(oversized.id), /timer range/);
    assert.equal(core.get(oversized.id).state, 'DRAFT');
  } finally { core.close(); await rm(root, { recursive: true, force: true }); }
});

test('review workspace snapshots before and after as data and rejects source conflicts', async () => {
  const root = await temporaryRoot();
  const core = await openCore(root);
  try {
    await writeFile(join(root, 'calc.mjs'), '\uFEFFexport const add = (left, right) => left + right;');
    const task = await core.create({ ...contract, allowedPaths: ['calc.mjs'] });
    const candidate = await core.prepareWorkspace(task.id);
    await writeFile(join(candidate.workspace, 'calc.mjs'), 'export const add = (left, right) => left - right;');
    const review = await core.prepareReviewWorkspace(task.id);
    const packet = JSON.parse(await readFile(review.inputPath, 'utf8'));
    assert.notEqual(review.workspace, candidate.workspace);
    assert.deepEqual(await readdir(review.workspace), ['REVIEW.json']);
    assert.equal(packet.files[0].before, '\uFEFFexport const add = (left, right) => left + right;');
    assert.equal(packet.files[0].after, 'export const add = (left, right) => left - right;');
    await writeFile(join(candidate.workspace, 'calc.mjs'), 'later candidate edit');
    assert.equal(JSON.parse(await readFile(review.inputPath, 'utf8')).files[0].after, packet.files[0].after);
    await writeFile(join(root, 'calc.mjs'), 'concurrent user edit');
    await assert.rejects(core.prepareReviewWorkspace(task.id), /Source conflict/);
    assert.equal((await readdir(join(root, '.RelayCore', 'reviews'))).length, 1);
  } finally { core.close(); await rm(root, { recursive: true, force: true }); }
});

test('review input rejects binary and oversized candidates', async () => {
  const root = await temporaryRoot();
  const core = await openCore(root);
  try {
    await writeFile(join(root, 'text.txt'), 'original');
    const task = await core.create({ ...contract, allowedPaths: ['text.txt'] });
    const candidate = await core.prepareWorkspace(task.id);
    await writeFile(join(candidate.workspace, 'text.txt'), Buffer.from([0xff]));
    await assert.rejects(core.prepareReviewWorkspace(task.id));
    await writeFile(join(candidate.workspace, 'text.txt'), 'x'.repeat(256 * 1024));
    await assert.rejects(core.prepareReviewWorkspace(task.id), /256 KiB/);
  } finally { core.close(); await rm(root, { recursive: true, force: true }); }
});

test('model turns reserve durable intent across both agents and fail closed at the limit', async () => {
  const root = await temporaryRoot();
  let core;
  try {
    const reserved = [];
    core = await openCore(root, async (task, context) => {
      for (const agent of ['dsh', 'codex']) {
        const receipt = context.beginModelTurn(agent);
        assert.equal(core.events(task.id).some((entry) => entry.sequence === receipt.intentSequence && entry.kind === `model_turn.requested.${agent}`), true);
        reserved.push(receipt.turnNumber);
      }
      assert.throws(() => context.beginModelTurn('dsh'), /Model turn limit exceeded/);
      assert.equal(context.signal.aborted, true);
      return { handoff: '# Must not complete after limit' };
    });
    const task = await core.create(runnableContract);
    core.dispatch(task.id);
    for (let attempt = 0; attempt < 50 && core.get(task.id).state !== 'RECOVERY_REQUIRED'; attempt++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.deepEqual(reserved, [1, 2]);
    assert.equal(core.get(task.id).state, 'RECOVERY_REQUIRED');
    assert.equal(core.events(task.id).filter((entry) => entry.kind.startsWith('model_turn.requested.')).length, 2);
    assert.equal(core.events(task.id).filter((entry) => entry.kind === 'execution.model_turn_limit_exceeded').length, 1);
    await assert.rejects(lstat(join(root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md')), { code: 'ENOENT' });
    core.close();
    core = await openCore(root);
    assert.equal(core.get(task.id).state, 'RECOVERY_REQUIRED');
    assert.equal(core.events(task.id).filter((entry) => entry.kind.startsWith('model_turn.requested.')).length, 2);
  } finally { core?.close(); await rm(root, { recursive: true, force: true }); }
});

test('deadline aborts an unresponsive executor and blocks new turns and queued execution', async () => {
  const root = await temporaryRoot();
  let finishWork;
  let core;
  try {
    let signalStarted;
    let context;
    const started = new Promise((done) => { signalStarted = done; });
    const work = new Promise((done) => { finishWork = done; });
    core = await openCore(root, async (task, current) => {
      context = current;
      current.beginModelTurn('dsh');
      signalStarted();
      await work;
      return { handoff: '# Late timed-out result' };
    });
    const task = await core.create({ ...contract, executionLimits: { maxDurationSeconds: 1, maxModelTurns: 1 } });
    core.dispatch(task.id);
    await started;
    const queued = await core.create(runnableContract);
    core.dispatch(queued.id);
    for (let attempt = 0; attempt < 300 && core.get(task.id).state !== 'RECOVERY_REQUIRED'; attempt++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(core.get(task.id).state, 'RECOVERY_REQUIRED');
    assert.equal(context.signal.aborted, true);
    assert.throws(() => context.beginModelTurn('codex'), /no longer active/);
    assert.equal(core.get(queued.id).state, 'QUEUED');
    assert.equal(core.events(queued.id).some((entry) => entry.kind === 'execution.started'), false);
    assert.equal(core.events(task.id).filter((entry) => entry.kind === 'execution.deadline_exceeded').length, 1);
    core.stop(queued.id);
    finishWork();
    await new Promise((done) => setImmediate(done));
    await assert.rejects(lstat(join(root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md')), { code: 'ENOENT' });
  } finally { finishWork?.(); core?.close(); await rm(root, { recursive: true, force: true }); }
});

test('expired queued work is reconciled before an executor can run after restart', async () => {
  const root = await temporaryRoot();
  let core;
  let calls = 0;
  try {
    const executor = async () => { calls++; return { handoff: '# Must not run' }; };
    core = await openCore(root, executor);
    const task = await core.create(runnableContract);
    core.dispatch(task.id);
    core.close();
    core = null;
    const database = new DatabaseSync(join(root, '.RelayCore', 'bridge', 'state.sqlite'));
    database.prepare("UPDATE events SET created_at=? WHERE task_id=? AND kind='task.dispatched'").run('2000-01-01T00:00:00.000Z', task.id);
    database.close();
    core = await openCore(root, executor);
    for (let attempt = 0; attempt < 50 && core.get(task.id).state !== 'RECOVERY_REQUIRED'; attempt++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(calls, 0);
    assert.equal(core.get(task.id).state, 'RECOVERY_REQUIRED');
    assert.equal(core.events(task.id).some((entry) => entry.kind === 'execution.deadline_exceeded'), true);
  } finally { core?.close(); await rm(root, { recursive: true, force: true }); }
});
