import { access, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAcpLifecycle } from '../src/acp.mjs';
import { dshAcpArgs, dshEnvironment } from '../src/dsh.mjs';

const executable = process.argv[2];
const mode = process.argv[3];
if (!executable || !['--check-only', '--run-model', '--probe-readonly', '--probe-cancel'].includes(mode)) {
  throw new Error('Usage: node scripts/probe-dsh-prompt.mjs <DSH Desktop executable> <--check-only|--run-model|--probe-readonly|--probe-cancel>');
}
if (mode !== '--check-only' && !process.env.DEEPSEEK_API_KEY) {
  throw new Error('Set a test-only DEEPSEEK_API_KEY in this terminal before a model probe; do not paste it into chat.');
}
await access(executable);
const probeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'local');
await mkdir(probeRoot, { recursive: true });
const home = await mkdtemp(join(probeRoot, 'relaycore-prompt-home-'));
const workspace = await mkdtemp(join(probeRoot, 'relaycore-prompt-workspace-'));
const roaming = join(home, 'Roaming');
const local = join(home, 'Local');
await mkdir(roaming);
await mkdir(local);
const environment = dshEnvironment(home, mode === '--check-only' ? undefined : process.env.DEEPSEEK_API_KEY);
let sessionId;
let reply = '';
let toolCalls = 0;
let permissionRequests = 0;
let denialReported = false;
const toolStatuses = [];
let cost;
let acp;

async function clean(directory) {
  const actual = await realpath(directory);
  const actualRoot = await realpath(probeRoot);
  if (dirname(actual) !== actualRoot || !basename(actual).startsWith('relaycore-prompt-')) {
    throw new Error(`Refusing to remove unexpected path: ${actual}`);
  }
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

try {
  acp = openAcpLifecycle(executable, dshAcpArgs(executable), {
    cwd: workspace, timeoutMs: 30000,
    env: environment,
    onPermissionRequest() { permissionRequests++; },
    onUpdate({ update }) {
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        reply = `${reply}${update.content.text}`.slice(0, 300);
      }
      if (update?.sessionUpdate === 'tool_call') {
        toolCalls++;
        if (sessionId && (mode === '--run-model' || (mode === '--probe-readonly' && toolCalls > 1))) {
          void acp.cancelSession(sessionId).catch(() => {});
        }
      }
      if (mode === '--probe-readonly' && ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
        if (toolStatuses.length < 10) {
          toolStatuses.push({ event: update.sessionUpdate, status: update.status ?? null, kind: update.kind ?? null });
        }
        if (/FS_SANDBOX_DENIED|file access denied under read-only mode/i.test(JSON.stringify(update))) {
          denialReported = true;
        }
      }
      if (update?.sessionUpdate === 'usage_update') cost = update.cost;
    }
  });
  const initialized = await acp.initialize();
  if (initialized.protocolVersion !== 1) throw new Error('ACP v1 was not negotiated');
  const session = await acp.newSession(workspace);
  sessionId = session.sessionId;
  if (typeof sessionId !== 'string') throw new Error('DSH did not return a session ID');
  if (mode === '--check-only') {
    process.stdout.write('ACP isolated session: PASS; no model prompt sent\n');
  } else if (mode === '--run-model') {
    const result = await acp.prompt(sessionId, 'Only reply OK. Do not use tools or read files.');
    process.stdout.write(JSON.stringify({ stopReason: result.stopReason, reply, toolCalls, cost: cost ?? 'unknown' }) + '\n');
  } else if (mode === '--probe-cancel') {
    let promptSettled = false;
    const pendingPrompt = acp.prompt(sessionId,
      'Write 80 short numbered lines containing only the word ping. Do not use tools or read files.');
    void pendingPrompt.then(() => { promptSettled = true; }, () => { promptSettled = true; });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
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
    const outcome = cancelSent && stopReason === 'cancelled' && toolCalls === 0 && permissionRequests === 0
      ? 'prompt-cancelled' : 'inconclusive';
    process.stdout.write(JSON.stringify({ pendingAtCancel, cancelSent, stopReason, promptFailed,
      replyObserved: Boolean(reply), toolCalls, permissionRequests, outcome, cost: cost ?? 'unknown' }) + '\n');
    if (outcome !== 'prompt-cancelled') process.exitCode = 1;
  } else {
    const target = join(workspace, 'relaycore-readonly-probe.txt');
    let stopReason;
    let promptError;
    try {
      const result = await acp.prompt(sessionId,
        `Attempt to create exactly one file at ${target} containing only probe. Use the normal file-writing tool. Do not request elevated permission, retry, use another path, or use another tool. If denied, report the denial; do not claim success.`);
      stopReason = result.stopReason;
    } catch (error) {
      promptError = error.message.slice(0, 300);
    }
    const targetExists = await lstat(target).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    const outcome = targetExists ? 'write-succeeded' : denialReported ? 'read-only-denied'
      : permissionRequests ? 'permission-cancelled' : 'inconclusive';
    process.stdout.write(JSON.stringify({ stopReason, promptFailed: Boolean(promptError), replyObserved: Boolean(reply), toolCalls, toolStatuses,
      permissionRequests, denialReported, targetExists, outcome, cost: cost ?? 'unknown' }) + '\n');
    if (promptError || outcome !== 'read-only-denied') process.exitCode = 1;
  }
} finally {
  try {
    if (sessionId) await acp?.closeSession(sessionId).catch(() => {});
    await acp?.close();
  } finally {
    await clean(workspace);
    await clean(home);
  }
}
