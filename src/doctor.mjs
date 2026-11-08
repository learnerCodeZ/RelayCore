// Zero-model installation diagnostic: resolves the production configuration
// exactly the way a daemon start would, checks the hard prerequisites that
// would block startup, and reports soft conditions (proxy, review login,
// port ownership) as warnings or info instead of failures. Never prints
// secrets: proxy URLs are reduced to their host part.
import { access, lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { productionExecution } from './daemon.mjs';

const run = promisify(execFile);

const fileURL = (path) => fileURLToPath(new URL(path, import.meta.url));
const fileURLToPath = (url) => import('node:url').then((module) => module.fileURLToPath(url));

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

// The execution config resolves exactly like a daemon start: env first, then
// .RelayCore/bridge/config.json. Disabled is a normal first-run state, not a
// failure; enabled-but-unusable paths are the real errors.
const root = process.env.RELAYCORE_ROOT ?? process.cwd();
let production = null;
await check('execution-config', async () => {
  let config = {};
  try { config = JSON.parse(await readFile(join(root, '.RelayCore', 'bridge', 'config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  production = productionExecution(root, config);
  if (!production.executor) return { state: 'disabled', note: production.note };
  const executable = process.env.RELAYCORE_DSH_EXE?.trim() || config.dshExe;
  const workspace = process.env.RELAYCORE_ACCOUNT_WORKSPACE?.trim() || config.accountWorkspace;
  await access(executable);
  const info = await lstat(workspace);
  if (!info.isDirectory()) throw new Error('account workspace is not a directory');
  const asar = join(executable, '..', 'resources', 'app.asar');
  const asarInfo = await lstat(asar);
  if (!asarInfo.isFile() || asarInfo.size < 1024 * 1024) throw new Error('app.asar missing or unusually small');
  return { state: 'enabled', note: production.note };
});

await check('dsh-account-home', async () => {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('account home must be a plain directory');
  return { home };
});

await check('review-login', async () => {
  const home = process.env.RELAYCORE_REVIEW_AUTH_HOME?.trim() || await fileURL('../.RelayCore/codex-review-home/');
  let info;
  try { info = await lstat(join(home, 'auth.json')); }
  catch {
    return { state: 'warning', detail: 'review login not initialized yet; run `npm run login:review` before the first real dispatch' };
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('auth.json missing or unusual');
  return { state: 'ready' };
});

await check('proxy', async () => {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (!proxy) {
    return { state: 'warning', detail: 'no HTTP(S)_PROXY set; if the model services need one, set it before dispatching' };
  }
  let host = proxy;
  try { host = new URL(proxy).host; } catch { /* keep the raw value out of the report */ }
  return { state: 'set', host };
});

await check('relaycore-port', async () => {
  const { createServer } = await import('node:http');
  const port = Number(process.env.RELAYCORE_PORT ?? 8765);
  try {
    await new Promise((done, fail) => {
      const listener = createServer();
      listener.once('error', fail);
      listener.listen(port, '127.0.0.1', () => listener.close(done));
    });
    return { state: 'available' };
  } catch {
    // Bind refused: is the RelayCore daemon itself already serving here?
    const answer = await fetch(`http://127.0.0.1:${port}/ui`, { signal: AbortSignal.timeout(2000) }).then((response) => response.status, () => 0);
    if (answer === 200) return { state: 'running', detail: 'a RelayCore daemon is already serving this port' };
    return { state: 'warning', detail: `port ${port} is occupied by another program; set RELAYCORE_PORT to change it` };
  }
});

const failed = checks.filter((entry) => !entry.ok);
const warnings = checks.filter((entry) => entry.ok && entry.state === 'warning');
process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, failed: failed.length, warnings: warnings.length, checks }, null, 2)}\n`);
process.exitCode = failed.length ? 1 : 0;
