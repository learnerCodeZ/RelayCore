import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotIdFromHandoff } from '../scripts/pause-probe-utils.mjs';

test('extracts the complete snapshot ID from a handoff and rejects missing or malformed lines', () => {
  const id = 'TASK-e7cb6338-24b6-4bcf-a4d2-7234e53e2d39-1btIrg';
  assert.equal(snapshotIdFromHandoff(`# Task\nSnapshot ID: ${id}\nReview SHA-256: abc\n`), id);
  assert.equal(snapshotIdFromHandoff(`Snapshot ID: ${id}\r\n`), id);
  assert.throws(() => snapshotIdFromHandoff('Snapshot ID: '), /must carry a review snapshot/);
  assert.throws(() => snapshotIdFromHandoff('Snapshot ID: bad id\n'), /must carry a review snapshot/);
});
