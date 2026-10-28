import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function withFixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-login-status-test-'));
  try {
    for (const directory of ['scripts', 'src', 'node_modules/@openai/codex/bin']) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await copyFile(fileURLToPath(new URL('../scripts/login-codex-review.mjs', import.meta.url)), join(root, 'scripts/login-codex-review.mjs'));
    await writeFile(join(root, 'src/review.mjs'), 'export const codexReviewEnvironment = (profile) => ({ ...process.env, CODEX_HOME: profile });\n');
    await writeFile(join(root, 'node_modules/@openai/codex/bin/codex.js'), 'process.exit(0);\n');
    await writeFile(join(root, 'deny-acl.cjs'), "require('node:child_process').execFileSync = () => { throw new Error('Unexpected ACL modification'); }; require('node:module').syncBuiltinESMExports();\n");
    await action(root);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

test('review login status leaves an existing profile and credential untouched', async () => {
  await withFixture(async (root) => {
    const profile = join(root, '.RelayCore', 'codex-review-home');
    await mkdir(profile, { recursive: true });
    const credential = join(profile, 'auth.json');
    await writeFile(credential, 'test-only fixture');
    const before = await lstat(credential);
    const result = spawnSync(process.execPath, ['--require', join(root, 'deny-acl.cjs'), join(root, 'scripts/login-codex-review.mjs'), '--status'], {
      cwd: root, encoding: 'utf8', timeout: 8000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { authenticated: true });
    assert.equal(await readFile(credential, 'utf8'), 'test-only fixture');
    assert.equal((await lstat(credential)).mtimeMs, before.mtimeMs);
  });
});

test('review login status does not create a missing profile', async () => {
  await withFixture(async (root) => {
    const result = spawnSync(process.execPath, [join(root, 'scripts/login-codex-review.mjs'), '--status'], {
      cwd: root, encoding: 'utf8', timeout: 8000, windowsHide: true
    });
    assert.notEqual(result.status, 0);
    await assert.rejects(lstat(join(root, '.RelayCore')), { code: 'ENOENT' });
  });
});
