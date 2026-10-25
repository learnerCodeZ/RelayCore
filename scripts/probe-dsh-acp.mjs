import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { openAcpLifecycle } from '../src/acp.mjs';
import { dshAcpArgs } from '../src/dsh.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node scripts/probe-dsh-acp.mjs <DSH Desktop executable>');
await access(executable);
const dshHome = await mkdtemp(join(tmpdir(), 'relaycore-acp-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'relaycore-acp-workspace-'));

async function removeProbeDirectory(directory) {
  const actual = await realpath(directory);
  const temporaryRoot = await realpath(tmpdir());
  if (dirname(actual) !== temporaryRoot || !basename(actual).startsWith('relaycore-acp-')) {
    throw new Error(`Refusing to remove unexpected path: ${actual}`);
  }
  await rm(actual, { recursive: true, force: true });
}

const acp = openAcpLifecycle(executable, dshAcpArgs(executable), {
  cwd: workspace,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome }
});

try {
  const initialized = await acp.initialize();
  if (initialized.protocolVersion !== 1) throw new Error('ACP v1 was not negotiated');
  const session = await acp.newSession(workspace);
  if (typeof session.sessionId !== 'string') throw new Error('DSH did not return a session ID');
  await acp.cancelSession(session.sessionId);
  await acp.closeSession(session.sessionId);
  process.stdout.write(`ACP initialize/new/close: PASS (${initialized.agentInfo?.version ?? 'version unknown'}); cancel notification sent without acknowledgement\n`);
} finally {
  try { await acp.close(); }
  finally {
    await removeProbeDirectory(workspace);
    await removeProbeDirectory(dshHome);
  }
}
