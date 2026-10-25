import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function transaction(database, action) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000) {
    throw new Error(`${name} must be nonempty text of at most 8000 characters`);
  }
  return value.trim();
}

function declaredPaths(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error('allowedPaths must be an array of at most 32 paths');
  const paths = value.map((path) => {
    if (typeof path !== 'string' || path.length > 512 || !path || path.includes('\\') ||
      path.split('/').some((segment) => !segment || segment === '.' || segment === '..' ||
        /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(segment))) {
      throw new Error('allowedPaths must use unambiguous project-relative paths with forward slashes');
    }
    if (['.git', '.relaycore', 'local'].includes(path.split('/')[0].toLowerCase())) {
      throw new Error('allowedPaths cannot include internal project data');
    }
    return path;
  });
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
    throw new Error('allowedPaths contains duplicate paths');
  }
  return paths;
}

function declaredLimits(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => !['maxDurationSeconds', 'maxModelTurns'].includes(key)) ||
    !Number.isSafeInteger(value.maxDurationSeconds) || value.maxDurationSeconds < 1 ||
    !Number.isSafeInteger(value.maxModelTurns) || value.maxModelTurns < 1) {
    throw new Error('executionLimits requires positive integer maxDurationSeconds and maxModelTurns');
  }
  return { maxDurationSeconds: value.maxDurationSeconds, maxModelTurns: value.maxModelTurns };
}

export async function openCore(root, executor = null) {
  const projectRoot = resolve(root);
  const dataDir = join(projectRoot, '.RelayCore');
  const taskDir = join(dataDir, '.agent-tasks');
  await mkdir(join(dataDir, 'bridge'), { recursive: true });
  await mkdir(taskDir, { recursive: true });
  const database = new DatabaseSync(join(dataDir, 'bridge', 'state.sqlite'));
  database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, contract TEXT NOT NULL,
      stop_requested INTEGER NOT NULL DEFAULT 0, result TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      kind TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      task_id TEXT NOT NULL, agent TEXT NOT NULL, session_id TEXT NOT NULL,
      PRIMARY KEY(task_id, agent), FOREIGN KEY(task_id) REFERENCES tasks(id)
    );`);
  database.exec('PRAGMA foreign_keys=ON');
  const now = () => new Date().toISOString();
  const event = (id, kind) => database.prepare('INSERT INTO events(task_id,kind,created_at) VALUES(?,?,?)').run(id, kind, now());
  transaction(database, () => {
    const interrupted = database.prepare("SELECT id FROM tasks WHERE state='RUNNING'").all();
    for (const { id } of interrupted) {
      database.prepare("UPDATE tasks SET state='RECOVERY_REQUIRED',updated_at=? WHERE id=?").run(now(), id);
      event(id, 'task.recovery_required');
    }
  });
  for (const { id } of database.prepare("SELECT id FROM tasks WHERE state!='COMPLETED'").all()) {
    if (!/^TASK-[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid stored task ID');
    const present = await lstat(join(taskDir, id, 'HANDOFF.md')).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (!present) continue;
    transaction(database, () => {
      database.prepare("UPDATE tasks SET state='RECOVERY_REQUIRED',updated_at=? WHERE id=? AND state!='RECOVERY_REQUIRED'").run(now(), id);
      if (!database.prepare("SELECT 1 FROM events WHERE task_id=? AND kind='handoff.reconciliation_required'").get(id)) {
        event(id, 'handoff.reconciliation_required');
      }
    });
  }

  const controllers = new Map();
  let draining = false;
  let closed = false;
  const get = (id) => {
    const row = database.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error('Task not found');
    return { id: row.id, state: row.state, contract: JSON.parse(row.contract),
      stopRequested: Boolean(row.stop_requested), result: row.result,
      createdAt: row.created_at, updatedAt: row.updated_at,
      sessions: database.prepare('SELECT agent,session_id AS sessionId FROM sessions WHERE task_id=?').all(id) };
  };
  const list = () => database.prepare('SELECT id,state,created_at AS createdAt,updated_at AS updatedAt FROM tasks ORDER BY created_at DESC').all();
  const create = async (input) => {
    const contract = {
      title: requiredText(input?.title, 'title'),
      objective: requiredText(input?.objective, 'objective'),
      acceptance: requiredText(input?.acceptance, 'acceptance'),
      allowedPaths: declaredPaths(input?.allowedPaths),
      executionLimits: declaredLimits(input?.executionLimits),
      revision: 1
    };
    const id = `TASK-${randomUUID()}`;
    const directory = join(taskDir, id);
    await mkdir(directory);
    await writeFile(join(directory, 'TASK.md'), `# ${id}: ${contract.title}\n\n## 目标\n${contract.objective}\n\n## 验收标准\n${contract.acceptance}\n\n## 允许路径（仅声明，未授权执行）\n${contract.allowedPaths.length ? contract.allowedPaths.map((path) => `- \`${path}\``).join('\n') : '无'}\n\n## 执行上限（仅声明，未强制执行）\n${contract.executionLimits ? `最长时长：${contract.executionLimits.maxDurationSeconds} 秒；最多模型回合：${contract.executionLimits.maxModelTurns}。` : '未声明'}\n\n修订：1。当前仅保存草稿；尚未授权外部 Agent 执行。\n`, { flag: 'wx' });
    transaction(database, () => {
      database.prepare('INSERT INTO tasks(id,state,contract,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(id, 'DRAFT', JSON.stringify(contract), now(), now());
      event(id, 'task.created');
    });
    return get(id);
  };
  const readFileWithin = async (base, path) => {
    const segments = path.split('/');
    let source = base;
    for (const [index, segment] of segments.entries()) {
      source = join(source, segment);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error(`Linked path is not supported: ${path}`);
      if (index === segments.length - 1) {
        if (!info.isFile()) throw new Error(`Only explicit files are supported: ${path}`);
        if (info.size > 8 * 1024 * 1024) throw new Error(`File exceeds 8 MiB: ${path}`);
      } else if (!info.isDirectory()) throw new Error(`Non-directory path component: ${path}`);
    }
    const contents = await readFile(source);
    if (contents.length > 8 * 1024 * 1024) throw new Error(`File exceeds 8 MiB: ${path}`);
    return contents;
  };
  const readBaseline = async (id) => {
    const task = get(id);
    const paths = declaredPaths(task.contract.allowedPaths);
    const baselinePath = join(taskDir, id, 'BASELINE.json');
    const info = await lstat(baselinePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Workspace baseline is not a plain file');
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    if (!baseline || baseline.taskId !== id || baseline.revision !== task.contract.revision ||
      !Array.isArray(baseline.files) || baseline.files.length !== paths.length ||
      baseline.files.some((file, index) => !file || file.path !== paths[index] ||
        !Number.isInteger(file.bytes) || file.bytes < 0 || file.bytes > 8 * 1024 * 1024 ||
        typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256))) {
      throw new Error('Workspace baseline does not match the task contract');
    }
    return { paths, baseline };
  };
  const prepareWorkspace = async (id) => {
    const task = get(id);
    if (task.state !== 'DRAFT') throw new Error('Only drafts can be prepared');
    const paths = declaredPaths(task.contract.allowedPaths);
    if (!paths.length) throw new Error('Declare allowedPaths before preparing a workspace');
    if ((await lstat(dataDir)).isSymbolicLink()) throw new Error('Runtime data directory is a link');
    const workspacesDir = join(dataDir, 'workspaces');
    await mkdir(workspacesDir, { recursive: true });
    if ((await lstat(workspacesDir)).isSymbolicLink()) throw new Error('Workspace directory is a link');
    const workspace = join(workspacesDir, id);
    if (await lstat(workspace).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw new Error('Workspace already exists');
    const temporary = await mkdtemp(join(workspacesDir, `${id}-tmp-`));
    let baselineCreated = false;
    try {
      const files = [];
      let totalBytes = 0;
      for (const path of paths) {
        const segments = path.split('/');
        const contents = await readFileWithin(projectRoot, path);
        totalBytes += contents.length;
        if (totalBytes > 32 * 1024 * 1024) throw new Error('Workspace exceeds 32 MiB');
        const target = join(temporary, ...segments);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents, { flag: 'wx' });
        files.push({ path, bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') });
      }
      await writeFile(join(taskDir, id, 'BASELINE.json'), JSON.stringify({ taskId: id, revision: task.contract.revision, files }, null, 2), { flag: 'wx' });
      baselineCreated = true;
      await rename(temporary, workspace);
      return { workspace, files };
    } catch (error) {
      if (baselineCreated) await unlink(join(taskDir, id, 'BASELINE.json'));
      if (dirname(resolve(temporary)) !== resolve(workspacesDir)) throw new Error('Refusing to clean unexpected workspace path');
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  };
  const inspectWorkspaceChanges = async (id) => {
    const { paths, baseline } = await readBaseline(id);
    const workspace = join(dataDir, 'workspaces', id);
    const expectedFiles = new Map(baseline.files.map((file) => [file.path, file]));
    const expectedDirectories = new Set(paths.flatMap((path) => path.split('/').slice(0, -1)
      .map((_, index, segments) => segments.slice(0, index + 1).join('/'))));
    for (const directory of [dataDir, join(dataDir, 'workspaces'), workspace]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Workspace directory is not a plain directory');
    }
    const seen = new Set();
    const changed = new Set();
    let totalBytes = 0;
    const scan = async (directory, prefix = '') => {
      for (const name of await readdir(directory)) {
        const path = prefix ? `${prefix}/${name}` : name;
        const target = join(directory, name);
        const info = await lstat(target);
        if (info.isSymbolicLink()) throw new Error(`Linked workspace path: ${path}`);
        if (info.isDirectory()) {
          if (!expectedDirectories.has(path)) throw new Error(`Unexpected workspace directory: ${path}`);
          await scan(target, path);
        } else if (info.isFile()) {
          const expected = expectedFiles.get(path);
          if (!expected) throw new Error(`Unexpected workspace file: ${path}`);
          if (info.size > 8 * 1024 * 1024) throw new Error(`Workspace file exceeds 8 MiB: ${path}`);
          const contents = await readFile(target);
          totalBytes += contents.length;
          if (contents.length > 8 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) throw new Error('Workspace exceeds size limit');
          if (contents.length !== expected.bytes || createHash('sha256').update(contents).digest('hex') !== expected.sha256) changed.add(path);
          seen.add(path);
        } else throw new Error(`Unsupported workspace entry: ${path}`);
      }
    };
    await scan(workspace);
    if (seen.size !== expectedFiles.size) throw new Error('Workspace file is missing');
    return { workspace, changedPaths: paths.filter((path) => changed.has(path)), files: seen.size };
  };
  const verifyWorkspace = async (id) => {
    const result = await inspectWorkspaceChanges(id);
    if (result.changedPaths.length) throw new Error(`Workspace file changed: ${result.changedPaths[0]}`);
    return { workspace: result.workspace, matchesBaseline: true, files: result.files };
  };
  const applyWorkspaceProposal = async (id, files, signal) => {
    const task = get(id);
    const paths = declaredPaths(task.contract.allowedPaths);
    if (!Array.isArray(files) || !files.length || files.length > paths.length) throw new Error('Invalid proposal files');
    const planned = [];
    let bytes = 0;
    const seen = new Set();
    for (const file of files) {
      if (!file || Object.keys(file).length !== 2 || !paths.includes(file.path) || seen.has(file.path) || typeof file.contents !== 'string') throw new Error('Proposal contains undeclared or invalid files');
      bytes += Buffer.byteLength(file.contents, 'utf8');
      if (bytes > 256 * 1024 || file.contents.includes('\0')) throw new Error('Proposal exceeds text limits');
      seen.add(file.path);
      planned.push({ path: file.path, contents: file.contents });
    }
    if (!(await inspectSourceConflicts(id)).matchesBaseline) throw new Error('Source conflict before proposal');
    const candidate = await verifyWorkspace(id);
    signal?.throwIfAborted();
    const current = get(id);
    if (closed || current.state !== 'RUNNING' || current.stopRequested) throw new Error('Task is no longer active');
    for (const file of planned) writeFileSync(join(candidate.workspace, ...file.path.split('/')), file.contents, 'utf8');
    return inspectWorkspaceChanges(id);
  };
  const inspectSourceConflicts = async (id) => {
    const { paths, baseline } = await readBaseline(id);
    const conflictedPaths = [];
    let totalBytes = 0;
    for (const [index, path] of paths.entries()) {
      let contents;
      try { contents = await readFileWithin(projectRoot, path); }
      catch (error) {
        if (error.code === 'ENOENT') { conflictedPaths.push(path); continue; }
        throw error;
      }
      totalBytes += contents.length;
      if (totalBytes > 32 * 1024 * 1024) throw new Error('Source files exceed 32 MiB');
      if (contents.length !== baseline.files[index].bytes ||
        createHash('sha256').update(contents).digest('hex') !== baseline.files[index].sha256) conflictedPaths.push(path);
    }
    return { conflictedPaths, matchesBaseline: conflictedPaths.length === 0 };
  };
  const prepareReviewWorkspace = async (id) => {
    const task = get(id);
    const { baseline } = await readBaseline(id);
    const candidate = await inspectWorkspaceChanges(id);
    const files = [];
    let bytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    for (const original of baseline.files) {
      const before = await readFileWithin(projectRoot, original.path);
      const after = await readFileWithin(candidate.workspace, original.path);
      bytes += before.length + after.length;
      if (bytes > 256 * 1024) throw new Error('Review input exceeds 256 KiB');
      if (before.length !== original.bytes || createHash('sha256').update(before).digest('hex') !== original.sha256) throw new Error(`Source conflict before review: ${original.path}`);
      if (before.includes(0) || after.includes(0)) throw new Error('Review input must be UTF-8 text');
      files.push({ path: original.path, before: decoder.decode(before), after: decoder.decode(after) });
    }
    const contents = JSON.stringify({ taskId: id, revision: task.contract.revision,
      objective: task.contract.objective, acceptance: task.contract.acceptance, files }, null, 2);
    if (Buffer.byteLength(contents, 'utf8') > 256 * 1024) throw new Error('Review input exceeds 256 KiB');
    const reviewsDir = join(dataDir, 'reviews');
    await mkdir(reviewsDir, { recursive: true });
    for (const directory of [dataDir, reviewsDir]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Review directory is not a plain directory');
    }
    const workspace = await mkdtemp(join(reviewsDir, `${id}-`));
    try {
      const inputPath = join(workspace, 'REVIEW.json');
      await writeFile(inputPath, contents, { flag: 'wx' });
      return { taskId: id, workspace, inputPath, sha256: createHash('sha256').update(contents).digest('hex') };
    } catch (error) {
      if (dirname(resolve(workspace)) !== resolve(reviewsDir)) throw new Error('Refusing to clean unexpected review path');
      await rm(workspace, { recursive: true, force: true });
      throw error;
    }
  };
  const dispatch = (id) => {
    if (!executor) throw new Error('External execution is disabled until Phase 0 safety checks pass');
    const task = get(id);
    if (task.state !== 'DRAFT') throw new Error(`Cannot dispatch task in ${task.state}`);
    const limits = declaredLimits(task.contract.executionLimits ?? undefined);
    if (!limits) throw new Error('Declare executionLimits before dispatch');
    if (limits.maxDurationSeconds > 2147483) throw new Error('maxDurationSeconds exceeds the supported timer range');
    transaction(database, () => {
      database.prepare("UPDATE tasks SET state='QUEUED',updated_at=? WHERE id=? AND state='DRAFT'").run(now(), id);
      event(id, 'task.dispatched');
    });
    queueMicrotask(drain);
    return get(id);
  };
  const stop = (id) => {
    const task = get(id);
    if (['DRAFT', 'QUEUED'].includes(task.state)) {
      transaction(database, () => {
        database.prepare("UPDATE tasks SET state='CANCELED',stop_requested=1,updated_at=? WHERE id=?").run(now(), id);
        event(id, 'task.canceled');
      });
    } else if (task.state === 'RUNNING') {
      transaction(database, () => {
        database.prepare("UPDATE tasks SET state='RECOVERY_REQUIRED',stop_requested=1,updated_at=? WHERE id=?").run(now(), id);
        event(id, 'task.stop_requested');
        event(id, 'task.recovery_required');
      });
      controllers.get(id)?.abort();
    }
    return get(id);
  };
  async function drain() {
    if (draining || !executor || closed) return;
    draining = true;
    try {
      while (!closed) {
        const next = transaction(database, () => {
          const queued = database.prepare("SELECT id FROM tasks WHERE state='QUEUED' ORDER BY created_at LIMIT 1").get();
          if (!queued) return null;
          const claim = database.prepare("UPDATE tasks SET state='RUNNING',updated_at=? WHERE id=? AND state='QUEUED'").run(now(), queued.id);
          if (claim.changes !== 1) throw new Error('Task claim failed');
          event(queued.id, 'execution.started');
          return queued;
        });
        if (!next) break;
        const { id } = next;
        const controller = new AbortController();
        controllers.set(id, controller);
        let timer;
        let deadline;
        const interrupt = (kind) => {
          if (closed || controller.signal.aborted) return;
          transaction(database, () => {
            const change = database.prepare("UPDATE tasks SET state='RECOVERY_REQUIRED',updated_at=? WHERE id=? AND state='RUNNING'").run(now(), id);
            if (change.changes) {
              event(id, kind);
              event(id, 'task.recovery_required');
            }
          });
          controller.abort(new Error(kind));
        };
        const requireActive = () => {
          if (closed || controller.signal.aborted || get(id).stopRequested || get(id).state !== 'RUNNING') throw new Error('Task is no longer active');
          if (Date.now() >= deadline) {
            interrupt('execution.deadline_exceeded');
            throw new Error('Task duration limit exceeded');
          }
        };
        try {
          const task = get(id);
          const limits = declaredLimits(task.contract.executionLimits ?? undefined);
          if (!limits || limits.maxDurationSeconds > 2147483) throw new Error('Missing or unsupported executionLimits');
          const dispatched = database.prepare("SELECT created_at FROM events WHERE task_id=? AND kind='task.dispatched' ORDER BY sequence LIMIT 1").get(id);
          deadline = Date.parse(dispatched?.created_at) + limits.maxDurationSeconds * 1000;
          if (!Number.isFinite(deadline) || deadline - Date.now() > 2147483647) throw new Error('Invalid task deadline');
          requireActive();
          timer = setTimeout(() => interrupt('execution.deadline_exceeded'), Math.max(0, deadline - Date.now()));
          controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
          const result = await executor(task, {
            signal: controller.signal,
            beginModelTurn(agent) {
              if (!['dsh', 'codex'].includes(agent)) throw new Error('Unknown agent');
              requireActive();
              const reservation = transaction(database, () => {
                const used = database.prepare("SELECT COUNT(*) AS count FROM events WHERE task_id=? AND kind IN ('model_turn.requested.dsh','model_turn.requested.codex')").get(id).count;
                if (used >= limits.maxModelTurns) return null;
                const recorded = event(id, `model_turn.requested.${agent}`);
                return { turnNumber: used + 1, intentSequence: Number(recorded.lastInsertRowid) };
              });
              if (!reservation) {
                interrupt('execution.model_turn_limit_exceeded');
                throw new Error('Model turn limit exceeded');
              }
              return reservation;
            },
            recordSession(agent, sessionId) {
              if (closed) throw new Error('Core is closed');
              if (!['dsh', 'codex'].includes(agent)) throw new Error('Unknown agent');
              requiredText(sessionId, 'sessionId');
              database.prepare('INSERT INTO sessions(task_id,agent,session_id) VALUES(?,?,?) ON CONFLICT(task_id,agent) DO UPDATE SET session_id=excluded.session_id')
                .run(id, agent, sessionId);
            }
          });
          requireActive();
          if (typeof result?.handoff !== 'string' || !result.handoff.trim()) throw new Error('Missing handoff');
          if (Buffer.byteLength(result.handoff, 'utf8') > 1024 * 1024) throw new Error('Handoff exceeds 1 MiB');
          writeFileSync(join(taskDir, id, 'HANDOFF.md'), result.handoff, { flag: 'wx' });
          transaction(database, () => {
            database.prepare("UPDATE tasks SET state='COMPLETED',result=?,updated_at=? WHERE id=?")
              .run(result.handoff, now(), id);
            event(id, 'task.completed');
          });
        } catch {
          if (!closed) transaction(database, () => {
            const change = database.prepare("UPDATE tasks SET state='RECOVERY_REQUIRED',updated_at=? WHERE id=? AND state='RUNNING'").run(now(), id);
            if (change.changes) event(id, 'task.recovery_required');
          });
        } finally {
          clearTimeout(timer);
          controllers.delete(id);
        }
      }
    } finally {
      draining = false;
    }
  }
  if (executor) queueMicrotask(drain);
  return { create, get, list, dispatch, stop, prepareWorkspace, verifyWorkspace, applyWorkspaceProposal, inspectWorkspaceChanges, inspectSourceConflicts, prepareReviewWorkspace,
    events: (id) => database.prepare('SELECT sequence,kind,created_at AS createdAt FROM events WHERE task_id=? ORDER BY sequence').all(id),
    close: () => {
      closed = true;
      for (const id of controllers.keys()) {
        transaction(database, () => {
          const change = database.prepare("UPDATE tasks SET state='RECOVERY_REQUIRED',updated_at=? WHERE id=? AND state='RUNNING'").run(now(), id);
          if (change.changes) event(id, 'task.recovery_required');
        });
      }
      for (const controller of controllers.values()) controller.abort();
      database.close();
    } };
}
