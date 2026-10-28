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

test('account catalog rejects ambiguous selectors and malformed account choices', () => {
  const scenarios = [
    ['duplicate selector', (options) => options.push(structuredClone(options[0]))],
    ['shadowed selector', (options) => options.unshift({ ...options[0], category: 'other' })],
    ['null selector', (options) => { options[0] = null; }],
    ['wrong selector category', (options) => { options[0].category = 'other'; }],
    ['wrong selector type', (options) => { options[0].type = 'boolean'; }],
    ['duplicate account group', (options) => options[0].options.push(structuredClone(options[0].options[1]))],
    ['empty account choices', (options) => { options[0].options[1].options = []; }],
    ['duplicate choice value', (options) => options[0].options[1].options.push(structuredClone(options[0].options[1].options[0]))],
    ['null choice', (options) => { options[0].options[1].options[0] = null; }],
    ['empty choice value', (options) => { options[0].options[1].options[0].value = ''; }],
    ['non-string choice value', (options) => { options[0].options[1].options[0].value = 1; }],
    ['oversized choice value', (options) => { options[0].options[1].options[0].value = 'x'.repeat(4097); }],
    ['empty choice name', (options) => { options[0].options[1].options[0].name = ''; }],
    ['non-string choice name', (options) => { options[0].options[1].options[0].name = 1; }],
    ['oversized choice name', (options) => { options[0].options[1].options[0].name = 'x'.repeat(257); }]
  ];
  for (const [name, mutate] of scenarios) {
    const options = catalog();
    mutate(options);
    assert.throws(() => accountModelChoice(options), /DSH account model catalog/, name);
  }
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

test('account proposal requires unambiguous native confirmation before reserving a prompt', async () => {
  for (const scenario of ['valid', 'missing', 'duplicate-selector', 'unconfirmed', 'api-only-confirmation', 'ambiguous-confirmation', 'selection-error', 'cancel-selection']) {
    const root = await mkdtemp(join(tmpdir(), 'relaycore-account-test-'));
    try {
      const home = join(root, 'job');
      const accountHome = join(root, 'native-home');
      const workspace = join(root, 'workspace');
      for (const directory of [home, accountHome, workspace]) await mkdir(directory);
      const calls = [];
      const controller = new AbortController();
      const configOptions = catalog('api-choice', scenario !== 'missing');
      if (scenario === 'duplicate-selector') configOptions.push(structuredClone(configOptions[0]));
      let onUpdate;
      const connect = (command, args, options) => {
        assert.equal(options.cwd, workspace);
        assert.equal(options.env.DSH_HOME, accountHome);
        assert.equal(options.env.DEEPSEEK_API_KEY, undefined);
        onUpdate = options.onUpdate;
        return {
          async initialize() { return { protocolVersion: 1 }; },
          async newSession() { return { sessionId: 'account-session', configOptions }; },
          async setConfigOption(sessionId, configId, value) {
            calls.push('select');
            if (scenario === 'selection-error') throw new Error('Native account selection failed');
            if (scenario === 'cancel-selection') controller.abort(new Error('Account selection cancelled'));
            const confirmed = catalog(scenario === 'unconfirmed' ? 'api-choice' : value, scenario !== 'api-only-confirmation');
            if (scenario === 'ambiguous-confirmation') confirmed.push(structuredClone(confirmed[0]));
            return { configOptions: confirmed };
          },
          async prompt() {
            calls.push('prompt');
            onUpdate({ sessionId: 'account-session', update: { sessionUpdate: 'agent_message_chunk', content: {
              type: 'text', text: JSON.stringify({ summary: 'Ready.', files: [{ path: 'message.txt', contents: 'ready\n' }] })
            } } });
            onUpdate({ sessionId: 'account-session', update: { sessionUpdate: 'usage_update', cost: { total: 21 } } });
            return { stopReason: 'end_turn' };
          },
          async closeSession() { calls.push('close-session'); },
          async close() { calls.push('close'); },
          async cancelSession() { calls.push('cancel'); }
        };
      };
      const input = { task: { contract: { objective: 'Ready.', acceptance: 'Exact text.' } }, files: [], home,
        executable: process.execPath, accountHome, accountWorkspace: workspace,
        context: { signal: controller.signal,
          recordSession() { calls.push('record-session'); }, beginModelTurn() { calls.push('reserve'); } } };
      if (scenario === 'valid') {
        const result = await runDshProposal(input, connect);
        assert.equal(result.provider, 'deepseek-account');
        assert.equal(result.model, 'Account Flash');
        assert.deepEqual(result.usage, { sessionUpdate: 'usage_update', cost: { total: 21 } });
        assert.deepEqual(calls, ['record-session', 'select', 'reserve', 'prompt', 'close-session', 'close']);
      } else {
        const expected = scenario === 'unconfirmed' ? /did not confirm/
          : scenario === 'selection-error' ? /Native account selection failed/
          : scenario === 'cancel-selection' ? /Account selection cancelled/ : /unavailable/;
        await assert.rejects(runDshProposal(input, connect), expected, scenario);
        const selected = !['missing', 'duplicate-selector'].includes(scenario);
        assert.deepEqual(calls, scenario === 'cancel-selection'
          ? ['record-session', 'select', 'cancel', 'close', 'close']
          : ['record-session', ...(selected ? ['select'] : []), 'close-session', 'close'], scenario);
      }
      await assert.rejects(runDshProposal({ ...input, apiKey: 'test-only-key' }, connect), /Do not mix/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
