import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { openCore } from '../src/core.mjs';

async function withMemory(action) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-memory-test-'));
  const state = { root };
  try {
    state.core = await openCore(root);
    await action(state);
  } finally {
    state.core.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('memory appends are versioned, hash-guarded and never overwritten', async () => {
  await withMemory(async (state) => {
    assert.equal(state.core.memoryRead('PROJECT.md'), null);
    const emptySha = createHash('sha256').update('').digest('hex');
    const first = state.core.memoryAppend('PROJECT.md', 'Initial project facts.', emptySha);
    assert.equal(first.version, 1);
    const second = state.core.memoryAppend('PROJECT.md', 'Second observation.', first.sha256);
    assert.equal(second.version, 2);
    const contents = await readFile(join(state.root, '.RelayCore', '.agent-memory', 'PROJECT.md'), 'utf8');
    assert.ok(contents.includes('Initial project facts.') && contents.includes('Second observation.'));
    // Optimistic lock: a writer holding stale content cannot clobber the file.
    assert.throws(() => state.core.memoryAppend('PROJECT.md', 'Stale write.', first.sha256), /changed since read/);
    const stale = await readFile(join(state.root, '.RelayCore', '.agent-memory', 'PROJECT.md'), 'utf8');
    assert.ok(stale.includes('Second observation.') && !stale.includes('Stale write.'));
    // The archived version holds the pre-append content.
    const archived = await readFile(join(state.root, '.RelayCore', '.agent-memory', 'versions', 'PROJECT-v2.md'), 'utf8');
    assert.ok(archived.includes('Initial project facts.') && !archived.includes('Second observation.'));
    assert.deepEqual(state.core.memoryHistory('PROJECT.md').map(({ version }) => version), [1, 2]);
  });
});

test('memory rejects unknown names, missing hashes and oversized text', async () => {
  await withMemory(async (state) => {
    assert.throws(() => state.core.memoryAppend('../evil.md', 'x', '0'.repeat(64)), /Unknown memory file/);
    assert.throws(() => state.core.memoryAppend('PROJECT.md', 'text'), /current memory file SHA-256/);
    assert.throws(() => state.core.memoryAppend('PROJECT.md', 'x'.repeat(65537), '0'.repeat(64)), /65536 characters/);
    assert.throws(() => state.core.memoryRead('FORBIDDEN.md'), /Unknown memory file/);
    assert.equal(state.core.memoryRead('LESSONS.md'), null);
    assert.deepEqual(state.core.memoryHistory('LESSONS.md'), []);
  });
});
