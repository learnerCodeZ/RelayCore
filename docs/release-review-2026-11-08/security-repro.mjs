// Read-only source audit; fixture writes are confined to a fresh temporary directory.
// Usage: node security-repro.mjs [RelayCore project directory]
// No daemon, model, real DSH registry, or real task database is opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(process.argv[2] ?? 'D:/MYCODE/RelayCore');
const sourcePath = (name) => join(projectRoot, 'src', name);
const { productionExecution } = await import(pathToFileURL(sourcePath('daemon.mjs')).href);
const { attachSessionToDshWorkspace } = await import(pathToFileURL(sourcePath('dsh-workspace.mjs')).href);
const results = {
  nodeVersion: process.version,
  projectRoot,
  sourceSha256: Object.fromEntries(['daemon.mjs', 'dsh-workspace.mjs'].map((name) =>
    [name, createHash('sha256').update(fs.readFileSync(sourcePath(name))).digest('hex')])),
};

// Reproduction 1: an explicit environment disable is overridden by account config.
// Paths are dummy strings: productionExecution builds a closure but does not run it.
const previousExecutionMode = process.env.RELAYCORE_EXECUTION;
try {
  process.env.RELAYCORE_EXECUTION = 'disabled';
  const execution = productionExecution(projectRoot, {
    execution: 'account',
    dshExe: 'C:/relaycore-audit-fixture/fake-dsh.exe',
    accountWorkspace: 'C:/relaycore-audit-fixture/workspace',
  });
  results.environmentDisable = {
    environmentValue: 'disabled',
    configExecution: 'account',
    executorEnabled: Boolean(execution.executor),
    bugReproduced: Boolean(execution.executor),
    note: execution.note,
  };
} finally {
  if (previousExecutionMode === undefined) delete process.env.RELAYCORE_EXECUTION;
  else process.env.RELAYCORE_EXECUTION = previousExecutionMode;
}

// Reproduction 2: deterministically inject one simulated DSH write immediately
// after RelayCore has read its registry snapshot and before its replacement.
// This is a schedule simulation, not a race against a real DSH process.
const fixture = fs.mkdtempSync(join(tmpdir(), 'relaycore-audit-registry-'));
const originalReadFileSync = fs.readFileSync;
try {
  const workspace = join(fixture, 'workspace');
  const dshHome = join(fixture, 'fake-dsh-home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(join(dshHome, 'storages'), { recursive: true });
  const registryPath = join(dshHome, 'storages', 'workspace.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    tables: { workspaces: { current: { path: workspace, sessionIds: ['existing-session'] } } },
  }));
  let interveningWriteInjected = false;
  fs.readFileSync = function (path, ...args) {
    const content = originalReadFileSync(path, ...args);
    if (path === registryPath && !interveningWriteInjected) {
      interveningWriteInjected = true;
      const concurrentUpdate = JSON.parse(content);
      concurrentUpdate.tables.workspaces.concurrent = {
        path: join(fixture, 'another-workspace'), sessionIds: ['concurrent-dsh-session'],
      };
      fs.writeFileSync(registryPath, JSON.stringify(concurrentUpdate));
    }
    return content;
  };
  syncBuiltinESMExports();
  const outcome = attachSessionToDshWorkspace({
    dshHome, workspacePath: workspace, sessionId: 'relaycore-test-session',
  });
  const actual = JSON.parse(originalReadFileSync(registryPath, 'utf8'));
  assert.equal(interveningWriteInjected, true, 'the controlled interleaving must run');
  results.registryLostUpdate = {
    method: 'simulated DSH write between RelayCore snapshot read and replacement',
    outcome,
    concurrentWorkspacePreserved: Boolean(actual.tables.workspaces.concurrent),
    relaycoreSessionAdded: actual.tables.workspaces.current.sessionIds.includes('relaycore-test-session'),
    bugReproduced: outcome.attached === true && !actual.tables.workspaces.concurrent,
    realDshDataTouched: false,
  };
} finally {
  fs.readFileSync = originalReadFileSync;
  syncBuiltinESMExports();
  // Verify the resolved recursive cleanup target stays under the system temp root.
  if (!resolve(fixture).startsWith(resolve(tmpdir()) + sep)) throw new Error('Refusing unexpected cleanup target');
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log(JSON.stringify(results, null, 2));
