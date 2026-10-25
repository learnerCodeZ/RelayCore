import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexReviewEnvironment, runCodexReview } from '../src/review.mjs';

async function withReview(action) {
  const workspace = await mkdtemp(join(tmpdir(), 'relaycore-review-test-'));
  const inputPath = join(workspace, 'REVIEW.json');
  const contents = JSON.stringify({ taskId: 'test-task', objective: 'Add numbers', acceptance: '2 + 3 = 5',
    files: [{ path: 'calc.mjs', before: 'return left + right;', after: 'return left - right;' }] });
  await writeFile(inputPath, contents);
  const review = { taskId: 'test-task', workspace, inputPath, sha256: createHash('sha256').update(contents).digest('hex') };
  const calls = { turns: 0, sessions: [] };
  const context = { signal: new AbortController().signal,
    beginModelTurn(agent) { assert.equal(agent, 'codex'); calls.turns++; },
    recordSession(agent, sessionId) { calls.sessions.push({ agent, sessionId }); } };
  try { await action({ review, model: 'test-review-model', apiKey: 'test-only-placeholder', context }, calls); }
  finally { await rm(workspace, { recursive: true, force: true }); }
}

test('review subprocess environment excludes provider keys and control credentials', () => {
  const names = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_REVIEW_API_KEY', 'DEEPSEEK_API_KEY', 'RELAYCORE_TOKEN', 'CODEX_HOME'];
  const proxies = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];
  const original = Object.fromEntries([...names, ...proxies].map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'test-only-sentinel';
    for (const name of proxies) process.env[name] = `test-proxy-${name}`;
    const env = codexReviewEnvironment('dedicated-review-home');
    assert.equal(env.CODEX_HOME, 'dedicated-review-home');
    for (const name of names.filter((name) => name !== 'CODEX_HOME')) assert.equal(env[name], undefined);
    for (const name of proxies) assert.equal(env[name], `test-proxy-${name}`);
  } finally {
    for (const name of [...names, ...proxies]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test('review tolerates transient reconnect notices but fails on other stream errors', async () => {
  await withReview(async (input) => {
    class ReconnectingCodex {
      startThread() {
        return { async runStreamed() {
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'reconnect-session' };
            yield { type: 'error', message: 'Reconnecting... 2/5 (request timed out)' };
            yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdict: 'rejected', rationale: 'Regression found.' }) } };
            yield { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } };
          })() };
        } };
      }
    }
    const result = await runCodexReview(input, ReconnectingCodex);
    assert.equal(result.verdict, 'rejected');
    assert.equal(result.sessionId, 'reconnect-session');
  });
  await withReview(async (input) => {
    class BrokenCodex {
      startThread() {
        return { async runStreamed() {
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'broken-session' };
            yield { type: 'error', message: 'stream disconnected' };
          })() };
        } };
      }
    }
    await assert.rejects(runCodexReview(input, BrokenCodex), /Codex review failed/);
  });
});

test('review reserves a turn, isolates configuration and accepts a structured verdict with usage', async () => {
  await withReview(async (input, calls) => {
    let options;
    let threadOptions;
    class FakeCodex {
      constructor(supplied) { options = supplied; }
      startThread(supplied) {
        threadOptions = supplied;
        return { async runStreamed(prompt, turn) {
          assert.equal(calls.turns, 1);
          assert.match(prompt, /return left - right/);
          assert.equal(turn.signal.aborted, false);
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'review-session' };
            yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdict: 'rejected', rationale: 'Subtraction violates addition acceptance.' }) } };
            yield { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } };
          })() };
        } };
      }
    }
    const result = await runCodexReview(input, FakeCodex);
    assert.equal(result.verdict, 'rejected');
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
    assert.deepEqual(calls.sessions, [{ agent: 'codex', sessionId: 'review-session' }]);
    assert.equal(options.env.CODEX_HOME, join(input.review.workspace, 'codex-home'));
    assert.equal(options.env.RELAYCORE_TOKEN, undefined);
    assert.equal(options.env.DEEPSEEK_API_KEY, undefined);
    assert.equal(options.config.features.apps, false);
    assert.equal(options.config.features.shell_tool, false);
    assert.deepEqual(options.config.mcp_servers, {});
    assert.equal(threadOptions.sandboxMode, 'read-only');
    assert.equal(threadOptions.approvalPolicy, 'never');
    assert.equal(threadOptions.networkAccessEnabled, false);
    assert.equal(threadOptions.webSearchMode, 'disabled');
  });
});

test('review rejects tools, missing usage, malformed verdicts and changed artifacts', async () => {
  for (const scenario of ['tool', 'usage', 'verdict', 'changed']) {
    await withReview(async (input) => {
      class FakeCodex {
        startThread() {
          return { async runStreamed() {
            return { events: (async function* () {
              yield { type: 'thread.started', thread_id: 'review-session' };
              if (scenario === 'tool') yield { type: 'item.started', item: { type: 'command_execution' } };
              if (scenario === 'changed') await writeFile(input.review.inputPath, '{}');
              yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdict: scenario === 'verdict' ? 'maybe' : 'approved', rationale: 'test' }) } };
              yield { type: 'turn.completed', usage: scenario === 'usage' ? null : { input_tokens: 10, output_tokens: 5 } };
            })() };
          } };
        }
      }
      await assert.rejects(runCodexReview(input, FakeCodex), /forbidden tool|usage is missing|Invalid review verdict|artifact changed/);
    });
  }
});

test('review refuses changed input or cancellation before reserving a model turn', async () => {
  await withReview(async (input, calls) => {
    const original = await readFile(input.review.inputPath, 'utf8');
    await writeFile(input.review.inputPath, '{}');
    await assert.rejects(runCodexReview(input), /artifact changed/);
    assert.equal(calls.turns, 0);
    await writeFile(input.review.inputPath, original);
    const controller = new AbortController();
    controller.abort();
    input.context.signal = controller.signal;
    await assert.rejects(runCodexReview(input), { name: 'AbortError' });
    assert.equal(calls.turns, 0);
  });
});

test('review uses an explicit dedicated login profile without requiring an API key', async () => {
  await withReview(async (input) => {
    delete input.apiKey;
    delete input.model;
    input.authHome = join(input.review.workspace, 'dedicated-profile');
    await mkdir(input.authHome);
    await writeFile(join(input.authHome, 'auth.json'), '{}');
    let options;
    class FakeCodex {
      constructor(supplied) { options = supplied; }
      startThread(supplied) {
        assert.equal(supplied.model, undefined);
        return { async runStreamed() {
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'account-review-session' };
            yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdict: 'rejected', rationale: 'Addition regressed.' }) } };
            yield { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } };
          })() };
        } };
      }
    }
    const result = await runCodexReview(input, FakeCodex);
    assert.equal(result.verdict, 'rejected');
    assert.equal(options.apiKey, undefined);
    assert.equal(options.env.CODEX_HOME, input.authHome);
    assert.equal(options.config.cli_auth_credentials_store, 'file');
  });
});
