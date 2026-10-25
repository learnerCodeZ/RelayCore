import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function openAcpLifecycle(command, args, { cwd, env, timeoutMs = 15000, onUpdate, onPermissionRequest }) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.resume();
  const pending = new Map();
  let nextId = 0;
  let failure;
  let closing;
  const exited = new Promise((resolve) => child.once('close', resolve));
  const fail = (error) => {
    if (failure) return;
    failure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.on('error', (error) => fail(error));
  child.on('close', (code) => fail(new Error(`ACP process exited (${code})`)));
  child.stdin.on('error', (error) => fail(error));
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch {
      fail(new Error('ACP returned invalid JSON'));
      child.kill();
      return;
    }
    if (message.method && message.id !== undefined) {
      if (message.method === 'session/request_permission') {
        try { onPermissionRequest?.(message.params); } catch (error) { fail(error); child.kill(); return; }
      }
      const response = message.method === 'session/request_permission'
        ? { result: { outcome: { outcome: 'cancelled' } } }
        : { error: { code: -32601, message: 'Method not found' } };
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response })}\n`, (error) => {
        if (error) fail(error);
      });
      return;
    }
    if (message.method === 'session/update') {
      try { onUpdate?.(message.params); } catch (error) { fail(error); child.kill(); }
      return;
    }
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`ACP ${message.error.code}: ${message.error.message}`));
    else request.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`ACP ${method} timed out`));
      child.kill();
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
      if (error) fail(error);
    });
  });
  return {
    initialize: () => request('initialize', {
      protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: 'relaycore-probe', version: '0.1.0' }
    }),
    newSession: (workspace) => request('session/new', { cwd: workspace, mcpServers: [] }),
    listSessions: (workspace) => request('session/list', { cwd: workspace }),
    setConfigOption: (sessionId, configId, value) => request('session/set_config_option', { sessionId, configId, value }),
    prompt: (sessionId, content) => request('session/prompt', {
      sessionId, prompt: [{ type: 'text', text: content }]
    }),
    cancelSession: (sessionId) => new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`, (error) => {
        if (error) { fail(error); reject(error); }
        else resolve();
      });
    }),
    closeSession: (sessionId) => request('session/close', { sessionId }),
    close: () => closing ??= (async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      await exited;
      clearTimeout(timer);
    })()
  };
}
