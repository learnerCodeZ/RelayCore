import { call } from './client.mjs';

const [command, id] = process.argv.slice(2);
const route = id ? `/tasks/${id}` : '/tasks';
if (id && !/^TASK-[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid task ID');
let result;
if (command === 'list' && !id) result = await call('GET', route);
else if (command === 'status' && id) result = await call('GET', route);
else if (command === 'events' && id) result = await call('GET', `${route}/events`);
else if (command === 'stop' && id) result = await call('POST', `${route}/stop`);
else throw new Error('Usage: node src/control.mjs list|status ID|events ID|stop ID');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
