import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const mcp = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))], {
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
});
const exited = new Promise((done, reject) => { mcp.once('close', done); mcp.once('error', reject); });
mcp.stderr.resume();
const lines = createInterface({ input: mcp.stdout });
const iterator = lines[Symbol.asyncIterator]();
let nextId = 0;
let taskId;
let canceled = false;

async function rpc(method, params) {
  const id = ++nextId;
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  let timer;
  try {
    const line = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP smoke test timed out')), 15000); })
    ]);
    if (line.done) throw new Error('MCP exited before a response');
    const response = JSON.parse(line.value);
    assert.equal(response.id, id);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  } finally { clearTimeout(timer); }
}

async function tool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result.isError) throw new Error(result.content?.[0]?.text ?? 'MCP tool failed');
  return JSON.parse(result.content[0].text);
}

try {
  await rpc('initialize', { protocolVersion: '2025-11-25' });
  const task = await tool('create_task', {
    title: 'RelayCore no-model lifecycle smoke test',
    objective: 'Verify draft creation, status, journal and cancellation without dispatching an Agent.',
    acceptance: 'The draft is queryable and ends in CANCELED with task.created and task.canceled events.',
    allowedPaths: [], executionLimits: { maxDurationSeconds: 30, maxModelTurns: 2 }
  });
  taskId = task.id;
  assert.equal(task.state, 'DRAFT');
  assert.equal((await tool('task_status', { id: taskId })).state, 'DRAFT');
  assert.deepEqual((await tool('task_events', { id: taskId })).map((entry) => entry.kind), ['task.created']);
  assert.equal((await tool('stop_task', { id: taskId })).state, 'CANCELED');
  canceled = true;
  const events = await tool('task_events', { id: taskId });
  assert.deepEqual(events.map((entry) => entry.kind), ['task.created', 'task.canceled']);
  assert.equal((await tool('list_tasks')).some((entry) => entry.id === taskId && entry.state === 'CANCELED'), true);
  process.stdout.write(`${JSON.stringify({ taskId, state: 'CANCELED', events: events.map((entry) => entry.kind), modelCalls: 0 })}\n`);
} finally {
  if (taskId && !canceled) await tool('stop_task', { id: taskId }).catch(() => {});
  mcp.stdin.end();
  const timer = setTimeout(() => mcp.kill(), 3000);
  await exited.finally(() => clearTimeout(timer));
}
