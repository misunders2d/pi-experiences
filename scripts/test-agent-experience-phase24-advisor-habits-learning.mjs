#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
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
} finally { await rm(temp, { recursive: true, force: true }); }
console.log('agent-experience phase24 advisor habit learning checks passed');
