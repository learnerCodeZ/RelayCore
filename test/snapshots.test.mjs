import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCore } from '../src/core.mjs';

async function withSnapshot(action) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-snapshot-test-'));
  const state = { root };
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    state.core = await openCore(root);
    state.task = await state.core.create({ title: 'Versioned review snapshot', objective: 'Set ready newline.',
      acceptance: 'Keep the source unchanged.', allowedPaths: ['message.txt'] });
    state.candidate = await state.core.prepareWorkspace(state.task.id);
    await writeFile(join(state.candidate.workspace, 'message.txt'), 'ready\n');
    state.snapshot = await state.core.prepareReviewWorkspace(state.task.id);
    await action(state);
  } finally {
    state.core?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

test('registered review versions survive reopen and remain bound to their own candidate', async () => {
  await withSnapshot(async (state) => {
    const first = await state.core.verifyReviewedWorkspace(state.task.id, state.snapshot.snapshotId);
    assert.equal(first.sha256, state.snapshot.sha256);
    assert.equal(first.revision, 1);
    await writeFile(join(state.candidate.workspace, 'message.txt'), 'next version\n');
    const second = await state.core.prepareReviewWorkspace(state.task.id);
    assert.notEqual(second.snapshotId, first.snapshotId);
    await assert.rejects(state.core.verifyReviewedWorkspace(state.task.id, first.snapshotId), /Candidate changed/);
    const checked = await state.core.verifyReviewedWorkspace(state.task.id, second.snapshotId);
    assert.equal(checked.sha256, second.sha256);
    assert.notEqual(checked.candidateSha256, first.candidateSha256);
    assert.equal(JSON.parse(await readFile(state.snapshot.inputPath, 'utf8')).files[0].after, 'ready\n');
    state.core.close();
    state.core = undefined;
    state.core = await openCore(state.root);
    const snapshots = state.core.reviewSnapshots(state.task.id);
    assert.deepEqual(snapshots.map((snapshot) => snapshot.snapshotId), [first.snapshotId, second.snapshotId]);
    assert.equal((await state.core.verifyReviewedWorkspace(state.task.id, second.snapshotId)).sha256, second.sha256);
    assert.equal(state.core.events(state.task.id).filter((event) => event.kind === 'review.snapshot_created').length, 2);
    assert.equal(state.core.get(state.task.id).state, 'DRAFT');
    assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), 'pending\n');
    const another = await state.core.create({ title: 'Another task', objective: 'No change.', acceptance: 'No calls.' });
    await assert.rejects(state.core.verifyReviewedWorkspace(another.id, second.snapshotId), /Invalid review snapshot ID/);
    await assert.rejects(state.core.verifyReviewedWorkspace(state.task.id, '../outside'), /Invalid review snapshot ID/);
    await assert.rejects(state.core.verifyReviewedWorkspace(state.task.id, { ...second }), /Invalid review snapshot ID/);
  });
});

test('registered snapshots reject changed files, links, contracts and source conflicts', async () => {
  for (const scenario of ['candidate-content', 'candidate-missing', 'candidate-extra', 'candidate-link',
    'snapshot-content', 'snapshot-missing', 'snapshot-link', 'contract', 'revision', 'source-conflict']) {
    await withSnapshot(async (state) => {
      let expected;
      if (scenario === 'candidate-content') {
        await writeFile(join(state.candidate.workspace, 'message.txt'), 'changed\n');
        expected = /Candidate changed/;
      } else if (scenario === 'candidate-missing') {
        await rm(join(state.candidate.workspace, 'message.txt'));
        expected = /Workspace file is missing/;
      } else if (scenario === 'candidate-extra') {
        await writeFile(join(state.candidate.workspace, 'extra.txt'), 'not reviewed');
        expected = /Unexpected workspace file/;
      } else if (scenario === 'candidate-link' || scenario === 'snapshot-link') {
        const directory = scenario === 'candidate-link' ? state.candidate.workspace : state.snapshot.workspace;
        const moved = `${directory}-original`;
        await rename(directory, moved);
        await symlink(moved, directory, 'junction');
        expected = /not a plain directory/;
      } else if (scenario === 'snapshot-content') {
        const packet = JSON.parse(await readFile(state.snapshot.inputPath, 'utf8'));
        packet.files[0].after = 'forged replacement\n';
        await writeFile(state.snapshot.inputPath, JSON.stringify(packet));
        expected = /Review snapshot changed/;
      } else if (scenario === 'snapshot-missing') {
        await rm(state.snapshot.inputPath);
        expected = { code: 'ENOENT' };
      } else if (scenario === 'contract' || scenario === 'revision') {
        const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
        try {
          const contract = { ...state.task.contract, ...(scenario === 'revision' ? { revision: 2 } : { objective: 'Changed after snapshot.' }) };
          database.prepare('UPDATE tasks SET contract=? WHERE id=?').run(JSON.stringify(contract), state.task.id);
        } finally { database.close(); }
        expected = /Review snapshot contract changed/;
      } else {
        await writeFile(join(state.root, 'message.txt'), 'user edit\n');
        expected = /Source conflict/;
      }
      await assert.rejects(state.core.verifyReviewedWorkspace(state.task.id, state.snapshot.snapshotId), expected, scenario);
      assert.equal(state.core.get(state.task.id).state, 'DRAFT');
      assert.equal(state.core.events(state.task.id).some((event) => event.kind.startsWith('model_turn.requested.')), false);
      assert.equal(await readFile(join(state.root, 'message.txt'), 'utf8'), scenario === 'source-conflict' ? 'user edit\n' : 'pending\n');
    });
  }
});

test('an additive registry upgrade preserves tasks and never adopts an unregistered snapshot', async () => {
  await withSnapshot(async (state) => {
    const events = state.core.events(state.task.id).map((event) => event.kind);
    const contents = await readFile(state.snapshot.inputPath, 'utf8');
    state.core.close();
    state.core = undefined;
    const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
    try { database.exec('DROP TABLE review_snapshots'); }
    finally { database.close(); }
    state.core = await openCore(state.root);
    assert.deepEqual(state.core.reviewSnapshots(state.task.id), []);
    assert.deepEqual(state.core.events(state.task.id).map((event) => event.kind), events);
    assert.deepEqual(state.core.get(state.task.id).contract, state.task.contract);
    await assert.rejects(state.core.verifyReviewedWorkspace(state.task.id, state.snapshot.snapshotId), /not registered/);
    assert.equal(await readFile(state.snapshot.inputPath, 'utf8'), contents);
    const replacement = await state.core.prepareReviewWorkspace(state.task.id);
    assert.equal((await state.core.verifyReviewedWorkspace(state.task.id, replacement.snapshotId)).sha256, replacement.sha256);
    assert.notEqual(replacement.snapshotId, state.snapshot.snapshotId);
  });
});

test('snapshot registration failure rolls back the event and removes its partial directory', async () => {
  await withSnapshot(async (state) => {
    const before = await readdir(dirname(state.snapshot.workspace));
    const database = new DatabaseSync(join(state.root, '.RelayCore', 'bridge', 'state.sqlite'));
    try {
      database.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON review_snapshots BEGIN SELECT RAISE(ABORT, 'snapshot registry unavailable'); END;");
      await assert.rejects(state.core.prepareReviewWorkspace(state.task.id), /snapshot registry unavailable/);
      assert.deepEqual(await readdir(dirname(state.snapshot.workspace)), before);
      assert.equal(state.core.reviewSnapshots(state.task.id).length, 1);
      assert.equal(state.core.events(state.task.id).filter((event) => event.kind === 'review.snapshot_created').length, 1);
      database.exec('DROP TRIGGER reject_snapshot');
    } finally { database.close(); }
  });
});
