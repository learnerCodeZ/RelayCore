import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openCore } from './core.mjs';
import { getControlToken } from './auth.mjs';

const port = Number(process.env.RELAYCORE_PORT ?? 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RELAYCORE_PORT');

export async function startDaemon(root = process.cwd()) {
  const projectRoot = resolve(root);
  const bridgeDir = join(projectRoot, '.RelayCore', 'bridge');
  await mkdir(bridgeDir, { recursive: true });
  const lockPath = join(bridgeDir, 'daemon.lock');
  const lockContents = JSON.stringify({ id: randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), port });
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Daemon lock exists at ${lockPath}; verify no process is using this project before removing it`);
    throw error;
  }
  const releaseLock = async () => {
    if (await readFile(lockPath, 'utf8').catch(() => '') === lockContents) await unlink(lockPath);
  };
  try {
    await lock.writeFile(lockContents);
  } catch (error) {
    await lock.close();
    await unlink(lockPath).catch(() => {});
    throw error;
  }
  await lock.close();
  let core;
  let token;
  try {
    token = await getControlToken(projectRoot, { create: true });
    core = await openCore(projectRoot);
  } catch (error) {
    await releaseLock();
    throw error;
  }
  const server = createServer(async (request, response) => {
    const reply = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
    const expected = Buffer.from(token);
    const authentic = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (!authentic || request.headers.origin) return reply(403, { error: 'Forbidden' });
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      let input = {};
      if (request.method === 'POST') {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 32768) throw new Error('Request too large');
        }
        input = body ? JSON.parse(body) : {};
      }
      if (request.method === 'GET' && url.pathname === '/tasks') return reply(200, core.list());
      if (request.method === 'POST' && url.pathname === '/tasks') return reply(201, await core.create(input));
      if (parts[0] === 'tasks' && parts.length >= 2) {
        const id = parts[1];
        if (request.method === 'GET' && parts.length === 2) return reply(200, core.get(id));
        if (request.method === 'GET' && parts[2] === 'events') return reply(200, core.events(id));
        if (request.method === 'POST' && parts[2] === 'dispatch') return reply(200, core.dispatch(id));
        if (request.method === 'POST' && parts[2] === 'stop') return reply(200, core.stop(id));
      }
      return reply(404, { error: 'Not found' });
    } catch (error) {
      reply(error.message === 'Task not found' ? 404 : 400, { error: error.message });
    }
  });
  try {
    await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
  } catch (error) {
    core.close();
    await releaseLock();
    throw error;
  }
  return { server, core, close: async () => {
    await new Promise((done) => server.close(done));
    core.close();
    await releaseLock();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const daemon = await startDaemon(process.env.RELAYCORE_ROOT ?? process.cwd());
  process.stderr.write(`RelayCore control server on 127.0.0.1:${port}; external execution disabled\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => daemon.close().then(() => process.exit()));
}
