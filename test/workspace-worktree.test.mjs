import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openCore } from '../src/core.mjs';

const runGit = promisify(execFile);
const git = async (repository, args) =>
  (await runGit('git', args, { cwd: repository, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;

const identity = ['-c', 'user.name=RelayCore Test', '-c', 'user.email=relaycore-test@example.invalid'];

async function seedRepository() {
  const repository = await mkdtemp(join(tmpdir(), 'relaycore-worktree-repo-'));
  await writeFile(join(repository, 'app.txt'), 'baseline\n');
  await runGit('git', [...identity, 'init', '-b', 'main'], { cwd: repository });
  await runGit('git', [...identity, 'add', 'app.txt'], { cwd: repository });
  await runGit('git', [...identity, 'commit', '-m', 'seed'], { cwd: repository });
  return repository;
}

const contract = { title: 'Worktree task', objective: 'Edit inside a worktree.', acceptance: 'Keep the source repo unchanged.',
  allowedPaths: ['app.txt'], executionLimits: { maxDurationSeconds: 10, maxModelTurns: 2 } };

async function withCore(action) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-worktree-test-'));
  const state = { root };
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    state.core = await openCore(root);
    state.repository = await seedRepository();
    await action(state);
  } finally {
    state.core?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
    await rm(state.repository, { recursive: true, force: true });
  }
}

test('prepareGitWorktree registers a detached worktree and reports its base commit', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    const baseCommit = (await git(state.repository, ['rev-parse', 'HEAD'])).trim();
    const prepared = await state.core.prepareGitWorktree(task.id, { repository: state.repository });
    assert.equal(prepared.kind, 'worktree');
    assert.equal(prepared.baseCommit, baseCommit);
    assert.equal((await lstat(join(prepared.workspace, '.git'))).isFile(), true, 'a linked worktree carries a .git file');
    assert.equal(await readFile(join(prepared.workspace, 'app.txt'), 'utf8'), 'baseline\n');
    const inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.registered.map(({ taskId, kind }) => ({ taskId, kind })), [{ taskId: task.id, kind: 'worktree' }]);
    // File-baseline machinery must refuse the worktree shape instead of guessing.
    await assert.rejects(state.core.verifyWorkspace(task.id), /do not apply to worktree workspaces/);
    await assert.rejects(state.core.prepareReviewWorkspace(task.id), /do not apply to worktree workspaces/);
    await assert.rejects(state.core.prepareGitWorktree(task.id, { repository: state.repository }), /already registered/);
  });
});

test('inspectWorktreeChanges reports tracked edits and untracked files against the base commit', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    const { workspace } = await state.core.prepareGitWorktree(task.id, { repository: state.repository });
    await writeFile(join(workspace, 'app.txt'), 'edited\n');
    await writeFile(join(workspace, 'extra.txt'), 'new file\n');
    const changes = await state.core.inspectWorktreeChanges(task.id);
    assert.equal(changes.kind, 'worktree');
    assert.deepEqual(changes.changedFiles.map(({ path }) => path).sort(), ['app.txt', 'extra.txt']);
    assert.ok(changes.changedFiles.find(({ path }) => path === 'extra.txt').status.includes('?'));
    assert.match(changes.diff, /-baseline\n\+edited\n/);
    const repositoryContent = await readFile(join(state.repository, 'app.txt'), 'utf8');
    assert.equal(repositoryContent, 'baseline\n', 'the main repository stays untouched');
  });
});

test('discarding a worktree removes the git link and leaves the repository clean', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    await state.core.prepareGitWorktree(task.id, { repository: state.repository });
    const discard = await state.core.discardWorkspace(task.id);
    assert.deepEqual(discard, { discarded: true, kind: 'worktree', removedRegistration: true, removedLeftovers: 0, worktreeRemoval: 'removed' });
    assert.equal(await lstat(join(state.root, '.RelayCore', 'workspaces', task.id)).then(() => true, () => false), false);
    const listed = await git(state.repository, ['worktree', 'list', '--porcelain']);
    assert.equal(listed.includes(task.id), false, 'git no longer tracks the removed worktree');
    const status = await git(state.repository, ['status', '--porcelain']);
    assert.equal(status.trim(), '', 'the main repository is unchanged');
    assert.deepEqual((await state.core.workspaceInventory()).registered, []);
  });
});

test('a manually deleted worktree still discards cleanly through pruning', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    await state.core.prepareGitWorktree(task.id, { repository: state.repository });
    await rm(join(state.root, '.RelayCore', 'workspaces', task.id), { recursive: true, force: true });
    const discard = await state.core.discardWorkspace(task.id);
    assert.deepEqual(discard, { discarded: true, kind: 'worktree', removedRegistration: true, removedLeftovers: 0, worktreeRemoval: 'pruned' });
    assert.deepEqual((await state.core.workspaceInventory()).registered, []);
  });
});

test('invalid repositories, refs and foreign ref strings are refused before any git call', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    await assert.rejects(state.core.prepareGitWorktree(task.id, { repository: state.root }), /does not contain a Git work tree/);
    await assert.rejects(state.core.prepareGitWorktree(task.id, { repository: state.repository, ref: '-oProxyCommand=evil' }), /Invalid Git ref/);
    await assert.rejects(state.core.prepareGitWorktree(task.id, { repository: state.repository, ref: 'no-such-ref' }), /could not be found|invalid|failed/);
    const inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.registered, []);
    assert.deepEqual(await readdir(join(state.root, '.RelayCore', 'workspaces')), []);
  });
});

test('copy workspaces keep working alongside worktree workspaces', async () => {
  await withCore(async (state) => {
    const copyTask = await state.core.create({ ...contract, allowedPaths: ['message.txt'] });
    const copyCandidate = await state.core.prepareWorkspace(copyTask.id);
    const worktreeTask = await state.core.createRevision(copyTask.id, { expectedRevision: 1, reason: 'Try the git route.', objective: 'Worktree goal.' });
    await state.core.prepareGitWorktree(worktreeTask.id, { repository: state.repository });
    const inventory = await state.core.workspaceInventory();
    assert.deepEqual(inventory.registered.map(({ taskId, kind }) => ({ taskId, kind }))
      .sort((left, right) => left.taskId.localeCompare(right.taskId)),
      [{ taskId: copyTask.id, kind: 'copy' }, { taskId: worktreeTask.id, kind: 'worktree' }]
        .sort((left, right) => left.taskId.localeCompare(right.taskId)));
    assert.equal((await state.core.verifyWorkspace(copyTask.id)).matchesBaseline, true);
    const changes = await state.core.inspectWorktreeChanges(worktreeTask.id);
    assert.deepEqual(changes.changedFiles, []);
    assert.equal(changes.diff, '');
    await state.core.discardWorkspace(copyTask.id);
    await state.core.discardWorkspace(worktreeTask.id);
    assert.deepEqual((await state.core.workspaceInventory()).registered, []);
  });
});
