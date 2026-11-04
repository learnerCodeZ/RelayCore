export function snapshotIdFromHandoff(handoff) {
  const match = /^Snapshot ID: (\S+)\r?$/m.exec(handoff);
  if (!match) throw new Error('A completed real loop must carry a review snapshot');
  return match[1];
}
