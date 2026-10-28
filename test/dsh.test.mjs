import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { openCore } from '../src/core.mjs';
import { openAcpLifecycle } from '../src/acp.mjs';
import { runDshProposal, runDshReviewTask, dshEnvironment } from '../src/dsh.mjs';
import { runCodexReview } from '../src/review.mjs';

const fakeDsh = `
import { createInterface } from 'node:readline';
const scenario = process.env.TEST_DSH_SCENARIO;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'session/cancel') return;
  const send = (value, done) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n', done);
  if (message.method === 'session/prompt') {
    if (scenario === 'waiting') return;
    if (scenario === 'crash-empty') process.exit(23);
    const update = scenario === 'tool' ? {sessionUpdate:'tool_call'} : {sessionUpdate:'agent_message_chunk',content:{type:'text',text: scenario === 'malformed' ? 'not json' : JSON.stringify({summary:'Set the requested message.',files: scenario === 'duplicate' ? [{path:'message.txt',contents:'ready\\n'},{path:'message.txt',contents:'ready\\n'}] : [{path: scenario === 'undeclared' ? '../outside.txt' : 'message.txt',contents: scenario === 'oversized' ? 'x'.repeat(256*1024) : 'ready\\n'}]})}};
    if (['crash-partial', 'crash-full'].includes(scenario)) {
      if (scenario === 'crash-partial') update.content.text = '{"summary":"incomplete';
      send({ method: 'session/update', params: { sessionId: 'dsh-test-session', update } }, () => process.exit(23));
      return;
    }
    if (scenario === 'permission') send({id:900,method:'session/request_permission',params:{sessionId:'dsh-test-session'}});
    else send({method:'session/update',params:{sessionId:scenario === 'foreign' ? 'another-session' : 'dsh-test-session',update}});
  }
  if (message.method === 'session/close' && scenario === 'late-tool') send({method:'session/update',params:{sessionId:'dsh-test-session',update:{sessionUpdate:'tool_call'}}});
  send({id:message.id,result:message.method === 'initialize' ? {protocolVersion:1} : message.method === 'session/new' ? {sessionId:'dsh-test-session'} : {stopReason:'end_turn'}});
});`;

async function exercise(scenario, verdict = 'approved', maxModelTurns = 2) {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-dsh-test-'));
  let core;
  let started = false;
  let finish;
  const settled = new Promise((done) => { finish = done; });
  let reviewCalls = 0;
  let snapshotSeparated = false;
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    const authHome = join(root, 'review-auth');
    await mkdir(authHome);
    await writeFile(join(authHome, 'auth.json'), '{}');
    const propose = (input) => runDshProposal(input, (command, args, options) => {
      assert.equal(options.env.DSH_PERMISSION_MODE, 'read-only');
      assert.equal(options.env.RELAYCORE_TOKEN, undefined);
      assert.equal(options.env.CODEX_API_KEY, undefined);
      assert.equal(options.env.DEEPSEEK_API_KEY, 'test-only-key');
      assert.equal(options.cwd, join(input.home, 'Workspace'));
      return openAcpLifecycle(process.execPath, ['--input-type=module', '-e', fakeDsh], {
        ...options, env: { ...options.env, TEST_DSH_SCENARIO: scenario }, timeoutMs: 2000
      });
    });
    const review = async (input) => {
      reviewCalls++;
      const packet = JSON.parse(await readFile(input.review.inputPath, 'utf8'));
      assert.equal(packet.files[0].before, 'pending\n');
      assert.equal(packet.files[0].after, 'ready\n');
      snapshotSeparated = dirname(input.review.workspace).endsWith(join('.RelayCore', 'reviews'));
      class FakeCodex {
        startThread() {
          return { async runStreamed() {
            return { events: (async function* () {
              yield { type: 'thread.started', thread_id: 'codex-test-session' };
              yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdict, rationale: 'Checked exact text against acceptance.' }) } };
              yield { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 8 } };
            })() };
          } };
        }
      }
      return runCodexReview(input, FakeCodex);
    };
    core = await openCore(root, async (task, context) => {
      started = true;
      try { return await runDshReviewTask({ core, task, context, executable: process.execPath, apiKey: 'test-only-key', authHome }, { propose, review }); }
      finally { finish(); }
    });
    const task = await core.create({ title: 'DSH integration', objective: 'Change pending to ready.', acceptance: 'Exact ready newline.',
      allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 10, maxModelTurns } });
    const candidate = await core.prepareWorkspace(task.id);
    core.dispatch(task.id);
    if (scenario === 'waiting') {
      while (!core.events(task.id).some((event) => event.kind === 'model_turn.requested.dsh')) await setTimeout(5);
      core.stop(task.id);
    }
    await settled;
    while (core.get(task.id).state === 'RUNNING') await setTimeout(5);
    const result = { task: core.get(task.id), events: core.events(task.id).map((event) => event.kind), reviewCalls, snapshotSeparated,
      source: await readFile(join(root, 'message.txt'), 'utf8'), candidate: await readFile(join(candidate.workspace, 'message.txt'), 'utf8'),
      handoff: await lstat(join(root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md')).then(() => true, () => false),
      reopened: [], replays: 0 };
    core.close();
    core = undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      core = await openCore(root, async () => { result.replays++; throw new Error('Unexpected task replay'); });
      await setTimeout(0);
      result.reopened.push({ task: core.get(task.id), events: core.events(task.id).map((event) => event.kind) });
      core.close();
      core = undefined;
    }
    return result;
  } finally {
    core?.close();
    if (started) await settled;
    await rm(root, { recursive: true, force: true });
  }
}

test('DSH proposal crosses ACP, updates only the candidate and receives independent SDK review', async () => {
  const result = await exercise('success');
  assert.equal(result.task.state, 'COMPLETED');
  assert.equal(result.source, 'pending\n');
  assert.equal(result.candidate, 'ready\n');
  assert.equal(result.handoff, true);
  assert.equal(result.snapshotSeparated, true);
  assert.deepEqual(result.task.sessions.map((session) => session.agent).sort(), ['codex', 'dsh']);
  assert.deepEqual(result.events.filter((kind) => kind.startsWith('model_turn.requested.')), ['model_turn.requested.dsh', 'model_turn.requested.codex']);
});

test('DSH tools, permissions, foreign sessions and invalid proposals never reach independent review', async () => {
  for (const scenario of ['tool', 'late-tool', 'permission', 'foreign', 'malformed', 'undeclared', 'duplicate', 'oversized']) {
    const result = await exercise(scenario);
    assert.equal(result.task.state, 'RECOVERY_REQUIRED', scenario);
    assert.equal(result.reviewCalls, 0, scenario);
    assert.equal(result.source, 'pending\n', scenario);
    assert.equal(result.candidate, 'pending\n', scenario);
    assert.equal(result.handoff, false, scenario);
  }
});

test('DSH process loss keeps durable intent without review, handoff or replay', async () => {
  for (const scenario of ['crash-empty', 'crash-partial', 'crash-full']) {
    const result = await exercise(scenario);
    assert.equal(result.task.state, 'RECOVERY_REQUIRED', scenario);
    assert.equal(result.reviewCalls, 0, scenario);
    assert.equal(result.source, 'pending\n', scenario);
    assert.equal(result.candidate, 'pending\n', scenario);
    assert.equal(result.handoff, false, scenario);
    assert.equal(result.replays, 0, scenario);
    for (const snapshot of [{ task: result.task, events: result.events }, ...result.reopened]) {
      assert.equal(snapshot.task.state, 'RECOVERY_REQUIRED', scenario);
      assert.deepEqual(snapshot.task.sessions.map(({ agent, sessionId }) => ({ agent, sessionId })),
        [{ agent: 'dsh', sessionId: 'dsh-test-session' }], scenario);
      assert.deepEqual(snapshot.events.filter((kind) => kind.startsWith('model_turn.requested.')), ['model_turn.requested.dsh'], scenario);
      assert.equal(snapshot.events.filter((kind) => kind === 'task.recovery_required').length, 1, scenario);
      assert.equal(snapshot.events.includes('task.completed'), false, scenario);
    }
  }
});

test('rejected review or stopping DSH cannot produce a successful handoff', async () => {
  const rejected = await exercise('success', 'rejected');
  assert.equal(rejected.task.state, 'RECOVERY_REQUIRED');
  assert.equal(rejected.candidate, 'ready\n');
  assert.equal(rejected.source, 'pending\n');
  assert.equal(rejected.handoff, false);
  const stopped = await exercise('waiting');
  assert.equal(stopped.task.state, 'RECOVERY_REQUIRED');
  assert.equal(stopped.reviewCalls, 0);
  assert.equal(stopped.candidate, 'pending\n');
  assert.equal(stopped.handoff, false);
});

test('DSH credentials are explicit and environment does not forward unrelated settings', async () => {
  await assert.rejects(runDshProposal({ apiKey: '' }), /test-only DeepSeek/);
  const env = dshEnvironment('isolated-home', 'test-only-key');
  assert.equal(env.DEEPSEEK_API_KEY, 'test-only-key');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.RELAYCORE_TOKEN, undefined);
});

test('DSH and independent review share the durable prompt quota', async () => {
  const result = await exercise('success', 'approved', 1);
  assert.equal(result.task.state, 'RECOVERY_REQUIRED');
  assert.deepEqual(result.events.filter((kind) => kind.startsWith('model_turn.requested.')), ['model_turn.requested.dsh']);
  assert.deepEqual(result.task.sessions.map((session) => session.agent), ['dsh']);
  assert.equal(result.source, 'pending\n');
  assert.equal(result.handoff, false);
});

const fakeAccountDsh = `
import { createInterface } from 'node:readline';
const catalog = (currentValue) => [{ id: 'model', category: 'model', type: 'select', currentValue, options: [
  { group: 'deepseek-official', name: 'DeepSeek Account', options: [{ name: 'API model', value: 'api-choice' }] },
  { group: 'deepseek-account', name: 'Account', options: [{ name: 'Account Flash', value: 'opaque-account-choice' }] }
] }];
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'session/cancel') return;
  const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
  if (message.method === 'session/prompt') {
    send({method:'session/update',params:{sessionId:'account-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({summary:'Set the requested message.',files:[{path:'message.txt',contents:'ready\\n'}]})}}}});
    send({id:message.id,result:{stopReason:'end_turn'}});
    return;
  }
  if (message.method === 'session/set_config_option') {
    if (message.params.value !== 'opaque-account-choice') process.exit(3);
    send({id:message.id,result:{configOptions:catalog(message.params.value)}});
    return;
  }
  send({id:message.id,result: message.method === 'initialize' ? {protocolVersion:1}
    : {sessionId:'account-session', configOptions:catalog('api-choice')}});
});`;

test('account-route full loop selects the native model before prompting and never touches the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relaycore-account-loop-'));
  let core;
  let finish;
  const settled = new Promise((done) => { finish = done; });
  try {
    await writeFile(join(root, 'message.txt'), 'pending\n');
    const authHome = join(root, 'review-auth');
    const accountHome = join(root, 'native-home');
    const accountWorkspace = join(root, 'account-workspace');
    for (const directory of [authHome, accountHome, accountWorkspace]) await mkdir(directory);
    await writeFile(join(authHome, 'auth.json'), '{}');
    const propose = (input) => runDshProposal(input, (command, args, options) => {
      assert.equal(options.cwd, accountWorkspace);
      assert.equal(options.env.DSH_HOME, accountHome);
      assert.equal(options.env.DEEPSEEK_API_KEY, undefined);
      return openAcpLifecycle(process.execPath, ['--input-type=module', '-e', fakeAccountDsh], { ...options, timeoutMs: 2000 });
    });
    const review = async (input) => {
      const packet = JSON.parse(await readFile(input.review.inputPath, 'utf8'));
      assert.equal(packet.files[0].after, 'ready\n');
      class FakeCodex {
        startThread() {
          return { async runStreamed() {
            return { events: (async function* () {
              yield { type: 'thread.started', thread_id: 'codex-account-test' };
              yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdict: 'approved', rationale: 'Exact replacement matches acceptance.' }) } };
              yield { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 8 } };
            })() };
          } };
        }
      }
      return runCodexReview(input, FakeCodex);
    };
    core = await openCore(root, async (task, context) => {
      try { return await runDshReviewTask({ core, task, context, executable: process.execPath, accountHome, accountWorkspace, authHome }, { propose, review }); }
      finally { finish(); }
    });
    const task = await core.create({ title: 'Account loop', objective: 'Change pending to ready.', acceptance: 'Exact ready newline.',
      allowedPaths: ['message.txt'], executionLimits: { maxDurationSeconds: 10, maxModelTurns: 2 } });
    const candidate = await core.prepareWorkspace(task.id);
    core.dispatch(task.id);
    await settled;
    while (core.get(task.id).state === 'RUNNING') await setTimeout(5);
    const final = core.get(task.id);
    const events = core.events(task.id).map((event) => event.kind);
    const handoff = await readFile(join(root, '.RelayCore', '.agent-tasks', task.id, 'HANDOFF.md'), 'utf8');
    assert.equal(final.state, 'COMPLETED');
    assert.equal(await readFile(join(root, 'message.txt'), 'utf8'), 'pending\n');
    assert.equal(await readFile(join(candidate.workspace, 'message.txt'), 'utf8'), 'ready\n');
    assert.deepEqual(events.filter((kind) => kind.startsWith('model_turn.requested.')), ['model_turn.requested.dsh', 'model_turn.requested.codex']);
    assert.ok(handoff.includes('account-session') && handoff.includes('codex-account-test'));
  } finally {
    core?.close();
    await rm(root, { recursive: true, force: true });
  }
});

