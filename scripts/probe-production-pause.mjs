// Production-path pause/resume diagnostic: drives the real account DSH loop
// through one in-flight pause, asserting that the native prompt is
// interrupted, budgets accumulate across the pause, and the resumed turn
// completes against the real model. The Codex review step is expected to be
// refused while the review account is out of quota; that outcome still proves
// the pause/resume semantics. Requires --allow-unknown-cost.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openMcpClient } from '../src/mcp-client.mjs';

const args = process.argv.slice(2);
const [executable, requestedWorkspace, consent] = args;
if (consent !== '--allow-unknown-cost') {
  throw new Error('Pause diagnostic calls real models; pass --allow-unknown-cost explicitly');
}
const workspace = resolve(requestedWorkspace ?? 'D:/MYCODE/RCtest');
const accountHome = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
if (!isAbsolute(executable ?? '')) throw new Error('Pass the DSH executable path');
for (const directory of [accountHome, workspace]) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Account paths must be plain directories');
}

const local = fileURLToPath(new URL('../local/', import.meta.url));
await mkdir(local, { recursive: true });
const root = await mkdtemp(join(local, 'relaycore-pause-prod-'));
const limits = { maxDurationSeconds: 600, maxModelTurns: 3 };
const token = randomBytes(32).toString('hex');
const previous = { ...process.env };
const diagnostic = { mode: 'production-pause', cost: 'unknown', outcome: 'production-pause-not-completed',
  stage: 'startup', evidenceRoot: root, automaticRetry: false };
let child;
let client;
let taskId;
let daemonStderr = '';
let childClosed;
try {
  await writeFile(join(root, 'message.txt'), 'pending\n', { flag: 'wx' });
  child = spawn(process.execPath, [fileURLToPath(new URL('../src/daemon.mjs', import.meta.url))], {
    cwd: root, windowsHide: true,
    env: { ...process.env, RELAYCORE_ROOT: root, RELAYCORE_TOKEN: token,
      RELAYCORE_EXECUTION: 'account', RELAYCORE_DSH_EXE: executable, RELAYCORE_ACCOUNT_WORKSPACE: workspace,
      RELAYCORE_MAX_DURATION: String(limits.maxDurationSeconds), RELAYCORE_MAX_TURNS: String(limits.maxModelTurns) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  childClosed = new Promise((done) => child.once('close', done));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { daemonStderr += chunk; });
  const port = await new Promise((resolvePort, rejectPort) => {
    const timer = setTimeout(() => rejectPort(new Error(`Daemon did not start; stderr: ${daemonStderr.slice(0, 300)}`)), 15000);
    child.stderr.on('data', (chunk) => {
      const match = /control server on 127\.0\.0\.1:(\d+); ([^\r\n]+)/.exec(daemonStderr);
      if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
    });
  });
  diagnostic.stage = 'mcp-create';
  client = openMcpClient({ root, port, token });
  await client.rpc('initialize', { protocolVersion: '2025-11-25' });
  taskId = (await client.tool('create_task', { title: 'Production pause diagnostic',
    objective: 'Change message.txt to exactly ready followed by one newline.',
    acceptance: 'Only the candidate changes; the source stays pending newline.', allowedPaths: ['message.txt'],
    executionLimits: limits })).id;
  diagnostic.stage = 'cli-authorize';
  const cliEnv = { ...process.env, RELAYCORE_ROOT: root, RELAYCORE_PORT: String(port), RELAYCORE_TOKEN: token };
  const cli = (parameters) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/control.mjs', import.meta.url)), ...parameters],
      { encoding: 'utf8', timeout: 20000, windowsHide: true, env: cliEnv });
    if (result.status !== 0) throw new Error(`CLI ${parameters[0]} failed: ${(result.stderr || result.stdout || '').slice(0, 400)}`);
    return result;
  };
  cli(['authorize', taskId, String(limits.maxDurationSeconds), '--allow-unknown-cost']);
  diagnostic.stage = 'dispatch';
  assert.equal((await client.tool('dispatch_task', { id: taskId })).state, 'QUEUED');
  diagnostic.stage = 'await-dsh-turn';
  const kinds = async () => (await client.tool('task_events', { id: taskId })).map((event) => event.kind);
  let dshTurns = 0;
  for (let attempt = 0; attempt < 400; attempt++) {
    dshTurns = (await kinds()).filter((kind) => kind === 'model_turn.requested.dsh').length;
    if (dshTurns >= 1) break;
    await delay(50);
  }
  assert.equal(dshTurns, 1, 'the real DSH turn must start before the pause');
  await delay(300); // pause while the native model turn is still in flight
  diagnostic.stage = 'pause';
  const paused = await client.tool('pause_task', { id: taskId });
  assert.equal(paused.state, 'PAUSED');
  await delay(1000);
  const pausedKinds = await kinds();
  assert.equal(pausedKinds.filter((kind) => kind === 'task.paused').length, 1);
  // The model may finish the DSH turn and enter the review before the pause
  // lands; interrupting either real turn is a valid in-flight pause.
  assert.ok(pausedKinds.filter((kind) => kind.startsWith('model_turn.requested.')).length >= 1);
  diagnostic.pauseRecorded = true;
  diagnostic.stage = 'resume';
  assert.equal((await client.tool('resume_task', { id: taskId })).state, 'QUEUED');
  const deadline = Date.now() + limits.maxDurationSeconds * 1000 + 10000;
  let final;
  do {
    final = await client.tool('task_status', { id: taskId });
    if (!['QUEUED', 'RUNNING'].includes(final.state)) break;
    await delay(100);
  } while (Date.now() < deadline);
  const finalKinds = await kinds();
  diagnostic.dshTurns = finalKinds.filter((kind) => kind === 'model_turn.requested.dsh').length;
  diagnostic.codexTurns = finalKinds.filter((kind) => kind === 'model_turn.requested.codex').length;
  assert.equal(diagnostic.dshTurns, 2, 'the resumed run must spend a second real DSH turn');
  assert.equal(final.state, 'COMPLETED', `Pause/resume failed; stderr: ${daemonStderr.slice(-500)}`);
  // The real loop finished; integrate and roll back through the CLI to close
  // the production-path acceptance that the review-quota stop point left open.
  diagnostic.stage = 'cli-integrate';
  const handoffText = await readFile(join(root, '.RelayCore', '.agent-tasks', taskId, 'HANDOFF.md'), 'utf8');
  const snapshotId = /Snapshot ID: (S+)/.exec(handoffText)?.[1];
  assert.ok(snapshotId, 'a completed real loop must carry a review snapshot');
  if (cli(['integrate', taskId, snapshotId]).status !== 0) throw new Error('CLI integrate failed');
  assert.equal(await readFile(join(root, 'message.txt'), 'utf8'), 'ready\n');
  if (cli(['rollback', taskId]).status !== 0) throw new Error('CLI rollback failed');
  assert.equal(await readFile(join(root, 'message.txt'), 'utf8'), 'pending\n');
  diagnostic.snapshotId = snapshotId;
  diagnostic.state = final.state;
  diagnostic.sessions = final.sessions;
  diagnostic.outcome = 'production-pause-resume-reviewed-integrated-rolled-back';
  diagnostic.stage = 'completed';
} catch (error) {
  diagnostic.errorDetail = String(error?.stack ?? error).slice(0, 1200);
  diagnostic.tailStderr = daemonStderr.slice(-400);
  process.exitCode = 1;
} finally {
  try { await client?.close(); }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([childClosed, delay(3000, undefined, { ref: false })]);
    }
    if (daemonStderr.trim()) await writeFile(join(root, 'daemon-stderr.log'), daemonStderr, { flag: 'wx' }).catch(() => {});
    await writeFile(join(root, 'DIAGNOSTIC.json'), JSON.stringify(diagnostic, null, 2), { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
    process.stderr.write(`Production pause evidence retained at ${root}\n`);
  }
}
