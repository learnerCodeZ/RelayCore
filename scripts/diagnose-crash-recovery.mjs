// Real crash-recovery diagnostic. A child process opens a temporary project,
// dispatches a task whose injected executor hangs, then the parent kills the
// child outright (no graceful close) so SQLite keeps the task in RUNNING.
// Reopening the project must reconcile RUNNING -> RECOVERY_REQUIRED exactly
// once, and an orphaned HANDOFF.md must be flagged once, not auto-completed.
// No model is called; executionLimits and a hanging local executor only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.mjs';

const local = fileURLToPath(new URL('../local/', import.meta.url));
await mkdir(local, { recursive: true });
const root = await mkdtemp(join(local, 'relaycore-crash-probe-'));
const coreUrl = new URL('../src/core.mjs', import.meta.url).href;

const helper = `
const [coreUrl, root] = process.argv.slice(2);
const { openCore } = await import(coreUrl);
let entered;
const started = new Promise((resolve) => { entered = resolve; });
const core = await openCore(root, async () => {
  entered();
  await new Promise(() => {});
});
const task = await core.create({ title: 'Crash recovery probe', objective: 'Hold RUNNING.',
  acceptance: 'Never completes in this process.', allowedPaths: ['a.txt'],
  executionLimits: { maxDurationSeconds: 120, maxModelTurns: 1 } });
core.dispatch(task.id);
await started;
process.stdout.write('RUNNING_ENTERED ' + task.id + '\\n');
setInterval(() => {}, 1000);
`;

async function waitForLine(child, pattern, timeoutMs = 20000) {
  let buffer = '';
  const timer = setTimeout(() => child.kill(), timeoutMs);
  for await (const chunk of child.stdout) {
    buffer += chunk;
    const line = buffer.split('\n').find((entry) => entry.includes(pattern));
    if (line) { clearTimeout(timer); return line; }
  }
  clearTimeout(timer);
  throw new Error(`Helper never reported ${pattern}`);
}

let taskId;
let outcome;
try {
  await writeFile(join(root, 'a.txt'), 'probe\n');
  await writeFile(join(root, 'helper.mjs'), helper);
  const child = spawn(process.execPath, [join(root, 'helper.mjs'), coreUrl, root],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const line = await waitForLine(child, 'RUNNING_ENTERED');
  taskId = line.split(' ')[1];
  // Hard kill: no graceful close, so the RUNNING state stays in SQLite.
  child.kill('SIGKILL');
  const exit = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  if (stderr.trim()) throw new Error(`Helper stderr: ${stderr.slice(0, 300)}`);

  const beforeReopen = { exit };
  const recovered = await openCore(root);
  try {
    const task = recovered.get(taskId);
    const events = recovered.events(taskId).map((entry) => entry.kind);
    beforeReopen.stateAfterReopen = task.state;
    beforeReopen.recoveryEvents = events.filter((kind) => kind === 'task.recovery_required').length;
    assert.equal(task.state, 'RECOVERY_REQUIRED');
    assert.equal(beforeReopen.recoveryEvents, 1);
    // Recovery must not auto-complete or auto-replay the task.
    assert.notEqual(task.state, 'COMPLETED');
  } finally { recovered.close(); }

  const again = await openCore(root);
  try {
    beforeReopen.recoveryEventsAfterSecondOpen = again.events(taskId).map((entry) => entry.kind)
      .filter((kind) => kind === 'task.recovery_required').length;
    assert.equal(beforeReopen.recoveryEventsAfterSecondOpen, 1);
  } finally { again.close(); }

  // Orphaned HANDOFF for a non-completed task must be quarantined once.
  await mkdir(join(root, '.RelayCore', '.agent-tasks', taskId), { recursive: true });
  await writeFile(join(root, '.RelayCore', '.agent-tasks', taskId, 'HANDOFF.md'), '# orphan\n');
  const orphaned = await openCore(root);
  try {
    const kinds = orphaned.events(taskId).map((entry) => entry.kind);
    beforeReopen.handoffReconciliationEvents = kinds.filter((kind) => kind === 'handoff.reconciliation_required').length;
    beforeReopen.stateAfterOrphanHandoff = orphaned.get(taskId).state;
    assert.equal(beforeReopen.handoffReconciliationEvents, 1);
    assert.equal(beforeReopen.stateAfterOrphanHandoff, 'RECOVERY_REQUIRED');
  } finally { orphaned.close(); }
  const finalOpen = await openCore(root);
  try {
    assert.equal(finalOpen.events(taskId).map((entry) => entry.kind)
      .filter((kind) => kind === 'handoff.reconciliation_required').length, 1);
  } finally { finalOpen.close(); }

  outcome = { outcome: 'crash-recovery-verified', taskId, ...beforeReopen, cost: 'no-model-calls',
    note: 'RUNNING survives a hard kill, reconciles exactly once on reopen without auto-completing, and quarantines an orphan HANDOFF once.' };
} catch (error) {
  outcome = { outcome: 'crash-recovery-inconclusive', taskId: taskId ?? null, reason: error.message.slice(0, 500) };
  process.exitCode = 1;
}
await writeFile(join(root, 'DIAGNOSTIC.json'), JSON.stringify(outcome, null, 2), { flag: 'wx' });
process.stdout.write(`${JSON.stringify(outcome)}\n`);
process.stderr.write(`Crash recovery evidence retained at ${root}\n`);
