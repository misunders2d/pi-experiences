#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension, { __setAgentExperienceSelectorAdapterForTest } from '../extensions/agent-experience/index.ts';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { createPiSelectorModelAdapter, DEFAULT_SELECTOR_MODEL } from '../extensions/agent-experience/src/selector-model.ts';
import { lawSnapshotForTest, readConfiguredLawSnapshot } from '../extensions/agent-experience/src/review.ts';
import { runSelectorRuntime, selectActiveSelectorSnapshot } from '../extensions/agent-experience/src/selector.ts';
import { getAgentExperiencePaths, readAgentExperienceConfig } from '../extensions/agent-experience/src/paths.ts';
import { ensurePrivateRoot } from '../extensions/agent-experience/src/storage/private-root.ts';
import { initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';

function refs(count = 3) {
  return Array.from({ length: count }, (_, index) => ({ file_generation: 'phase7a', seq: index + 1, checksum: String(index + 1).repeat(64).slice(0, 64) }));
}

function habitData(overrides = {}) {
  return {
    schema_version: 2,
    record_kind: 'candidate_habit_v1',
    status: 'active',
    active: true,
    injectable: false,
    condition: 'answering selector adapter tests',
    behavior: 'return bounded JSON choices',
    polarity: 1,
    confidence_bp: 9500,
    activation: 1,
    staleness: 0,
    source_refs: refs(3),
    source_dates: ['2026-07-06T00:00:00.000Z', '2026-07-06T01:00:00.000Z', '2026-07-07T00:00:00.000Z'],
    ...overrides,
  };
}

function assistantText(text) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.4-mini',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function fakeRegistry({ auth = { ok: true, apiKey: 'secret-api-key', headers: { 'x-secret-header': 'secret-header' }, env: { SECRET_ENV: 'secret-env' } }, model = { provider: 'openai-codex', id: 'gpt-5.4-mini', api: 'openai-codex-responses', maxTokens: 128000 }, provider = 'openai-codex', id = 'gpt-5.4-mini' } = {}) {
  return {
    find(requestedProvider, requestedId) {
      return requestedProvider === provider && requestedId === id ? { ...model, provider, id } : undefined;
    },
    async getApiKeyAndHeaders() {
      return auth;
    },
  };
}

const adapterSuccessCalls = [];
const adapter = createPiSelectorModelAdapter({ modelRegistry: fakeRegistry() }, {
  complete: async (_model, context, options) => {
    adapterSuccessCalls.push({ context, options });
    assert.equal(options.apiKey, 'secret-api-key');
    assert.equal(options.headers['x-secret-header'], 'secret-header');
    assert.equal(options.env.SECRET_ENV, 'secret-env');
    assert.ok(options.signal instanceof AbortSignal, 'production adapter must pass AbortSignal');
    assert.equal(options.timeoutMs, 1500);
    assert.equal(options.maxRetries, 0);
    assert.equal(String(context.messages[0].content).includes('answering selector adapter tests'), false, 'raw habit text is supplied by selector prompt only in runtime tests, not this direct adapter test');
    return assistantText('{"schema_version":1,"selected":[{"id":"active-1","confidence_bp":9500}]}');
  },
  now: () => 0,
});
const selected = await adapter.select({ prompt: '{"schema_version":1,"candidates":[{"id":"active-1"}]}', candidateIds: ['active-1'], timeoutMs: 1500, model: DEFAULT_SELECTOR_MODEL, signal: new AbortController().signal });
assert.deepEqual(selected, { schema_version: 1, selected: [{ id: 'active-1', confidence_bp: 9500 }] });
assert.equal(adapterSuccessCalls.length, 1);

await assert.rejects(() => adapter.select({ prompt: '{}', candidateIds: ['active-1'], timeoutMs: 1500, model: 'not-a-provider-model' }), /selector_model_unverified/);
await assert.rejects(() => adapter.select({ prompt: '{}', candidateIds: ['active-1'], timeoutMs: 1500, model: 'openai/gpt-5.4-mini' }), /selector_model_unavailable/);
assert.equal(adapterSuccessCalls.length, 1, 'invalid or unavailable configured model must fail before model call');
const providerSwitch = createPiSelectorModelAdapter({ modelRegistry: fakeRegistry({ provider: 'zai', id: 'glm-5.2', model: { provider: 'zai', id: 'glm-5.2', api: 'test', maxTokens: 128000 } }) }, { complete: async () => assistantText('{"schema_version":1,"selected":[]}') });
assert.deepEqual(await providerSwitch.select({ prompt: '{}', candidateIds: [], timeoutMs: 1500, model: 'zai/glm-5.2' }), { schema_version: 1, selected: [] });

const authBlocked = createPiSelectorModelAdapter({ modelRegistry: fakeRegistry({ auth: { ok: false, error: 'No API key found SECRET_TOKEN' } }) }, { complete: async () => { throw new Error('must not call'); } });
await assert.rejects(async () => authBlocked.select({ prompt: '{}', candidateIds: [], timeoutMs: 1500, model: DEFAULT_SELECTOR_MODEL }), (error) => {
  assert.equal(error.message.includes('SECRET_TOKEN'), false, 'auth errors must not expose secrets');
  assert.match(error.message, /selector_model_auth_unavailable|selector_model_call_failed/);
  return true;
});

const throwing = createPiSelectorModelAdapter({ modelRegistry: fakeRegistry() }, { complete: async () => { throw new Error('provider leaked SECRET_TOKEN in raw error'); } });
await assert.rejects(async () => throwing.select({ prompt: '{}', candidateIds: [], timeoutMs: 1500, model: DEFAULT_SELECTOR_MODEL }), (error) => {
  assert.equal(error.message, 'selector_model_call_failed');
  return true;
});

const invalidJson = createPiSelectorModelAdapter({ modelRegistry: fakeRegistry() }, { complete: async () => assistantText('not json') });
await assert.rejects(() => invalidJson.select({ prompt: '{}', candidateIds: [], timeoutMs: 1500, model: DEFAULT_SELECTOR_MODEL }), /selector_model_invalid_json/);

const controller = new AbortController();
controller.abort();
await assert.rejects(() => adapter.select({ prompt: '{}', candidateIds: [], timeoutMs: 1500, model: DEFAULT_SELECTOR_MODEL, signal: controller.signal }), /selector_timeout/);

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase7a-'));
process.env.AX_STATE_ROOT = join(temp, 'state');
const root = await ensurePrivateRoot(process.env.AX_STATE_ROOT);
await writeFile(join(root, 'law.md'), 'phase7a configured law\n');
const liveCwd = await mkdtemp(join(temp, 'live-cwd-no-docs-'));
const storage = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
try {
  const law = lawSnapshotForTest('phase7a law');
  insertStorageRecord(storage.db, 'habits', { id: 'active-1', userId: 'owner', data: habitData({ law_hash: law.hash }), now: '2026-07-08T00:00:00.000Z' });
  const config = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, selector_enabled: true, selector_mode: 'smart', selector_min_confidence_bp: 7500, selector_max_habits: 3, selector_staleness_max: 0.8 };
  let sawSignal = false;
  const ok = await runSelectorRuntime(storage.db, {
    userId: 'owner',
    prompt: 'selector adapter tests',
    config,
    law,
    now: '2026-07-08T01:00:00.000Z',
    adapter: { async select({ signal }) { sawSignal = signal instanceof AbortSignal; return { schema_version: 1, selected: [{ id: 'active-1', confidence_bp: 9500 }] }; } },
  });
  assert.equal(ok.injected, true);
  assert.equal(sawSignal, true, 'runSelectorRuntime must pass AbortSignal to adapter');
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM selector_hit_log WHERE user_id = ? AND action = 'inject' AND selected = 1").get('owner').count, 1);

  let repeatedCalls = 0;
  const repeated = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'selector adapter tests', config, law, now: '2026-07-08T01:01:00.000Z', adapter: { async select() { repeatedCalls += 1; return { schema_version: 1, selected: [{ id: 'active-1', confidence_bp: 9500 }] }; } } });
  assert.equal(repeated.injected, true, 'smart selection must not stop after an arbitrary number of successful messages');
  assert.equal(repeatedCalls, 1, 'every eligible smart selection may call its configured adapter');
  for (let index = 0; index < 25; index += 1) {
    const continued = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'selector adapter tests', config, law, now: `2026-07-08T02:${String(index).padStart(2, '0')}:00.000Z`, adapter: { async select() { repeatedCalls += 1; return { schema_version: 1, selected: [{ id: 'active-1', confidence_bp: 9500 }] }; } } });
    assert.equal(continued.injected, true, `smart guidance must remain available beyond the former daily cap (${index + 1}/25)`);
  }
  assert.equal(repeatedCalls, 26);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM selector_hit_log WHERE user_id = ? AND action = 'inject' AND selected = 1").get('owner').count, 27);

  const beforeTimeoutLogs = storage.db.prepare('SELECT COUNT(*) AS count FROM selector_hit_log').get().count;
  let aborted = false;
  const timeout = await runSelectorRuntime(storage.db, {
    userId: 'owner',
    prompt: 'selector adapter tests',
    config: { ...config, selector_timeout_ms: 5 },
    law,
    now: '2026-07-08T01:02:00.000Z',
    adapter: { async select({ signal }) { await new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('selector_timeout')); }); }); } },
  });
  assert.equal(timeout.injected, false);
  assert.match(timeout.reason, /timeout/);
  assert.equal(aborted, true, 'timeout must abort adapter signal');
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS count FROM selector_hit_log').get().count, beforeTimeoutLogs, 'timeout no-injection must not write skip logs');

  const malformed = await runSelectorRuntime(storage.db, {
    userId: 'owner',
    prompt: 'selector adapter tests',
    config,
    law,
    now: '2026-07-08T01:03:00.000Z',
    adapter: { async select() { return { schema_version: 1, selected: [{ id: 'unknown', confidence_bp: 9500 }] }; } },
  });
  assert.equal(malformed.injected, false);
  assert.equal(malformed.reason, 'invalid_selector_output');

  const unavailable = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'selector adapter tests', config, law, now: '2026-07-08T01:04:00.000Z' });
  assert.equal(unavailable.injected, false);
  assert.equal(unavailable.reason, 'selector_unavailable');

  const logsText = JSON.stringify(storage.db.prepare('SELECT data_json, prompt_hash FROM selector_hit_log').all());
  assert.equal(logsText.includes('selector adapter tests'), false, 'hit logs must not store raw prompt');
  assert.equal(logsText.includes('omitted'), true, 'prompt_hash must remain omitted');
  assert.deepEqual(selectActiveSelectorSnapshot(storage.db, { userId: 'owner' }).map((row) => row.id), ['active-1']);

  function makePi() {
    const commands = new Map();
    const handlers = new Map();
    const fakePi = {
      registerCommand(name, options) { commands.set(name, options); },
      on(event, handler) { handlers.set(event, handler); },
      registerTool() {},
      registerEntryRenderer() {},
      appendEntry() {},
      registerFlag() { throw new Error('no flags'); },
      registerShortcut() { throw new Error('no shortcuts'); },
    };
    agentExperienceExtension(fakePi);
    return { commands, handlers };
  }

  const { commands, handlers } = makePi();
  const notes = [];
  const ctx = { cwd: liveCwd, mode: 'tui', sessionManager: { getSessionId: () => 'phase7a-main', getSessionFile: () => join(temp, 'phase7a-main.jsonl') }, ui: { notify(message, level) { notes.push({ message, level }); } } };
  await commands.get('experience').handler('enable', ctx);
  assert.equal((await readAgentExperienceConfig(getAgentExperiencePaths())).config.selector_enabled, false, 'selector disabled default after master enable');
  await commands.get('experience').handler('selector on', ctx);
  process.env.AX_SELECTOR_MODE = 'smart';
  const realLaw = await readConfiguredLawSnapshot(root, (await readAgentExperienceConfig(getAgentExperiencePaths())).config);
  insertStorageRecord(storage.db, 'habits', { id: 'hook-active', userId: 'owner', data: habitData({ condition: 'hook adapter prompt', behavior: 'use production adapter guidance', law_hash: realLaw.hash }), now: '2026-07-08T02:00:00.000Z' });
  storage.db.prepare('DELETE FROM selector_hit_log').run();
  __setAgentExperienceSelectorAdapterForTest({ async select({ candidateIds, signal }) { assert.ok(signal instanceof AbortSignal); return { schema_version: 1, selected: [{ id: candidateIds[0], confidence_bp: 9500 }] }; } });
  const hookCtx = { ...ctx, modelRegistry: fakeRegistry() };
  const hookResult = await handlers.get('before_agent_start')({ prompt: 'hook adapter prompt', systemPrompt: 'base' }, hookCtx);
  assert.equal(hookResult, undefined, 'before_agent_start prepares steering but must not modify the system prompt');
  const contextResult = await handlers.get('context')({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hook adapter prompt' }], timestamp: Date.now() }] }, hookCtx);
  assert.equal(contextResult.messages.at(-1).customType, 'agent_experience.habit_guidance');
  assert.match(contextResult.messages.at(-1).content, /Agent Experience approved habit guidance/);
  assert.match(contextResult.messages.at(-1).content, /Do: use production adapter guidance/);

  const noLedgerRoot = join(temp, 'no-ledger-state');
  process.env.AX_STATE_ROOT = noLedgerRoot;
  const noLedger = makePi();
  const noLedgerCtx = { cwd: liveCwd, mode: 'tui', sessionManager: { getSessionId: () => 'phase7a-no-ledger', getSessionFile: () => join(temp, 'phase7a-no-ledger.jsonl') }, ui: { notify() {} } };
  await noLedger.commands.get('experience').handler('enable', noLedgerCtx);
  await noLedger.commands.get('experience').handler('selector on', noLedgerCtx);
  const noLedgerResult = await noLedger.handlers.get('before_agent_start')({ prompt: 'no ledger', systemPrompt: 'base' }, { ...noLedgerCtx, modelRegistry: fakeRegistry({ auth: { ok: false, error: 'SECRET should not matter' } }) });
  assert.equal(noLedgerResult, undefined);
  assert.equal(existsSync(join(noLedgerRoot, 'ledger.sqlite')), false, 'selector hook must not initialize storage on missing ledger');
  process.env.AX_STATE_ROOT = join(temp, 'state');
  delete process.env.AX_SELECTOR_MODE;
} finally {
  storage.db.close();
  __setAgentExperienceSelectorAdapterForTest(undefined);
  await rm(temp, { recursive: true, force: true });
}

console.log('agent-experience phase7a selector adapter checks passed');
