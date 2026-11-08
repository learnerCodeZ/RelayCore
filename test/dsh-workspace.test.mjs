import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachSessionToDshWorkspace } from '../src/dsh-workspace.mjs';

function registryFixture(sessionIds, path) {
  return { unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'] },
    tables: { workspaces: { w1: { path, title: 'proj', sessionIds,
      createdAt: '2026-10-13T08:31:00.000Z', updatedAt: '2026-10-13T08:31:00.000Z' } } } };
}

async function withHome(action) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-dsh-workspace-'));
  try {
    const dshHome = join(root, 'dsh-home');
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await action({ root, dshHome });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('attach appends the dispatched session to the matching workspace record', async () => {
  await withHome(async ({ root, dshHome }) => {
    const workspace = join(root, 'proj');
    await mkdir(workspace);
    const registryPath = join(dshHome, 'storages', 'workspace.json');
    await writeFile(registryPath, JSON.stringify(registryFixture([], workspace), null, 2));
    const first = attachSessionToDshWorkspace({ dshHome, workspacePath: workspace, sessionId: 'session-a' });
    assert.deepEqual(first, { attached: true, already: false });
    const second = attachSessionToDshWorkspace({ dshHome, workspacePath: workspace, sessionId: 'session-a' });
    assert.deepEqual(second, { attached: true, already: true });
    const data = JSON.parse(await readFile(registryPath, 'utf8'));
    assert.deepEqual(data.tables.workspaces.w1.sessionIds, ['session-a']);
    // Unit-level keys stay intact after the attach.
    assert.deepEqual(data.unit, { name: 'workspace', version: 2 });
    assert.deepEqual(data.global, { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'] });
  });
});

test('attach never touches a foreign or malformed registry file', async () => {
  await withHome(async ({ root, dshHome }) => {
    const workspace = join(root, 'proj');
    await mkdir(workspace);
    const registryPath = join(dshHome, 'storages', 'workspace.json');
    const foreign = { hello: 'world' };
    await writeFile(registryPath, JSON.stringify(foreign));
    const result = attachSessionToDshWorkspace({ dshHome, workspacePath: workspace, sessionId: 'session-a' });
    assert.equal(result.attached, false);
    assert.match(result.reason, /not the expected workspace unit/);
    assert.deepEqual(JSON.parse(await readFile(registryPath, 'utf8')), foreign);
    await writeFile(registryPath, '{ truncated');
    const unreadable = attachSessionToDshWorkspace({ dshHome, workspacePath: workspace, sessionId: 'session-a' });
    assert.equal(unreadable.attached, false);
    assert.match(unreadable.reason, /registry unreadable/);
    assert.equal(await readFile(registryPath, 'utf8'), '{ truncated');
  });
});

test('attach reports when no workspace record matches the account workspace', async () => {
  await withHome(async ({ root, dshHome }) => {
    const workspace = join(root, 'proj');
    await mkdir(workspace);
    const registryPath = join(dshHome, 'storages', 'workspace.json');
    await writeFile(registryPath, JSON.stringify(registryFixture([], 'D:\\ELSEWHERE\\other'), null, 2));
    const missing = attachSessionToDshWorkspace({ dshHome, workspacePath: workspace, sessionId: 'session-a' });
    assert.equal(missing.attached, false);
    assert.match(missing.reason, /no workspace record matches/);
  });
});
