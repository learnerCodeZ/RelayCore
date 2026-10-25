import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.mjs';
import { runDshProposal, runDshReviewTask } from '../src/dsh.mjs';

const [executable, mode] = process.argv.slice(2);
if (!executable || !['--check-only', '--run-proposal', '--run-task'].includes(mode)) throw new Error('Usage: node scripts/probe-dsh-task.mjs <DSH executable> <--check-only|--run-proposal|--run-task>');
if (mode === '--check-only') {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./probe-dsh-prompt.mjs', import.meta.url)), executable, '--check-only'], { stdio: 'inherit', timeout: 45000, windowsHide: true });
  if (result.error) throw new Error('DSH connection check could not finish');
  process.exit(result.status ?? 1);
}
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey?.trim()) throw new Error('Set a test-only DEEPSEEK_API_KEY locally before a model diagnostic; do not paste it into chat');
if (mode === '--run-task') {
  const login = spawnSync(process.execPath, [fileURLToPath(new URL('./login-codex-review.mjs', import.meta.url)), '--status'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
  if (login.status !== 0) throw new Error('Authorize the dedicated review profile with npm run login:review first');
}
const local = fileURLToPath(new URL('../local/', import.meta.url));
await mkdir(local, { recursive: true });
const root = await mkdtemp(join(local, 'relaycore-dsh-task-'));
const authHome = fileURLToPath(new URL('../.RelayCore/codex-review-home/', import.meta.url));
let core;
let finished;
const settled = new Promise((done) => { finished = done; });
try {
  await writeFile(join(root, 'message.txt'), 'pending\n');
  core = await openCore(root, mode === '--run-task' ? async (task, context) => {
    try { return await runDshReviewTask({ core, task, context, executable, apiKey, authHome }); }
    finally { finished(); }
  } : null);
  const task = await core.create({ title: 'DSH proposal and independent review diagnostic',
    objective: 'Change message.txt to exactly ready followed by one newline.',
    acceptance: 'Only message.txt changes; its complete contents must be ready\\n.',
    allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 60, maxModelTurns: 2 } });
  const candidate = await core.prepareWorkspace(task.id);
  if (mode === '--run-proposal') {
    const home = join(root, '.RelayCore', 'dsh-proposal-home');
    await mkdir(home);
    let turns = 0;
    const proposal = await runDshProposal({ task, files: [{ path: 'message.txt', contents: 'pending\n' }], home, executable, apiKey,
      context: { signal: AbortSignal.timeout(30000),
        beginModelTurn(agent) {
          if (++turns > 1) throw new Error('Diagnostic turn limit exceeded');
          return writeFileSync(join(root, 'DSH-INTENT.json'), JSON.stringify({ taskId: task.id, agent, requestedAt: new Date().toISOString() }), { flag: 'wx' });
        },
        recordSession(agent, sessionId) { writeFileSync(join(root, 'DSH-SESSION.json'), JSON.stringify({ agent, sessionId }), { flag: 'wx' }); } }
    });
    await writeFile(join(root, 'PROPOSAL.json'), JSON.stringify(proposal, null, 2), { flag: 'wx' });
    assert.deepEqual(proposal.files, [{ path: 'message.txt', contents: 'ready\n' }]);
    assert.equal(await readFile(join(root, 'message.txt'), 'utf8'), 'pending\n');
    assert.equal(await readFile(join(candidate.workspace, 'message.txt'), 'utf8'), 'pending\n');
    const outcome = { taskId: task.id, state: 'DRAFT', outcome: 'proposal-validated-not-applied', sessionId: proposal.sessionId,
      requestedTurns: turns, candidateUnchanged: true, reviewCalls: 0, cost: 'unknown' };
    await writeFile(join(root, 'DIAGNOSTIC.json'), JSON.stringify(outcome, null, 2), { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  } else {
    core.dispatch(task.id);
    await settled;
    while (core.get(task.id).state === 'RUNNING') await setTimeout(10);
    const final = core.get(task.id);
    const sourceUnchanged = await readFile(join(root, 'message.txt'), 'utf8') === 'pending\n';
    const candidateMatches = await readFile(join(candidate.workspace, 'message.txt'), 'utf8') === 'ready\n';
    const events = core.events(task.id).map((event) => event.kind);
    const outcome = { taskId: task.id, state: final.state, sourceUnchanged, candidateMatches,
      sessions: final.sessions, requestedTurns: events.filter((kind) => kind.startsWith('model_turn.requested.')).length,
      outcome: final.state === 'COMPLETED' && sourceUnchanged && candidateMatches ? 'reviewed-not-merged' : 'recovery-required', cost: 'unknown' };
    await writeFile(join(root, 'DIAGNOSTIC.json'), JSON.stringify(outcome, null, 2), { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    assert.equal(outcome.outcome, 'reviewed-not-merged', 'Diagnostic did not complete; inspect retained records before retrying');
  }
} finally {
  core?.close();
  process.stderr.write(`DSH task diagnostic evidence retained at ${root}\n`);
}
