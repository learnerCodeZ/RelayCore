import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getControlToken } from '../src/auth.mjs';

test('Windows local credential survives reload and corrupted data is not replaced', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-auth-'));
  const previous = process.env.RELAYCORE_TOKEN;
  delete process.env.RELAYCORE_TOKEN;
  try {
    await assert.rejects(getControlToken(root), /start the RelayCore Daemon/);
    const token = await getControlToken(root, { create: true });
    assert.match(token, /^[0-9a-f]{64}$/);
    const path = join(root, '.RelayCore', 'bridge', 'control-token.dpapi');
    const encrypted = await readFile(path, 'utf8');
    assert.equal(encrypted.includes(token), false);
    assert.equal((await getControlToken(root)) === token, true);
    assert.equal((await getControlToken(root, { create: true })) === token, true);
    await writeFile(path, 'invalid protected data');
    await assert.rejects(getControlToken(root, { create: true }), /has not been replaced/);
    assert.equal(await readFile(path, 'utf8'), 'invalid protected data');
    const corrupted = Buffer.from('not a DPAPI blob').toString('base64');
    await writeFile(path, corrupted);
    await assert.rejects(getControlToken(root, { create: true }), /protection failed/);
    assert.equal(await readFile(path, 'utf8'), corrupted);
    process.env.RELAYCORE_TOKEN = 'short';
    await assert.rejects(getControlToken(root), /at least 32/);
  } finally {
    if (previous === undefined) delete process.env.RELAYCORE_TOKEN;
    else process.env.RELAYCORE_TOKEN = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows local credential refuses a linked runtime directory', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-auth-link-'));
  const previous = process.env.RELAYCORE_TOKEN;
  delete process.env.RELAYCORE_TOKEN;
  try {
    const target = join(root, 'target');
    await mkdir(target);
    await symlink(target, join(root, '.RelayCore'), 'junction');
    await assert.rejects(getControlToken(root, { create: true }), /plain directory/);
    assert.deepEqual(await readdir(target), []);
  } finally {
    if (previous === undefined) delete process.env.RELAYCORE_TOKEN;
    else process.env.RELAYCORE_TOKEN = previous;
    await rm(root, { recursive: true, force: true });
  }
});
