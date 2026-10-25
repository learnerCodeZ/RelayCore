import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

test('daemon and MCP exchange task drafts without launching a model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-protocol-'));
  const token = randomBytes(32).toString('hex');
  const port = 30000 + Math.floor(Math.random() * 30000);
  const env = { ...process.env, RELAYCORE_ROOT: root, RELAYCORE_TOKEN: token, RELAYCORE_PORT: String(port) };
  const daemon = spawn(process.execPath, [resolve('src/daemon.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let mcp;
  try {
    const url = `http://127.0.0.1:${port}/tasks`;
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); ready = response.ok; if (ready) break; } catch {}
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(ready, true, 'daemon did not start');
    const second = spawn(process.execPath, [resolve('src/daemon.mjs')], {
      env: { ...env, RELAYCORE_PORT: String(port + 1) }, stdio: ['ignore', 'ignore', 'pipe']
    });
    let secondError = '';
    second.stderr.on('data', (chunk) => { secondError += chunk; });
    const secondExit = await new Promise((done) => second.once('exit', done));
    assert.notEqual(secondExit, 0);
    assert.match(secondError, /Daemon lock exists/);
    const unauthenticated = await fetch(url);
    assert.equal(unauthenticated.status, 403);
    const crossOrigin = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com' } });
    assert.equal(crossOrigin.status, 403);
    mcp = spawn(process.execPath, [resolve('src/mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const responses = createInterface({ input: mcp.stdout });
    const iterator = responses[Symbol.asyncIterator]();
    async function rpc(id, method, params = {}) {
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const response = await Promise.race([iterator.next(), new Promise((_, reject) => setTimeout(() => reject(new Error('MCP timeout')), 2000))]);
      return JSON.parse(response.value);
    }
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-11-25' });
    assert.equal(init.result.serverInfo.name, 'relaycore');
    const tools = await rpc(2, 'tools/list');
    assert.ok(tools.result.tools.some((entry) => entry.name === 'create_task'));
    const created = await rpc(3, 'tools/call', { name: 'create_task', arguments: {
      title: 'Protocol test', objective: 'Store a draft', acceptance: 'It is queryable', allowedPaths: ['src/core.mjs'],
      executionLimits: { maxDurationSeconds: 60, maxModelTurns: 1 } } });
    const task = JSON.parse(created.result.content[0].text);
    assert.equal(task.state, 'DRAFT');
    assert.deepEqual(task.contract.allowedPaths, ['src/core.mjs']);
    assert.deepEqual(task.contract.executionLimits, { maxDurationSeconds: 60, maxModelTurns: 1 });
    const refused = await rpc(4, 'tools/call', { name: 'dispatch_task', arguments: { id: task.id } });
    assert.equal(refused.result.isError, true);
    const stopped = await rpc(5, 'tools/call', { name: 'stop_task', arguments: { id: task.id } });
    assert.equal(JSON.parse(stopped.result.content[0].text).state, 'CANCELED');
    mcp.stdin.end();
    await new Promise((done) => mcp.once('exit', done));
    mcp = null;
    const stillRunning = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(stillRunning.status, 200);
  } finally {
    mcp?.kill();
    daemon.kill();
    await new Promise((done) => daemon.once('exit', done));
    await rm(root, { recursive: true, force: true });
  }
});

test('graceful daemon shutdown releases its project lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-lock-'));
  const env = { ...process.env, RELAYCORE_ROOT: root,
    RELAYCORE_TOKEN: randomBytes(32).toString('hex'), RELAYCORE_PORT: String(30000 + Math.floor(Math.random() * 30000)) };
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      "import { startDaemon } from './src/daemon.mjs'; const daemon = await startDaemon(process.env.RELAYCORE_ROOT); await daemon.close();"],
    { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    const exitCode = await new Promise((done) => child.once('exit', done));
    assert.equal(exitCode, 0, errors);
    await assert.rejects(stat(join(root, '.RelayCore', 'bridge', 'daemon.lock')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows MCP and daemon authenticate without an inherited token', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-local-protocol-'));
  const env = { ...process.env, RELAYCORE_ROOT: root, RELAYCORE_PORT: String(30000 + Math.floor(Math.random() * 30000)) };
  delete env.RELAYCORE_TOKEN;
  const daemon = spawn(process.execPath, [resolve('src/daemon.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const daemonExited = new Promise((done) => daemon.once('close', done));
  let mcp;
  let mcpExited;
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Local credential daemon startup timed out')), 10000);
      let errors = '';
      daemon.stderr.on('data', (chunk) => {
        errors += chunk;
        if (errors.includes('external execution disabled')) { clearTimeout(timer); done(); }
      });
      daemon.once('error', (error) => { clearTimeout(timer); reject(error); });
      daemon.once('close', () => { clearTimeout(timer); reject(new Error(errors || 'Daemon exited before startup')); });
    });
    mcp = spawn(process.execPath, [resolve('src/mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });
    mcpExited = new Promise((done) => mcp.once('close', done));
    let output = '';
    let errors = '';
    mcp.stdout.on('data', (chunk) => { output += chunk; });
    mcp.stderr.on('data', (chunk) => { errors += chunk; });
    mcp.stdin.end([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } })
    ].join('\n') + '\n');
    assert.equal(await mcpExited, 0, errors);
    const responses = output.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(responses.length, 2);
    assert.equal(responses[0].result.serverInfo.name, 'relaycore');
    assert.notEqual(responses[1].result.isError, true);
    assert.deepEqual(JSON.parse(responses[1].result.content[0].text), []);
  } finally {
    mcp?.kill();
    if (mcpExited) await mcpExited;
    daemon.kill();
    await daemonExited;
    await rm(root, { recursive: true, force: true });
  }
});
