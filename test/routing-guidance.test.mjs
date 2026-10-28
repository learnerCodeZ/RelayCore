import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { openCore } from '../src/core.mjs';

const contract = { title: 'Routed task', objective: 'Change pending to ready.', acceptance: 'Exact ready newline.',
  allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 20, maxModelTurns: 3 } };
const approval = () => ({ expiresAt: new Date(Date.now() + 60000).toISOString(), allowUnknownCost: true });

async function withCore(action, executor) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-routing-test-'));
  const state = { root, proposals: [] };
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    state.core = await openCore(root, executor ?? null, executor
      ? { maxDurationSeconds: 40, maxModelTurns: 3, costMode: 'unknown' } : undefined);
    await action(state);
  } finally {
    state.core?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

test('guidance recorded mid-run folds into the next prompt and is consumed exactly once', async () => {
  await withCore(async (state) => {
    const task = await state.core.create(contract);
    state.core.guide(task.id, 'Please also mention the reason in the summary.');
    assert.equal((await readFile(join(state.root, '.RelayCore', '.agent-tasks', task.id, 'GUIDANCE.md'), 'utf8'))
      .includes('mention the reason'), true);
    assert.throws(() => state.core.guide(task.id, '   '), /nonempty text/);
    assert.throws(() => state.core.guide(task.id, 'x'.repeat(8001)), /nonempty text/);
    const consumed = await state.core.consumeGuidance(task.id);
    assert.match(consumed, /mention the reason/);
    const again = await state.core.consumeGuidance(task.id);
    assert.equal(again, null);
    assert.deepEqual(state.core.events(task.id).filter((event) => event.kind === 'task.guided').length, 1);
    assert.deepEqual(state.core.events(task.id).filter((event) => event.kind === 'task.guidance_consumed').length, 1);
    // The live GUIDANCE.md is gone; the archived copy stays as audit evidence.
    assert.equal((await readdir(join(state.root, '.RelayCore', '.agent-tasks', task.id))).includes('GUIDANCE.md'), false);
    assert.equal((await readdir(join(state.root, '.RelayCore', '.agent-tasks', task.id)))
      .some((name) => name.startsWith('GUIDANCE-')), true);
  });
});

test('an executor prompt carries recorded guidance and rejects malformed guidance', async () => {
  await withCore(async (state) => {
    const { runDshProposal } = await import('../src/dsh.mjs');
    const { openAcpLifecycle } = await import('../src/acp.mjs');
    const home = join(state.root, 'dsh-home');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(home);
    const task = { contract: { objective: 'Objective.', acceptance: 'Acceptance.' } };
    const prompts = [];
    const fakeConnect = (command, args, options) => {
      void command; void args;
      return {
        async initialize() { return { protocolVersion: 1 }; },
        async newSession() { return { sessionId: 'guidance-session' }; },
        async prompt(sessionId, prompt) {
          prompts.push(prompt);
          options.onUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: JSON.stringify({ summary: 'Done.', files: [{ path: 'message.txt', contents: 'ready\n' }] }) } } });
          return { stopReason: 'end_turn' };
        },
        async closeSession() {}, async close() {}, async cancelSession() {}
      };
    };
    await runDshProposal({ task, files: [{ path: 'message.txt', contents: 'pending\n' }], home,
      executable: process.execPath, apiKey: 'test-only-key', guidance: 'Keep the summary short.',
      context: { signal: new AbortController().signal, beginModelTurn() {}, recordSession() {} } }, fakeConnect);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes('userGuidance') && prompts[0].includes('Keep the summary short.'));
    await assert.rejects(runDshProposal({ task, files: [], home, executable: process.execPath,
      apiKey: 'test-only-key', guidance: '   ',
      context: { signal: new AbortController().signal, beginModelTurn() {}, recordSession() {} } }, fakeConnect),
      /nonempty text/);
    void openAcpLifecycle;
  });
});

test('E2 risk level is refused without explicit L3 approval and allowed with it', async () => {
  await withCore(async (state) => {
    const e2 = await state.core.create({ ...contract, riskLevel: 'E2' });
    assert.equal(state.core.get(e2.id).contract.riskLevel, 'E2');
    state.core.authorizeExecution(e2.id, approval());
    assert.throws(() => state.core.dispatch(e2.id), /E2 operations require explicit L3 approval/);
    await assert.rejects(state.core.create({ ...contract, riskLevel: 'E9' }), /'E0', 'E1' or 'E2'/);
    // Revision can lower the level; the E1 path dispatches with plain consent.
    const raised = await state.core.createRevision(e2.id, { expectedRevision: 1, reason: 'Escalate after review.', riskLevel: 'E1' });
    assert.equal(raised.contract.riskLevel, 'E1');
    state.core.authorizeExecution(raised.id, approval());
    const routed = state.core.dispatch(raised.id);
    assert.equal(routed.state, 'QUEUED');
    const routing = JSON.parse(await readFile(
      join(state.root, '.RelayCore', '.agent-tasks', raised.id, 'ROUTING.json'), 'utf8'));
    assert.equal(routing.executionLevel, 'E1');
    assert.match(routing.riskReason, /isolated code changes/);
    assert.deepEqual(state.core.events(raised.id).filter((event) => event.kind === 'task.routed').length, 1);
  }, async () => ({ handoff: 'routed run completed' }));
});
