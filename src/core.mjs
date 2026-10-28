import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runCaptured = promisify(execFile);
const gitRun = async (args, options = {}) =>
  (await runCaptured('git', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options })).stdout;

const readFileSyncSafe = (path) => {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const renameSyncSafe = (from, to) => {
  try { renameSync(from, to); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
};

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

const riskLevels = new Set(['E0', 'E1', 'E2']);

function taskContract(input, revision) {
  const riskLevel = input?.riskLevel === undefined ? undefined : input.riskLevel;
  if (riskLevel !== undefined && (typeof riskLevel !== 'string' || !riskLevels.has(riskLevel))) {
    throw new Error("riskLevel must be one of 'E0', 'E1' or 'E2'");
  }
  return {
    title: requiredText(input?.title, 'title'),
    objective: requiredText(input?.objective, 'objective'),
    acceptance: requiredText(input?.acceptance, 'acceptance'),
    allowedPaths: declaredPaths(input?.allowedPaths),
    executionLimits: declaredLimits(input?.executionLimits),
    ...(riskLevel !== undefined ? { riskLevel } : {}),
    revision
  };
}

export async function openCore(root, executor = null, executionPolicy) {
  let policy;
  if (executionPolicy !== undefined) {
    if (!executor || !executionPolicy || typeof executionPolicy !== 'object' || Array.isArray(executionPolicy) ||
      !['no-model', 'unknown'].includes(executionPolicy.costMode)) throw new Error('Invalid execution policy');
    const { costMode, ...limits } = executionPolicy;
    policy = { ...declaredLimits(limits), costMode };
    if (policy.maxDurationSeconds > 2147483) throw new Error('Execution policy exceeds timer range');
  }
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
    );
    CREATE TABLE IF NOT EXISTS execution_grants (
      task_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL UNIQUE,
      authorization TEXT NOT NULL, consumed_at TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS review_snapshots (
      snapshot_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
      contract_sha256 TEXT NOT NULL, packet_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS task_revisions (
      task_id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL UNIQUE,
      root_task_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 2),
      parent_contract_sha256 TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(root_task_id,revision),
      FOREIGN KEY(task_id) REFERENCES tasks(id),
      FOREIGN KEY(parent_task_id) REFERENCES tasks(id),
      FOREIGN KEY(root_task_id) REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
      baseline_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'copy', metadata TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS usage_ledger (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      agent TEXT NOT NULL, model TEXT, input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL, context_tokens INTEGER, source TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS memory_versions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT NOT NULL,
      version INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
      recorded_at TEXT NOT NULL, UNIQUE(file,version)
    );`);
  for (const [column, definition] of [['kind', "TEXT NOT NULL DEFAULT 'copy'"], ['metadata', 'TEXT']]) {
    if (!database.prepare('PRAGMA table_info(workspaces)').all().some((column_) => column_.name === column)) {
      database.exec(`ALTER TABLE workspaces ADD COLUMN ${column} ${definition}`);
    }
  }
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
  const readAuthorization = (id) => {
    const row = database.prepare('SELECT * FROM execution_grants WHERE task_id=?').get(id);
    return row ? { id: row.grant_id, ...JSON.parse(row.authorization), consumedAt: row.consumed_at } : null;
  };
  const get = (id) => {
    const row = database.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error('Task not found');
    const authorization = readAuthorization(id);
    const revisionInfo = database.prepare('SELECT parent_task_id AS parentTaskId,root_task_id AS rootTaskId,revision,parent_contract_sha256 AS parentContractSha256,reason FROM task_revisions WHERE task_id=?').get(id);
    const successor = database.prepare('SELECT task_id AS id FROM task_revisions WHERE parent_task_id=?').get(id);
    return { id: row.id, state: row.state, contract: JSON.parse(row.contract),
      stopRequested: Boolean(row.stop_requested), result: row.result,
      createdAt: row.created_at, updatedAt: row.updated_at,
      sessions: database.prepare('SELECT agent,session_id AS sessionId FROM sessions WHERE task_id=?').all(id),
      ...(revisionInfo ? { revisionInfo: { ...revisionInfo } } : {}),
      ...(successor ? { supersededBy: successor.id } : {}),
      ...(authorization ? { executionAuthorization: authorization } : {}) };
  };
  const checkPolicyLimits = (task) => {
    const limits = declaredLimits(task.contract.executionLimits ?? undefined);
    if (!limits || limits.maxDurationSeconds > policy.maxDurationSeconds || limits.maxModelTurns > policy.maxModelTurns) throw new Error('Task exceeds execution policy budget');
    return limits;
  };
  const requireAuthorization = (task, consumed) => {
    if (task.supersededBy) throw new Error('Task has a newer revision; use the latest draft');
    if (!policy) return null;
    checkPolicyLimits(task);
    const grant = readAuthorization(task.id);
    if (!grant || Boolean(grant.consumedAt) !== consumed) throw new Error('A fresh local execution authorization is required');
    if (grant.contractSha256 !== createHash('sha256').update(JSON.stringify(task.contract)).digest('hex') || grant.costMode !== policy.costMode) throw new Error('Execution authorization does not match the task or runtime');
    if (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) throw new Error('Execution authorization expired');
    if (policy.costMode === 'unknown' && grant.allowUnknownCost !== true) throw new Error('Unknown execution cost requires explicit local consent');
    return grant;
  };
  const authorizeExecution = (id, approval) => {
    if (!policy || !executor) throw new Error('Local execution authorization is unavailable');
    if (!approval || typeof approval !== 'object' || Array.isArray(approval) ||
      Object.keys(approval).some((key) => !['expiresAt', 'allowUnknownCost', 'e2Approved'].includes(key)) ||
      typeof approval.expiresAt !== 'string' || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now() ||
      (approval.allowUnknownCost !== undefined && typeof approval.allowUnknownCost !== 'boolean') ||
      (approval.e2Approved !== undefined && typeof approval.e2Approved !== 'boolean')) throw new Error('Invalid local execution authorization');
    const task = get(id);
    if (task.state !== 'DRAFT') throw new Error('Only a draft can receive execution authorization');
    if (task.supersededBy) throw new Error('Task has a newer revision; use the latest draft');
    checkPolicyLimits(task);
    if (policy.costMode === 'unknown' && approval.allowUnknownCost !== true) throw new Error('Unknown execution cost requires explicit local consent');
    if (readAuthorization(id)) throw new Error('Execution authorization already exists; create a new draft instead');
    const grantId = `GRANT-${randomUUID()}`;
    const authorization = { contractSha256: createHash('sha256').update(JSON.stringify(task.contract)).digest('hex'),
      executionLimits: task.contract.executionLimits, costMode: policy.costMode,
      allowUnknownCost: approval.allowUnknownCost === true, e2Approved: approval.e2Approved === true,
      expiresAt: new Date(approval.expiresAt).toISOString() };
    transaction(database, () => {
      database.prepare('INSERT INTO execution_grants(task_id,grant_id,authorization) VALUES(?,?,?)').run(id, grantId, JSON.stringify(authorization));
      event(id, 'execution.authorized');
    });
    return readAuthorization(id);
  };
  const list = () => database.prepare('SELECT id,state,created_at AS createdAt,updated_at AS updatedAt FROM tasks ORDER BY created_at DESC').all();
  const requireRevisionParent = (id, expectedRevision, expectedHash) => {
    const parent = get(id);
    if (!['DRAFT', 'CANCELED', 'COMPLETED', 'PAUSED'].includes(parent.state)) throw new Error('Revisions require an inactive task with known state; reconcile unknown execution first');
    if (parent.supersededBy) throw new Error('Task already has a newer revision; revise the latest task');
    if (parent.contract.revision !== expectedRevision || parent.contract.revision !== (parent.revisionInfo?.revision ?? 1)) throw new Error('Task revision does not match the expected parent version');
    if (expectedHash && createHash('sha256').update(JSON.stringify(parent.contract)).digest('hex') !== expectedHash) throw new Error('Parent contract changed while creating its revision');
    return parent;
  };
  const persistDraft = async (contract, revisionInfo) => {
    const id = `TASK-${randomUUID()}`;
    const directory = join(taskDir, id);
    await mkdir(directory);
    try {
      const origin = revisionInfo ? `\n\n## 修订来源\n父任务：${revisionInfo.parentTaskId}\n版本链：${revisionInfo.rootTaskId}\n原因：${revisionInfo.reason}` : '';
      await writeFile(join(directory, 'TASK.md'), `# ${id}: ${contract.title}\n\n## 目标\n${contract.objective}\n\n## 验收标准\n${contract.acceptance}\n\n## 允许路径（仅声明，未授权执行）\n${contract.allowedPaths.length ? contract.allowedPaths.map((path) => `- \`${path}\``).join('\n') : '无'}\n\n## 执行上限（草稿声明，执行须单独授权）\n${contract.executionLimits ? `最长时长：${contract.executionLimits.maxDurationSeconds} 秒；最多模型回合：${contract.executionLimits.maxModelTurns}。` : '未声明'}${origin}\n\n修订：${contract.revision}。当前仅保存草稿；尚未授权外部 Agent 执行。\n`, { flag: 'wx' });
      transaction(database, () => {
        if (revisionInfo) requireRevisionParent(revisionInfo.parentTaskId, contract.revision - 1, revisionInfo.parentContractSha256);
        database.prepare('INSERT INTO tasks(id,state,contract,created_at,updated_at) VALUES(?,?,?,?,?)')
          .run(id, 'DRAFT', JSON.stringify(contract), now(), now());
        event(id, 'task.created');
        if (revisionInfo) {
          database.prepare('INSERT INTO task_revisions(task_id,parent_task_id,root_task_id,revision,parent_contract_sha256,reason,created_at) VALUES(?,?,?,?,?,?,?)')
            .run(id, revisionInfo.parentTaskId, revisionInfo.rootTaskId, contract.revision, revisionInfo.parentContractSha256, revisionInfo.reason, now());
          event(id, 'task.revised_from');
          event(revisionInfo.parentTaskId, 'task.revision_created');
        }
      });
    } catch (error) {
      if (dirname(resolve(directory)) !== resolve(taskDir)) throw new Error('Refusing to clean unexpected draft path');
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return get(id);
  };
  const create = async (input) => persistDraft(taskContract(input, 1));
  const createRevision = async (id, input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['expectedRevision', 'reason', 'title', 'objective', 'acceptance', 'allowedPaths', 'executionLimits', 'riskLevel'].includes(key)) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || input.expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid task revision request');
    const { expectedRevision, reason, ...changes } = input;
    const revisionReason = requiredText(reason, 'reason');
    const parent = requireRevisionParent(id, expectedRevision);
    const contract = taskContract({ ...parent.contract, executionLimits: parent.contract.executionLimits ?? undefined, ...changes }, expectedRevision + 1);
    if (JSON.stringify(contract) === JSON.stringify({ ...parent.contract, revision: contract.revision })) throw new Error('A revision must change at least one contract field');
    return persistDraft(contract, { parentTaskId: id, rootTaskId: parent.revisionInfo?.rootTaskId ?? id,
      parentContractSha256: createHash('sha256').update(JSON.stringify(parent.contract)).digest('hex'), reason: revisionReason });
  };
  const taskVersions = (id) => {
    const task = get(id);
    const rootId = task.revisionInfo?.rootTaskId ?? id;
    const rootTask = get(rootId);
    return [{ taskId: rootId, parentTaskId: null, revision: rootTask.contract.revision, reason: null, createdAt: rootTask.createdAt },
      ...database.prepare('SELECT task_id AS taskId,parent_task_id AS parentTaskId,revision,reason,created_at AS createdAt FROM task_revisions WHERE root_task_id=? ORDER BY revision').all(rootId)];
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
    const registration = database.prepare('SELECT * FROM workspaces WHERE task_id=?').get(id);
    if (registration?.kind === 'worktree') throw new Error('Worktree workspaces do not use a file baseline');
    const baselinePath = join(taskDir, id, 'BASELINE.json');
    const info = await lstat(baselinePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Workspace baseline is not a plain file');
    const baselineContents = await readFile(baselinePath);
    const baseline = JSON.parse(baselineContents.toString('utf8'));
    if (!baseline || baseline.taskId !== id || baseline.revision !== task.contract.revision ||
      !Array.isArray(baseline.files) || baseline.files.length !== paths.length ||
      baseline.files.some((file, index) => !file || file.path !== paths[index] ||
        !Number.isInteger(file.bytes) || file.bytes < 0 || file.bytes > 8 * 1024 * 1024 ||
        typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256))) {
      throw new Error('Workspace baseline does not match the task contract');
    }
    if (registration && (registration.revision !== baseline.revision ||
      createHash('sha256').update(baselineContents).digest('hex') !== registration.baseline_sha256)) {
      throw new Error('Workspace baseline changed since registration');
    }
    return { paths, baseline, registration: registration ?? null };
  };
  const requirePreparable = (id) => {
    const task = get(id);
    if (task.state === 'RUNNING' && policy) {
      requireAuthorization(task, true);
      if (database.prepare("SELECT 1 FROM events WHERE task_id=? AND kind IN ('model_turn.requested.dsh','model_turn.requested.codex')").get(id)) throw new Error('Workspace preparation must precede model prompts');
    } else if (task.state !== 'DRAFT') throw new Error('Only drafts or locally authorized unstarted executions can be prepared');
    return task;
  };
  const requireCopyWorkspace = async (id) => {
    const registration = database.prepare('SELECT kind FROM workspaces WHERE task_id=?').get(id);
    if (registration?.kind === 'worktree') throw new Error('File-baseline checks do not apply to worktree workspaces');
    return registration ?? null;
  };
  const prepareWorkspace = async (id) => {
    const task = requirePreparable(id);
    const paths = declaredPaths(task.contract.allowedPaths);
    if (!paths.length) throw new Error('Declare allowedPaths before preparing a workspace');
    if ((await lstat(dataDir)).isSymbolicLink()) throw new Error('Runtime data directory is a link');
    const workspacesDir = join(dataDir, 'workspaces');
    await mkdir(workspacesDir, { recursive: true });
    if ((await lstat(workspacesDir)).isSymbolicLink()) throw new Error('Workspace directory is a link');
    const workspace = join(workspacesDir, id);
    if (database.prepare('SELECT 1 FROM workspaces WHERE task_id=?').get(id)) {
      throw new Error('Workspace is already registered; discard it before preparing again');
    }
    if (await lstat(workspace).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw new Error('Workspace already exists');
    const temporary = await mkdtemp(join(workspacesDir, `${id}-tmp-`));
    let baselineCreated = false;
    const files = [];
    let totalBytes = 0;
    try {
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
    } catch (error) {
      if (baselineCreated) await unlink(join(taskDir, id, 'BASELINE.json'));
      if (dirname(resolve(temporary)) !== resolve(workspacesDir)) throw new Error('Refusing to clean unexpected workspace path');
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    // After the rename the workspace and baseline are the task's durable site:
    // a registration failure must keep them for explicit reconciliation instead
    // of deleting evidence the catch above can no longer reach.
    const baselineContents = await readFile(join(taskDir, id, 'BASELINE.json'));
    const baselineSha256 = createHash('sha256').update(baselineContents).digest('hex');
    try {
      transaction(database, () => {
        database.prepare('INSERT INTO workspaces(task_id,revision,baseline_sha256,created_at,kind,metadata) VALUES(?,?,?,?,?,?)')
          .run(id, task.contract.revision, baselineSha256, now(), 'copy', null);
        event(id, 'workspace.prepared');
      });
    } catch (error) {
      throw new Error(`Workspace prepared but registration failed; the site is kept for reconciliation: ${error.message}`);
    }
    return { workspace, files, registered: true, baselineSha256 };
  };
  const inspectWorkspaceChanges = async (id) => {
    await requireCopyWorkspace(id);
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
  const prepareReviewWorkspace = async (id, { verifyCandidate, signal } = {}) => {
    const task = get(id);
    await requireCopyWorkspace(id);
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
    let testEvidence;
    if (verifyCandidate !== undefined) {
      if (typeof verifyCandidate !== 'function') throw new Error('Candidate verifier must be a trusted function');
      signal?.throwIfAborted();
      const report = await verifyCandidate({ task: structuredClone(task), workspace: candidate.workspace, files: structuredClone(files), signal });
      signal?.throwIfAborted();
      if (!report || Object.keys(report).length !== 2 || typeof report.checker !== 'string' || !report.checker.trim() || report.checker.length > 128 ||
        !Array.isArray(report.checks) || !report.checks.length || report.checks.length > 32 ||
        report.checks.some((check) => !check || Object.keys(check).length !== 2 || typeof check.name !== 'string' || !check.name.trim() || check.name.length > 200 || check.passed !== true) ||
        new Set(report.checks.map((check) => check.name)).size !== report.checks.length) throw new Error('Candidate verification failed or returned invalid evidence');
      testEvidence = { origin: 'relaycore-host', checker: report.checker,
        checks: report.checks.map(({ name, passed }) => ({ name, passed })),
        candidateSha256: createHash('sha256').update(JSON.stringify(files.map(({ path, after }) => ({ path, contents: after })))).digest('hex'),
        recordedAt: now() };
      await inspectWorkspaceChanges(id);
      for (const file of files) {
        if (!Buffer.from(file.after, 'utf8').equals(await readFileWithin(candidate.workspace, file.path))) throw new Error('Candidate changed during verification');
      }
      if (!(await inspectSourceConflicts(id)).matchesBaseline) throw new Error('Source conflict during verification');
      signal?.throwIfAborted();
    }
    const contents = JSON.stringify({ taskId: id, revision: task.contract.revision,
      objective: task.contract.objective, acceptance: task.contract.acceptance, files, ...(testEvidence ? { testEvidence } : {}) }, null, 2);
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
      const snapshotId = basename(workspace);
      const sha256 = createHash('sha256').update(contents).digest('hex');
      transaction(database, () => {
        database.prepare('INSERT INTO review_snapshots(snapshot_id,task_id,revision,contract_sha256,packet_sha256,created_at) VALUES(?,?,?,?,?,?)')
          .run(snapshotId, id, task.contract.revision, createHash('sha256').update(JSON.stringify(task.contract)).digest('hex'), sha256, now());
        event(id, 'review.snapshot_created');
      });
      return { taskId: id, snapshotId, workspace, inputPath, sha256, ...(testEvidence ? { testEvidence } : {}) };
    } catch (error) {
      if (dirname(resolve(workspace)) !== resolve(reviewsDir)) throw new Error('Refusing to clean unexpected review path');
      await rm(workspace, { recursive: true, force: true });
      throw error;
    }
  };
  const reviewSnapshots = (id) => {
    get(id);
    return database.prepare('SELECT snapshot_id AS snapshotId,revision,packet_sha256 AS sha256,created_at AS createdAt FROM review_snapshots WHERE task_id=? ORDER BY rowid').all(id);
  };
  const verifyReviewedWorkspace = async (id, snapshotId) => {
    const task = get(id);
    await requireCopyWorkspace(id);
    if (typeof snapshotId !== 'string' || snapshotId.length > 128 || !snapshotId.startsWith(`${id}-`) || !/^[A-Za-z0-9-]+$/.test(snapshotId)) throw new Error('Invalid review snapshot ID');
    const record = database.prepare('SELECT * FROM review_snapshots WHERE task_id=? AND snapshot_id=?').get(id, snapshotId);
    if (!record) throw new Error('Review snapshot is not registered');
    if (record.revision !== task.contract.revision || record.contract_sha256 !== createHash('sha256').update(JSON.stringify(task.contract)).digest('hex')) throw new Error('Review snapshot contract changed');
    const workspace = join(dataDir, 'reviews', snapshotId);
    for (const directory of [dataDir, join(dataDir, 'reviews'), workspace]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Review snapshot directory is not a plain directory');
    }
    const info = await lstat(join(workspace, 'REVIEW.json'));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('Invalid review snapshot file');
    const contents = await readFileWithin(workspace, 'REVIEW.json');
    if (contents.length > 256 * 1024 || createHash('sha256').update(contents).digest('hex') !== record.packet_sha256) throw new Error('Review snapshot changed');
    const packet = JSON.parse(contents);
    const paths = declaredPaths(task.contract.allowedPaths);
    if (!packet || packet.taskId !== id || packet.revision !== task.contract.revision ||
      packet.objective !== task.contract.objective || packet.acceptance !== task.contract.acceptance ||
      !Array.isArray(packet.files) || packet.files.length !== paths.length ||
      packet.files.some((file, index) => !file || file.path !== paths[index] || typeof file.before !== 'string' || typeof file.after !== 'string')) throw new Error('Review snapshot does not match the task');
    const candidate = await inspectWorkspaceChanges(id);
    for (const file of packet.files) {
      if (!Buffer.from(file.after, 'utf8').equals(await readFileWithin(candidate.workspace, file.path))) throw new Error('Candidate changed after review snapshot');
    }
    if (!(await inspectSourceConflicts(id)).matchesBaseline) throw new Error('Source conflict after review snapshot');
    if (createHash('sha256').update(await readFileWithin(workspace, 'REVIEW.json')).digest('hex') !== record.packet_sha256) throw new Error('Review snapshot changed during validation');
    return { snapshotId, revision: record.revision, sha256: record.packet_sha256, files: paths.length,
      candidateSha256: createHash('sha256').update(JSON.stringify(packet.files.map(({ path, after }) => ({ path, contents: after })))).digest('hex'),
      ...(packet.testEvidence ? { testEvidence: packet.testEvidence } : {}) };
  };
  const taskWorkspacePattern = /^TASK-[0-9a-f-]{36}$/;
  const tempWorkspacePattern = /^TASK-[0-9a-f-]{36}-tmp-/;
  const workspacesRoot = () => join(dataDir, 'workspaces');
  const validGitRef = (ref) => typeof ref === 'string' && ref.length <= 256 && !ref.startsWith('-') && !ref.includes('..') &&
    /^[A-Za-z0-9._/-]+$/.test(ref);
  const prepareGitWorktree = async (id, { repository, ref = 'HEAD' } = {}) => {
    const task = requirePreparable(id);
    const paths = declaredPaths(task.contract.allowedPaths);
    if (!paths.length) throw new Error('Declare allowedPaths before preparing a workspace');
    if (!repository || typeof repository !== 'string') throw new Error('A Git worktree requires an explicit repository path');
    if (!validGitRef(ref)) throw new Error('Invalid Git ref');
    if ((await lstat(dataDir)).isSymbolicLink()) throw new Error('Runtime data directory is a link');
    const workspacesDir = join(dataDir, 'workspaces');
    await mkdir(workspacesDir, { recursive: true });
    if ((await lstat(workspacesDir)).isSymbolicLink()) throw new Error('Workspace directory is a link');
    const workspace = join(workspacesDir, id);
    if (database.prepare('SELECT 1 FROM workspaces WHERE task_id=?').get(id)) {
      throw new Error('Workspace is already registered; discard it before preparing again');
    }
    if (await lstat(workspace).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw new Error('Workspace already exists');
    const repositoryPath = resolve(repository);
    const repositoryInfo = await lstat(repositoryPath);
    if (!repositoryInfo.isDirectory() || repositoryInfo.isSymbolicLink()) throw new Error('Repository must be a plain directory');
    if (!await lstat(join(repositoryPath, '.git')).then((gitInfo) => gitInfo.isDirectory() || gitInfo.isFile(),
      (error) => { if (error.code === 'ENOENT') return false; throw error; })) {
      throw new Error('Repository does not contain a Git work tree');
    }
    const baseCommit = (await gitRun(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repositoryPath })).trim();
    // The worktree must be created directly at its final path: renaming a
    // worktree directory afterwards would leave Git's internal registration
    // pointing at the stale temporary name.
    try {
      await gitRun(['worktree', 'add', '--detach', workspace, baseCommit], { cwd: repositoryPath });
    } catch (error) {
      if (dirname(resolve(workspace)) !== resolve(workspacesDir)) throw new Error('Refusing to clean unexpected workspace path');
      await rm(workspace, { recursive: true, force: true });
      await gitRun(['worktree', 'prune'], { cwd: repositoryPath }).catch(() => {});
      throw error;
    }
    const metadata = JSON.stringify({ repository: repositoryPath, requestedRef: ref, baseCommit });
    try {
      transaction(database, () => {
        database.prepare('INSERT INTO workspaces(task_id,revision,baseline_sha256,created_at,kind,metadata) VALUES(?,?,?,?,?,?)')
          .run(id, task.contract.revision, '0'.repeat(64), now(), 'worktree', metadata);
        event(id, 'workspace.prepared');
      });
    } catch (error) {
      throw new Error(`Worktree prepared but registration failed; the site is kept for reconciliation: ${error.message}`);
    }
    return { workspace, kind: 'worktree', registered: true, repository: repositoryPath, ref, baseCommit };
  };
  const requireWorktreeRegistration = (id) => {
    get(id);
    const registration = database.prepare('SELECT * FROM workspaces WHERE task_id=?').get(id);
    if (!registration || registration.kind !== 'worktree') throw new Error('Task has no registered Git worktree workspace');
    let metadata;
    try { metadata = JSON.parse(registration.metadata); }
    catch { throw new Error('Registered worktree metadata is unreadable'); }
    if (!metadata || typeof metadata.repository !== 'string' || !/^[0-9a-f]{40}$/.test(metadata.baseCommit ?? '')) {
      throw new Error('Registered worktree metadata is incomplete');
    }
    return { registration, metadata };
  };
  const inspectWorktreeChanges = async (id) => {
    const { metadata } = requireWorktreeRegistration(id);
    const workspace = join(workspacesRoot(), id);
    const info = await lstat(workspace);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Worktree workspace is not a plain directory');
    const status = await gitRun(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: workspace });
    const changedFiles = [];
    for (const entry of status.split('\0').filter(Boolean)) {
      changedFiles.push({ status: entry.slice(0, 2).trim(), path: entry.slice(3) });
    }
    if (changedFiles.length > 512) throw new Error('Worktree exceeds 512 changed files');
    const diff = await gitRun(['diff', metadata.baseCommit, '--'], { cwd: workspace });
    if (Buffer.byteLength(diff, 'utf8') > 1024 * 1024) throw new Error('Worktree diff exceeds 1 MiB');
    return { workspace, kind: 'worktree', baseCommit: metadata.baseCommit, changedFiles, diff };
  };
  const workspaceInventory = async () => {
    const root = workspacesRoot();
    const names = await readdir(root).then((entries) => entries, (error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const registrations = new Map(database.prepare('SELECT task_id AS taskId,revision,baseline_sha256 AS baselineSha256,created_at AS createdAt,kind,metadata FROM workspaces').all()
      .map((row) => [row.taskId, row]));
    const observed = new Set();
    const inventory = { registered: [], unregistered: [], leftoverTemp: [], unexpected: [] };
    for (const name of names) {
      observed.add(name);
      const info = await lstat(join(root, name));
      const entry = { name, kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'other' };
      if (tempWorkspacePattern.test(name)) inventory.leftoverTemp.push(entry);
      else if (taskWorkspacePattern.test(name)) {
        const registration = registrations.get(name);
        if (registration) inventory.registered.push({ ...registration, present: entry.kind === 'directory' });
        else inventory.unregistered.push(entry);
      } else inventory.unexpected.push(entry);
    }
    for (const [taskId, registration] of registrations) {
      if (!observed.has(taskId)) inventory.registered.push({ ...registration, present: false });
    }
    return inventory;
  };
  const discardWorkspace = async (id) => {
    const task = get(id);
    if (!['DRAFT', 'CANCELED', 'COMPLETED'].includes(task.state)) {
      throw new Error(`Refusing to discard a workspace while the task is ${task.state}; reconcile the outcome first`);
    }
    const root = workspacesRoot();
    const registration = database.prepare('SELECT * FROM workspaces WHERE task_id=?').get(id);
    const workspacePath = join(root, id);
    const baselinePath = join(taskDir, id, 'BASELINE.json');
    const present = async (path) => lstat(path).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    const workspacePresent = await present(workspacePath);
    const baselinePresent = await present(baselinePath);
    const leftovers = (await readdir(root).then((entries) => entries, (error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).filter((name) => name.startsWith(`${id}-tmp-`) || name.startsWith(`${id}-wt-tmp-`));
    if (!registration && !workspacePresent && !baselinePresent && !leftovers.length) {
      throw new Error('No registered workspace, directory, baseline or leftover temporary to discard');
    }
    let worktreeRemoval = null;
    let worktreeRemovalDetail = null;
    let worktreeRepository = null;
    if (registration?.kind === 'worktree') {
      let metadata = null;
      try { metadata = JSON.parse(registration.metadata); } catch { metadata = null; }
      if (metadata && typeof metadata.repository === 'string') worktreeRepository = metadata.repository;
    }
    if (registration?.kind === 'worktree' && worktreeRepository && workspacePresent) {
      try {
        await gitRun(['worktree', 'remove', '--force', workspacePath], { cwd: worktreeRepository });
        worktreeRemoval = 'removed';
      } catch (error) {
        worktreeRemovalDetail = String(error.stderr ?? error.message).slice(0, 300);
      }
    }
    const removeDirectory = async (path) => {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing to remove a non-plain directory: ${basename(path)}`);
      if (dirname(resolve(path)) !== resolve(root)) throw new Error('Refusing to clean unexpected workspace path');
      await rm(path, { recursive: true, force: true });
    };
    if (workspacePresent && worktreeRemoval !== 'removed') await removeDirectory(workspacePath);
    for (const name of leftovers) await removeDirectory(join(root, name));
    if (baselinePresent) {
      const info = await lstat(baselinePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Workspace baseline is not a plain file');
      await unlink(baselinePath);
    }
    if (registration?.kind === 'worktree' && worktreeRemoval !== 'removed' && worktreeRepository) {
      // Prune only after the directory is gone; pruning with the site still on
      // disk would leave a live registration for a workspace we just deleted.
      await gitRun(['worktree', 'prune', '--verbose'], { cwd: worktreeRepository }).catch(() => {});
      worktreeRemoval = 'pruned';
    }
    transaction(database, () => {
      database.prepare('DELETE FROM workspaces WHERE task_id=?').run(id);
      event(id, 'workspace.discarded');
    });
    return { discarded: true, kind: registration?.kind ?? 'copy', removedRegistration: Boolean(registration),
      removedLeftovers: leftovers.length, ...(worktreeRemoval ? { worktreeRemoval } : {}),
      ...(worktreeRemovalDetail ? { worktreeRemovalDetail } : {}) };
  };
  const integrationManifestPath = (id) => join(taskDir, id, 'PRE-INTEGRATION', 'manifest.json');
  const integrateWorkspace = async (id, snapshotId) => {
    const task = get(id);
    if (task.state !== 'COMPLETED') throw new Error(`Only a completed task can integrate; ${task.state} must reconcile first`);
    if (await lstat(integrationManifestPath(id)).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw new Error('This task already integrated; roll back before integrating again');
    const verified = await verifyReviewedWorkspace(id, snapshotId);
    const packet = JSON.parse(await readFileWithin(join(dataDir, 'reviews', snapshotId), 'REVIEW.json'));
    const backups = [];
    let totalBytes = 0;
    for (const file of packet.files) {
      const source = await readFileWithin(projectRoot, file.path);
      totalBytes += source.length;
      if (totalBytes > 32 * 1024 * 1024) throw new Error('Integration sources exceed 32 MiB');
      if (!Buffer.from(file.before, 'utf8').equals(source)) throw new Error(`Source changed after review: ${file.path}`);
      const after = Buffer.from(file.after, 'utf8');
      if (after.includes(0)) throw new Error('Integrated content must be UTF-8 text');
      backups.push({ path: file.path, before: source, after });
    }
    const backupDir = join(taskDir, id, 'PRE-INTEGRATION');
    const manifest = { taskId: id, snapshotId, revision: task.contract.revision,
      sha256: verified.sha256, candidateSha256: verified.candidateSha256, integratedAt: now(),
      files: backups.map(({ path, before, after }) => ({ path,
        beforeSha256: createHash('sha256').update(before).digest('hex'), beforeBytes: before.length,
        afterSha256: createHash('sha256').update(after).digest('hex'), afterBytes: after.length })) };
    let backupCreated = false;
    try {
      await mkdir(backupDir);
      backupCreated = true;
      await writeFile(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
      for (const { path, before, after } of backups) {
        const target = join(backupDir, ...path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, before, { flag: 'wx' });
      }
    } catch (error) {
      if (backupCreated) await rm(backupDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Integration backups failed; no source file was modified: ${error.message}`);
    }
    const written = [];
    try {
      for (const { path, after } of backups) {
        for (const file of backups) {
          const expected = written.includes(file.path) ? file.after : file.before;
          if (!expected.equals(await readFileWithin(projectRoot, file.path))) throw new Error('Source conflict during integration');
        }
        await writeFile(join(projectRoot, ...path.split('/')), after);
        written.push(path);
      }
    } catch (error) {
      let restored = 0;
      let restoreFailure = null;
      for (const path of written) {
        try {
          const integrated = backups.find((file) => file.path === path).after;
          if (!integrated.equals(await readFileWithin(projectRoot, path))) throw new Error(`Source changed after integration write: ${path}`);
          await writeFile(join(projectRoot, ...path.split('/')), await readFileWithin(backupDir, path));
          restored++;
        } catch (restoreError) { restoreFailure ??= restoreError; }
      }
      transaction(database, () => {
        event(id, 'integration.failed');
        database.prepare("UPDATE tasks SET state='RECOVERY_REQUIRED',updated_at=? WHERE id=? AND state='COMPLETED'").run(now(), id);
      });
      throw new Error(`Integration failed after ${written.length} writes and restored ${restored}` +
        `${restoreFailure ? ` (restore also failed: ${restoreFailure.message})` : ''}; the task needs reconciliation: ${error.message}`);
    }
    transaction(database, () => { event(id, 'integration.completed'); });
    return { integrated: true, taskId: id, snapshotId, files: written, manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') };
  };
  const rollbackIntegration = async (id) => {
    const task = get(id);
    if (task.state !== 'COMPLETED') throw new Error(`Only a completed task can roll back; ${task.state} must reconcile first`);
    if (database.prepare("SELECT 1 FROM events WHERE task_id=? AND kind='integration.rolled_back'").get(id)) {
      throw new Error('This task already rolled back');
    }
    if (!await lstat(integrationManifestPath(id)).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw new Error('No integration manifest to roll back');
    const backupDir = join(taskDir, id, 'PRE-INTEGRATION');
    const manifest = JSON.parse(await readFileWithin(backupDir, 'manifest.json'));
    for (const file of manifest.files) {
      const current = await readFileWithin(projectRoot, file.path);
      if (current.length !== file.afterBytes || createHash('sha256').update(current).digest('hex') !== file.afterSha256) {
        throw new Error(`Source changed after integration; rollback refused: ${file.path}`);
      }
    }
    for (const file of manifest.files) {
      const backup = await readFileWithin(backupDir, file.path);
      if (backup.length !== file.beforeBytes || createHash('sha256').update(backup).digest('hex') !== file.beforeSha256) {
        throw new Error(`Integration backup changed; rollback refused: ${file.path}`);
      }
    }
    const restored = [];
    try {
      for (const file of manifest.files) {
        const backup = await readFileWithin(backupDir, file.path);
        await writeFile(join(projectRoot, ...file.path.split('/')), backup);
        restored.push(file.path);
      }
    } catch (error) {
      // A partial restore leaves the source tree mixed; record it as an
      // explicit reconciliation requirement instead of throwing silently.
      transaction(database, () => {
        event(id, 'integration.rollback_failed');
        database.prepare("UPDATE tasks SET state='RECOVERY_REQUIRED',updated_at=? WHERE id=? AND state='COMPLETED'").run(now(), id);
      });
      throw new Error(`Rollback failed after restoring ${restored.length} of ${manifest.files.length} files` +
        ` (restored: ${restored.join(', ') || 'none'}); the source tree is mixed and the task needs reconciliation: ${error.message}`);
    }
    transaction(database, () => { event(id, 'integration.rolled_back'); });
    return { rolledBack: true, taskId: id, files: manifest.files.map(({ path }) => path) };
  };
  const dispatch = (id) => {
    if (!executor) throw new Error('External execution is disabled until Phase 0 safety checks pass');
    const task = get(id);
    if (task.state !== 'DRAFT') throw new Error(`Cannot dispatch task in ${task.state}`);
    const limits = declaredLimits(task.contract.executionLimits ?? undefined);
    if (!limits) throw new Error('Declare executionLimits before dispatch');
    if (limits.maxDurationSeconds > 2147483) throw new Error('maxDurationSeconds exceeds the supported timer range');
    const executionLevel = task.contract.riskLevel ?? 'E1';
    if (executionLevel === 'E2') {
      const grant = readAuthorization(id);
      if (!grant?.e2Approved) throw new Error('E2 operations require explicit L3 approval before dispatch');
    }
    transaction(database, () => {
      requireAuthorization(task, false);
      if (policy) {
        const consumed = database.prepare('UPDATE execution_grants SET consumed_at=? WHERE task_id=? AND consumed_at IS NULL').run(now(), id);
        if (consumed.changes !== 1) throw new Error('Execution authorization was already consumed');
        event(id, 'execution.authorization_consumed');
      }
      database.prepare("UPDATE tasks SET state='QUEUED',updated_at=? WHERE id=? AND state='DRAFT'").run(now(), id);
      event(id, 'task.dispatched');
      event(id, 'task.routed');
    });
    // Only a truly dispatched task gets a routing record; refused attempts
    // must not leave one behind. Overwriting is intentional for re-dispatches
    // of a revised task.
    const routing = { taskId: id, executionLevel, adapterKind: 'dsh-acp-account',
      riskReason: executionLevel === 'E2' ? 'declared protected-write task; L3 approval required'
        : executionLevel === 'E0' ? 'declared read-only analysis'
        : 'declared isolated code changes; candidate-copy workspace with read-only DSH policy',
      recordedAt: now() };
    writeFileSync(join(taskDir, id, 'ROUTING.json'), JSON.stringify(routing, null, 2));
    queueMicrotask(drain);
    return get(id);
  };
  // Ordinary guidance never interrupts a running turn: it is recorded and
  // folded into the next model prompt by the executor.
  const guide = (id, text) => {
    const task = get(id);
    if (!['DRAFT', 'QUEUED', 'RUNNING', 'PAUSED'].includes(task.state)) {
      throw new Error(`Cannot guide a task in ${task.state}`);
    }
    const guidance = requiredText(text, 'guidance');
    writeFileSync(join(taskDir, id, 'GUIDANCE.md'), `${guidance}\n`, { flag: 'a' });
    transaction(database, () => { event(id, 'task.guided'); });
    return { guided: true, taskId: id };
  };
  const consumeGuidance = (id) => {
    get(id);
    const guidancePath = join(taskDir, id, 'GUIDANCE.md');
    const pending = readFileSyncSafe(guidancePath);
    if (pending === null) return null;
    const archive = join(taskDir, id, `GUIDANCE-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.md`);
    renameSyncSafe(guidancePath, archive);
    transaction(database, () => { event(id, 'task.guidance_consumed'); });
    return pending;
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
        database.prepare("UPDATE tasks SET state='RECOVERY_REQUIRED',stop_requested=1,updated_at=? WHERE id=? AND state='RUNNING'").run(now(), id);
        event(id, 'task.stop_requested');
        event(id, 'task.recovery_required');
      });
      controllers.get(id)?.abort();
    } else if (task.state === 'PAUSED') {
      transaction(database, () => {
        database.prepare("UPDATE tasks SET state='CANCELED',stop_requested=1,updated_at=? WHERE id=? AND state='PAUSED'").run(now(), id);
        event(id, 'task.canceled');
      });
    }
    return get(id);
  };
  // Pausing a RUNNING task must flip the state before aborting the executor:
  // drain's failure path only touches tasks still in RUNNING, so the abort is
  // recorded as an intentional pause instead of an unknown interruption.
  const pause = (id) => {
    const task = get(id);
    transaction(database, () => {
      let changed;
      if (task.state === 'RUNNING') {
        changed = database.prepare("UPDATE tasks SET state='PAUSED',updated_at=? WHERE id=? AND state='RUNNING'").run(now(), id);
      } else if (task.state === 'RECOVERY_REQUIRED') {
        changed = database.prepare("UPDATE tasks SET state='PAUSED',updated_at=? WHERE id=? AND state='RECOVERY_REQUIRED'").run(now(), id);
      } else throw new Error(`Cannot pause a task in ${task.state}`);
      if (changed.changes !== 1) throw new Error('Task state changed while pausing');
      event(id, 'task.paused');
    });
    controllers.get(id)?.abort();
    return get(id);
  };
  const resume = (id) => {
    if (!executor) throw new Error('Resuming requires a locally configured executor');
    const task = get(id);
    if (task.state !== 'PAUSED') throw new Error(`Cannot resume a task in ${task.state}`);
    if (task.supersededBy) throw new Error('Task has a newer revision; use the latest draft');
    requireAuthorization(task, true);
    transaction(database, () => {
      const changed = database.prepare("UPDATE tasks SET state='QUEUED',updated_at=? WHERE id=? AND state='PAUSED'").run(now(), id);
      if (changed.changes !== 1) throw new Error('Task state changed while resuming');
      event(id, 'task.resumed');
    });
    queueMicrotask(drain);
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
          requireAuthorization(get(id), true);
        };
        try {
          const task = get(id);
          const limits = declaredLimits(task.contract.executionLimits ?? undefined);
          if (!limits || limits.maxDurationSeconds > 2147483) throw new Error('Missing or unsupported executionLimits');
          const dispatched = database.prepare("SELECT created_at FROM events WHERE task_id=? AND kind='task.dispatched' ORDER BY sequence LIMIT 1").get(id);
          deadline = Date.parse(dispatched?.created_at) + limits.maxDurationSeconds * 1000;
          const authorization = requireAuthorization(task, true);
          if (authorization) deadline = Math.min(deadline, Date.parse(authorization.expiresAt));
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
            },
            recordUsage(agent, usage, model) {
              if (closed) throw new Error('Core is closed');
              if (!['dsh', 'codex'].includes(agent)) throw new Error('Unknown agent');
              const inputTokens = Number(usage?.inputTokens ?? usage?.input_tokens ?? usage?.used);
              const outputTokens = Number(usage?.outputTokens ?? usage?.output_tokens ?? 0);
              if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
                !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
                throw new Error('Usage must carry nonnegative integer token counts');
              }
              const contextTokens = Number.isSafeInteger(Number(usage?.size)) ? Number(usage.size) : null;
              const safeModel = model === undefined || model === null ? null : String(model).slice(0, 128);
              transaction(database, () => {
                database.prepare('INSERT INTO usage_ledger(task_id,agent,model,input_tokens,output_tokens,context_tokens,source,recorded_at) VALUES(?,?,?,?,?,?,?,?)')
                  .run(id, agent, safeModel, inputTokens, outputTokens, contextTokens, 'executor', now());
                event(id, 'usage.recorded');
              });
              return { recorded: true, inputTokens, outputTokens };
            }
          }, api);
          requireActive();
          if (typeof result?.handoff !== 'string' || !result.handoff.trim()) throw new Error('Missing handoff');
          if (Buffer.byteLength(result.handoff, 'utf8') > 1024 * 1024) throw new Error('Handoff exceeds 1 MiB');
          writeFileSync(join(taskDir, id, 'HANDOFF.md'), result.handoff, { flag: 'wx' });
          transaction(database, () => {
            database.prepare("UPDATE tasks SET state='COMPLETED',result=?,updated_at=? WHERE id=?")
              .run(result.handoff, now(), id);
            event(id, 'task.completed');
          });
        } catch (error) {
          // The failure detail is the only input a reconciliation decision has;
          // dropping it made every RECOVERY_REQUIRED a guess.
          if (!closed) process.stderr.write(`[relaycore] task ${id} entered recovery: ${String(error?.stack ?? error).slice(0, 800)}\n`);
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
  // Long-term memory is Bridge-controlled: agents never write these files
  // directly, appends are versioned, and optimistic hashes prevent concurrent
  // updates from overwriting each other.
  const memoryFiles = new Set(['INDEX.md', 'PROJECT.md', 'ARCHITECTURE.md', 'DECISIONS.md', 'PROGRESS.md', 'LESSONS.md']);
  const memoryDir = join(dataDir, '.agent-memory');
  const memoryRead = (file) => {
    if (!memoryFiles.has(file)) throw new Error('Unknown memory file');
    return readFileSyncSafe(join(memoryDir, file));
  };
  const memoryAppend = (file, text, expectedSha256) => {
    if (!memoryFiles.has(file)) throw new Error('Unknown memory file');
    if (typeof text !== 'string' || !text.trim() || text.length > 65536) {
      throw new Error('Memory text must be nonempty text of at most 65536 characters');
    }
    const appendix = text;
    if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new Error('Provide the current memory file SHA-256 to prevent concurrent overwrite');
    }
    mkdir(memoryDir, { recursive: true });
    const current = readFileSyncSafe(join(memoryDir, file)) ?? '';
    const currentSha256 = createHash('sha256').update(current).digest('hex');
    if (currentSha256 !== expectedSha256) {
      throw new Error(`Memory file changed since read (${file}); re-read and re-apply`);
    }
    const version = (database.prepare('SELECT COALESCE(MAX(version),0) AS version FROM memory_versions WHERE file=?').get(file).version) + 1;
    const versionsDir = join(memoryDir, 'versions');
    mkdir(versionsDir, { recursive: true });
    if (current.length) writeFileSync(join(versionsDir, `${file.replace(/\.md$/, '')}-v${version}.md`), current, { flag: 'wx' });
    writeFileSync(join(memoryDir, file), `${current}${current.length ? '\n' : ''}${appendix}\n`);
    transaction(database, () => {
      database.prepare('INSERT INTO memory_versions(file,version,sha256,bytes,recorded_at) VALUES(?,?,?,?,?)')
        .run(file, version, createHash('sha256').update(`${current}${current.length ? '\n' : ''}${appendix}\n`).digest('hex'),
          Buffer.byteLength(`${current}${current.length ? '\n' : ''}${appendix}\n`), now());
    });
    return { file, version, sha256: createHash('sha256').update(readFileSyncSafe(join(memoryDir, file)) ?? '').digest('hex') };
  };
  const memoryHistory = (file) => {
    if (!memoryFiles.has(file)) throw new Error('Unknown memory file');
    return database.prepare('SELECT version,sha256,bytes,recorded_at AS recordedAt FROM memory_versions WHERE file=? ORDER BY version').all(file);
  };
  const usageSummary = () => {
    const entries = database.prepare('SELECT task_id AS taskId,agent,model,input_tokens AS inputTokens,output_tokens AS outputTokens,context_tokens AS contextTokens,recorded_at AS recordedAt FROM usage_ledger ORDER BY sequence').all();
    return { entries, totals: entries.reduce((sums, entry) => {
      sums[entry.agent] ??= { inputTokens: 0, outputTokens: 0, calls: 0 };
      sums[entry.agent].inputTokens += entry.inputTokens;
      sums[entry.agent].outputTokens += entry.outputTokens;
      sums[entry.agent].calls += 1;
      return sums;
    }, {}) };
  };
  const api = { create, createRevision, taskVersions, get, list, dispatch, stop, pause, resume, guide, consumeGuidance, authorizeExecution, prepareWorkspace, prepareGitWorktree, inspectWorktreeChanges, verifyWorkspace, applyWorkspaceProposal, inspectWorkspaceChanges, inspectSourceConflicts, prepareReviewWorkspace, reviewSnapshots, verifyReviewedWorkspace, workspaceInventory, discardWorkspace, integrateWorkspace, rollbackIntegration, usageSummary, memoryRead, memoryAppend, memoryHistory,
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
  if (executor) queueMicrotask(drain);
  return api;
}
