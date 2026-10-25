import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshAcpArgs } from '../src/dsh.mjs';

const shimUrl = new URL('../src/dsh-console-shim.mjs', import.meta.url);

// A stand-in for the DSH CLI: it logs like the bundled account plugin
// (console.info to stdout), then answers with one protocol-style JSON frame
// reporting the argv it received after the script path.
const fakeCli = `
console.info('[fake-plugin]', 'stdout pollution line');
console.log('second pollution line');
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
`;

async function runFakeCli(nodeArgs) {
  const directory = await mkdtemp(join(tmpdir(), 'relaycore-shim-test-'));
  const script = join(directory, 'fake-cli.mjs');
  await writeFile(script, fakeCli);
  try {
    const child = spawn(process.execPath, [...nodeArgs, script, '--profile', 'acp'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.once('close', resolve));
    return { code, stdout, stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('DSH ACP launch args preload the console shim ahead of the official CLI', async () => {
  const args = dshAcpArgs('D:/DeepSeekHarness/DeepSeek Harness.exe');
  assert.deepEqual(args.slice(0, 2), ['--expose-internals', '--import']);
  assert.equal(args[2], shimUrl.href);
  assert.ok(args[3].endsWith(join('dsh-desktop-host', 'lib', 'cli.js')));
  assert.deepEqual(args.slice(4), ['--profile', 'acp']);
  await access(fileURLToPath(shimUrl));
});

test('with the shim, plugin console logging leaves stdout pure JSON frames', async () => {
  const { code, stdout, stderr } = await runFakeCli(['--import', shimUrl.href]);
  assert.equal(code, 0);
  const lines = stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).argv, ['--profile', 'acp']);
  assert.ok(stderr.includes('stdout pollution line'));
  assert.ok(stderr.includes('second pollution line'));
});

test('without the shim the same fake CLI pollutes stdout', async () => {
  const { stdout } = await runFakeCli([]);
  assert.throws(() => JSON.parse(stdout.split('\n')[0]));
});
