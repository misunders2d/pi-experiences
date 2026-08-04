#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import agentExperienceExtension, {
  __advisorCatchupRequiredForTest,
  __setAgentExperienceAdvisorAdapterForTest,
} from '../extensions/agent-experience/index.ts';
import {
  ADVISOR_FINDING_MESSAGE_TYPE,
  ADVISOR_FINDING_VISIBLE_ENTRY_TYPE,
  buildAdvisorCustomMessage,
  chooseAdvisorDelivery,
  renderAdvisorFinding,
  validateAdvisorFindingDetails,
} from '../extensions/agent-experience/src/advisor/message.ts';
import { writeAgentExperienceConfig } from '../extensions/agent-experience/src/paths.ts';
import { lawSnapshotForTest } from '../extensions/agent-experience/src/review.ts';
import {
  buildAdvisorHabitAliases,
  prepareAdvisorHabitVectors,
  retrieveAdvisorHabitCandidates,
  revalidateAdvisorHabitFinding,
} from '../extensions/agent-experience/src/advisor/habits.ts';
import { prepareAdvisorRetrievalQuery } from '../extensions/agent-experience/src/advisor/retrieval-query.ts';
import { prepareHabitFieldEmbeddings } from '../extensions/agent-experience/src/semantic/service.ts';
import { LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_PROVIDER } from '../extensions/agent-experience/src/semantic/local-model-manifest.ts';
import { buildTypedStorageRow, initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';

function unit(index) { const value = new Float32Array(LOCAL_EMBEDDING_DIMENSIONS); value[index] = 1; return value; }
const publishVector = unit(0), conditionVector = unit(1), unrelatedVector = unit(2);
function vectorFor(text) {
  const normalized = String(text).toLowerCase();
  if (normalized.startsWith('condition:')) return normalized.includes('condition-near-publish') ? publishVector : conditionVector;
  if (normalized.startsWith('behavior:')) return normalized.includes('verify the packed install before publishing') ? publishVector : unrelatedVector;
  return normalized.includes('publish') || normalized.includes('packed install') ? publishVector : unrelatedVector;
}
function fakeEmbeddingAdapter({ failQuery = false } = {}) {
  const calls = [];
  return { id: 'phase24-local', provider: LOCAL_EMBEDDING_PROVIDER, model: LOCAL_EMBEDDING_MODEL, dimensions: LOCAL_EMBEDDING_DIMENSIONS, calls,
    async embed(texts) { calls.push([...texts]); if (failQuery && texts.length === 1 && !/^condition:|^behavior:/i.test(texts[0])) throw new Error('query unavailable'); return texts.map(vectorFor); } };
}
function refs() { return [1, 2, 3].map((seq) => ({ file_generation: 'phase24', seq, checksum: String(seq).repeat(64).slice(0, 64) })); }
function habitData(id, condition, behavior, lawHash, overrides = {}) {
  const polarity = overrides.polarity ?? 1;
  return { schema_version: 2, record_kind: 'candidate_habit_v1', status: overrides.status ?? 'active', active: (overrides.status ?? 'active') === 'active', injectable: false,
    condition, behavior, polarity, confidence_bp: overrides.confidence_bp ?? 9000, activation: 1, staleness: overrides.staleness ?? 0, law_hash: lawHash,
    approved_identity: { candidate_id: id, condition: condition.trim().replace(/\s+/g, ' ').toLowerCase(), behavior: behavior.trim().replace(/\s+/g, ' ').toLowerCase(), polarity, approved_at: '2026-08-04T00:00:00.000Z' },
    source_refs: refs(), source_dates: ['2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z'], ...overrides };
}
function replaceHabit(db, id, patch) {
  const before = db.prepare('SELECT * FROM habits WHERE user_id = ? AND id = ?').get('owner', id);
  const row = buildTypedStorageRow('habits', { id, userId: 'owner', data: { ...JSON.parse(before.data_json), ...patch }, createdAt: before.created_at, updatedAt: '2026-08-04T01:00:00.000Z' });
  db.prepare(`UPDATE habits SET record_kind=?, schema_version=?, status=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, data_json=?, checksum=?, created_at=?, updated_at=? WHERE user_id=? AND id=?`).run(
    row.record_kind, row.schema_version, row.status, row.habit_id, row.condition, row.behavior, row.polarity, row.confidence_bp, row.activation, row.staleness, row.data_json, row.checksum, row.created_at, row.updated_at, 'owner', id);
}
function delta(text, overrides = {}) {
  return { scope: { userId: 'owner', sessionId: 'phase24-session', sessionFile: '/tmp/phase24.jsonl' }, epoch: 4, generation: 7, cursor: 19, currentUserEntryId: 'user-1', primaryEntryIds: ['assistant-1'], causalEpisodeId: 'episode-1', causedByAdvisor: false, text, currentRequest: 'Prepare the package release safely.', inProgress: false, toolEventCount: 1, eventFingerprint: 'a'.repeat(64), ...overrides };
}
const tokenizerJson = {
  version: '1.0', truncation: null, padding: null,
  added_tokens: [
    { id: 0, content: '[PAD]', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true }, { id: 1, content: '[UNK]', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
    { id: 2, content: '[CLS]', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true }, { id: 3, content: '[SEP]', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true }],
  normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true }, pre_tokenizer: { type: 'BertPreTokenizer' },
  post_processor: { type: 'TemplateProcessing', single: [{ SpecialToken: { id: '[CLS]', type_id: 0 } }, { Sequence: { id: 'A', type_id: 0 } }, { SpecialToken: { id: '[SEP]', type_id: 0 } }], pair: [{ SpecialToken: { id: '[CLS]', type_id: 0 } }, { Sequence: { id: 'A', type_id: 0 } }, { SpecialToken: { id: '[SEP]', type_id: 0 } }, { Sequence: { id: 'B', type_id: 1 } }, { SpecialToken: { id: '[SEP]', type_id: 1 } }], special_tokens: { '[CLS]': { id: '[CLS]', ids: [2], tokens: ['[CLS]'] }, '[SEP]': { id: '[SEP]', ids: [3], tokens: ['[SEP]'] } } },
  decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
  model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100, vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, tool: 4, call: 5, result: 6, publish: 7, packed: 8, install: 9, verify: 10, bash: 11, assistant: 12, action: 13, failed: 14, safe: 15, artifact: 16, привет: 17, проверка: 18, 发布: 19, 检查: 20 } },
};
const tokenizerConfig = { do_lower_case: true, model_max_length: 128, pad_token: '[PAD]', unk_token: '[UNK]', cls_token: '[CLS]', sep_token: '[SEP]' };

const findingUpdate = {
  schemaVersion: 1,
  scope: { userId: 'owner', sessionId: 'phase24-session', sessionFile: '/tmp/phase24.jsonl' },
  generation: 7,
  epoch: 4,
  cursor: 19,
  inProgress: true,
  primaryDelta: 'release work',
  currentRequest: 'Prepare the package release safely.',
  habits: [],
  eventFingerprint: 'a'.repeat(64),
  causalEpisodeId: 'episode-1',
  causedByAdvisor: false,
};
const fixedNow = Date.now;
Date.now = () => Date.parse('2026-08-04T00:00:00.000Z');
const habitMessage = buildAdvisorCustomMessage({
  kind: 'habit_violation',
  severity: 'blocker',
  eventFingerprint: 'a'.repeat(64),
  candidate: { alias: 'h1', habitId: 'habit-id', condition: 'When releasing packages', behavior: 'Verify the packed install first', checksum: 'b'.repeat(64), lawHash: 'c'.repeat(64) },
}, findingUpdate);
Date.now = fixedNow;
assert.equal(habitMessage.customType, ADVISOR_FINDING_MESSAGE_TYPE);
assert.equal(habitMessage.display, true);
assert.deepEqual(habitMessage.details, {
  schema_version: 1,
  kind: 'habit_violation',
  severity: 'blocker',
  condition: 'When releasing packages',
  behavior: 'Verify the packed install first',
  created_at: '2026-08-04T00:00:00.000Z',
});
assert.match(habitMessage.content, /<advisory severity="blocker"[^>]*>.*Verify the packed install first.*<\/advisory>/s);
assert.doesNotMatch(JSON.stringify(habitMessage), /habit-id|checksum|vector|score|alias/);
const genericMessage = buildAdvisorCustomMessage({ kind: 'generic_advice', severity: 'concern', note: 'Check <packed> & "signed" output', eventFingerprint: 'd'.repeat(64) }, findingUpdate);
assert.match(genericMessage.content, /guidance="weigh, don&apos;t blindly obey"/);
assert.match(genericMessage.content, /Check &lt;packed&gt; &amp; &quot;signed&quot; output/);
assert.equal(validateAdvisorFindingDetails(genericMessage.details).kind, 'generic_advice');
assert.throws(() => validateAdvisorFindingDetails({ ...genericMessage.details, habit_id: 'hidden' }), /fields/i);
assert.throws(() => buildAdvisorCustomMessage({ kind: 'generic_advice', severity: 'nit', note: 'x'.repeat(1201), eventFingerprint: 'e'.repeat(64) }, findingUpdate), /note/i);
const plainTheme = { fg(_name, text) { return text; } };
assert.match(renderAdvisorFinding({ ...genericMessage, role: 'custom', timestamp: Date.now() }, { expanded: false, outputPad: 0 }, plainTheme).render(100).join('\n'), /^◇ Advisor · concern/);
assert.match(renderAdvisorFinding({ ...habitMessage, role: 'custom', timestamp: Date.now() }, { expanded: true, outputPad: 0 }, plainTheme).render(100).join('\n'), /◇ Experience · habit violation · blocker[\s\S]*When: When releasing packages[\s\S]*Next step: Verify the packed install first/);

const deliveryBase = { severity: 'concern', active: true, idle: false, cancelled: false, terminal: false, planMode: 'off', canSteer: true, canAppendMessage: true, canAppendVisible: true, immuneTurnsRemaining: 0, shuttingDown: false };
assert.deepEqual(chooseAdvisorDelivery(deliveryBase), { mode: 'steer' });
assert.deepEqual(chooseAdvisorDelivery({ ...deliveryBase, severity: 'nit' }), { mode: 'append_when_settled' });
assert.deepEqual(chooseAdvisorDelivery({ ...deliveryBase, planMode: 'on' }), { mode: 'append_when_settled' });
assert.deepEqual(chooseAdvisorDelivery({ ...deliveryBase, planMode: 'ambiguous' }), { mode: 'append_when_settled' });
assert.deepEqual(chooseAdvisorDelivery({ ...deliveryBase, cancelled: true }), { mode: 'append_when_settled' });
assert.deepEqual(chooseAdvisorDelivery({ ...deliveryBase, terminal: true }), { mode: 'append_when_settled' });
assert.deepEqual(chooseAdvisorDelivery({ ...deliveryBase, idle: true, active: false }), { mode: 'append_now' });
assert.deepEqual(chooseAdvisorDelivery({ ...deliveryBase, canSteer: false }), { mode: 'append_when_settled' });
assert.deepEqual(chooseAdvisorDelivery({ ...deliveryBase, immuneTurnsRemaining: 1 }), { mode: 'append_when_settled' });
assert.deepEqual(chooseAdvisorDelivery({ ...deliveryBase, shuttingDown: true, canAppendMessage: false }), { mode: 'visible_fallback' });
for (const [value, expected] of [['off', false], [1, true], [3, false], [5, false]]) assert.equal(__advisorCatchupRequiredForTest(value, 1), expected);
assert.equal(__advisorCatchupRequiredForTest(3, 3), true);
assert.equal(__advisorCatchupRequiredForTest(5, 5), true);

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase24-'));
const tokenizerAssetDir = join(temp, 'tokenizer');
await mkdir(tokenizerAssetDir, { recursive: true });
await writeFile(join(tokenizerAssetDir, 'tokenizer.json'), JSON.stringify(tokenizerJson));
await writeFile(join(tokenizerAssetDir, 'tokenizer_config.json'), JSON.stringify(tokenizerConfig));
try {
  for (const [name, text, signal] of [
    ['ascii', `${'assistant prose '.repeat(1500)}\n[tool_call:bash] {"action":"publish","artifact":"packed install"}`, /publish|packed install/i],
    ['multibyte', `${'привет проверка '.repeat(1400)}\n[tool_result:bash] verify packed install`, /verify packed install/i],
    ['adversarial', `${'x'.repeat(23900)}[tool_call:publish]{"artifact":"packed install"}`, /publish|packed install/i],
  ]) {
    const query = await prepareAdvisorRetrievalQuery({ delta: delta(text), tokenizerAssetDir });
    assert.ok(query.tokenCount <= 128, `${name} query must fit exact configured tokenizer IDs`);
    assert.match(query.text, signal, `${name} query must retain emergent action signal`);
    assert.ok(query.text.length < text.length, `${name} query must not pass the full delta to embeddings`);
  }

  const law = lawSnapshotForTest('phase24 advisor habit law'), staleLaw = lawSnapshotForTest('phase24 stale law');
  const config = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true, embedding_enabled: true, selector_min_confidence_bp: 7500, selector_staleness_max: 0.8 };
  const storage = await initExperienceStorage(join(temp, 'state'), { allowInit: true, userId: 'owner' });
  try {
    const definitions = [
      ['active-request-id', 'When explicitly requested for this response', 'Use the active-request instruction.', law.hash, {}],
      ['behavior-id', 'When preparing a release candidate', 'Verify the packed install before publishing', law.hash, {}],
      ['disabled-id', 'When publishing', 'Verify the packed install before publishing', law.hash, { status: 'disabled' }],
      ['pending-id', 'When publishing', 'Verify the packed install before publishing', law.hash, { status: 'candidate' }],
      ['superseded-id', 'When publishing', 'Verify the packed install before publishing', law.hash, { status: 'archived' }],
      ['stale-id', 'When publishing', 'Verify the packed install before publishing', staleLaw.hash, {}],
      ['corrupt-id', 'When publishing', 'Verify the packed install before publishing', law.hash, {}],
      ['low-confidence-id', 'When publishing', 'Verify the packed install before publishing', law.hash, { confidence_bp: 7000 }],
      ['stale-freshness-id', 'When publishing', 'Verify the packed install before publishing', law.hash, { staleness: 0.9 }],
    ];
    for (const [id, condition, behavior, lawHash, overrides] of definitions) insertStorageRecord(storage.db, 'habits', { id, userId: 'owner', data: habitData(id, condition, behavior, lawHash, overrides), now: '2026-08-04T00:00:00.000Z' });
    storage.db.prepare("UPDATE habits SET checksum=? WHERE user_id='owner' AND id='corrupt-id'").run('0'.repeat(64));

    assert.equal(typeof prepareHabitFieldEmbeddings, 'function', 'field-vector preparation must be reusable');
    const embedding = fakeEmbeddingAdapter();
    assert.deepEqual(await prepareAdvisorHabitVectors(storage.db, { userId: 'owner', law, config, embeddingAdapter: embedding, now: '2026-08-04T00:30:00.000Z' }), { total: 2, cached: 0, prepared: 2 });
    assert.deepEqual(await prepareAdvisorHabitVectors(storage.db, { userId: 'owner', law, config, embeddingAdapter: embedding, now: '2026-08-04T00:31:00.000Z' }), { total: 2, cached: 2, prepared: 0 });

    embedding.calls.length = 0;
    const retrieved = await retrieveAdvisorHabitCandidates(storage.db, { userId: 'owner', delta: delta(`${'ignored prose '.repeat(1200)}\n[tool_call:bash] {"action":"publish","artifact":"packed install"}`), activeRequestHabitIds: [], law, config, embeddingAdapter: embedding, tokenizerAssetDir });
    assert.deepEqual(retrieved.map((item) => item.behavior), ['Verify the packed install before publishing']);
    assert.deepEqual(embedding.calls.map((call) => call.length), [1], 'retrieval must embed one fitted behavior query exactly once');
    assert.ok(retrieved.every((item) => /^h[1-8]$/.test(item.alias)));
    assert.ok(retrieved.every((item) => !['disabled-id', 'pending-id', 'superseded-id', 'stale-id', 'corrupt-id', 'low-confidence-id', 'stale-freshness-id'].includes(item.habitId)));

    insertStorageRecord(storage.db, 'habits', { id: 'condition-id', userId: 'owner', data: habitData('condition-id', 'condition-near-publish', 'Use an unrelated behavior.', law.hash), now: '2026-08-04T00:32:00.000Z' });
    for (let index = 0; index < 9; index++) { const id = `ranked-${index}`; insertStorageRecord(storage.db, 'habits', { id, userId: 'owner', data: habitData(id, `When ranked ${index}`, 'Verify the packed install before publishing', law.hash), now: `2026-08-04T00:${40 + index}:00.000Z` }); }
    await prepareAdvisorHabitVectors(storage.db, { userId: 'owner', law, config, embeddingAdapter: embedding, now: '2026-08-04T00:59:00.000Z' });
    embedding.calls.length = 0;
    const ranked = await retrieveAdvisorHabitCandidates(storage.db, { userId: 'owner', delta: delta('[tool_result:bash] publish packed install'), activeRequestHabitIds: ['active-request-id'], law, config, embeddingAdapter: embedding, tokenizerAssetDir });
    assert.equal(ranked.length, 8, 'Advisor candidates must cap at eight');
    assert.equal(ranked[0].habitId, 'active-request-id', 'active-request habits must sort first');
    assert.ok(ranked.some((item) => item.habitId === 'condition-id'), 'retrieval must use max(condition, behavior) similarity');
    assert.deepEqual(ranked.map((item) => item.alias), ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8']);
    assert.ok(ranked.every((item) => !('violation' in item)), 'vectors retrieve/rank but never decide violations');

    const aliased = buildAdvisorHabitAliases(ranked);
    assert.equal(aliased.originalIdByAlias.get('h1'), 'active-request-id');
    const modelShape = aliased.candidates.map(({ alias, condition, behavior }) => ({ alias, condition, behavior }));
    assert.doesNotMatch(JSON.stringify(modelShape), /active-request-id|behavior-id|condition-id/, 'model payload must contain aliases, never IDs');

    const behaviorCandidate = ranked.find((item) => item.habitId === 'behavior-id');
    assert.ok(behaviorCandidate, 'behavior candidate must survive the bounded rank');
    const strictInput = { userId: 'owner', alias: behaviorCandidate.alias, candidates: ranked, originalIdByAlias: aliased.originalIdByAlias, law, config, responseGeneration: 7, cursor: 19, advisorEpoch: 4 };
    assert.equal(revalidateAdvisorHabitFinding(storage.db, strictInput).behavior, 'Verify the packed install before publishing');
    for (const [label, mutate] of [
      ['status', () => replaceHabit(storage.db, 'behavior-id', { status: 'disabled', active: false })],
      ['wording', () => replaceHabit(storage.db, 'behavior-id', { behavior: 'Changed approved wording.' })],
      ['approval identity', () => replaceHabit(storage.db, 'behavior-id', { approved_identity: { candidate_id: 'behavior-id', condition: 'wrong', behavior: 'wrong', polarity: 1 } })],
    ]) {
      storage.db.exec('BEGIN IMMEDIATE');
      try { mutate(); assert.throws(() => revalidateAdvisorHabitFinding(storage.db, strictInput), /advisor_habit_snapshot_changed/, `${label} change must fail revalidation`); }
      finally { storage.db.exec('ROLLBACK'); }
    }
    assert.throws(() => revalidateAdvisorHabitFinding(storage.db, { ...strictInput, law: staleLaw }), /advisor_habit_snapshot_changed/);
    assert.throws(() => revalidateAdvisorHabitFinding(storage.db, { ...strictInput, responseGeneration: 8 }), /advisor_habit_snapshot_changed/);
    assert.throws(() => revalidateAdvisorHabitFinding(storage.db, { ...strictInput, cursor: 20 }), /advisor_habit_snapshot_changed/);
    assert.throws(() => revalidateAdvisorHabitFinding(storage.db, { ...strictInput, advisorEpoch: 5 }), /advisor_habit_snapshot_changed/);

    const fallback = await retrieveAdvisorHabitCandidates(storage.db, {
      userId: 'owner',
      delta: delta('[tool_call:bash] publish packed install'),
      activeRequestHabitIds: ['disabled-id', 'pending-id', 'superseded-id', 'stale-id', 'corrupt-id', 'low-confidence-id', 'stale-freshness-id', 'missing-id', 'active-request-id'],
      law,
      config,
      embeddingAdapter: fakeEmbeddingAdapter({ failQuery: true }),
      tokenizerAssetDir,
    });
    assert.deepEqual(fallback.map((item) => item.habitId), ['active-request-id'], 'ineligible leading IDs must not consume the active-request fallback limit');
  } finally { storage.db.close(); }

  const advisorEnv = Object.fromEntries(['AX_STATE_ROOT', 'AX_ENABLED', 'AX_ADVISOR_ENABLED', 'AX_ADVISOR_MODEL', 'AX_ADVISOR_SYNC_BACKLOG', 'AX_CAPTURE_ENABLED', 'AX_BREAK_IN_ENABLED'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    AX_STATE_ROOT: join(temp, 'advisor-state'),
    AX_ENABLED: 'true',
    AX_ADVISOR_ENABLED: 'true',
    AX_ADVISOR_MODEL: 'test/advisor',
    AX_ADVISOR_SYNC_BACKLOG: 'off',
    AX_CAPTURE_ENABLED: 'false',
    AX_BREAK_IN_ENABLED: 'false',
  });
  await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true, advisor_model: 'test/advisor', capture_enabled: false, break_in_enabled: false });
  let entrySequence = 0;
  const addMessageEntry = (branch, id, message) => {
    branch.push({ type: 'message', id, parentId: branch.at(-1)?.id || null, timestamp: new Date(message.timestamp).toISOString(), message });
  };
  async function waitUntil(predicate, label) {
    for (let index = 0; index < 100; index++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.fail(`timed out waiting for ${label}`);
  }
  function makeAdvisorHarness(adapter, initialEntries = []) {
    const handlers = new Map(), messageRenderers = new Map(), entryRenderers = new Map(), sent = [], visibleEntries = [];
    const branch = [...initialEntries];
    let idle = true;
    const pi = {
      on(event, handler) { const list = handlers.get(event) || []; list.push(handler); handlers.set(event, list); },
      registerTool() {},
      registerCommand() {},
      registerMessageRenderer(type, renderer) { messageRenderers.set(type, renderer); },
      registerEntryRenderer(type, renderer) { entryRenderers.set(type, renderer); },
      sendMessage(message, options) { sent.push({ message, options }); },
      appendEntry(customType, data) {
        const entry = { type: 'custom', customType, data, id: `custom-${++entrySequence}`, parentId: branch.at(-1)?.id || null, timestamp: new Date().toISOString() };
        visibleEntries.push(entry);
        branch.push(entry);
      },
      getFlag() { return undefined; },
      getActiveTools() { return []; },
      setActiveTools() {},
    };
    const sessionManager = {
      getSessionId: () => 'phase24-lifecycle',
      getSessionFile: () => join(temp, 'phase24-lifecycle.jsonl'),
      getLeafId: () => branch.at(-1)?.id || null,
      getLeafEntry: () => branch.at(-1),
      getBranch: () => branch,
      getEntries: () => branch,
    };
    const ctx = {
      cwd: temp,
      mode: 'tui',
      hasUI: true,
      model: { provider: 'test', id: 'primary', api: 'test', contextWindow: 128000 },
      modelRegistry: {},
      sessionManager,
      signal: undefined,
      isIdle: () => idle,
      hasPendingMessages: () => false,
      ui: { notify() {} },
    };
    async function emit(type, event = {}) {
      let result;
      for (const handler of handlers.get(type) || []) {
        const next = await handler({ type, ...event }, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    }
    __setAgentExperienceAdvisorAdapterForTest(adapter);
    agentExperienceExtension(pi);
    return { handlers, messageRenderers, entryRenderers, sent, visibleEntries, branch, ctx, emit, setIdle(value) { idle = value; } };
  }
  function fakeAdvisorAdapter(attempt) {
    const updates = [];
    return {
      updates,
      contextTokenEstimate: 0,
      async review(update) { updates.push(update); return [attempt]; },
      reset() {},
      async dispose() {},
    };
  }
  async function runTurn(harness, id, prompt, stopReason = 'toolUse') {
    harness.setIdle(false);
    await harness.emit('before_agent_start', { prompt, systemPrompt: 'base', systemPromptOptions: {} });
    const user = { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() };
    addMessageEntry(harness.branch, `user-${id}`, user);
    const assistant = { role: 'assistant', content: [{ type: 'text', text: `assistant ${id}` }, ...(stopReason === 'toolUse' ? [{ type: 'toolCall', id: `call-${id}`, name: 'bash', arguments: { command: 'publish' } }] : [])], stopReason, timestamp: Date.now() + 1 };
    addMessageEntry(harness.branch, `assistant-${id}`, assistant);
    await harness.emit('turn_end', { turnIndex: Number(id) || 0, message: assistant, toolResults: [] });
  }
  try {
    const concernAdapter = fakeAdvisorAdapter({ kind: 'generic_advice', severity: 'concern', note: 'Inspect the packed output.' });
    const concernHarness = makeAdvisorHarness(concernAdapter);
    assert.ok(concernHarness.messageRenderers.has(ADVISOR_FINDING_MESSAGE_TYPE));
    assert.ok(concernHarness.entryRenderers.has(ADVISOR_FINDING_VISIBLE_ENTRY_TYPE));
    for (const event of ['session_before_switch', 'session_before_fork', 'session_before_compact', 'session_before_tree', 'session_start', 'session_compact', 'session_tree', 'session_shutdown', 'before_agent_start', 'turn_end', 'message_start', 'message_end', 'model_select', 'agent_settled']) assert.ok(concernHarness.handlers.has(event), `missing Advisor lifecycle event ${event}`);
    await concernHarness.emit('session_start', { reason: 'startup' });
    await runTurn(concernHarness, '1', 'Publish the package.');
    await waitUntil(() => concernHarness.sent.length === 1, 'active Advisor steer');
    assert.equal(concernHarness.sent[0].message.customType, ADVISOR_FINDING_MESSAGE_TYPE);
    assert.deepEqual(concernHarness.sent[0].options, { triggerTurn: false, deliverAs: 'steer' });
    assert.doesNotMatch(JSON.stringify(concernHarness.sent[0]), /followUp|nextTurn|sendUserMessage/);
    const advisorCaused = { role: 'assistant', content: [{ type: 'text', text: 'responding to Advisor only' }], stopReason: 'stop', timestamp: Date.now() + 2 };
    addMessageEntry(concernHarness.branch, 'assistant-advisor-caused', advisorCaused);
    await concernHarness.emit('turn_end', { turnIndex: 2, message: advisorCaused, toolResults: [] });
    assert.equal(concernAdapter.updates.length, 1, 'the full Advisor-caused generation must be excluded from review');
    await runTurn(concernHarness, '2', 'A genuinely new user request.');
    await waitUntil(() => concernAdapter.updates.length === 2, 'causal state clear on new user generation');
    await concernHarness.emit('session_shutdown', { reason: 'quit' });

    const planEntry = { type: 'custom', customType: 'plan-mode', data: { enabled: true, todos: [], executing: false }, id: 'plan-state', parentId: null, timestamp: '2026-08-04T00:00:00.000Z' };
    const planAdapter = fakeAdvisorAdapter({ kind: 'generic_advice', severity: 'blocker', note: 'Do not continue yet.' });
    const planHarness = makeAdvisorHarness(planAdapter, [planEntry]);
    await planHarness.emit('session_start', { reason: 'startup' });
    await runTurn(planHarness, 'plan', 'Plan the package release.');
    await waitUntil(() => planAdapter.updates.length === 1, 'plan-mode review');
    assert.equal(planHarness.sent.length, 0, 'plan mode must remain visible-only while active');
    planHarness.setIdle(true);
    await planHarness.emit('agent_settled');
    await waitUntil(() => planHarness.sent.length === 1, 'settled plan-mode append');
    assert.deepEqual(planHarness.sent[0].options, { triggerTurn: false });
    await planHarness.emit('session_shutdown', { reason: 'quit' });

    const malformedPlan = { type: 'custom', customType: 'plan-mode', data: { enabled: 'maybe' }, id: 'plan-bad', parentId: 'plan-off', timestamp: '2026-08-04T00:01:00.000Z' };
    const ambiguousAdapter = fakeAdvisorAdapter({ kind: 'generic_advice', severity: 'concern', note: 'Ambiguous plan state.' });
    const ambiguousHarness = makeAdvisorHarness(ambiguousAdapter, [{ ...planEntry, id: 'plan-off', data: { enabled: false, todos: [], executing: false } }, malformedPlan]);
    await ambiguousHarness.emit('session_start', { reason: 'startup' });
    await runTurn(ambiguousHarness, 'ambiguous', 'Continue carefully.');
    await waitUntil(() => ambiguousAdapter.updates.length === 1, 'ambiguous plan review');
    assert.equal(ambiguousHarness.sent.length, 0, 'malformed latest plan state must fail closed to visible-only');
    ambiguousHarness.setIdle(true);
    await ambiguousHarness.emit('agent_settled');
    await waitUntil(() => ambiguousHarness.sent.length === 1, 'ambiguous settled append');
    assert.deepEqual(ambiguousHarness.sent[0].options, { triggerTurn: false });
    await ambiguousHarness.emit('session_shutdown', { reason: 'quit' });

    const nitAdapter = fakeAdvisorAdapter({ kind: 'generic_advice', severity: 'nit', note: 'Small release note.' });
    const nitHarness = makeAdvisorHarness(nitAdapter);
    await nitHarness.emit('session_start', { reason: 'startup' });
    await runTurn(nitHarness, 'nit', 'Prepare release notes.');
    await waitUntil(() => nitAdapter.updates.length === 1, 'nit review');
    await nitHarness.emit('session_before_switch', { reason: 'resume', targetSessionFile: '/tmp/replacement.jsonl' });
    assert.equal(nitHarness.sent.length, 0, 'nit must never trigger or steer a turn');
    await nitHarness.emit('session_shutdown', { reason: 'quit' });
    assert.equal(nitHarness.sent.length, 0);
    assert.equal(nitHarness.visibleEntries.at(-1).customType, ADVISOR_FINDING_VISIBLE_ENTRY_TYPE);
    assert.deepEqual(nitHarness.visibleEntries.at(-1).data, validateAdvisorFindingDetails(nitHarness.visibleEntries.at(-1).data));
    assert.doesNotMatch(JSON.stringify(nitHarness.visibleEntries.at(-1)), /delivered|guidance reached|followUp|nextTurn/);

    const staleResolvers = [];
    const staleAdapter = {
      contextTokenEstimate: 0,
      async review() { return new Promise((resolve) => { staleResolvers.push(resolve); }); },
      reset() {},
      async dispose() {},
    };
    const staleHarness = makeAdvisorHarness(staleAdapter);
    const staleAttempt = [{ kind: 'generic_advice', severity: 'blocker', note: 'Stale finding.' }];
    const finishStaleReview = async (index, label) => {
      staleResolvers[index](staleAttempt);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(staleHarness.sent.length, 0, `${label} must reject the old generation`);
    };
    await staleHarness.emit('session_start', { reason: 'startup' });
    await runTurn(staleHarness, 'tree-stale', 'Navigate away.');
    await waitUntil(() => staleResolvers.length === 1, 'tree stale review start');
    await staleHarness.emit('session_before_tree', { preparation: {}, signal: new AbortController().signal });
    await finishStaleReview(0, 'tree navigation');
    await staleHarness.emit('session_tree', { newLeafId: staleHarness.branch.at(-1)?.id || null, oldLeafId: null });

    await runTurn(staleHarness, 'compact-stale', 'Compact now.');
    await waitUntil(() => staleResolvers.length === 2, 'compaction stale review start');
    await staleHarness.emit('session_before_compact', { preparation: {}, branchEntries: staleHarness.branch, reason: 'manual', willRetry: false, signal: new AbortController().signal });
    await finishStaleReview(1, 'compaction');
    await staleHarness.emit('session_compact', { compactionEntry: {}, fromExtension: false, reason: 'manual', willRetry: false });

    await runTurn(staleHarness, 'model-stale', 'Change the model.');
    await waitUntil(() => staleResolvers.length === 3, 'model stale review start');
    await staleHarness.emit('model_select', { model: staleHarness.ctx.model, source: 'set' });
    await finishStaleReview(2, 'model selection');

    await runTurn(staleHarness, 'reload-stale', 'Reload the extension.');
    await waitUntil(() => staleResolvers.length === 4, 'reload stale review start');
    await staleHarness.emit('session_start', { reason: 'reload' });
    await finishStaleReview(3, 'session reset');

    await runTurn(staleHarness, 'switch-stale', 'Switch sessions.');
    await waitUntil(() => staleResolvers.length === 5, 'switch stale review start');
    await staleHarness.emit('session_before_switch', { reason: 'resume', targetSessionFile: '/tmp/other.jsonl' });
    await finishStaleReview(4, 'session switch');
    await staleHarness.emit('session_start', { reason: 'resume', previousSessionFile: '/tmp/old.jsonl' });

    await runTurn(staleHarness, 'fork-stale', 'Fork the session.');
    await waitUntil(() => staleResolvers.length === 6, 'fork stale review start');
    await staleHarness.emit('session_before_fork', { entryId: staleHarness.branch.at(-1).id, position: 'at' });
    await finishStaleReview(5, 'session fork');
    await staleHarness.emit('session_start', { reason: 'fork', previousSessionFile: '/tmp/old.jsonl' });

    await runTurn(staleHarness, 'shutdown-stale', 'Shut down.');
    await waitUntil(() => staleResolvers.length === 7, 'shutdown stale review start');
    const shutdown = staleHarness.emit('session_shutdown', { reason: 'quit' });
    await finishStaleReview(6, 'shutdown');
    await shutdown;
  } finally {
    __setAgentExperienceAdvisorAdapterForTest(undefined);
    for (const [key, value] of Object.entries(advisorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
} finally { await rm(temp, { recursive: true, force: true }); }
console.log('agent-experience phase24 advisor habit learning checks passed');
