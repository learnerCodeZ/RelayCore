import { createInterface } from 'node:readline';
import { call } from './client.mjs';

const tools = [
  { name: 'create_task', description: 'Save a task draft. Does not run an Agent.', inputSchema: {
    type: 'object', properties: { title: { type: 'string' }, objective: { type: 'string' }, acceptance: { type: 'string' },
      allowedPaths: { type: 'array', items: { type: 'string' }, maxItems: 32 },
      executionLimits: { type: 'object', properties: {
        maxDurationSeconds: { type: 'integer', minimum: 1 }, maxModelTurns: { type: 'integer', minimum: 1 }
      }, required: ['maxDurationSeconds', 'maxModelTurns'], additionalProperties: false } },
    required: ['title', 'objective', 'acceptance'], additionalProperties: false } },
  { name: 'list_tasks', description: 'List saved tasks.', inputSchema: { type: 'object', properties: {} } },
  { name: 'task_status', description: 'Read one task status and session registry.', inputSchema: {
    type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'task_events', description: 'Read the event journal for one task.', inputSchema: {
    type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'dispatch_task', description: 'Request execution. Currently refuses until external safety checks pass.', inputSchema: {
    type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'stop_task', description: 'Cancel a draft/queued task, or request stop for an active task.', inputSchema: {
    type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }
];

async function invoke(name, args) {
  if (name === 'create_task') return call('POST', '/tasks', args);
  if (name === 'list_tasks') return call('GET', '/tasks');
  if (!args || typeof args.id !== 'string' || !/^TASK-[0-9a-f-]{36}$/.test(args.id)) throw new Error('Invalid task ID');
  const path = `/tasks/${args.id}`;
  if (name === 'task_status') return call('GET', path);
  if (name === 'task_events') return call('GET', `${path}/events`);
  if (name === 'dispatch_task') return call('POST', `${path}/dispatch`);
  if (name === 'stop_task') return call('POST', `${path}/stop`);
  throw new Error('Unknown tool');
}

const output = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { output({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
  if (request.id === undefined) continue;
  try {
    let result;
    if (request.method === 'initialize') {
      const version = request.params?.protocolVersion;
      result = { protocolVersion: ['2025-11-25', '2025-03-26'].includes(version) ? version : '2025-11-25',
        capabilities: { tools: {} }, serverInfo: { name: 'relaycore', version: '0.1.0' } };
      initialized = true;
    } else if (!initialized) {
      throw new Error('Initialize first');
    } else if (request.method === 'ping') {
      result = {};
    } else if (request.method === 'tools/list') {
      result = { tools };
    } else if (request.method === 'tools/call') {
      try {
        const data = await invoke(request.params?.name, request.params?.arguments ?? {});
        result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    } else {
      output({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
      continue;
    }
    output({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    output({ jsonrpc: '2.0', id: request.id, error: { code: -32600, message: error.message } });
  }
}
