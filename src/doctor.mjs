// Zero-model installation diagnostic: checks every prerequisite the
// production path needs and reports findings without changing anything.
import { access, lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const fileURL = (path) => fileURLToPath(new URL(path, import.meta.url));
const checks = [];
const check = async (name, probe) => {
  try { checks.push({ name, ok: true, ...(await probe()) }); }
  catch (error) { checks.push({ name, ok: false, detail: String(error?.message ?? error).slice(0, 300) }); }
};

await check('node-version', async () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 15) throw new Error(`Node ${process.versions.node}; need >=24.15.0 <25`);
  return { version: process.versions.node };
});
await check('git', async () => ({ version: (await run('git', ['--version'])).stdout.trim() }));
await check('dsh-executable', async () => {
  const executable = process.argv[2];
  if (!executable) throw new Error('pass the DSH executable path to check it');
  await access(executable);
  const asar = join(executable, '..', 'resources', 'app.asar');
  const info = await lstat(asar);
  if (!info.isFile() || info.size < 1024 * 1024) throw new Error('app.asar missing or unusually small');
  return { executable, asarBytes: info.size };
});
await check('dsh-account-home', async () => {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('account home must be a plain directory');
  return { home };
});
await check('review-login', async () => {
  const home = fileURL('../.RelayCore/codex-review-home/');
  const info = await lstat(join(home, 'auth.json'));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('auth.json missing or unusual');
  return { home };
});
await check('proxy', async () => {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (!proxy) throw new Error('no HTTP(S)_PROXY configured; direct access must be verified separately');
  return { proxy };
});
await check('port-8765', async () => {
  const { createServer } = await import('node:http');
  await new Promise((done, fail) => {
    const listener = createServer();
    listener.once('error', fail);
    listener.listen(8765, '127.0.0.1', () => listener.close(done));
  });
  return { available: true };
});

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, checks }, null, 2)}\n`);
process.exitCode = failed.length ? 1 : 0;
