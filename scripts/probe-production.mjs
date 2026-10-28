// Production-path diagnostic: starts the daemon exactly like `npm start`
// would (environment-driven execution), drives it through the MCP surface and
// the control CLI, runs one real DSH account loop, then integrates and rolls
// back through the CLI. Requires explicit --allow-unknown-cost.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openMcpClient } from '../src/mcp-client.mjs';

const args = process.argv.slice(2);
const [executable, requestedWorkspace, consent] = args;
if (consent !== '--allow-unknown-cost') {
  throw new Error('Production-path diagnostic calls real models; pass --allow-unknown-cost explicitly');
}
const workspace = resolve(requestedWorkspace ?? 'D:/MYCODE/RCtest');
const accountHome = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
const authHome = fileURLToPath(new URL('../.RelayCore/codex-review-home/', import.meta.url));
if (!isAbsolute(executable ?? '')) throw new Error('Pass the DSH executable path');
for (const directory of [accountHome, workspace, authHome]) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Account paths must be plain directories');
}
const status = spawnSync(process.execPath, [fileURLToPath(new URL('./login-codex-review.mjs', import.meta.url)), '--status'],
  { stdio: 'ignore', timeout: 15000, windowsHide: true });
if (status.status !== 0) throw new Error('Dedicated review login unavailable; no model was called');

const local = fileURLToPath(new URL('../local/', import.meta.url));
await mkdir(local, { recursive: true });
const root = await mkdtemp(join(local, 'relaycore-production-probe-'));
const limits = { maxDurationSeconds: 600, maxModelTurns: 2 };
const token = randomBytes(32).toString('hex');
const diagnostic = { mode: 'production-path', cost: 'unknown', outcome: 'production-path-not-completed', stage: 'startup',
  evidenceRoot: root, automaticRetry: false };
let child;
let childClosed;
let client;
let taskId;
let daemonStderr = '';
try {
  await writeFile(join(root, 'message.txt'), 'pending\n', { flag: 'wx' });
  // The production daemon is started through the same entry the operator uses,
  // with execution enabled only via environment variables.
  const port = await new Promise((resolvePort, rejectPort) => {
    const listener = createServer();
    listener.once('error', rejectPort);
    listener.listen(0, '127.0.0.1', () => {
      const selectedPort = listener.address().port;
      listener.close((error) => error ? rejectPort(error) : resolvePort(selectedPort));
    });
  });
  child = spawn(process.execPath, [fileURLToPath(new URL('../src/daemon.mjs', import.meta.url))], {
    cwd: root, windowsHide: true,
    env: { ...process.env, RELAYCORE_ROOT: root, RELAYCORE_TOKEN: token,
      RELAYCORE_PORT: String(port), RELAYCORE_EXECUTION: 'account', RELAYCORE_DSH_EXE: executable, RELAYCORE_ACCOUNT_WORKSPACE: workspace,
      RELAYCORE_MAX_DURATION: String(limits.maxDurationSeconds), RELAYCORE_MAX_TURNS: String(limits.maxModelTurns) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  childClosed = new Promise((done) => child.once('close', done));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { daemonStderr += chunk; });
  const portLine = await new Promise((resolvePort, rejectPort) => {
    const fail = () => rejectPort(new Error(`Daemon did not start; stderr: ${daemonStderr.slice(0, 300)}`));
    const timer = setTimeout(fail, 15000);
    child.once('error', fail);
    child.once('exit', fail);
    child.stderr.on('data', () => {
      const match = /control server on 127\.0\.0\.1:(\d+); ([^\r\n]+)/.exec(daemonStderr);
      if (match) { clearTimeout(timer); resolvePort({ port: Number(match[1]), note: match[2] }); }
    });
    childClosed.then(() => clearTimeout(timer));
  });
  diagnostic.daemonNote = portLine.note;
  assert.match(portLine.note, /account execution enabled/);
  client = openMcpClient({ root, port: portLine.port, token });
  await client.rpc('initialize', { protocolVersion: '2025-11-25' });
  diagnostic.stage = 'mcp-create';
  taskId = (await client.tool('create_task', { title: 'Production path diagnostic',
    objective: 'Change message.txt to exactly ready followed by one newline.',
    acceptance: 'Only the candidate changes; the source stays pending newline.', allowedPaths: ['message.txt'],
    executionLimits: limits })).id;
  diagnostic.stage = 'cli-authorize';
  const authorize = spawnSync(process.execPath, [fileURLToPath(new URL('../src/control.mjs', import.meta.url)),
    'authorize', taskId, String(limits.maxDurationSeconds), '--allow-unknown-cost'], { encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, RELAYCORE_ROOT: root, RELAYCORE_PORT: String(portLine.port), RELAYCORE_TOKEN: token } });
  if (authorize.status !== 0) throw new Error(`CLI authorize failed: ${authorize.stderr.slice(0, 300)}`);
  diagnostic.stage = 'mcp-dispatch';
  assert.equal((await client.tool('dispatch_task', { id: taskId })).state, 'QUEUED');
  const deadline = Date.now() + limits.maxDurationSeconds * 1000 + 5000;
  let final;
  do {
    final = await client.tool('task_status', { id: taskId });
    if (!['QUEUED', 'RUNNING'].includes(final.state)) break;
    await delay(50);
  } while (Date.now() < deadline);
  assert.equal(final.state, 'COMPLETED', `Inspect retained records; do not retry automatically; stderr: ${daemonStderr.slice(0, 300)}`);
  diagnostic.stage = 'cli-integrate';
  const database = new DatabaseSync(join(root, '.RelayCore', 'bridge', 'state.sqlite'), { readOnly: true });
  let reviewSnapshots;
  try { reviewSnapshots = database.prepare('SELECT snapshot_id FROM review_snapshots WHERE task_id=?').all(taskId); }
  finally { database.close(); }
  assert.equal(reviewSnapshots.length, 1, 'the real loop must register exactly one review snapshot');
  const snapshotId = reviewSnapshots[0].snapshot_id;
  assert.ok(snapshotId, 'the real loop must register a review snapshot');
  const integrate = spawnSync(process.execPath, [fileURLToPath(new URL('../src/control.mjs', import.meta.url)),
    'integrate', taskId, snapshotId], { encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, RELAYCORE_ROOT: root, RELAYCORE_PORT: String(portLine.port), RELAYCORE_TOKEN: token } });
  if (integrate.status !== 0) throw new Error(`CLI integrate failed: ${integrate.stderr.slice(0, 400)}`);
  assert.equal(await readFile(join(root, 'message.txt'), 'utf8'), 'ready\n');
  diagnostic.stage = 'cli-rollback';
  const rollback = spawnSync(process.execPath, [fileURLToPath(new URL('../src/control.mjs', import.meta.url)),
    'rollback', taskId], { encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, RELAYCORE_ROOT: root, RELAYCORE_PORT: String(portLine.port), RELAYCORE_TOKEN: token } });
  if (rollback.status !== 0) throw new Error(`CLI rollback failed: ${rollback.stderr.slice(0, 400)}`);
  assert.equal(await readFile(join(root, 'message.txt'), 'utf8'), 'pending\n');
  diagnostic.taskId = taskId;
  diagnostic.state = final.state;
  diagnostic.sessions = final.sessions;
  diagnostic.snapshotId = snapshotId;
  diagnostic.requestedBridgePrompts = (await client.tool('task_events', { id: taskId }))
    .filter((entry) => entry.kind.startsWith('model_turn.requested.')).length;
  diagnostic.outcome = 'production-path-reviewed-integrated-rolled-back';
  diagnostic.stage = 'completed';
} catch (error) {
  diagnostic.errorDetail = String(error?.stack ?? error).slice(0, 1200);
  process.exitCode = 1;
} finally {
  try { await client?.close(); }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([childClosed, delay(3000, undefined, { ref: false })]);
    }
    if (daemonStderr.trim()) await writeFile(join(root, 'daemon-stderr.log'), daemonStderr, { flag: 'wx' });
    await writeFile(join(root, 'DIAGNOSTIC.json'), JSON.stringify(diagnostic, null, 2), { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
    process.stderr.write(`Production-path evidence retained at ${root}\n`);
  }
}
