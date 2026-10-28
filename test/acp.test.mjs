import test from 'node:test';
import assert from 'node:assert/strict';
import { openAcpLifecycle } from '../src/acp.mjs';

const fakeAgent = `
import { createInterface } from 'node:readline';
let sawCancel = false;
let waitingForPermission;
let waitingForPrompt;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 900 && waitingForPermission !== undefined) {
    const denied = message.result?.outcome?.outcome === 'cancelled';
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: waitingForPermission, result: { denied } }) + '\\n');
    waitingForPermission = undefined;
    return;
  }
  if (message.method === 'session/cancel') {
    if (message.id !== undefined || message.params.sessionId !== 'test-session') process.exit(2);
    sawCancel = true;
    if (process.env.FAKE_ACP_MODE === 'cancel-prompt' && waitingForPrompt !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: waitingForPrompt, result: { stopReason: 'cancelled' } }) + '\\n');
      waitingForPrompt = undefined;
    }
    return;
  }
  if (process.env.FAKE_ACP_MODE === 'permission' && message.method === 'session/new') {
    waitingForPermission = message.id;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { sessionId: 'test-session' } }) + '\\n');
    return;
  }
  if (message.method === 'session/prompt') {
    if (process.env.FAKE_ACP_MODE === 'cancel-prompt') {
      waitingForPrompt = message.id;
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } }
    } }) + '\\n');
  }
  if (process.env.FAKE_ACP_MODE === 'timeout') return;
  if (process.env.FAKE_ACP_MODE === 'invalid') return process.stdout.write('not json\\n');
  const invalidFrames = {
    'null-frame': null, 'array-frame': [], 'scalar-frame': 7,
    'missing-version': { id: message.id, result: { protocolVersion: 1 } },
    'wrong-version': { jsonrpc: '1.0', id: message.id, result: { protocolVersion: 1 } }
  };
  if (Object.hasOwn(invalidFrames, process.env.FAKE_ACP_MODE)) return process.stdout.write(JSON.stringify(invalidFrames[process.env.FAKE_ACP_MODE]) + '\\n');
  if (process.env.FAKE_ACP_MODE === 'invalid-late-update') return process.stdout.write('not json\\n' + JSON.stringify({
    jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'test-session', update: { sessionUpdate: 'agent_message_chunk' } }
  }) + '\\n');
  const result = message.method === 'initialize' ? { protocolVersion: 1 }
    : message.method === 'session/new' ? { sessionId: 'test-session' }
      : message.method === 'session/prompt' ? { stopReason: 'end_turn' }
        : message.method === 'session/list' ? { sessions: [{ sessionId: 'test-session', cwd: message.params.cwd }] }
          : message.method === 'session/set_config_option' ? { configOptions: [{ id: message.params.configId, currentValue: message.params.value, sessionId: message.params.sessionId }] } : { sawCancel };
  const response = process.env.FAKE_ACP_MODE === 'error'
    ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported' } }
    : { jsonrpc: '2.0', id: message.id, result };
  process.stdout.write(JSON.stringify(response) + '\\n');
});`;

function connect(mode, onUpdate, onPermissionRequest) {
  return openAcpLifecycle(process.execPath, ['--input-type=module', '-e', fakeAgent], {
    cwd: process.cwd(), env: { ...process.env, FAKE_ACP_MODE: mode }, timeoutMs: 1000, onUpdate, onPermissionRequest
  });
}

test('ACP lifecycle exchanges only non-model methods', async () => {
  const acp = connect('success');
  try {
    assert.deepEqual(Object.keys(acp).sort(), ['cancelSession', 'close', 'closeSession', 'initialize', 'listSessions', 'newSession', 'prompt', 'setConfigOption']);
    assert.equal((await acp.initialize()).protocolVersion, 1);
    assert.equal((await acp.newSession(process.cwd())).sessionId, 'test-session');
    await acp.cancelSession('test-session');
    assert.deepEqual(await acp.closeSession('test-session'), { sawCancel: true });
  } finally { await acp.close(); }
});

test('ACP errors and malformed responses fail closed', async () => {
  for (const mode of ['error', 'invalid']) {
    const acp = connect(mode);
    try { await assert.rejects(acp.initialize(), /ACP (-32601|returned invalid JSON)/); }
    finally { await acp.close(); }
  }
});

test('ACP rejects invalid JSON-RPC envelopes without crashing', async () => {
  for (const mode of ['null-frame', 'array-frame', 'scalar-frame', 'missing-version', 'wrong-version']) {
    const acp = connect(mode);
    try { await assert.rejects(acp.initialize(), /invalid JSON-RPC/, mode); }
    finally { await acp.close(); }
  }
});

test('ACP stops delivering buffered updates after a fatal protocol error', async () => {
  const updates = [];
  const acp = connect('invalid-late-update', (params) => updates.push(params));
  try {
    await assert.rejects(acp.initialize(), /invalid JSON/);
    assert.deepEqual(updates, []);
    await assert.rejects(acp.newSession(process.cwd()), /invalid JSON/);
  } finally { await acp.close(); }
});

test('ACP session discovery and model configuration use the requested workspace and opaque value', async () => {
  const acp = connect('success');
  try {
    assert.deepEqual(await acp.listSessions(process.cwd()), { sessions: [{ sessionId: 'test-session', cwd: process.cwd() }] });
    assert.deepEqual(await acp.setConfigOption('test-session', 'model', 'opaque-choice'), {
      configOptions: [{ id: 'model', currentValue: 'opaque-choice', sessionId: 'test-session' }]
    });
  } finally { await acp.close(); }
});

test('ACP permission requests are denied by default', async () => {
  const requests = [];
  const acp = connect('permission', undefined, (params) => requests.push(params));
  try {
    assert.equal((await acp.newSession(process.cwd())).denied, true);
    assert.deepEqual(requests, [{ sessionId: 'test-session' }]);
  } finally { await acp.close(); }
});

test('ACP permission observer failures stop the session', async () => {
  const acp = connect('permission', undefined, () => { throw new Error('observer failed'); });
  try { await assert.rejects(acp.newSession(process.cwd()), /observer failed/); }
  finally { await acp.close(); }
});

test('ACP prompt returns a stop reason and delivers updates', async () => {
  const updates = [];
  const acp = connect('success', (params) => updates.push(params.update));
  try {
    assert.equal((await acp.prompt('test-session', 'Reply OK')).stopReason, 'end_turn');
    assert.deepEqual(updates, [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } }]);
  } finally { await acp.close(); }
});

test('ACP cancel notification ends an in-flight prompt', async () => {
  const acp = connect('cancel-prompt');
  try {
    const pendingPrompt = acp.prompt('test-session', 'Reply slowly');
    await acp.cancelSession('test-session');
    assert.equal((await pendingPrompt).stopReason, 'cancelled');
  } finally { await acp.close(); }
});

test('ACP timeout stops the child', async () => {
  const acp = connect('timeout');
  try {
    const results = await Promise.allSettled([acp.initialize(), acp.newSession(process.cwd())]);
    assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
    const failure = results[0].reason;
    assert.match(failure.message, /initialize timed out/);
    assert.equal(results[1].reason, failure);
    await assert.rejects(acp.prompt('test-session', 'Never send this'), (error) => error === failure);
    await assert.rejects(acp.cancelSession('test-session'), (error) => error === failure);
  }
  finally { await acp.close(); }
});
