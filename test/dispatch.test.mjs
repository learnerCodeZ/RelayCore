import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../src/daemon.mjs';
import { runDshReviewTask } from '../src/dsh.mjs';
import { openMcpClient } from '../src/mcp-client.mjs';

async function exerciseDispatch(scenario) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-dispatch-test-'));
  const token = randomBytes(32).toString('hex');
  const originalToken = process.env.RELAYCORE_TOKEN;
  let daemon;
  let client;
  let proposals = 0;
  let reviews = 0;
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    process.env.RELAYCORE_TOKEN = token;
    daemon = await startDaemon(root, { port: 0,
      executionPolicy: { maxDurationSeconds: 30, maxModelTurns: 2, costMode: 'no-model' },
      executor: async (task, context, core) => {
        await core.prepareWorkspace(task.id);
        return runDshReviewTask({ core, task, context, executable: process.execPath }, {
          async propose({ context: execution }) {
            execution.recordSession('dsh', 'local-fake-dsh');
            execution.beginModelTurn('dsh');
            proposals++;
            if (scenario === 'stopped') await new Promise((_, reject) => {
              execution.signal.addEventListener('abort', () => reject(new Error('Fake proposal stopped')), { once: true });
            });
            return { sessionId: 'local-fake-dsh', summary: 'Exact replacement.', files: [{ path: 'message.txt', contents: 'ready\n' }] };
          },
          async verifyCandidate({ files }) {
            return { checker: 'exact-message-check', checks: [{ name: 'message.txt is exactly ready with newline', passed: scenario !== 'verification-failed' && files[0].after === 'ready\n' }] };
          },
          async review({ review, context: execution }) {
            execution.beginModelTurn('codex');
            reviews++;
            execution.recordSession('codex', 'local-fake-review');
            if (scenario === 'review-interrupted') throw new Error('Fake review stream interrupted');
            const packet = JSON.parse(await readFile(review.inputPath, 'utf8'));
            assert.equal(packet.testEvidence.origin, 'relaycore-host');
            assert.equal(packet.testEvidence.checks[0].passed, true);
            assert.equal(packet.testEvidence.candidateSha256, createHash('sha256').update(JSON.stringify([{ path: 'message.txt', contents: 'ready\n' }])).digest('hex'));
            const candidateRoot = join(root, '.RelayCore', 'workspaces', review.taskId);
            if (scenario === 'candidate-changed-during-review') await writeFile(join(candidateRoot, 'message.txt'), 'changed after review\n');
            if (scenario === 'candidate-extra-file') await writeFile(join(candidateRoot, 'unexpected.txt'), 'not reviewed\n');
            if (scenario === 'review-substituted') {
              const replacement = JSON.stringify({ ...packet, objective: 'Substituted after snapshot creation.' });
              await writeFile(review.inputPath, replacement);
              review.sha256 = createHash('sha256').update(replacement).digest('hex');
            }
            if (scenario === 'success') review.testEvidence = { checker: 'Changed by the review adapter', checks: [] };
            return { verdict: scenario === 'review-rejected' ? 'rejected' : 'approved', sessionId: 'local-fake-review', rationale: 'Verified test evidence and exact contents.',
              packetSha256: scenario === 'review-hash-mismatch' ? '0'.repeat(64) : review.sha256 };
          }
        });
      }
    });
    const port = daemon.server.address().port;
    client = openMcpClient({ root, port, token });
    await client.rpc('initialize', { protocolVersion: '2025-11-25' });
    const tools = await client.rpc('tools/list');
    assert.equal(tools.tools.some((tool) => /authoriz|approv/.test(tool.name)), false);
    const input = { title: 'Authorized MCP loop', objective: 'Set message.txt to ready newline.', acceptance: 'Exact text; source is unchanged.',
      allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 20, maxModelTurns: scenario === 'budget-exhausted' ? 1 : 2 } };
    const task = await client.tool('create_task', { ...input, executionAuthorization: { allowUnknownCost: true } });
    await assert.rejects(client.tool('dispatch_task', { id: task.id, approval: { allowUnknownCost: true } }), /local execution authorization/);
    assert.equal(proposals, 0);
    assert.equal(reviews, 0);
    daemon.core.authorizeExecution(task.id, { expiresAt: new Date(Date.now() + 60000).toISOString() });
    assert.equal((await client.tool('dispatch_task', { id: task.id })).state, 'QUEUED');
    if (scenario === 'stopped') {
      for (let attempt = 0; attempt < 100 && !proposals; attempt++) await setTimeout(5);
      assert.equal(proposals, 1);
      assert.equal((await client.tool('stop_task', { id: task.id })).state, 'RECOVERY_REQUIRED');
    }
    let final;
    for (let attempt = 0; attempt < 200; attempt++) {
      final = await client.tool('task_status', { id: task.id });
      if (!['QUEUED', 'RUNNING'].includes(final.state)) break;
      await setTimeout(5);
    }
    const succeeded = scenario === 'success';
    const reviewed = !['verification-failed', 'budget-exhausted', 'stopped'].includes(scenario);
    assert.equal(final.state, succeeded ? 'COMPLETED' : 'RECOVERY_REQUIRED');
    assert.equal(proposals, 1);
    assert.equal(reviews, reviewed ? 1 : 0);
    assert.ok(final.executionAuthorization.consumedAt);
    if (succeeded) {
      assert.match(final.result, /Candidate checks: 1 passed \(exact-message-check\)/);
      assert.doesNotMatch(final.result, /Changed by the review adapter/);
    }
    else {
      assert.equal(final.result, null);
      await assert.rejects(readFile(join(root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md')), { code: 'ENOENT' });
    }
    assert.equal(await readFile(join(root, 'message.txt'), 'utf8'), 'pending\n');
    assert.equal(await readFile(join(root, '.RelayCore', 'workspaces', task.id, 'message.txt'), 'utf8'),
      scenario === 'stopped' ? 'pending\n' : scenario === 'candidate-changed-during-review' ? 'changed after review\n' : 'ready\n');
    const events = await client.tool('task_events', { id: task.id });
    assert.deepEqual(events.filter((entry) => entry.kind.startsWith('model_turn.requested.')).map((entry) => entry.kind),
      ['model_turn.requested.dsh', ...(reviewed ? ['model_turn.requested.codex'] : [])]);
    await assert.rejects(client.tool('dispatch_task', { id: task.id }), /Cannot dispatch/);
    await client.close();
    const response = await fetch(`http://127.0.0.1:${port}/tasks/${task.id}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await response.json()).state, succeeded ? 'COMPLETED' : 'RECOVERY_REQUIRED');
  } finally {
    if (originalToken === undefined) delete process.env.RELAYCORE_TOKEN;
    else process.env.RELAYCORE_TOKEN = originalToken;
    await client?.close();
    await daemon?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

for (const scenario of ['success', 'verification-failed', 'review-rejected', 'review-interrupted', 'budget-exhausted', 'stopped',
  'candidate-changed-during-review', 'candidate-extra-file', 'review-substituted', 'review-hash-mismatch']) {
  test(`isolated MCP dispatch enforces authorization and safe outcomes: ${scenario}`, () => exerciseDispatch(scenario));
}

test('dispatch diagnostic defaults to no models and refuses missing real-cost consent', async () => {
  const script = fileURLToPath(new URL('../scripts/probe-dispatch.mjs', import.meta.url));
  const refused = spawnSync(process.execPath, [script, '--run-task', process.execPath, tmpdir()],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /explicit --allow-unknown-cost/);
  const checked = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 45000, windowsHide: true });
  assert.equal(checked.status, 0, checked.stderr);
  const result = JSON.parse(checked.stdout.trim());
  const parent = fileURLToPath(new URL('../local/', import.meta.url));
  assert.equal(dirname(resolve(result.evidenceRoot)), resolve(parent));
  assert.ok(result.evidenceRoot.includes('relaycore-dispatch-probe-'));
  try {
    assert.equal(result.outcome, 'simulated-reviewed-integrated-rolled-back');
    assert.equal(result.realModelPrompts, 0);
    assert.equal(result.requestedBridgePrompts, 2);
    assert.equal(result.unapprovedDispatchRefused, true);
    assert.equal(result.authorizationConsumed, true);
    assert.equal(result.sourceUnchanged, true);
    assert.equal(result.candidateMatches, true);
    assert.equal(result.testEvidence.origin, 'relaycore-host');
    assert.equal(result.reviewSnapshot.sha256, result.reviewSha256);
    assert.equal(result.reviewSnapshot.candidateSha256, result.testEvidence.candidateSha256);
    assert.equal(result.reviewSnapshot.revision, 1);
    assert.deepEqual(JSON.parse(await readFile(join(result.evidenceRoot, 'DIAGNOSTIC.json'), 'utf8')), result);
    await assert.rejects(readFile(join(result.evidenceRoot, '.RelayCore', 'bridge', 'daemon.lock')), { code: 'ENOENT' });
  } finally {
    await rm(result.evidenceRoot, { recursive: true, force: true });
  }
});
