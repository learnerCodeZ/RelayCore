
import { startDaemon } from "file:///D:/MYCODE/RelayCore/src/daemon.mjs";
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const trace = (step, detail) => { try { appendFileSync(join(process.cwd(), 'demo-trace.log'), step + ': ' + detail + '\n'); } catch { } };
process.stderr.on('data', () => { });
process.on('uncaughtException', (error) => { trace('uncaught', error.message); });
const daemon = await startDaemon(process.cwd(), { port: Number(process.env.RELAYCORE_PORT ?? 8790),
  executor: async (task, context, core) => {
    trace('started', task.id);
    try {
      await core.prepareWorkspace(task.id);
      trace('prepare', 'ok');
      context.beginModelTurn('dsh');
      trace('dsh-turn', 'reserved');
      context.recordSession('dsh', 'demo-dsh-session');
      await core.applyWorkspaceProposal(task.id, (task.contract.allowedPaths).map((path) => ({
        path, contents: 'ready' + String.fromCharCode(10) })), context.signal);
      trace('apply', 'ok');
      const artifact = await core.prepareReviewWorkspace(task.id, { verifyCandidate: async () => ({
        checker: 'demo-exact-check', checks: [{ name: 'message becomes ready', passed: true }] }) });
      trace('snapshot', artifact.snapshotId);
      context.beginModelTurn('codex');
      trace('codex-turn', 'reserved');
      context.recordSession('codex', 'demo-codex-session');
      context.recordUsage('dsh', { used: 6700, size: 1048576 }, 'Demo-V4.1-Flash');
      context.recordUsage('codex', { inputTokens: 10900, outputTokens: 52 }, 'demo-codex-model');
      trace('usage', 'recorded');
      return { handoff: `# ${task.id} Demo approved; not merged. Snapshot ID: ${artifact.snapshotId}` };
    } catch (error) {
      trace('EXECUTOR-FAIL', error.message);
      throw error;
    }
  },
  executionPolicy: { maxDurationSeconds: 600, maxModelTurns: 3, costMode: 'unknown' } });
const actualPort = daemon.server.address().port;
const pairingUrl = `http://127.0.0.1:${actualPort}/ui?pairing=${daemon.issuePairing()}`;
trace('daemon-up', String(actualPort));
process.stderr.write(`Demo daemon on 127.0.0.1:${actualPort}
配对链接: ${pairingUrl}
`);
