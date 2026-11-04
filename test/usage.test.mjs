import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCore } from '../src/core.mjs';

test('legacy usage survives migration without being relabelled as known token consumption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-legacy-usage-'));
  let core;
  try {
    core = await openCore(root);
    const task = await core.create({ title: 'Legacy usage', objective: 'Preserve evidence', acceptance: 'No invented counts' });
    core.close();
    core = undefined;
    const db = new DatabaseSync(join(root, '.RelayCore', 'bridge', 'state.sqlite'));
    try {
      db.exec(`DROP TABLE usage_ledger;
        CREATE TABLE usage_ledger (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
          agent TEXT NOT NULL, model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
          context_tokens INTEGER, source TEXT NOT NULL, recorded_at TEXT NOT NULL);`);
      db.prepare('INSERT INTO usage_ledger(task_id,agent,input_tokens,output_tokens,context_tokens,source,recorded_at) VALUES(?,?,?,?,?,?,?)')
        .run(task.id, 'dsh', 123, 0, 1000000, 'executor', '2026-10-27T00:00:00Z');
    } finally { db.close(); }
    for (let attempt = 0; attempt < 2; attempt++) {
      core = await openCore(root);
      const { entries, totals } = core.usageSummary();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].usageKind, 'legacy-unclassified');
      assert.equal(entries[0].inputTokens, null);
      assert.equal(entries[0].contextTokens, null);
      assert.equal(totals.dsh.inputTokens, null);
      core.close();
      core = undefined;
    }
    const check = new DatabaseSync(join(root, '.RelayCore', 'bridge', 'state.sqlite'));
    try {
      const raw = check.prepare('SELECT input_tokens,output_tokens,context_tokens FROM usage_ledger').get();
      assert.deepEqual({ ...raw }, { input_tokens: 123, output_tokens: 0, context_tokens: 1000000 });
    } finally { check.close(); }
  } finally {
    core?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
