import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAcpLifecycle } from '../src/acp.mjs';
import { dshAcpArgs, runDshProposal } from '../src/dsh.mjs';
import { dshAccountEnvironment, selectAccountModel } from '../src/dsh-account.mjs';
import { writeFileSync } from 'node:fs';

const [mode = '--check-only', executable = 'D:/DeepSeekHarness/DeepSeek Harness.exe', requestedWorkspace = 'D:/MYCODE/RCtest'] = process.argv.slice(2);
if (!['--check-only', '--run-proposal', '--probe-cancel'].includes(mode)) throw new Error('Usage: node scripts/probe-dsh-account.mjs [--check-only|--run-proposal|--probe-cancel] [DSH executable] [test workspace]');
const accountHome = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
const workspace = resolve(requestedWorkspace);
for (const path of [accountHome, workspace]) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('DSH account paths must be existing plain directories');
}
const local = fileURLToPath(new URL('../local/', import.meta.url));
await mkdir(local, { recursive: true });
const root = await mkdtemp(join(local, 'relaycore-dsh-account-'));
let requestedTurns = 0;
let sessionId;
let acp;
let outcome;
let stage = 'preparing';
try {
  if (mode === '--check-only') {
    acp = openAcpLifecycle(executable, dshAcpArgs(executable), {
      cwd: workspace, env: dshAccountEnvironment(accountHome), timeoutMs: 20000,
      onPermissionRequest() { throw new Error('Unexpected permission during account check'); }
    });
    stage = 'initialize';
    if ((await acp.initialize()).protocolVersion !== 1) throw new Error('ACP v1 was not negotiated');
    stage = 'list-sessions';
    const listed = await acp.listSessions(workspace);
    stage = 'new-session';
    const session = await acp.newSession(workspace);
    sessionId = session.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('DSH session ID is missing');
    stage = 'select-account-model';
    const selected = await selectAccountModel(acp, sessionId, session.configOptions);
    outcome = { outcome: 'account-route-selected', workspace, sessionId, matchingSessions: listed.sessions?.length ?? null,
      ...selected, requestedTurns: 0 };
  } else if (mode === '--probe-cancel') {
    let toolCalls = 0;
    let permissionRequests = 0;
    let replyChunks = 0;
    let usage;
    acp = openAcpLifecycle(executable, dshAcpArgs(executable), {
      cwd: workspace, env: dshAccountEnvironment(accountHome), timeoutMs: 30000,
      onPermissionRequest() { permissionRequests++; },
      onUpdate(params) {
        if (params?.sessionId !== sessionId) return;
        const update = params.update;
        if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) toolCalls++;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') replyChunks++;
        if (update?.sessionUpdate === 'usage_update') usage = update;
      }
    });
    stage = 'initialize';
    if ((await acp.initialize()).protocolVersion !== 1) throw new Error('ACP v1 was not negotiated');
    stage = 'new-session';
    const session = await acp.newSession(workspace);
    sessionId = session.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('DSH session ID is missing');
    stage = 'select-account-model';
    const selected = await selectAccountModel(acp, sessionId, session.configOptions);
    stage = 'prompt';
    requestedTurns = 1;
    let promptSettled = false;
    const pendingPrompt = acp.prompt(sessionId,
      'Write 80 short numbered lines containing only the word ping. Do not use tools or read files.');
    void pendingPrompt.then(() => { promptSettled = true; }, () => { promptSettled = true; });
    // The account model can deliver its whole reply as one chunk, so a
    // first-chunk trigger never fires: cancel shortly after dispatch instead.
    const deadline = Date.now() + 250;
    while (!promptSettled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const pendingAtCancel = !promptSettled;
    let cancelSent = false;
    let stopReason;
    let promptFailed = false;
    try {
      if (pendingAtCancel) {
        await acp.cancelSession(sessionId);
        cancelSent = true;
      }
      stopReason = (await pendingPrompt).stopReason;
    } catch {
      promptFailed = true;
    }
    const cancelled = cancelSent && stopReason === 'cancelled' && toolCalls === 0 && permissionRequests === 0;
    outcome = { outcome: cancelled ? 'account-prompt-cancelled' : 'account-cancel-inconclusive', workspace, sessionId,
      ...selected, requestedTurns, pendingAtCancel, cancelSent, stopReason, promptFailed, replyChunks,
      toolCalls, permissionRequests, ...(usage ? { dshUsage: usage } : {}), cost: 'unknown' };
    if (!cancelled) process.exitCode = 1;
  } else {
    const path = 'relaycore-write-probe.txt';
    const source = join(workspace, path);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Expected an existing small plain test file');
    const before = await readFile(source, 'utf8');
    const task = { id: `TASK-${randomUUID()}`, contract: { title: 'DSH account proposal diagnostic',
      objective: `Propose changing ${path} to exactly probe-account-success followed by one newline, without applying it.`,
      acceptance: 'Only return the declared replacement text; do not use tools or modify files.', allowedPaths: [path] } };
    await writeFile(join(root, 'TASK.json'), JSON.stringify(task, null, 2), { flag: 'wx' });
    const home = join(root, 'job');
    await mkdir(home);
    stage = 'proposal';
    const proposal = await runDshProposal({ task, files: [{ path, contents: before }], home, executable,
      accountHome, accountWorkspace: workspace, context: { signal: AbortSignal.timeout(30000),
        beginModelTurn(agent) {
          if (++requestedTurns > 1) throw new Error('Diagnostic prompt quota exceeded');
          writeFileSync(join(root, 'DSH-INTENT.json'), JSON.stringify({ taskId: task.id, agent, requestedAt: new Date().toISOString() }), { flag: 'wx' });
        },
        recordSession(agent, observed) {
          sessionId = observed;
          writeFileSync(join(root, 'DSH-SESSION.json'), JSON.stringify({ agent, sessionId }), { flag: 'wx' });
        } }
    });
    await writeFile(join(root, 'PROPOSAL.json'), JSON.stringify(proposal, null, 2), { flag: 'wx' });
    assert.deepEqual(proposal.files, [{ path, contents: 'probe-account-success\n' }]);
    assert.equal(await readFile(source, 'utf8'), before);
    outcome = { outcome: 'account-proposal-validated-not-applied', workspace, sessionId, provider: proposal.provider,
      model: proposal.model, requestedTurns, sourceUnchanged: true, reviewCalls: 0, ...(proposal.usage ? { dshUsage: proposal.usage } : {}), cost: 'unknown' };
  }
} catch (error) {
  outcome = { outcome: 'account-diagnostic-inconclusive', workspace, sessionId: sessionId ?? null, requestedTurns,
    stage, reason: error.message === 'DSH account model catalog is unavailable' ? 'account-model-catalog-unavailable' : 'operation-not-completed',
    protocolCode: error.message.match(/^ACP (-?\d+):/)?.[1] ?? null,
    transportFailure: ['ACP returned invalid JSON', 'DSH session ID is missing', 'write EPIPE'].find((message) => error.message === message) ??
      (error.message.startsWith('ACP process exited (') ? 'ACP process exited' : error.message.includes('timed out') ? 'request timed out' : null),
    diagnosticCodes: ['EPERM', 'EACCES', 'ENOENT', 'ACCOUNT_SIGN_IN_REQUIRED', 'CLIENT_UPGRADE_REQUIRED', 'MODEL_UNSUPPORTED', 'MISSING_CREDENTIAL'].filter((code) => error.message.includes(code)),
    errorType: error.name, cost: 'unknown', externalCancellationConfirmed: false };
  process.exitCode = 1;
} finally {
  try { if (sessionId && acp) await acp.closeSession(sessionId).catch(() => {}); }
  finally { await acp?.close(); }
  if (outcome) {
    await writeFile(join(root, 'DIAGNOSTIC.json'), JSON.stringify(outcome, null, 2), { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  }
  process.stderr.write(`Account diagnostic evidence retained at ${root}\n`);
}
