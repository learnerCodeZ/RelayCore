import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function openMcpClient({ root, port, token, timeoutMs = 15000 }) {
  if (!isAbsolute(root) || !Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || token.length < 32) throw new Error('Invalid MCP diagnostic connection');
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp.mjs', import.meta.url))], {
    cwd: root, env: { ...env, RELAYCORE_ROOT: root, RELAYCORE_PORT: String(port), RELAYCORE_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  const exited = new Promise((done) => child.once('close', done));
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let nextId = 0;
  let busy = false;
  let closing;
  let failed = false;
  const rpc = async (method, params = {}) => {
    if (busy || failed || closing) throw new Error('MCP diagnostic client is busy or closed');
    busy = true;
    let timer;
    try {
      const id = ++nextId;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const line = await Promise.race([iterator.next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('MCP diagnostic request timed out')), timeoutMs);
      })]);
      if (line.done) throw new Error('MCP exited before replying');
      const response = JSON.parse(line.value);
      if (!response || response.id !== id || response.jsonrpc !== '2.0' || response.error) throw new Error('MCP returned an invalid response');
      return response.result;
    } catch (error) {
      failed = true;
      child.kill();
      throw error;
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  };
  return { rpc,
    tool: async (name, args = {}) => {
      const result = await rpc('tools/call', { name, arguments: args });
      if (result.isError) throw new Error(result.content?.[0]?.text ?? 'MCP tool failed');
      return JSON.parse(result.content[0].text);
    },
    close: () => closing ??= (async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      try { await exited; }
      finally { clearTimeout(timer); lines.close(); }
    })()
  };
}
