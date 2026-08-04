#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import agentExperienceExtension, {
  __advisorCatchupRequiredForTest,
  __normalizeAgentExperienceConsolidationModelOutputForTest,
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
import {
  __resetObservationUniqueDedupeForTest,
  appendObservation,
  OBSERVATION_UNIQUE_SCAN_CAP_FOR_TEST,
  observationChecksumForTest,
  readValidatedObservationRange,
  rotateObservationGenerationIfFullyRead,
} from '../extensions/agent-experience/src/storage/observations.ts';
import { validateObservationRecords } from '../extensions/agent-experience/src/consolidate/observations.ts';
import { buildConsolidationUserPrompt } from '../extensions/agent-experience/src/consolidate/model-adapter.ts';
import { runConsolidationOnce } from '../extensions/agent-experience/src/consolidate/runner.ts';
import { buildCompactHabitContext } from '../extensions/agent-experience/src/consolidate/context.ts';
import { listPendingReviewItems } from '../extensions/agent-experience/src/review.ts';
import {
  appendAdvisorFindingObservation,
  buildAdvisorFindingObservation,
} from '../extensions/agent-experience/src/advisor/observation.ts';
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
function replaceHabit(db, id, patch, remove = []) {
  const before = db.prepare('SELECT * FROM habits WHERE user_id = ? AND id = ?').get('owner', id);
  const data = { ...JSON.parse(before.data_json), ...patch };
  for (const key of remove) delete data[key];
  const row = buildTypedStorageRow('habits', { id, userId: 'owner', data, createdAt: before.created_at, updatedAt: '2026-08-04T01:00:00.000Z' });
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
  const config = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true, selector_enabled: true, embedding_enabled: true, selector_min_confidence_bp: 7500, selector_staleness_max: 0.8 };
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

    const selectorDisabledConfig = { ...config, selector_enabled: false };
    await assert.rejects(
      () => prepareAdvisorHabitVectors(storage.db, { userId: 'owner', law, config: selectorDisabledConfig, embeddingAdapter: embedding, now: '2026-08-04T00:31:30.000Z' }),
      /advisor_habit_vectors_disabled/,
      'approved-habit vector preparation must require the independent approved-habits switch',
    );
    await assert.rejects(
      () => retrieveAdvisorHabitCandidates(storage.db, { userId: 'owner', delta: delta('[tool_call:bash] publish packed install'), activeRequestHabitIds: ['active-request-id'], law, config: selectorDisabledConfig, embeddingAdapter: embedding, tokenizerAssetDir }),
      /advisor_habit_vectors_disabled/,
      'Advisor retrieval must expose zero approved habits while Use approved habits is OFF',
    );

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
    assert.throws(
      () => revalidateAdvisorHabitFinding(storage.db, { ...strictInput, config: selectorDisabledConfig }),
      /advisor_habit_snapshot_changed/,
      'a selector disable after retrieval but before delivery must revoke the in-flight habit finding',
    );
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

  const learningRoot = join(temp, 'advisor-learning-observations');
  const learningPaths = { root: learningRoot, configPath: join(learningRoot, 'agent-experience.toml') };
  const learningConfig = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, capture_enabled: false };
  const firstFingerprint = '1'.repeat(64);
  const findingFor = (eventFingerprint, overrides = {}) => ({
    kind: 'generic_advice',
    severity: 'concern',
    note: 'Check concrete evidence before reporting completion.',
    eventFingerprint,
    ...overrides,
  });
  const updateFor = (eventFingerprint, overrides = {}) => ({
    ...findingUpdate,
    inProgress: false,
    primaryDelta: 'Reported completion before checking the produced artifact.',
    currentRequest: 'Prepare the release safely.',
    eventFingerprint,
    causedByAdvisor: false,
    ...overrides,
  });
  await writeAgentExperienceConfig(learningConfig, learningPaths);
  assert.deepEqual(
    await appendAdvisorFindingObservation(learningRoot, {
      userId: 'owner',
      finding: findingFor(firstFingerprint),
      update: updateFor(firstFingerprint),
      createdAt: '2026-08-03T08:00:00.000Z',
      modelVisibleDelivered: true,
    }),
    { appended: false, reason: 'learning_disabled' },
    'Learning-off must not append Advisor evidence',
  );
  assert.ok(!(await readdir(learningRoot)).includes('observations.jsonl'), 'Learning-off must not initialize an observation stream');

  await writeAgentExperienceConfig({ ...learningConfig, capture_enabled: true }, learningPaths);
  const boundedPayload = buildAdvisorFindingObservation(
    findingFor(firstFingerprint, { note: `${'Use checked output, not assumptions. '.repeat(100)} person@example.invalid token=abcdefghijk` }),
    updateFor(firstFingerprint, {
      currentRequest: `${'Release request '.repeat(300)} person@example.invalid`,
      primaryDelta: `${'Assistant behavior with \\ quoted output. '.repeat(500)} Bearer abcdefghijklmnop`,
    }),
    '2026-08-03T08:00:00.000Z',
  );
  assert.equal(boundedPayload.kind, 'advisor_finding_v1');
  assert.equal(boundedPayload.finding_kind, 'generic_advice');
  assert.equal(boundedPayload.severity, 'concern');
  assert.ok(boundedPayload.primary_behavior_redacted.length <= 3000);
  assert.ok(boundedPayload.advice_redacted.length <= 1200);
  assert.ok(JSON.stringify(boundedPayload).length <= 6000, 'Advisor payload must remain bounded after JSON escaping');
  assert.doesNotMatch(JSON.stringify(boundedPayload), /person@example\.invalid|abcdefghijk|abcdefghijklmnop/);

  const firstAppend = await appendAdvisorFindingObservation(learningRoot, {
    userId: 'owner',
    finding: findingFor(firstFingerprint),
    update: updateFor(firstFingerprint),
    createdAt: '2026-08-03T08:00:00.000Z',
    modelVisibleDelivered: true,
  });
  assert.deepEqual(firstAppend, { appended: true, reason: 'appended' });
  __resetObservationUniqueDedupeForTest();
  assert.deepEqual(
    await appendAdvisorFindingObservation(learningRoot, {
      userId: 'owner',
      finding: findingFor(firstFingerprint),
      update: updateFor(firstFingerprint),
      createdAt: '2026-08-03T08:01:00.000Z',
      modelVisibleDelivered: true,
    }),
    { appended: false, reason: 'duplicate' },
    'restart/resume replay must be rejected by durable active-generation evidence',
  );
  assert.deepEqual(
    await appendAdvisorFindingObservation(learningRoot, {
      userId: 'owner',
      finding: findingFor('9'.repeat(64)),
      update: updateFor('9'.repeat(64), { causedByAdvisor: true }),
      createdAt: '2026-08-03T08:02:00.000Z',
      modelVisibleDelivered: true,
    }),
    { appended: false, reason: 'advisor_caused' },
  );
  assert.deepEqual(
    await appendAdvisorFindingObservation(learningRoot, {
      userId: 'owner',
      finding: findingFor('8'.repeat(64)),
      update: updateFor('8'.repeat(64)),
      createdAt: '2026-08-03T08:03:00.000Z',
      modelVisibleDelivered: false,
    }),
    { appended: false, reason: 'not_model_visible' },
    'UI-only fallback cards must never become learning evidence',
  );

  for (const [eventFingerprint, createdAt] of [
    ['2'.repeat(64), '2026-08-03T09:00:00.000Z'],
    ['3'.repeat(64), '2026-08-04T09:00:00.000Z'],
  ]) {
    assert.deepEqual(await appendAdvisorFindingObservation(learningRoot, {
      userId: 'owner',
      finding: findingFor(eventFingerprint),
      update: updateFor(eventFingerprint),
      createdAt,
      modelVisibleDelivered: true,
    }), { appended: true, reason: 'appended' });
  }
  const learningRange = await readValidatedObservationRange(learningRoot, { userId: 'owner', maxRecords: 10, maxBytes: 100000 });
  assert.equal(learningRange.records.length, 3, 'one durable record must be stored per distinct causal fingerprint');
  const firstLearningRecord = learningRange.records[0];
  assert.deepEqual(firstLearningRecord.origin, { source: 'advisor_finding' });
  assert.equal(firstLearningRecord.payload_redacted.kind, 'advisor_finding_v1');
  assert.equal(firstLearningRecord.payload_redacted.finding_kind, 'generic_advice');
  assert.equal(firstLearningRecord.payload_redacted.severity, 'concern');
  assert.match(firstLearningRecord.id, /^advisor-[0-9a-f]{64}$/);
  assert.ok(!firstLearningRecord.id.includes(firstFingerprint), 'observation ID must not disclose the source fingerprint');
  assert.doesNotMatch(JSON.stringify(firstLearningRecord), /provider|habit_id|alias|vector|score|thinking/);

  const rawLearningRecords = learningRange.records.map(({ file_generation: _generation, ...record }) => record);
  assert.equal(validateObservationRecords({ records: rawLearningRecords, userId: 'owner', fileGeneration: learningRange.manifest.file_generation }).length, 3);
  const invalidOriginBase = { ...rawLearningRecords[0], origin: { source: 'advisor_finding', command: 'analyze' } };
  const invalidOrigin = { ...invalidOriginBase, checksum: observationChecksumForTest(Object.fromEntries(Object.entries(invalidOriginBase).filter(([key]) => key !== 'checksum'))) };
  assert.throws(() => validateObservationRecords({ records: [invalidOrigin], userId: 'owner', fileGeneration: learningRange.manifest.file_generation }), /origin/i);
  const mismatchedKindBase = { ...rawLearningRecords[0], origin: { source: 'test' } };
  const mismatchedKind = { ...mismatchedKindBase, checksum: observationChecksumForTest(Object.fromEntries(Object.entries(mismatchedKindBase).filter(([key]) => key !== 'checksum'))) };
  assert.throws(() => validateObservationRecords({ records: [mismatchedKind], userId: 'owner', fileGeneration: learningRange.manifest.file_generation }), /origin|payload kind/i);

  const promptRecords = [...learningRange.records, {
    ...learningRange.records[0],
    seq: 4,
    checksum: '4'.repeat(64),
    created_at: '2026-08-04T10:00:00.000Z',
  }];
  const normalizeInput = {
    model: 'test/learning',
    userId: 'owner',
    observations: learningRange.records,
    habitContext: [],
    expected: {
      file_generation: learningRange.manifest.file_generation,
      seq_start: 1,
      seq_end: 3,
      read_checksum: learningRange.records[2].checksum,
    },
  };
  const promptObservations = JSON.parse(buildConsolidationUserPrompt({ ...normalizeInput, observations: promptRecords })).observations;
  assert.equal(promptObservations.length, 3, 'Analyze must collapse duplicate Advisor fingerprints before prompting');
  assert.deepEqual(Object.keys(promptObservations[0]).sort(), ['advisor_finding', 'assistant', 'checksum', 'created_at', 'origin', 'seq', 'severity', 'user']);
  assert.equal(promptObservations[0].origin, 'advisor_finding');
  assert.equal(promptObservations[0].advisor_finding, 'Check concrete evidence before reporting completion.');

  const recurringRaw = {
    batch_id: 'advisor-recurring',
    proposals: [{
      proposal_id: 'advisor-recurring-1',
      kind: 'habit_candidate',
      candidate_key: 'verify-before-completion',
      condition: 'When reporting whether work is complete',
      behavior: 'Check concrete evidence before reporting completion',
      polarity: 1,
      confidence_bp: 9300,
      source_refs: learningRange.records.map((record) => ({ file_generation: record.file_generation, seq: record.seq, checksum: record.checksum })),
      evidence_summary: 'The same behavior recurred in three distinct checked events.',
    }],
  };
  const recurringOutput = __normalizeAgentExperienceConsolidationModelOutputForTest(recurringRaw, normalizeInput);
  assert.equal(recurringOutput.proposals[0].evidence_stage, 'reviewable', 'three distinct fingerprints across two days may reach review');

  const evidenceRecords = (fingerprints, dates) => fingerprints.map((eventFingerprint, index) => ({
    ...learningRange.records[0],
    seq: index + 1,
    checksum: String(index + 5).repeat(64).slice(0, 64),
    created_at: dates[index],
    payload_redacted: { ...learningRange.records[0].payload_redacted, event_fingerprint: eventFingerprint },
  }));
  const normalizeEvidence = (records, raw = recurringRaw) => __normalizeAgentExperienceConsolidationModelOutputForTest({
    ...raw,
    proposals: raw.proposals.map((proposal) => ({
      ...proposal,
      source_refs: records.map((record) => ({ file_generation: record.file_generation, seq: record.seq, checksum: record.checksum })),
    })),
  }, { ...normalizeInput, observations: records, expected: { ...normalizeInput.expected, read_checksum: records.at(-1).checksum } });
  const replayRows = evidenceRecords(['7'.repeat(64), '7'.repeat(64), '7'.repeat(64)], ['2026-08-02T08:00:00.000Z', '2026-08-03T08:00:00.000Z', '2026-08-04T08:00:00.000Z']);
  assert.equal(normalizeEvidence(replayRows).proposals[0].evidence_stage, 'collecting', 'duplicate Advisor rows must collapse by fingerprint for recurrence');
  const sameDayRows = evidenceRecords(['5'.repeat(64), '6'.repeat(64), '7'.repeat(64)], ['2026-08-04T08:00:00.000Z', '2026-08-04T09:00:00.000Z', '2026-08-04T10:00:00.000Z']);
  assert.equal(normalizeEvidence(sameDayRows).proposals[0].evidence_stage, 'collecting', 'same-day Advisor evidence must not satisfy the day threshold');

  const correctionRaw = {
    batch_id: 'advisor-correction',
    proposals: [{
      proposal_id: 'advisor-correction-1',
      kind: 'correction_split',
      candidate_key: 'advisor-correction',
      old_condition: 'When reporting whether work is complete',
      old_behavior: 'Report completion before checking evidence',
      new_condition: 'When reporting whether work is complete',
      new_behavior: 'Check concrete evidence before reporting completion',
      confidence_bp: 9900,
      source_refs: [],
    }],
  };
  const correctionContext = [{
    condition: correctionRaw.proposals[0].old_condition,
    behavior: correctionRaw.proposals[0].old_behavior,
    polarity: 1,
    status: 'active',
    unique_observations: 20,
    source_dates: ['2026-08-01'],
  }];
  const correctionInput = {
    ...normalizeInput,
    observations: [learningRange.records[0]],
    habitContext: correctionContext,
    expected: {
      file_generation: learningRange.records[0].file_generation,
      seq_start: 1,
      seq_end: 1,
      read_checksum: learningRange.records[0].checksum,
    },
  };
  const oneShotCorrection = __normalizeAgentExperienceConsolidationModelOutputForTest({
    ...correctionRaw,
    proposals: [{ ...correctionRaw.proposals[0], source_refs: [{ file_generation: learningRange.records[0].file_generation, seq: 1, checksum: learningRange.records[0].checksum }] }],
  }, correctionInput);
  assert.equal(oneShotCorrection.proposals[0].evidence_stage, 'collecting', 'Advisor evidence can never invoke explicit-correction authority');
  assert.equal(normalizeEvidence(learningRange.records, correctionRaw).proposals[0].evidence_stage, 'collecting', 'repeated Advisor evidence can never create a correction split');

  const correctionLedger = await initExperienceStorage(join(temp, 'advisor-correction-ledger'), { allowInit: true, userId: 'owner' });
  try {
    const activeId = 'advisor-correction-active';
    insertStorageRecord(correctionLedger.db, 'habits', {
      id: activeId,
      userId: 'owner',
      data: habitData(activeId, correctionRaw.proposals[0].old_condition, correctionRaw.proposals[0].old_behavior, lawSnapshotForTest('advisor correction sink law').hash),
      now: '2026-08-04T10:00:00.000Z',
    });
    const committedCorrection = await runConsolidationOnce({
      root: correctionLedger.root,
      db: correctionLedger.db,
      userId: 'owner',
      observations: correctionInput.observations,
      modelOutput: oneShotCorrection,
      model: 'test/learning',
      now: '2026-08-04T10:30:00.000Z',
    });
    assert.equal(committedCorrection.ok, true);
    assert.equal(correctionLedger.db.prepare('SELECT status FROM habits WHERE user_id=? AND id=?').get('owner', activeId).status, 'active', 'Advisor-only collecting correction must not suppress an active habit at commit');
    assert.equal(Number(correctionLedger.db.prepare("SELECT COUNT(*) AS count FROM experience_review_audit WHERE user_id='owner' AND action='suppress_contradicted_habit'").get().count), 0, 'Advisor-only collecting correction must not write a suppression audit');
  } finally { correctionLedger.db.close(); }

  const learningLedger = await initExperienceStorage(join(temp, 'advisor-learning-ledger'), { allowInit: true, userId: 'owner' });
  try {
    const committed = await runConsolidationOnce({
      root: learningLedger.root,
      db: learningLedger.db,
      userId: 'owner',
      observations: learningRange.records,
      modelOutput: recurringOutput,
      model: 'test/learning',
      now: '2026-08-04T11:00:00.000Z',
    });
    assert.equal(committed.ok, true);
    assert.equal(listPendingReviewItems(learningLedger.db, { userId: 'owner' }).items.length, 1, 'recurring Advisor evidence may create only an explicit review item');
    assert.equal(Number(learningLedger.db.prepare("SELECT COUNT(*) AS count FROM habits WHERE user_id='owner' AND status='active'").get().count), 0, 'Advisor evidence must never approve or activate a habit');
  } finally { learningLedger.db.close(); }

  const rotatedReplayRoot = join(temp, 'advisor-rotated-replay');
  const rotatedReplayPaths = { root: rotatedReplayRoot, configPath: join(rotatedReplayRoot, 'agent-experience.toml') };
  const rotatedReplayFingerprint = 'd'.repeat(64);
  await writeAgentExperienceConfig({ ...learningConfig, capture_enabled: true }, rotatedReplayPaths);
  const rotatedReplayLedger = await initExperienceStorage(join(temp, 'advisor-rotated-replay-ledger'), { allowInit: true, userId: 'owner' });
  try {
    for (let index = 0; index < 3; index++) {
      const day = String(index + 1).padStart(2, '0');
      const createdAt = `2026-08-${day}T08:00:00.000Z`;
      __resetObservationUniqueDedupeForTest();
      assert.deepEqual(await appendAdvisorFindingObservation(rotatedReplayRoot, {
        userId: 'owner',
        finding: findingFor(rotatedReplayFingerprint),
        update: updateFor(rotatedReplayFingerprint),
        createdAt,
        modelVisibleDelivered: true,
      }), { appended: true, reason: 'appended' }, 'active-generation replay policy permits a retained-generation replay after rotation');
      const replayRange = await readValidatedObservationRange(rotatedReplayRoot, { userId: 'owner', maxRecords: 10, maxBytes: 100000 });
      assert.equal(replayRange.records.length, 1);
      const replayInput = {
        model: 'test/learning',
        userId: 'owner',
        observations: replayRange.records,
        habitContext: buildCompactHabitContext(rotatedReplayLedger.db, { userId: 'owner' }),
        expected: {
          file_generation: replayRange.manifest.file_generation,
          seq_start: 1,
          seq_end: 1,
          read_checksum: replayRange.records[0].checksum,
        },
      };
      const replayOutput = __normalizeAgentExperienceConsolidationModelOutputForTest({
        ...recurringRaw,
        batch_id: `advisor-rotated-replay-${index}`,
        proposals: [{
          ...recurringRaw.proposals[0],
          proposal_id: `advisor-rotated-replay-${index}`,
          source_refs: [{ file_generation: replayRange.records[0].file_generation, seq: 1, checksum: replayRange.records[0].checksum }],
        }],
      }, replayInput);
      assert.equal(replayOutput.proposals[0].evidence_stage, 'collecting', 'one replayed Advisor fingerprint across rotations/days must remain collecting');
      const replayCommit = await runConsolidationOnce({
        root: rotatedReplayLedger.root,
        db: rotatedReplayLedger.db,
        userId: 'owner',
        observations: replayRange.records,
        modelOutput: replayOutput,
        model: 'test/learning',
        now: createdAt,
      });
      assert.equal(replayCommit.ok, true);
      assert.equal(listPendingReviewItems(rotatedReplayLedger.db, { userId: 'owner' }).items.length, 0);
      const rotation = await rotateObservationGenerationIfFullyRead(rotatedReplayRoot, {
        userId: 'owner',
        fileGeneration: replayRange.manifest.file_generation,
        seq: replayRange.records[0].seq,
        checksum: replayRange.records[0].checksum,
        retentionDays: 30,
        now: `2026-08-${day}T09:00:00.000Z`,
      });
      assert.equal(rotation.rotated, true);
    }
    const replayContext = buildCompactHabitContext(rotatedReplayLedger.db, { userId: 'owner' });
    assert.equal(replayContext[0].unique_observations, 1, 'durable candidate context must aggregate Advisor evidence by event fingerprint across generations');
    assert.equal(replayContext[0].distinct_days, 1, 'replayed fingerprint dates must not inflate durable day recurrence');
    assert.doesNotMatch(
      buildConsolidationUserPrompt({ ...normalizeInput, habitContext: replayContext }),
      new RegExp(rotatedReplayFingerprint),
      'durable fingerprint identity must remain internal and never enter the Analyze model prompt',
    );
  } finally { rotatedReplayLedger.db.close(); }

  const legacyMergeLedger = await initExperienceStorage(join(temp, 'advisor-legacy-merge-ledger'), { allowInit: true, userId: 'owner' });
  try {
    const initial = await runConsolidationOnce({
      root: legacyMergeLedger.root,
      db: legacyMergeLedger.db,
      userId: 'owner',
      observations: learningRange.records,
      modelOutput: recurringOutput,
      model: 'test/learning',
      now: '2026-08-04T13:00:00.000Z',
    });
    assert.equal(initial.ok, true);
    const candidate = legacyMergeLedger.db.prepare("SELECT id FROM habits WHERE user_id='owner' AND condition=? AND behavior=?").get(recurringRaw.proposals[0].condition, recurringRaw.proposals[0].behavior);
    const legacyRefs = [
      { file_generation: 'legacy-ordinary', seq: 1, checksum: 'a'.repeat(64) },
      { file_generation: 'legacy-ordinary', seq: 2, checksum: 'b'.repeat(64) },
    ];
    replaceHabit(legacyMergeLedger.db, candidate.id, {
      status: 'candidate',
      review_status: 'collecting_evidence',
      active: false,
      source_refs: legacyRefs,
      source_dates: ['2026-07-01T08:00:00.000Z', '2026-07-02T08:00:00.000Z'],
    }, ['advisor_events', 'advisor_source_ref_keys', 'non_advisor_source_dates']);
    const legacyContext = buildCompactHabitContext(legacyMergeLedger.db, { userId: 'owner' });
    assert.equal(legacyContext[0].unique_observations, 2);
    assert.equal(legacyContext[0].distinct_days, 2);
    assert.deepEqual(legacyContext[0].advisor_event_fingerprints, []);

    const advisorRecord = {
      ...learningRange.records[0],
      file_generation: 'legacy-advisor-merge',
      seq: 1,
      prev_pair_ref: null,
      created_at: '2026-07-03T08:00:00.000Z',
    };
    const legacyMergeInput = {
      ...normalizeInput,
      observations: [advisorRecord],
      habitContext: legacyContext,
      expected: {
        file_generation: advisorRecord.file_generation,
        seq_start: 1,
        seq_end: 1,
        read_checksum: advisorRecord.checksum,
      },
    };
    const legacyMergeOutput = __normalizeAgentExperienceConsolidationModelOutputForTest({
      ...recurringRaw,
      batch_id: 'advisor-legacy-merge',
      proposals: [{
        ...recurringRaw.proposals[0],
        proposal_id: 'advisor-legacy-merge',
        source_refs: [{ file_generation: advisorRecord.file_generation, seq: 1, checksum: advisorRecord.checksum }],
      }],
    }, legacyMergeInput);
    const merged = await runConsolidationOnce({
      root: legacyMergeLedger.root,
      db: legacyMergeLedger.db,
      userId: 'owner',
      observations: [advisorRecord],
      modelOutput: legacyMergeOutput,
      model: 'test/learning',
      now: '2026-07-03T09:00:00.000Z',
    });
    assert.equal(merged.ok, true);
    const mergedContext = buildCompactHabitContext(legacyMergeLedger.db, { userId: 'owner' });
    assert.equal(mergedContext[0].unique_observations, 3, 'legacy ordinary source refs must survive a later Advisor merge');
    assert.equal(mergedContext[0].distinct_days, 3, 'legacy ordinary source dates must survive a later Advisor merge');
    assert.deepEqual(mergedContext[0].advisor_event_fingerprints, [firstFingerprint], 'ordinary legacy evidence must never be reclassified as Advisor fingerprint evidence');
    assert.doesNotMatch(buildConsolidationUserPrompt({ ...legacyMergeInput, habitContext: mergedContext }), new RegExp(firstFingerprint), 'internal Advisor fingerprints must remain absent from model context');
  } finally { legacyMergeLedger.db.close(); }

  const cappedRoot = join(temp, 'advisor-learning-cap');
  const cappedPaths = { root: cappedRoot, configPath: join(cappedRoot, 'agent-experience.toml') };
  await writeAgentExperienceConfig({ ...learningConfig, capture_enabled: true }, cappedPaths);
  for (let index = 0; index <= OBSERVATION_UNIQUE_SCAN_CAP_FOR_TEST; index++) {
    await appendObservation(cappedRoot, {
      userId: 'owner',
      origin: { source: 'test' },
      payload: {
        kind: 'conversation_pair_v1',
        close_reason: 'agent_settled',
        user_text_redacted: `request ${index}`,
        assistant_text_redacted: `response ${index}`,
        user_char_count: 10,
        assistant_char_count: 11,
        input_created_at: '2026-08-04T00:00:00.000Z',
        completed_at: '2026-08-04T00:00:01.000Z',
      },
      id: `cap-${index}`,
      createdAt: '2026-08-04T00:00:01.000Z',
    });
  }
  __resetObservationUniqueDedupeForTest();
  assert.deepEqual(await appendAdvisorFindingObservation(cappedRoot, {
    userId: 'owner',
    finding: findingFor('f'.repeat(64)),
    update: updateFor('f'.repeat(64)),
    createdAt: '2026-08-04T12:00:00.000Z',
    modelVisibleDelivered: true,
  }), { appended: false, reason: 'scan_cap_exceeded' }, 'durable dedupe must fail closed when its bounded reverse scan cannot cover the active generation');

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
    const handlers = new Map(), commands = new Map(), messageRenderers = new Map(), entryRenderers = new Map(), sent = [], visibleEntries = [];
    const branch = [...initialEntries];
    const setupChoices = [], setupNotes = [];
    let idle = true;
    const advisorModels = [
      { provider: 'test', id: 'advisor', name: 'Advisor', api: 'test', contextWindow: 128000, input: ['text'] },
      { provider: 'test', id: 'advisor-v2', name: 'Advisor v2', api: 'test', contextWindow: 128000, input: ['text'] },
      { provider: 'test', id: 'primary', name: 'Primary', api: 'test', contextWindow: 128000, input: ['text'] },
    ];
    const pi = {
      on(event, handler) { const list = handlers.get(event) || []; list.push(handler); handlers.set(event, list); },
      registerTool() {},
      registerCommand(name, options) { commands.set(name, options); },
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
      model: advisorModels[2],
      modelRegistry: {
        getAvailable: () => advisorModels,
        find: (provider, id) => advisorModels.find((model) => model.provider === provider && model.id === id),
        hasConfiguredAuth: () => true,
        async getApiKeyAndHeaders() { return { ok: true, apiKey: 'test-not-used' }; },
      },
      sessionManager,
      signal: undefined,
      isIdle: () => idle,
      hasPendingMessages: () => false,
      ui: {
        notify(message, level) { setupNotes.push({ message, level }); },
        async select(_title, options) {
          const choice = setupChoices.shift();
          if (choice === undefined) return undefined;
          return options.find((option) => option === choice || option.startsWith(`${choice}:`)) ?? choice;
        },
      },
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
    return {
      handlers, commands, messageRenderers, entryRenderers, sent, visibleEntries, branch, ctx, emit, setupNotes,
      queueSetup(...choices) { setupChoices.push(...choices); },
      setIdle(value) { idle = value; },
    };
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
  function deferredAdvisorAdapter() {
    const updates = [], resolvers = [];
    let resetCalls = 0;
    return {
      updates,
      resolvers,
      get resetCalls() { return resetCalls; },
      contextTokenEstimate: 0,
      async review(update) {
        updates.push(update);
        return new Promise((resolve) => resolvers.push(resolve));
      },
      reset() { resetCalls++; },
      async dispose() {},
    };
  }
  async function runTurn(harness, id, prompt, stopReason = 'toolUse') {
    harness.setIdle(false);
    await harness.emit('before_agent_start', { prompt, systemPrompt: 'base', systemPromptOptions: {} });
    const user = { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() };
    await harness.emit('message_start', { message: user });
    addMessageEntry(harness.branch, `user-${id}`, user);
    await harness.emit('message_end', { message: user });
    const assistant = { role: 'assistant', content: [{ type: 'text', text: `assistant ${id}` }, ...(stopReason === 'toolUse' ? [{ type: 'toolCall', id: `call-${id}`, name: 'bash', arguments: { command: 'publish' } }] : [])], stopReason, timestamp: Date.now() + 1 };
    addMessageEntry(harness.branch, `assistant-${id}`, assistant);
    await harness.emit('turn_end', { turnIndex: Number(id) || 0, message: assistant, toolResults: [] });
  }
  try {
    process.env.AX_CAPTURE_ENABLED = 'true';
    await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true, advisor_model: 'test/advisor', capture_enabled: true, break_in_enabled: false });
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
    let deliveredLearningRange;
    for (let index = 0; index < 100; index++) {
      try {
        const candidate = await readValidatedObservationRange(join(temp, 'advisor-state'), { userId: 'owner', maxRecords: 10, maxBytes: 100000 });
        if (candidate.records.length > 0) {
          deliveredLearningRange = candidate;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(deliveredLearningRange?.records[0].origin.source, 'advisor_finding', 'successful model-visible delivery must append Advisor evidence');
    process.env.AX_CAPTURE_ENABLED = 'false';
    await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true, advisor_model: 'test/advisor', capture_enabled: false, break_in_enabled: false });
    const advisorCaused = { role: 'assistant', content: [{ type: 'text', text: 'responding to Advisor only' }], stopReason: 'stop', timestamp: Date.now() + 2 };
    addMessageEntry(concernHarness.branch, 'assistant-advisor-caused', advisorCaused);
    await concernHarness.emit('turn_end', { turnIndex: 2, message: advisorCaused, toolResults: [] });
    assert.equal(concernAdapter.updates.length, 1, 'the full Advisor-caused generation must be excluded from review');
    const firstGeneration = concernAdapter.updates[0].generation;
    const firstCursor = concernAdapter.updates[0].cursor;
    const queuedPrompt = 'A genuinely queued user steer.';
    const queuedUser = { role: 'user', content: [{ type: 'text', text: queuedPrompt }], timestamp: Date.now() + 3 };
    await concernHarness.emit('message_start', { message: queuedUser });
    addMessageEntry(concernHarness.branch, 'user-queued', queuedUser);
    await concernHarness.emit('message_end', { message: queuedUser });
    const queuedAssistant = { role: 'assistant', content: [{ type: 'text', text: 'responding to the queued user' }], stopReason: 'stop', timestamp: Date.now() + 4 };
    addMessageEntry(concernHarness.branch, 'assistant-queued', queuedAssistant);
    await concernHarness.emit('turn_end', { turnIndex: 3, message: queuedAssistant, toolResults: [] });
    await waitUntil(() => concernAdapter.updates.length === 2, 'causal state clear on queued user generation');
    assert.equal(concernAdapter.updates[1].generation, firstGeneration + 1);
    assert.ok(concernAdapter.updates[1].cursor > firstCursor);
    assert.equal(concernAdapter.updates[1].currentRequest, queuedPrompt);
    assert.equal(concernAdapter.updates[1].causedByAdvisor, false);
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

    for (const [beforeEvent, label] of [['session_before_tree', 'tree'], ['session_before_compact', 'compaction']]) {
      const updates = [];
      const cancelledAdapter = {
        contextTokenEstimate: 0,
        async review(update) {
          updates.push(update);
          return updates.length === 1 ? [{ kind: 'generic_advice', severity: 'nit', note: `Pending across cancelled ${label}.` }] : [];
        },
        reset() {},
        async dispose() {},
      };
      const cancelledHarness = makeAdvisorHarness(cancelledAdapter);
      await cancelledHarness.emit('session_start', { reason: 'startup' });
      await runTurn(cancelledHarness, `${label}-before`, `Prepare ${label}.`);
      await waitUntil(() => updates.length === 1, `${label} pending finding`);
      assert.equal(cancelledHarness.sent.length, 0);
      await cancelledHarness.emit(beforeEvent, { preparation: {}, signal: new AbortController().signal });
      await runTurn(cancelledHarness, `${label}-cancelled`, `Continue after cancelled ${label}.`, 'stop');
      await waitUntil(() => updates.length === 2, `${label} reseeded review`);
      cancelledHarness.setIdle(true);
      await cancelledHarness.emit('agent_settled');
      assert.equal(cancelledHarness.sent.length, 0, `a later ${label} cursor must discard the immutable pending finding`);
      await cancelledHarness.emit('session_shutdown', { reason: 'quit' });
    }

    const cursorUpdates = [];
    const cursorAdapter = {
      contextTokenEstimate: 0,
      async review(update) {
        cursorUpdates.push(update);
        return cursorUpdates.length === 1 ? [{ kind: 'generic_advice', severity: 'nit', note: 'Finding from the intermediate tool-use turn.' }] : [];
      },
      reset() {},
      async dispose() {},
    };
    const cursorHarness = makeAdvisorHarness(cursorAdapter);
    await cursorHarness.emit('session_start', { reason: 'startup' });
    await runTurn(cursorHarness, 'cursor-first', 'Complete the release with tools.');
    await waitUntil(() => cursorUpdates.length === 1, 'intermediate pending finding');
    const continuation = { role: 'assistant', content: [{ type: 'text', text: 'assistant corrected the issue before settling' }], stopReason: 'stop', timestamp: Date.now() + 10 };
    addMessageEntry(cursorHarness.branch, 'assistant-cursor-second', continuation);
    await cursorHarness.emit('turn_end', { turnIndex: 2, message: continuation, toolResults: [] });
    await waitUntil(() => cursorUpdates.length === 2, 'later cursor review');
    cursorHarness.setIdle(true);
    await cursorHarness.emit('agent_settled');
    assert.equal(cursorHarness.sent.length, 0, 'a pending finding must retain its original cursor and be discarded after a later turn advances it');
    await cursorHarness.emit('session_shutdown', { reason: 'quit' });

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

    delete process.env.AX_ENABLED;
    delete process.env.AX_ADVISOR_ENABLED;
    delete process.env.AX_ADVISOR_MODEL;
    process.env.AX_CAPTURE_ENABLED = 'false';

    const authorityAdapter = deferredAdvisorAdapter();
    await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true, advisor_model: 'test/advisor', selector_enabled: true, embedding_enabled: true, capture_enabled: false, break_in_enabled: false });
    const authorityHarness = makeAdvisorHarness(authorityAdapter);
    await authorityHarness.emit('session_start', { reason: 'startup' });
    await runTurn(authorityHarness, 'authority-pending', 'Check the current authority signature.');
    await waitUntil(() => authorityAdapter.resolvers.length === 1, 'authority-signature deferred review');
    await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true, advisor_model: 'test/advisor', selector_enabled: true, embedding_enabled: true, selector_min_confidence_bp: 7600, capture_enabled: false, break_in_enabled: false });
    authorityAdapter.resolvers[0]([{ kind: 'generic_advice', severity: 'concern', note: 'Finding from the old authority signature.' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(authorityHarness.sent.length, 0, 'every generic finding must reload and compare the full runtime/authority signature before delivery');
    await authorityHarness.emit('session_shutdown', { reason: 'quit' });

    await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true, advisor_model: 'test/advisor', selector_enabled: true, embedding_enabled: true, capture_enabled: false, break_in_enabled: false });
    const deliveryRevalidationAdapter = fakeAdvisorAdapter({ kind: 'generic_advice', severity: 'nit', note: 'Pending until the primary settles.' });
    const deliveryRevalidationHarness = makeAdvisorHarness(deliveryRevalidationAdapter);
    await deliveryRevalidationHarness.emit('session_start', { reason: 'startup' });
    await runTurn(deliveryRevalidationHarness, 'delivery-revalidation', 'Settle after checking configuration.');
    await waitUntil(() => deliveryRevalidationAdapter.updates.length === 1, 'pending delivery revalidation');
    await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true, advisor_model: 'test/advisor', selector_enabled: false, embedding_enabled: true, capture_enabled: false, break_in_enabled: false });
    deliveryRevalidationHarness.setIdle(true);
    await deliveryRevalidationHarness.emit('agent_settled');
    assert.equal(deliveryRevalidationHarness.sent.length, 0, 'pending findings must reload the full authority signature immediately before send');
    await deliveryRevalidationHarness.emit('session_shutdown', { reason: 'quit' });

    await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: false, advisor_enabled: false, advisor_model: 'test/advisor', capture_enabled: false, break_in_enabled: false });
    const enabledMidSessionAdapter = fakeAdvisorAdapter({ kind: 'generic_advice', severity: 'concern', note: 'Advisor became active immediately.' });
    const enabledMidSessionHarness = makeAdvisorHarness(enabledMidSessionAdapter);
    await enabledMidSessionHarness.emit('session_start', { reason: 'startup' });
    enabledMidSessionHarness.queueSetup('Guidance and Advisor', 'Runtime Advisor', 'Turn Runtime Advisor ON', 'Back', 'Done');
    await enabledMidSessionHarness.commands.get('experience').handler('setup', enabledMidSessionHarness.ctx);
    await runTurn(enabledMidSessionHarness, 'enabled-mid-session', 'Review this turn immediately.');
    await waitUntil(() => enabledMidSessionAdapter.updates.length === 1, 'mid-session Advisor activation');
    assert.equal(enabledMidSessionHarness.sent.length, 1, 'a successful setup enable must synchronously rebuild an active runtime');
    await enabledMidSessionHarness.emit('session_shutdown', { reason: 'quit' });

    await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true, advisor_model: 'test/advisor', capture_enabled: false, break_in_enabled: false });
    const disableAdapter = deferredAdvisorAdapter();
    const disableHarness = makeAdvisorHarness(disableAdapter);
    await disableHarness.emit('session_start', { reason: 'startup' });
    await runTurn(disableHarness, 'disable-pending', 'Begin a deferred review before disable.');
    await waitUntil(() => disableAdapter.resolvers.length === 1, 'setup-disable deferred review');
    disableHarness.queueSetup('Guidance and Advisor', 'Runtime Advisor', 'Back', 'Done');
    await disableHarness.commands.get('experience').handler('setup', disableHarness.ctx);
    assert.ok(disableAdapter.resetCalls > 0, 'successful setup disable must synchronously abort/reset the old runtime');
    disableAdapter.resolvers[0]([{ kind: 'generic_advice', severity: 'blocker', note: 'Old result after Advisor disable.' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(disableHarness.sent.length, 0, 'Advisor disable must revoke the pending generic finding');
    await runTurn(disableHarness, 'disabled-next-turn', 'No Advisor review should start now.', 'stop');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(disableAdapter.resolvers.length, 1, 'setup disable must not rebuild a disabled runtime');
    await disableHarness.emit('session_shutdown', { reason: 'quit' });

    await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true, advisor_model: 'test/advisor', capture_enabled: false, break_in_enabled: false });
    const modelChangeAdapter = deferredAdvisorAdapter();
    const modelChangeHarness = makeAdvisorHarness(modelChangeAdapter);
    await modelChangeHarness.emit('session_start', { reason: 'startup' });
    await runTurn(modelChangeHarness, 'model-change-pending', 'Begin a deferred review before model change.');
    await waitUntil(() => modelChangeAdapter.resolvers.length === 1, 'setup-model deferred review');
    modelChangeHarness.queueSetup('Guidance and Advisor', 'Advisor model', 'Choose separate authenticated model', 'test/advisor-v2', 'Back', 'Done');
    await modelChangeHarness.commands.get('experience').handler('setup', modelChangeHarness.ctx);
    assert.ok(modelChangeAdapter.resetCalls > 0, 'successful Advisor-model mutation must synchronously abort/reset the old runtime');
    modelChangeAdapter.resolvers[0]([{ kind: 'generic_advice', severity: 'concern', note: 'Old-model result.' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(modelChangeHarness.sent.length, 0, 'Advisor model change must revoke the old-model pending finding');
    await runTurn(modelChangeHarness, 'model-change-active', 'Use the rebuilt Advisor runtime.', 'stop');
    await waitUntil(() => modelChangeAdapter.resolvers.length === 2, 'rebuilt Advisor runtime after model change');
    modelChangeAdapter.resolvers[1]([]);
    await modelChangeHarness.emit('session_shutdown', { reason: 'quit' });

    await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true, advisor_model: 'test/advisor', selector_enabled: true, embedding_enabled: true, capture_enabled: false, break_in_enabled: false });
    const selectorDisableAdapter = deferredAdvisorAdapter();
    const selectorDisableHarness = makeAdvisorHarness(selectorDisableAdapter);
    await selectorDisableHarness.emit('session_start', { reason: 'startup' });
    await runTurn(selectorDisableHarness, 'selector-disable-pending', 'Begin review before approved habits are disabled.');
    await waitUntil(() => selectorDisableAdapter.resolvers.length === 1, 'setup-selector deferred review');
    selectorDisableHarness.queueSetup('Guidance and Advisor', 'Use approved habits', 'Back', 'Done');
    await selectorDisableHarness.commands.get('experience').handler('setup', selectorDisableHarness.ctx);
    assert.ok(selectorDisableAdapter.resetCalls > 0, 'selector authority mutation must synchronously reset and rebuild the Advisor runtime');
    selectorDisableAdapter.resolvers[0]([{ kind: 'generic_advice', severity: 'concern', note: 'Old selector-authority result.' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(selectorDisableHarness.sent.length, 0, 'selector disable must revoke every pending finding from the old authority signature');
    await selectorDisableHarness.emit('session_shutdown', { reason: 'quit' });
  } finally {
    __setAgentExperienceAdvisorAdapterForTest(undefined);
    for (const [key, value] of Object.entries(advisorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
} finally { await rm(temp, { recursive: true, force: true }); }
console.log('agent-experience phase24 advisor habit learning checks passed');
