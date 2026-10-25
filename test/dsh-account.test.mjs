import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountModelChoice, dshAccountEnvironment, selectAccountModel } from '../src/dsh-account.mjs';
import { runDshProposal } from '../src/dsh.mjs';

function catalog(currentValue = 'api-choice', includeAccount = true) {
  return [{ id: 'model', category: 'model', type: 'select', currentValue, options: [
    { group: 'deepseek-official', name: 'DeepSeek Account', options: [{ name: 'API model', value: 'api-choice' }] },
    ...(includeAccount ? [{ group: 'deepseek-account', name: 'Account', options: [
      { name: 'Account Flash', value: 'opaque-account-choice' }, { name: 'Account Pro', value: 'opaque-pro-choice' }
    ] }] : [])
  ] }];
}

test('account model selection uses provider identity, preserves opaque values and never falls back to API', async () => {
  assert.deepEqual(accountModelChoice(catalog()), { configId: 'model', name: 'Account Flash', value: 'opaque-account-choice' });
  assert.equal(accountModelChoice(catalog('opaque-pro-choice')).name, 'Account Pro');
  assert.throws(() => accountModelChoice(catalog('api-choice', false)), /unavailable/);
  assert.throws(() => accountModelChoice({}), /unavailable/);
  const acp = { async setConfigOption(sessionId, configId, value) {
    assert.equal(sessionId, 'account-session');
    assert.equal(configId, 'model');
    assert.equal(value, 'opaque-account-choice');
    return { configOptions: catalog(value) };
  } };
  assert.deepEqual(await selectAccountModel(acp, 'account-session', catalog()), { provider: 'deepseek-account', model: 'Account Flash' });
  await assert.rejects(selectAccountModel({ async setConfigOption() { return { configOptions: catalog() }; } }, 'account-session', catalog()), /did not confirm/);
});

test('account runtime keeps the native user profile without forwarding provider keys or control credentials', () => {
  const names = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'RELAYCORE_TOKEN', 'DSH_CLIENT_VERSION'];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'test-only-sentinel';
    const home = join(tmpdir(), 'native-account-home');
    const env = dshAccountEnvironment(home);
    assert.equal(env.DSH_HOME, home);
    assert.equal(env.USERPROFILE, process.env.USERPROFILE);
    assert.equal(env.DSH_PERMISSION_MODE, 'read-only');
    for (const name of names) assert.equal(env[name], undefined);
    assert.throws(() => dshAccountEnvironment('relative-home'), /absolute/);
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test('account proposal confirms the native model before reserving a prompt and refuses a missing account catalog', async () => {
  for (const includeAccount of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), 'relaycore-account-test-'));
    try {
      const home = join(root, 'job');
      const accountHome = join(root, 'native-home');
      const workspace = join(root, 'workspace');
      for (const directory of [home, accountHome, workspace]) await mkdir(directory);
      const calls = [];
      let onUpdate;
      const connect = (command, args, options) => {
        assert.equal(options.cwd, workspace);
        assert.equal(options.env.DSH_HOME, accountHome);
        assert.equal(options.env.DEEPSEEK_API_KEY, undefined);
        onUpdate = options.onUpdate;
        return {
          async initialize() { return { protocolVersion: 1 }; },
          async newSession() { return { sessionId: 'account-session', configOptions: catalog('api-choice', includeAccount) }; },
          async setConfigOption(sessionId, configId, value) { calls.push('select'); return { configOptions: catalog(value) }; },
          async prompt() {
            calls.push('prompt');
            onUpdate({ sessionId: 'account-session', update: { sessionUpdate: 'agent_message_chunk', content: {
              type: 'text', text: JSON.stringify({ summary: 'Ready.', files: [{ path: 'message.txt', contents: 'ready\n' }] })
            } } });
            return { stopReason: 'end_turn' };
          },
          async closeSession() { calls.push('close-session'); },
          async close() { calls.push('close'); },
          async cancelSession() { calls.push('cancel'); }
        };
      };
      const input = { task: { contract: { objective: 'Ready.', acceptance: 'Exact text.' } }, files: [], home,
        executable: process.execPath, accountHome, accountWorkspace: workspace,
        context: { signal: new AbortController().signal,
          recordSession() { calls.push('record-session'); }, beginModelTurn() { calls.push('reserve'); } } };
      if (includeAccount) {
        const result = await runDshProposal(input, connect);
        assert.equal(result.provider, 'deepseek-account');
        assert.equal(result.model, 'Account Flash');
        assert.deepEqual(calls, ['record-session', 'select', 'reserve', 'prompt', 'close-session', 'close']);
      } else {
        await assert.rejects(runDshProposal(input, connect), /unavailable/);
        assert.deepEqual(calls, ['record-session', 'close-session', 'close']);
      }
      await assert.rejects(runDshProposal({ ...input, apiKey: 'test-only-key' }, connect), /Do not mix/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
