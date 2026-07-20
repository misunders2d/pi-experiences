#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { lawSnapshotForTest } from '../extensions/agent-experience/src/review.ts';
import {
  buildSelectorPrompt,
  capSelectorCandidatesToBound,
  filterEligibleSelectorCandidates,
  parseSelectorModelOutput,
  runSelectorRuntime,
  selectActiveSelectorSnapshot,
} from '../extensions/agent-experience/src/selector.ts';
import {
  MAX_SELECTOR_ELIGIBLE_HABITS,
  MAX_SELECTOR_PREPARED_HABITS,
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
    schema_version: 3,
    judgments: candidateIds.map((id) => selected.has(id)
      ? { id, applicable: true, confidence_bp: 9500, reason: 'current_applicability' }
      : { id, applicable: false, confidence_bp: 9500, reason: 'not_currently_relevant' }),
  };
}

const conditionPatternByOriginalId = {
  status: /status\/progress/i,
  code: /nontrivial code changes/i,
  release: /package release/i,
  decision: /decision, approval/i,
  vacation: /summer vacation/i,
};

function aliasForOriginalId(prompt, originalId) {
  const pattern = conditionPatternByOriginalId[originalId];
  assert.ok(pattern, `missing condition pattern for ${originalId}`);
  const match = JSON.parse(prompt).candidates.find((candidate) => pattern.test(candidate.condition));
  assert.ok(match, `expected aliased candidate for ${originalId}`);
  assert.match(match.id, /^c[1-9][0-9]*$/);
  return match.id;
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
  assert.throws(() => parseSelectorModelOutput({ schema_version: 2, judgments: [{ id: 'status', applicable: true, confidence_bp: 9500, reason: 'current_applicability' }] }, { candidateIds: ['status'], maxSelected: 3, minConfidenceBp: 7500 }), /schema version/i, 'schema-v2 judge output must fail closed after schema-v3 migration');
  assert.throws(() => parseSelectorModelOutput({ schema_version: 3, judgments: [] }, { candidateIds: ['status'], maxSelected: 3, minConfidenceBp: 7500 }), /coverage/i);
  assert.throws(() => parseSelectorModelOutput({ schema_version: 3, judgments: [{ id: 'status', applicable: true, confidence_bp: 9500, reason: 'hypothetical_or_future' }] }, { candidateIds: ['status'], maxSelected: 3, minConfidenceBp: 7500 }), /Inconsistent/i);
  // A structurally valid non-applicable judgment below threshold is a valid rejection, not a batch-vetoing error.
  assert.deepEqual(parseSelectorModelOutput({ schema_version: 3, judgments: [{ id: 'status', applicable: false, confidence_bp: 7000, reason: 'not_currently_relevant' }] }, { candidateIds: ['status'], maxSelected: 3, minConfidenceBp: 7500 }), []);
  // meta_discussion is an accepted non-applicable reason (talking ABOUT the trigger, not triggering it).
  assert.deepEqual(parseSelectorModelOutput({ schema_version: 3, judgments: [{ id: 'status', applicable: false, confidence_bp: 9500, reason: 'meta_discussion' }] }, { candidateIds: ['status'], maxSelected: 3, minConfidenceBp: 7500 }), []);
  // applicable=true with meta_discussion is inconsistent and still fails closed.
  assert.throws(() => parseSelectorModelOutput({ schema_version: 3, judgments: [{ id: 'status', applicable: true, confidence_bp: 9500, reason: 'meta_discussion' }] }, { candidateIds: ['status'], maxSelected: 3, minConfidenceBp: 7500 }), /Inconsistent/i);
  // Structural confidence problems (out of range, non-integer) still fail closed.
  assert.throws(() => parseSelectorModelOutput({ schema_version: 3, judgments: [{ id: 'status', applicable: true, confidence_bp: 10001, reason: 'current_applicability' }] }, { candidateIds: ['status'], maxSelected: 3, minConfidenceBp: 7500 }), /confidence/i);
  assert.throws(() => parseSelectorModelOutput({ schema_version: 3, judgments: [{ id: 'status', applicable: true, confidence_bp: 8000.5, reason: 'current_applicability' }] }, { candidateIds: ['status'], maxSelected: 3, minConfidenceBp: 7500 }), /confidence/i);
  // Per-candidate isolation: one low-confidence judgment must not veto a confident applicable one in the same batch.
  assert.deepEqual(parseSelectorModelOutput({ schema_version: 3, judgments: [
    { id: 'status', applicable: true, confidence_bp: 9500, reason: 'current_applicability' },
    { id: 'code', applicable: false, confidence_bp: 3000, reason: 'not_currently_relevant' },
  ] }, { candidateIds: ['status', 'code'], maxSelected: 3, minConfidenceBp: 7500 }), [{ id: 'status', confidence_bp: 9500 }]);
  // A below-threshold APPLICABLE judgment is simply not selected, not an error, and does not veto others.
  assert.deepEqual(parseSelectorModelOutput({ schema_version: 3, judgments: [
    { id: 'status', applicable: true, confidence_bp: 9500, reason: 'current_applicability' },
    { id: 'code', applicable: true, confidence_bp: 6000, reason: 'current_applicability' },
  ] }, { candidateIds: ['status', 'code'], maxSelected: 3, minConfidenceBp: 7500 }), [{ id: 'status', confidence_bp: 9500 }]);

  const config = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, selector_enabled: true, selector_min_confidence_bp: 7500, selector_max_habits: 3, selector_staleness_max: 0.8 };
  let judgeCalls = 0;
  const statusResult = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Is the background task complete?', config, law, now: '2026-07-13T02:00:00.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds, prompt }) { judgeCalls += 1; assert.doesNotMatch(prompt, /Give concise evidence-backed status|"status"/); return judgments(candidateIds, [aliasForOriginalId(prompt, 'status')]); } },
  });
  assert.equal(statusResult.injected, true);
  assert.equal(statusResult.mode, 'vector_judge');
  assert.match(statusResult.message, /Give concise evidence-backed status/);
  assert.equal(judgeCalls, 1);

  // Judge-missteering regression — FAITHFUL-JUDGE SIMULATION, prompt/protocol-layer ONLY.
  // The real message discussed steering and quoted "check" as a false trigger, yet the
  // status habit was injected. These cases drive the REAL runSelectorRuntime +
  // buildSelectorPrompt + parser pipeline, with retrieval forced to nominate the status
  // habit (as real embeddings did) so the MANDATORY judge is the decision point. The
  // adapter here PLAYS a faithful judge; model-level judge precision is deliberately NOT
  // asserted and is kept outside release claims. The precision evidence is the maintainer's
  // out-of-band real configured-model probe (original 8-case set 8/8; expanded set 18/18),
  // recorded in extensions/agent-experience/VALIDATION.md, not this simulation.
  const statusConditionPattern = /status\/progress or checks whether background work/i;
  const forceStatusEmbedding = { ...embedding, async embed(texts, opts = {}) { if (opts.signal?.aborted) throw opts.signal.reason || new Error('aborted'); return texts.map(() => vectors.status); } };
  const falsePositiveMessage = 'did he suggest anything that will improve the quality of steering? i\'m not satisfied now, looks like it\'s only matching keywords. whenever I say "check" it applies irrelevant steering';
  const judgeMissteeringCases = [
    { name: 'defect-false-positive', prompt: falsePositiveMessage, expect: false },
    { name: 'quoted-check-trigger', prompt: "The word 'check' keeps triggering my status habit.", expect: false },
    { name: 'explain-activation', prompt: 'Explain why checking code activates this habit.', expect: false },
    { name: 'review-selector-diff', prompt: 'Review this selector diff for false positives.', expect: false },
    { name: 'hypothetical-future', prompt: 'If I ask you to check task status later, what happens?', expect: false },
    // Mixed-intent: metalinguistic discussion AND an explicit present action must SELECT.
    { name: 'mixed-meta-plus-action', prompt: 'Explain why the status habit fired, and also check whether the background job is complete.', expect: true },
    { name: 'check-background-complete', prompt: 'Check whether the background job is complete.', expect: true },
    { name: 'current-progress', prompt: 'What is the current progress of the deployment?', expect: true },
    { name: 'done-or-blocked', prompt: 'Is that task done or blocked?', expect: true },
    { name: 'yes-check-that-context', prompt: 'Yes, check that', expect: true, contextTurns: [{ role: 'assistant', text: 'I am checking whether the background job is complete.' }] },
  ];
  // The exact false-positive request text must reach the judge payload verbatim.
  const falsePositivePayload = JSON.parse(buildSelectorPrompt([candidates.find((item) => item.id === 'status')], { prompt: falsePositiveMessage, maxHabits: 3 }));
  assert.match(falsePositivePayload.current_user_request, /whenever I say .*check.* it applies irrelevant steering/i, 'buildSelectorPrompt must carry the exact false-positive request text to the judge');
  let caseIndex = 0;
  for (const testCase of judgeMissteeringCases) {
    caseIndex += 1;
    let judgeSawStatusCondition = false;
    const result = await runSelectorRuntime(storage.db, {
      userId: 'owner', prompt: testCase.prompt, contextTurns: testCase.contextTurns, config, law,
      now: `2026-07-13T07:${String(caseIndex).padStart(2, '0')}:00.000Z`, embeddingAdapter: forceStatusEmbedding,
      adapter: { async select({ candidateIds, prompt }) {
        const payload = JSON.parse(prompt);
        const statusAlias = payload.candidates.find((candidate) => statusConditionPattern.test(candidate.condition))?.id;
        judgeSawStatusCondition = Boolean(statusAlias);
        // Faithful judge: select the status habit only for a genuine current status request.
        return judgments(candidateIds, testCase.expect && statusAlias ? [statusAlias] : []);
      } },
    });
    assert.ok(judgeSawStatusCondition, `${testCase.name}: mandatory judge must receive the real status condition`);
    assert.equal(result.injected, testCase.expect, `${testCase.name}: injection must match the faithful judge decision`);
  }

  const russian = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Завершилась ли фоновая задача?', config, law, now: '2026-07-13T02:01:00.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds, prompt }) { return judgments(candidateIds, [aliasForOriginalId(prompt, 'status')]); } },
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
      adapter: { async select({ candidateIds, prompt: judgePrompt }) { const alias = aliasForOriginalId(judgePrompt, selectedId); assert.ok(candidateIds.includes(alias)); return judgments(candidateIds, [alias]); } },
    });
    assert.equal(positive.injected, true, `${selectedId} true positive must pass vector retrieval and strict judge`);
  }

  const multiCandidate = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'agent package', config, law, now: '2026-07-13T02:01:50.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds, prompt }) {
      const codeAlias = aliasForOriginalId(prompt, 'code');
      assert.ok(candidateIds.includes(aliasForOriginalId(prompt, 'release')));
      return judgments(candidateIds, [codeAlias]);
    } },
  });
  assert.equal(multiCandidate.injected, true);
  const multiCandidateLogs = storage.db.prepare('SELECT action, habit_id FROM selector_hit_log WHERE created_at = ? ORDER BY action, habit_id').all('2026-07-13T02:01:50.000Z').map((row) => ({ action: row.action, habit_id: row.habit_id }));
  assert.deepEqual(multiCandidateLogs, [{ action: 'inject', habit_id: 'code' }, { action: 'skip', habit_id: 'release' }], 'selected and skipped logs must use restored original habit ids');
  assert.equal(multiCandidateLogs.some((row) => /^c[1-9][0-9]*$/.test(row.habit_id)), false);

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
  const maintained = await prepareActiveSelectorVectorsAfterChange(storage.db, { root: join(temp, 'state'), userId: 'owner', config: maintenanceConfig, now: '2026-07-13T02:06:03.000Z', embeddingAdapter: embedding, law });
  assert.equal(maintained.ready, true);
  assert.equal(maintained.prepared, 1, 'post-activation maintenance must repair only missing active condition vectors');
  storage.db.prepare('DELETE FROM habit_embeddings WHERE habit_id = ? AND embedding_input_version = ?').run('release', SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION);
  const maintenanceFailed = await prepareActiveSelectorVectorsAfterChange(storage.db, { root: join(temp, 'state'), userId: 'owner', config: maintenanceConfig, now: '2026-07-13T02:06:04.000Z', embeddingAdapter: { ...embedding, async embed() { throw new Error('fixture failure'); } }, law });
  assert.equal(maintenanceFailed.ready, false);
  assert.equal(storage.db.prepare('SELECT status FROM habits WHERE id = ?').get('release').status, 'active', 'selector-vector maintenance failure must never roll back approved habit state');
  await prepareSelectorConditionVectors(storage.db, { userId: 'owner', candidates, embeddingAdapter: embedding, now: '2026-07-13T02:06:05.000Z' });

  const before = storage.db.prepare('SELECT * FROM habits WHERE id = ?').get('status');
  const drifted = buildTypedStorageRow('habits', { id: before.id, userId: before.user_id, data: { ...JSON.parse(before.data_json), record_kind: before.record_kind, schema_version: before.schema_version, status: before.status, habit_id: before.habit_id, condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, activation: before.activation, staleness: before.staleness + 0.01 }, createdAt: before.created_at, updatedAt: '2026-07-13T02:07:00.000Z' });
  const drift = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Is the background task complete?', config, law, now: '2026-07-13T02:07:01.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds, prompt }) {
      storage.db.prepare('UPDATE habits SET staleness=?, checksum=?, updated_at=? WHERE id=?').run(drifted.staleness, drifted.checksum, drifted.updated_at, 'status');
      return judgments(candidateIds, [aliasForOriginalId(prompt, 'status')]);
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

  // A collection larger than the hard bound no longer disables steering. Runtime
  // deterministically caps to the top MAX_SELECTOR_ELIGIBLE_HABITS eligible
  // candidates and still reaches the judge instead of failing on the old cliff.
  for (let index = 0; index < MAX_SELECTOR_ELIGIBLE_HABITS + 5; index += 1) {
    const id = `overflow-${String(index).padStart(3, '0')}`;
    insertStorageRecord(storage.db, 'habits', { id, userId: 'overflow-user', data: habitData(`When status check number ${index} is requested`, `Give status answer ${index}.`, law.hash), now: `2026-07-13T05:00:${String(index % 60).padStart(2, '0')}.000Z` });
  }
  const overflowActive = selectActiveSelectorSnapshot(storage.db, { userId: 'overflow-user' });
  assert.equal(overflowActive.length, MAX_SELECTOR_ELIGIBLE_HABITS + 5);
  const overflowEligible = capSelectorCandidatesToBound(filterEligibleSelectorCandidates(overflowActive, { minConfidenceBp: 7500, stalenessMax: 0.8 }));
  assert.equal(overflowEligible.length, MAX_SELECTOR_ELIGIBLE_HABITS, 'runtime cap must bound the eligible set to the hard limit');
  await prepareSelectorConditionVectors(storage.db, { userId: 'overflow-user', candidates: overflowEligible, embeddingAdapter: embedding, now: '2026-07-13T05:10:00.000Z' });
  let overflowJudgeSaw = 0;
  const overflowResult = await runSelectorRuntime(storage.db, {
    userId: 'overflow-user', prompt: 'overflow status now', config, law, now: '2026-07-13T05:11:00.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds }) { overflowJudgeSaw = candidateIds.length; return judgments(candidateIds); } },
  });
  assert.notEqual(overflowResult.reason, 'selector_vectors_unavailable', 'a large eligible set must not fail closed on the old 100-habit cliff');
  assert.equal(overflowResult.injected, false);
  assert.equal(overflowResult.reason, 'empty_selection');
  assert.ok(overflowJudgeSaw >= 1 && overflowJudgeSaw <= 12, 'retrieval still bounds the judge candidate set');

  // BLOCKER-3: with more than MAX_SELECTOR_PREPARED_HABITS active-eligible habits
  // where the highest-confidence ones are law-stale, a rank-only prepared superset
  // would miss the ENTIRE law-fresh runtime top-100 and permanently fail closed.
  // Preparation must EXPLICITLY include the current-law runtime top-100. Exercise the
  // real maintenance prep path with the same law snapshot the runtime uses.
  const staleLaw = 'stalelaw'.repeat(8);
  for (let index = 0; index < MAX_SELECTOR_PREPARED_HABITS; index += 1) {
    insertStorageRecord(storage.db, 'habits', { id: `supstale-${String(index).padStart(4, '0')}`, userId: 'superset-user', data: { ...habitData(`When status stale check ${index} runs`, `Answer stale ${index}.`, staleLaw), confidence_bp: 9500 }, now: '2026-07-13T06:00:00.000Z' });
  }
  for (let index = 0; index < 100; index += 1) {
    insertStorageRecord(storage.db, 'habits', { id: `supfresh-${String(index).padStart(4, '0')}`, userId: 'superset-user', data: { ...habitData(`When status fresh check ${index} runs`, `Answer fresh ${index}.`, law.hash), confidence_bp: 9000 }, now: '2026-07-13T06:10:00.000Z' });
  }
  assert.equal(selectActiveSelectorSnapshot(storage.db, { userId: 'superset-user' }).length, MAX_SELECTOR_PREPARED_HABITS + 100);
  const supersetPrep = await prepareActiveSelectorVectorsAfterChange(storage.db, { root: join(temp, 'state'), userId: 'superset-user', config: { ...config, selector_enabled: true }, now: '2026-07-13T06:20:00.000Z', embeddingAdapter: embedding, law });
  assert.equal(supersetPrep.ready, true);
  assert.equal(supersetPrep.total, MAX_SELECTOR_PREPARED_HABITS, 'prep must include the current-law runtime top-100 plus a buffer, capped at the prepared bound');
  const supersetResult = await runSelectorRuntime(storage.db, {
    userId: 'superset-user', prompt: 'status now please', config, law, now: '2026-07-13T06:21:00.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds }) { return judgments(candidateIds, [candidateIds[0]]); } },
  });
  assert.notEqual(supersetResult.reason, 'selector_vectors_unavailable', 'law-fresh runtime candidates must have prepared vectors even when 500 higher-confidence habits are law-stale');
  assert.equal(supersetResult.injected, true, 'runtime must still inject when >500 active-eligible habits exist and the highest-confidence 500 are law-stale');
} finally {
  storage.db.close();
  await rm(temp, { recursive: true, force: true });
}

console.log('agent-experience phase19 vector selector checks passed');
