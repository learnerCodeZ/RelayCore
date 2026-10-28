import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../src/daemon.mjs';
import { runDshReviewTask } from '../src/dsh.mjs';
import { openMcpClient } from '../src/mcp-client.mjs';

const args = process.argv.slice(2);
const [mode = '--check-only', executable, requestedWorkspace, consent] = args;
const real = mode === '--run-task';
if (real && consent !== '--allow-unknown-cost') throw new Error('Real dispatch requires explicit --allow-unknown-cost; no model was called');
if ((!real && (mode !== '--check-only' || args.length > 1)) || (real && args.length !== 4)) {
  throw new Error('Usage: node scripts/probe-dispatch.mjs [--check-only] | --run-task <DSH executable> <account workspace> --allow-unknown-cost');
}
const accountHome = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
const authHome = fileURLToPath(new URL('../.RelayCore/codex-review-home/', import.meta.url));
if (real) {
  if (!isAbsolute(executable) || !isAbsolute(requestedWorkspace)) throw new Error('Select absolute DSH executable and account workspace paths');
  for (const directory of [accountHome, requestedWorkspace, authHome]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Account paths must be plain directories');
  }
  if (!(await lstat(executable)).isFile()) throw new Error('DSH executable must be a file');
  const status = spawnSync(process.execPath, [fileURLToPath(new URL('./login-codex-review.mjs', import.meta.url)), '--status'],
    { stdio: 'ignore', timeout: 15000, windowsHide: true });
  if (status.status !== 0) throw new Error('Dedicated review login is unavailable; no model was called');
}
const local = fileURLToPath(new URL('../local/', import.meta.url));
await mkdir(local, { recursive: true });
if ((await lstat(local)).isSymbolicLink()) throw new Error('Diagnostic parent must not be a link');
const root = await mkdtemp(join(local, 'relaycore-dispatch-probe-'));
const executionLimits = { maxDurationSeconds: real ? 600 : 30, maxModelTurns: 2 };
const token = randomBytes(32).toString('hex');
const previousToken = process.env.RELAYCORE_TOKEN;
const diagnostic = { mode, adapters: real ? 'native-account' : 'in-memory-fakes', executionLimits,
  cost: real ? 'unknown' : 'no-model-calls', outcome: 'dispatch-not-completed', stage: 'startup',
  evidenceRoot: root, automaticRetry: false, externalCancellationConfirmed: false };
let daemon;
let client;
let task;
try {
  await writeFile(join(root, 'message.txt'), 'pending\n', { flag: 'wx' });
  process.env.RELAYCORE_TOKEN = token;
  daemon = await startDaemon(root, { port: 0,
    executionPolicy: { ...executionLimits, costMode: real ? 'unknown' : 'no-model' },
    executor: async (running, context, core) => {
      await core.prepareWorkspace(running.id);
      return runDshReviewTask({ core, task: running, context, executable: real ? executable : process.execPath,
        ...(real ? { accountHome, accountWorkspace: requestedWorkspace, authHome } : {}) }, {
        ...(!real ? {
          async propose({ context: execution }) {
            execution.recordSession('dsh', 'diagnostic-fake-dsh');
            execution.beginModelTurn('dsh');
            return { sessionId: 'diagnostic-fake-dsh', summary: 'Exact text replacement.', files: [{ path: 'message.txt', contents: 'ready\n' }] };
          },
          async review({ review, context: execution }) {
            execution.recordSession('codex', 'diagnostic-fake-review');
            execution.beginModelTurn('codex');
            return { verdict: 'approved', sessionId: 'diagnostic-fake-review', rationale: 'Simulated approval; not a model result.', packetSha256: review.sha256 };
          }
        } : {}),
        async verifyCandidate({ files, workspace }) {
          const passed = files.length === 1 && files[0].path === 'message.txt' && files[0].after === 'ready\n' &&
            await readFile(join(workspace, 'message.txt'), 'utf8') === 'ready\n';
          return { checker: 'exact-message-check', checks: [{ name: 'message.txt is exactly ready with newline', passed }] };
        }
      });
    }
  });
  diagnostic.stage = 'mcp-connect';
  client = openMcpClient({ root, port: daemon.server.address().port, token });
  await client.rpc('initialize', { protocolVersion: '2025-11-25' });
  task = await client.tool('create_task', { title: 'Isolated controlled dispatch diagnostic',
    objective: 'Change message.txt to exactly ready followed by one newline.',
    acceptance: 'Only the candidate changes; the host exact-text check passes; the source stays pending newline.',
    allowedPaths: ['message.txt'], executionLimits });
  diagnostic.stage = 'authorization';
  await assert.rejects(client.tool('dispatch_task', { id: task.id }), /local execution authorization/);
  diagnostic.unapprovedDispatchRefused = true;
  daemon.core.authorizeExecution(task.id, { expiresAt: new Date(Date.now() + executionLimits.maxDurationSeconds * 1000).toISOString(),
    ...(real ? { allowUnknownCost: true } : {}) });
  diagnostic.stage = 'dispatch';
  assert.equal((await client.tool('dispatch_task', { id: task.id })).state, 'QUEUED');
  const deadline = Date.now() + executionLimits.maxDurationSeconds * 1000 + 5000;
  let final;
  do {
    final = await client.tool('task_status', { id: task.id });
    if (!['QUEUED', 'RUNNING'].includes(final.state)) break;
    await setTimeout(50);
  } while (Date.now() < deadline);
  diagnostic.stage = 'verify-result';
  assert.equal(final.state, 'COMPLETED', 'Inspect retained records; do not retry automatically');
  assert.equal(await readFile(join(root, 'message.txt'), 'utf8'), 'pending\n');
  const candidate = await daemon.core.inspectWorkspaceChanges(task.id);
  assert.deepEqual(candidate.changedPaths, ['message.txt']);
  assert.equal(await readFile(join(candidate.workspace, 'message.txt'), 'utf8'), 'ready\n');
  const reviews = join(root, '.RelayCore', 'reviews');
  const entries = await readdir(reviews);
  assert.equal(entries.length, 1);
  const contents = await readFile(join(reviews, entries[0], 'REVIEW.json'), 'utf8');
  const packet = JSON.parse(contents);
  assert.equal(packet.testEvidence.origin, 'relaycore-host');
  assert.equal(packet.testEvidence.checks[0].passed, true);
  assert.equal(packet.testEvidence.candidateSha256,
    createHash('sha256').update(JSON.stringify([{ path: 'message.txt', contents: 'ready\n' }])).digest('hex'));
  const reviewSha256 = createHash('sha256').update(contents).digest('hex');
  const handoff = await readFile(join(root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md'), 'utf8');
  assert.equal(handoff, final.result);
  assert.ok(handoff.includes(`Review SHA-256: ${reviewSha256}`));
  assert.match(handoff, /Candidate checks: 1 passed/);
  const snapshots = daemon.core.reviewSnapshots(task.id);
  assert.equal(snapshots.length, 1);
  const snapshot = await daemon.core.verifyReviewedWorkspace(task.id, snapshots[0].snapshotId);
  assert.equal(snapshot.sha256, reviewSha256);
  assert.equal(snapshot.candidateSha256, packet.testEvidence.candidateSha256);
  assert.ok(handoff.includes(`Snapshot ID: ${snapshot.snapshotId}`));
  diagnostic.reviewSnapshot = snapshot;
  diagnostic.reviewSha256 = reviewSha256;
  diagnostic.testEvidence = packet.testEvidence;
  // Controlled integration and rollback on the real reviewed candidate: the
  // source ends back at its baseline, proving the merge path is reversible.
  diagnostic.stage = 'integration';
  const integration = await daemon.core.integrateWorkspace(task.id, snapshot.snapshotId);
  assert.deepEqual(integration.files, ['message.txt']);
  assert.equal(await readFile(join(root, 'message.txt'), 'utf8'), 'ready\n');
  diagnostic.integration = { files: integration.files, manifestSha256: integration.manifestSha256 };
  diagnostic.stage = 'rollback';
  await daemon.core.rollbackIntegration(task.id);
  assert.equal(await readFile(join(root, 'message.txt'), 'utf8'), 'pending\n');
  assert.deepEqual(daemon.core.events(task.id).filter((event) => event.kind === 'integration.rolled_back').length, 1);
  diagnostic.rolledBack = true;
  diagnostic.outcome = real ? 'reviewed-integrated-rolled-back' : 'simulated-reviewed-integrated-rolled-back';
  diagnostic.stage = 'completed';
} catch (error) {
  diagnostic.errorDetail = String(error?.stack ?? error).slice(0, 1200);
  process.exitCode = 1;
} finally {
  if (task && daemon) {
    if (['QUEUED', 'RUNNING'].includes(daemon.core.get(task.id).state)) daemon.core.stop(task.id);
    const final = daemon.core.get(task.id);
    diagnostic.taskId = task.id;
    diagnostic.state = final.state;
    diagnostic.sessions = final.sessions;
    diagnostic.authorizationConsumed = Boolean(final.executionAuthorization?.consumedAt);
    diagnostic.requestedBridgePrompts = daemon.core.events(task.id).filter((entry) => entry.kind.startsWith('model_turn.requested.')).length;
    diagnostic.sourceUnchanged = await readFile(join(root, 'message.txt'), 'utf8').then((contents) => contents === 'pending\n', () => false);
    diagnostic.candidateMatches = await readFile(join(root, '.RelayCore', 'workspaces', task.id, 'message.txt'), 'utf8').then((contents) => contents === 'ready\n', () => false);
  }
  if (!real) diagnostic.realModelPrompts = 0;
  try { await client?.close(); }
  finally {
    try { await daemon?.close(); }
    finally {
      if (previousToken === undefined) delete process.env.RELAYCORE_TOKEN;
      else process.env.RELAYCORE_TOKEN = previousToken;
      await writeFile(join(root, 'DIAGNOSTIC.json'), JSON.stringify(diagnostic, null, 2), { flag: 'wx' });
      process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
    }
  }
}
