import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.mjs';
import { runCodexReview } from '../src/review.mjs';
import { Codex } from '@openai/codex-sdk';

const [mode, model] = process.argv.slice(2);
if (!['--check-only', '--run-review'].includes(mode)) throw new Error('Usage: node scripts/probe-codex-review.mjs <--check-only|--run-review [model]>');
const apiKey = process.env.CODEX_REVIEW_API_KEY;
const authHome = fileURLToPath(new URL('../.RelayCore/codex-review-home/', import.meta.url));
if (mode === '--run-review') {
  if (apiKey && !model) throw new Error('Select an explicit review model for API key mode');
  if (!apiKey) {
    const status = spawnSync(process.execPath, [fileURLToPath(new URL('./login-codex-review.mjs', import.meta.url)), '--status'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
    if (status.status !== 0) throw new Error('Run npm run login:review to authorize the dedicated review profile, or set a test-only CODEX_REVIEW_API_KEY and model locally.');
  }
}
const local = fileURLToPath(new URL('../local/', import.meta.url));
await mkdir(local, { recursive: true });
const root = await mkdtemp(join(local, 'relaycore-review-probe-'));
let core;
let turns = 0;
let sessionId;
try {
  await writeFile(join(root, 'calc.mjs'), 'export const add = (left, right) => left + right;');
  core = await openCore(root);
  const task = await core.create({ title: 'Independent review diagnostic', objective: 'Preserve addition behavior.',
    acceptance: 'add(2, 3) must equal 5.', allowedPaths: ['calc.mjs'] });
  const candidate = await core.prepareWorkspace(task.id);
  await writeFile(join(candidate.workspace, 'calc.mjs'), 'export const add = (left, right) => left - right;');
  const review = await core.prepareReviewWorkspace(task.id);
  const packet = JSON.parse(await readFile(review.inputPath, 'utf8'));
  assert.equal(packet.files.length, 1);
  if (mode === '--check-only') {
    const client = new Codex();
    const thread = client.startThread({ workingDirectory: review.workspace, sandboxMode: 'read-only', approvalPolicy: 'never' });
    assert.equal(typeof thread.runStreamed, 'function');
    process.stdout.write(`${JSON.stringify({ sdkLoaded: true, nativeCliLocated: true, reviewPrepared: true, files: 1, modelCalls: 0 })}\n`);
  } else {
    const result = await runCodexReview({ review, model, apiKey, authHome,
      context: { signal: AbortSignal.timeout(30000),
        beginModelTurn(agent) {
          if (++turns > 1) throw new Error('Diagnostic turn limit exceeded');
          writeFileSync(join(root, 'REVIEW-INTENT.json'), JSON.stringify({ taskId: task.id, agent, model: model ?? 'account-default', requestedAt: new Date().toISOString() }), { flag: 'wx' });
        },
        recordSession(agent, observedSessionId) {
          sessionId = observedSessionId;
          writeFileSync(join(root, 'REVIEW-SESSION.json'), JSON.stringify({ agent, sessionId }), { flag: 'wx' });
        } }
    });
    assert.equal(result.verdict, 'rejected', 'The intentional addition regression must be rejected');
    const outcome = { verdict: result.verdict, sessionId: result.sessionId, usage: result.usage, modelCalls: turns, cost: 'unknown' };
    await writeFile(join(root, 'REVIEW-OUTCOME.json'), JSON.stringify(outcome, null, 2), { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  }
} catch (error) {
  if (mode === '--check-only') throw error;
  const outcome = { outcome: ['AbortError', 'TimeoutError'].includes(error.name) ? 'review-inconclusive-timeout-or-cancel' : 'review-not-completed',
    sessionId: sessionId ?? null, modelCalls: turns, usage: null, cost: 'unknown', externalCancellationConfirmed: false };
  await writeFile(join(root, 'REVIEW-OUTCOME.json'), JSON.stringify(outcome, null, 2), { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.exitCode = 1;
} finally {
  core?.close();
  if (mode === '--check-only') {
    const actual = await realpath(root);
    if (dirname(actual) !== await realpath(local) || !basename(actual).startsWith('relaycore-review-probe-')) throw new Error('Refusing to clean unexpected review path');
    await rm(actual, { recursive: true, force: true });
  } else {
    process.stderr.write(`Review diagnostic evidence retained at ${root}\n`);
  }
}
