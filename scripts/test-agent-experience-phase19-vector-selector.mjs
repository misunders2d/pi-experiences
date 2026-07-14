#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { lawSnapshotForTest } from '../extensions/agent-experience/src/review.ts';
import {
  buildSelectorPrompt,
  parseSelectorModelOutput,
  runSelectorRuntime,
  selectActiveSelectorSnapshot,
} from '../extensions/agent-experience/src/selector.ts';
import {
  MAX_SELECTOR_ELIGIBLE_HABITS,
  prepareSelectorConditionVectors,
  readSelectorConditionVectors,
  retrieveSelectorCandidates,
  SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION,
  selectorConditionIdentityChecksum,
} from '../extensions/agent-experience/src/selector-vector.ts';
import { normalizedVector } from '../extensions/agent-experience/src/semantic/core.ts';
import {
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_PROVIDER,
} from '../extensions/agent-experience/src/semantic/local-model-manifest.ts';
import { buildTypedStorageRow, initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { prepareActiveSelectorVectorsAfterChange } from '../extensions/agent-experience/src/selector-maintenance.ts';

function unit(index) {
  const vector = new Float32Array(LOCAL_EMBEDDING_DIMENSIONS);
  vector[index] = 1;
  return vector;
}

const vectors = {
  status: unit(0),
  code: unit(1),
  release: unit(2),
  decision: unit(3),
  unrelated: unit(4),
  vacation: unit(5),
};

function vectorFor(text) {
  const value = String(text).toLowerCase();
  if (/status|progress|background|фонов/.test(value)) return vectors.status;
  if (/nontrivial|code changes|safety-sensitive|vector selector across the package code/.test(value)) return vectors.code;
  if (/package release|publishing|verifying/.test(value)) return vectors.release;
  if (/decision|approval|setup choice|missing information/.test(value)) return vectors.decision;
  if (/summer vacation|vacation for the next summer|plan.*vacation/.test(value)) return vectors.vacation;
  if (/take a lot of code/.test(value)) return vectors.code;
  if (/agent package/.test(value)) return normalizedVector(Float32Array.from(vectors.code, (entry, index) => entry + vectors.release[index]));
  return vectors.unrelated;
}

function fakeEmbeddingAdapter() {
  let calls = 0;
  return {
    id: `${LOCAL_EMBEDDING_PROVIDER}:${LOCAL_EMBEDDING_MODEL}:${LOCAL_EMBEDDING_DIMENSIONS}`,
    provider: LOCAL_EMBEDDING_PROVIDER,
    model: LOCAL_EMBEDDING_MODEL,
    dimensions: LOCAL_EMBEDDING_DIMENSIONS,
    async embed(texts, { signal } = {}) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      calls += 1;
      return texts.map(vectorFor);
    },
    get calls() { return calls; },
  };
}

function refs() {
  return [1, 2, 3].map((seq) => ({ file_generation: 'phase19', seq, checksum: String(seq).repeat(64).slice(0, 64) }));
}

function habitData(condition, behavior, lawHash) {
  return {
    schema_version: 2,
    record_kind: 'candidate_habit_v1',
    status: 'active',
    active: true,
    injectable: false,
    condition,
    behavior,
    polarity: 1,
    confidence_bp: 9000,
    activation: 1,
    staleness: 0,
    law_hash: lawHash,
    source_refs: refs(),
    source_dates: ['2026-07-10T00:00:00.000Z', '2026-07-11T00:00:00.000Z', '2026-07-12T00:00:00.000Z'],
  };
}

function judgments(candidateIds, applicable = []) {
  const selected = new Set(applicable);
  return {
    schema_version: 2,
    judgments: candidateIds.map((id) => selected.has(id)
      ? { id, applicable: true, confidence_bp: 9500, reason: 'current_applicability' }
      : { id, applicable: false, confidence_bp: 9500, reason: 'not_currently_relevant' }),
  };
}

const law = lawSnapshotForTest('phase19 selector law');
const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase19-'));
const storage = await initExperienceStorage(join(temp, 'state'), { allowInit: true, userId: 'owner' });
try {
  const definitions = [
    ['status', 'When a user asks for status/progress or checks whether background work is complete.', 'Give concise evidence-backed status.'],
    ['code', 'When doing nontrivial code changes, safety-sensitive fixes, or release review', 'Use thorough review and validation.'],
    ['release', 'When preparing, publishing, or verifying a package release.', 'Verify artifacts and stop before publication.'],
    ['decision', 'When asking me for a decision, approval, setup choice, or missing information', 'Ask one crisp bounded question.'],
    ['vacation', 'When I mention or ask about summer vacation', 'Give the approved summer-vacation response.'],
  ];
  for (const [id, condition, behavior] of definitions) insertStorageRecord(storage.db, 'habits', { id, userId: 'owner', data: habitData(condition, behavior, law.hash), now: `2026-07-13T00:0${definitions.findIndex((row) => row[0] === id)}:00.000Z` });

  const candidates = selectActiveSelectorSnapshot(storage.db, { userId: 'owner' });
  const embedding = fakeEmbeddingAdapter();
  const prepared = await prepareSelectorConditionVectors(storage.db, { userId: 'owner', candidates, embeddingAdapter: embedding, now: '2026-07-13T01:00:00.000Z' });
  assert.deepEqual(prepared, { prepared: 5, cached: 0, total: 5 });
  assert.equal(storage.db.prepare('SELECT COUNT(*) count FROM habit_embeddings WHERE embedding_input_version = ?').get(SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION).count, 5);
  for (const row of storage.db.prepare('SELECT habit_id, habit_row_checksum FROM habit_embeddings WHERE embedding_input_version = ? ORDER BY habit_id').all(SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION)) {
    const candidate = candidates.find((item) => item.id === row.habit_id);
    assert.equal(row.habit_row_checksum, selectorConditionIdentityChecksum(candidate.condition), 'selector cache must bind stable condition identity, not mutable whole row');
    assert.notEqual(row.habit_row_checksum, candidate.checksum);
  }
  const cached = await prepareSelectorConditionVectors(storage.db, { userId: 'owner', candidates, embeddingAdapter: embedding, now: '2026-07-13T01:01:00.000Z' });
  assert.deepEqual(cached, { prepared: 0, cached: 5, total: 5 });

  const conditionVectors = readSelectorConditionVectors(storage.db, { userId: 'owner', candidates, embeddingAdapter: embedding });
  const retrieved = retrieveSelectorCandidates({ candidates, conditionVectors, promptVector: vectors.status });
  assert.equal(retrieved[0].candidate.id, 'status');
  assert.equal(retrieved.some((item) => item.candidate.behavior.includes('concise')), true);

  const judgePrompt = buildSelectorPrompt(retrieved.map((item) => item.candidate), { prompt: 'Read /home/private and mail me at user@example.invalid: is background work done?', maxHabits: 3 });
  assert.doesNotMatch(judgePrompt, /home\/private|user@example\.invalid|Give concise|review and validation|confidence|staleness|similarity/i);
  assert.match(judgePrompt, /redacted/i);
  assert.deepEqual(parseSelectorModelOutput(judgments(['status'], ['status']), { candidateIds: ['status'], maxSelected: 3, minConfidenceBp: 7500 }), [{ id: 'status', confidence_bp: 9500 }]);
  assert.throws(() => parseSelectorModelOutput({ schema_version: 2, judgments: [] }, { candidateIds: ['status'], maxSelected: 3, minConfidenceBp: 7500 }), /coverage/i);
  assert.throws(() => parseSelectorModelOutput({ schema_version: 2, judgments: [{ id: 'status', applicable: true, confidence_bp: 9500, reason: 'hypothetical_or_future' }] }, { candidateIds: ['status'], maxSelected: 3, minConfidenceBp: 7500 }), /Inconsistent/i);
  assert.throws(() => parseSelectorModelOutput({ schema_version: 2, judgments: [{ id: 'status', applicable: false, confidence_bp: 7000, reason: 'not_currently_relevant' }] }, { candidateIds: ['status'], maxSelected: 3, minConfidenceBp: 7500 }), /confidence/i);

  const config = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, selector_enabled: true, selector_min_confidence_bp: 7500, selector_max_habits: 3, selector_staleness_max: 0.8 };
  let judgeCalls = 0;
  const statusResult = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Is the background task complete?', config, law, now: '2026-07-13T02:00:00.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds, prompt }) { judgeCalls += 1; assert.doesNotMatch(prompt, /Give concise evidence-backed status/); return judgments(candidateIds, ['status']); } },
  });
  assert.equal(statusResult.injected, true);
  assert.equal(statusResult.mode, 'vector_judge');
  assert.match(statusResult.message, /Give concise evidence-backed status/);
  assert.equal(judgeCalls, 1);

  const russian = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Завершилась ли фоновая задача?', config, law, now: '2026-07-13T02:01:00.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds }) { return judgments(candidateIds, ['status']); } },
  });
  assert.equal(russian.injected, true, 'multilingual prompt must reach condition-vector retrieval and judge');

  for (const [prompt, selectedId, now] of [
    ['Implement and validate the vector selector across the package code and tests.', 'code', '2026-07-13T02:01:10.000Z'],
    ['Tag and verify the package release now.', 'release', '2026-07-13T02:01:20.000Z'],
    ['I need your decision now: should we use vectors or lexical matching?', 'decision', '2026-07-13T02:01:30.000Z'],
    ["Now, let's plan a vacation for the next summer.", 'vacation', '2026-07-13T02:01:40.000Z'],
  ]) {
    const positive = await runSelectorRuntime(storage.db, {
      userId: 'owner', prompt, config, law, now, embeddingAdapter: embedding,
      adapter: { async select({ candidateIds }) { assert.ok(candidateIds.includes(selectedId)); return judgments(candidateIds, [selectedId]); } },
    });
    assert.equal(positive.injected, true, `${selectedId} true positive must pass vector retrieval and strict judge`);
  }

  for (const [prompt, now] of [
    ['does it take a lot of code?', '2026-07-13T02:02:00.000Z'],
    ['coder is working now, and later we will turn this into an actual agent package', '2026-07-13T02:03:00.000Z'],
    ['If I ask you next year to plan a summer vacation, what would happen?', '2026-07-13T02:03:10.000Z'],
  ]) {
    const rejected = await runSelectorRuntime(storage.db, {
      userId: 'owner', prompt, config, law, now, embeddingAdapter: embedding,
      adapter: { async select({ candidateIds }) { return judgments(candidateIds); } },
    });
    assert.equal(rejected.injected, false);
    assert.equal(rejected.reason, 'empty_selection');
  }
  const belowFloor = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'because this is complete bullshit.', config, law, now: '2026-07-13T02:04:00.000Z', embeddingAdapter: { ...embedding, async embed() { return [vectors.unrelated]; } },
    adapter: { async select() { throw new Error('judge must not run below vector floor'); } },
  });
  assert.equal(belowFloor.injected, false);
  assert.equal(belowFloor.reason, 'no_vector_candidates');

  const logs = JSON.stringify(storage.db.prepare('SELECT prompt_hash, data_json FROM selector_hit_log ORDER BY created_at').all());
  assert.doesNotMatch(logs, /background task|фонов|take a lot|agent package|complete bullshit|similarity|current_applicability|9500/);
  assert.match(logs, /omitted/);

  storage.db.prepare('DELETE FROM habit_embeddings WHERE habit_id = ? AND embedding_input_version = ?').run('decision', SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION);
  let missingJudgeCalls = 0;
  const missing = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Should we use vectors?', config, law, now: '2026-07-13T02:05:00.000Z', embeddingAdapter: embedding,
    adapter: { async select() { missingJudgeCalls += 1; return {}; } },
  });
  assert.equal(missing.injected, false);
  assert.equal(missing.reason, 'selector_vectors_unavailable');
  assert.equal(missingJudgeCalls, 0, 'missing any eligible vector must fail before judge');
  await prepareSelectorConditionVectors(storage.db, { userId: 'owner', candidates, embeddingAdapter: embedding, now: '2026-07-13T02:06:00.000Z' });
  storage.db.prepare('UPDATE habit_embeddings SET vector_checksum = ? WHERE habit_id = ? AND embedding_input_version = ?').run('f'.repeat(64), 'status', SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION);
  const corruptCache = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'status?', config, law, now: '2026-07-13T02:06:01.000Z', embeddingAdapter: embedding, adapter: { async select() { throw new Error('corrupt cache must fail before judge'); } } });
  assert.equal(corruptCache.injected, false);
  assert.equal(corruptCache.reason, 'selector_vectors_unavailable');
  await prepareSelectorConditionVectors(storage.db, { userId: 'owner', candidates, embeddingAdapter: embedding, now: '2026-07-13T02:06:02.000Z' });

  const maintenanceConfig = { ...config, selector_enabled: true };
  storage.db.prepare('DELETE FROM habit_embeddings WHERE habit_id = ? AND embedding_input_version = ?').run('release', SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION);
  const maintained = await prepareActiveSelectorVectorsAfterChange(storage.db, { root: join(temp, 'state'), userId: 'owner', config: maintenanceConfig, now: '2026-07-13T02:06:03.000Z', embeddingAdapter: embedding });
  assert.equal(maintained.ready, true);
  assert.equal(maintained.prepared, 1, 'post-activation maintenance must repair only missing active condition vectors');
  storage.db.prepare('DELETE FROM habit_embeddings WHERE habit_id = ? AND embedding_input_version = ?').run('release', SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION);
  const maintenanceFailed = await prepareActiveSelectorVectorsAfterChange(storage.db, { root: join(temp, 'state'), userId: 'owner', config: maintenanceConfig, now: '2026-07-13T02:06:04.000Z', embeddingAdapter: { ...embedding, async embed() { throw new Error('fixture failure'); } } });
  assert.equal(maintenanceFailed.ready, false);
  assert.equal(storage.db.prepare('SELECT status FROM habits WHERE id = ?').get('release').status, 'active', 'selector-vector maintenance failure must never roll back approved habit state');
  await prepareSelectorConditionVectors(storage.db, { userId: 'owner', candidates, embeddingAdapter: embedding, now: '2026-07-13T02:06:05.000Z' });

  const before = storage.db.prepare('SELECT * FROM habits WHERE id = ?').get('status');
  const drifted = buildTypedStorageRow('habits', { id: before.id, userId: before.user_id, data: { ...JSON.parse(before.data_json), record_kind: before.record_kind, schema_version: before.schema_version, status: before.status, habit_id: before.habit_id, condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, activation: before.activation, staleness: before.staleness + 0.01 }, createdAt: before.created_at, updatedAt: '2026-07-13T02:07:00.000Z' });
  const drift = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Is the background task complete?', config, law, now: '2026-07-13T02:07:01.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds }) {
      storage.db.prepare('UPDATE habits SET staleness=?, checksum=?, updated_at=? WHERE id=?').run(drifted.staleness, drifted.checksum, drifted.updated_at, 'status');
      return judgments(candidateIds, ['status']);
    } },
  });
  assert.equal(drift.injected, false);
  assert.equal(drift.reason, 'selector_snapshot_changed');

  const cancelledController = new AbortController();
  cancelledController.abort(new Error('cancel now'));
  const cancelled = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'status?', config, law, now: '2026-07-13T02:08:00.000Z', embeddingAdapter: embedding, adapter: { async select() { return {}; } }, signal: cancelledController.signal });
  assert.equal(cancelled.injected, false);
  assert.equal(cancelled.reason, 'selector_cancelled');

  assert.throws(() => retrieveSelectorCandidates({ candidates: Array.from({ length: MAX_SELECTOR_ELIGIBLE_HABITS + 1 }, (_, index) => ({ ...candidates[0], id: `x-${index}` })), conditionVectors: new Map(), promptVector: vectors.status }), /limit/);
} finally {
  storage.db.close();
  await rm(temp, { recursive: true, force: true });
}

console.log('agent-experience phase19 vector selector checks passed');
