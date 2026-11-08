import { realpathSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Best-effort registration of a dispatched DSH session into the durable
// workspace registry (~/.dsh/storages/workspace.json) so DSH Desktop and Web
// list the dispatched session under its workspace in the sidebar. Verified
// against DSH v0.2.2-rc.1: the sidebar reads the dsh-workspace registry, not
// a directory scan; attachSession validates header.cwd realpath-equals the
// record path (holds for account execution) and re-filters by archive
// presence on read. The registry backend (dsh-storage-json) is
// memory-authoritative with whole-unit atomic replacement and no cross-
// process locking, so a concurrent DSH write between our read and write
// would silently drop its update. We therefore re-read immediately before
// the atomic replace and retry while the file keeps changing under us; the
// remaining window cannot be closed without a protocol DSH does not offer.
// Every failure is self-healing (the next dispatch retries; DSH rewrites its
// own state from memory) and never touches the session archives. Opt out
// with the dshRegistryAttach=false setting.
export function attachSessionToDshWorkspace({ dshHome, workspacePath, sessionId, attempts = 3 }) {
  try {
    if (typeof sessionId !== 'string' || !sessionId.trim()) return { attached: false, reason: 'session id is missing' };
    const registryPath = join(dshHome, 'storages', 'workspace.json');
    let target;
    try { target = realpathSync(workspacePath); } catch {
      return { attached: false, reason: `account workspace does not resolve: ${workspacePath}` };
    }
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let before;
      try { before = readFileSync(registryPath, 'utf8'); } catch (error) {
        return { attached: false, reason: `registry unreadable: ${error.message}` };
      }
      let data;
      try {
        data = JSON.parse(before);
        if (data?.unit?.name !== 'workspace' || data?.unit?.version !== 2 || typeof data.tables?.workspaces !== 'object') {
          return { attached: false, reason: 'registry file is not the expected workspace unit' };
        }
      } catch (error) {
        return { attached: false, reason: `registry unreadable: ${error.message}` };
      }
      let record;
      for (const candidate of Object.values(data.tables.workspaces)) {
        try {
          if (candidate?.path && realpathSync(candidate.path) === target) { record = candidate; break; }
        } catch { /* record path missing on disk: skip */ }
      }
      if (!record) return { attached: false, reason: 'no workspace record matches the account workspace' };
      if (!Array.isArray(record.sessionIds)) record.sessionIds = [];
      if (record.sessionIds.includes(sessionId)) return { attached: true, already: true };
      record.sessionIds.push(sessionId);
      record.updatedAt = new Date().toISOString();
      // Re-read immediately before the atomic replace: if DSH wrote between
      // our two reads, start over instead of clobbering its update. The gap
      // between this check and the rename stays sub-millisecond.
      if (readFileSync(registryPath, 'utf8') !== before) {
        if (attempt === attempts) return { attached: false, reason: 'registry changed concurrently; will retry on the next dispatch' };
        continue;
      }
      const temp = `${registryPath}.relaycore-${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(data, null, 2));
      renameSync(temp, registryPath);
      return { attached: true, already: false };
    }
    return { attached: false, reason: 'registry changed concurrently; will retry on the next dispatch' };
  } catch (error) {
    return { attached: false, reason: `attach failed: ${error.message}` };
  }
}
