import { call } from './client.mjs';

const [command, id, value] = process.argv.slice(2);
const route = id ? `/tasks/${id}` : '/tasks';
if (id && !/^TASK-[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid task ID');
let result;
if (command === 'list' && !id) result = await call('GET', route);
else if (command === 'status' && id) result = await call('GET', route);
else if (command === 'events' && id) result = await call('GET', `${route}/events`);
else if (command === 'inventory' && !id) result = await call('GET', '/inventory');
else if (command === 'dispatch' && id) result = await call('POST', `${route}/dispatch`);
else if (command === 'stop' && id) result = await call('POST', `${route}/stop`);
else if (command === 'pause' && id) result = await call('POST', `${route}/pause`);
else if (command === 'resume' && id) result = await call('POST', `${route}/resume`);
else if (command === 'guide' && id && value) result = await call('POST', `${route}/guide`, { text: value });
else if (command === 'authorize' && id) {
  const options = process.argv.slice(4);
  const lifetime = options.filter((option) => option !== '--allow-unknown-cost');
  if (lifetime.length > 1 || options.filter((option) => option === '--allow-unknown-cost').length > 1 ||
    (lifetime.length && (!/^\d+$/.test(lifetime[0]) || !Number.isSafeInteger(Number(lifetime[0])) || Number(lifetime[0]) < 1))) {
    throw new Error('Authorize takes an optional positive lifetime in seconds and --allow-unknown-cost');
  }
  const expiresAt = lifetime.length ? new Date(Date.now() + Number(lifetime[0]) * 1000) : undefined;
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw new Error('Invalid authorization lifetime');
  result = await call('POST', `${route}/authorize`, { ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
    ...(options.includes('--allow-unknown-cost') ? { allowUnknownCost: true } : {}) });
}
else if (command === 'integrate' && id && value) result = await call('POST', `${route}/integrate`, { snapshotId: value });
else if (command === 'rollback' && id) result = await call('POST', `${route}/rollback`);
else if (command === 'discard-workspace' && id) result = await call('POST', `${route}/discard-workspace`);
else throw new Error('Usage: node src/control.mjs list | inventory | status ID | events ID | dispatch ID | authorize ID [seconds] [--allow-unknown-cost] | guide ID TEXT | pause ID | resume ID | stop ID | integrate ID SNAPSHOT | rollback ID | discard-workspace ID');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
