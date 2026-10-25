import { fileURLToPath } from 'node:url';
import { getControlToken } from './auth.mjs';

const port = Number(process.env.RELAYCORE_PORT ?? 8765);

export async function call(method, path, input) {
  const root = process.env.RELAYCORE_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
  const token = await getControlToken(root);
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(5000)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
