#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTypedStorageRow, initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { checksumJson } from '../extensions/agent-experience/src/storage/checksum.ts';
import { ensurePrivateRoot } from '../extensions/agent-experience/src/storage/private-root.ts';
import { embeddingInputChecksum, habitBehaviorEmbeddingInputV1, habitConditionEmbeddingInputV1, habitEmbeddingInputV1, cosineBp, normalizedVector, SEMANTIC_CONDITION_EMBEDDING_INPUT_VERSION, SEMANTIC_EMBEDDING_INPUT_VERSION } from '../extensions/agent-experience/src/semantic/core.ts';
import { getCachedHabitEmbedding, getKeptSeparateDuplicate, listHabitDuplicates, upsertCachedHabitEmbedding } from '../extensions/agent-experience/src/semantic/storage.ts';
import { checkSemanticActivationGate, reconcileSemanticDuplicateThresholds, sanitizePolicy, scanAndBackfillSemanticDuplicates } from '../extensions/agent-experience/src/semantic/service.ts';
import { consolidateProposalBatch } from '../extensions/agent-experience/src/consolidate/commit.ts';
import { runConsolidationOnce } from '../extensions/agent-experience/src/consolidate/runner.ts';
import { acceptCandidateHabit, archiveHideHabit, lawSnapshotForTest, listApprovedHabitsForSetup, listPendingReviewItems, planHabitDuplicateResolution, readConfiguredLawSnapshot, resolveHabitDuplicate } from '../extensions/agent-experience/src/review.ts';
import { promoteApprovedPendingCandidates, selectActiveSelectorSnapshot } from '../extensions/agent-experience/src/selector.ts';

for (const file of ['core.ts', 'service.ts', 'storage.ts', 'types.ts']) {
  const text = await readFile(new URL(`../extensions/agent-experience/src/semantic/${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(text, /@earendil-works\/pi-|pi-tui|ExtensionCommandContext|\.\.\/\.\.\//, `semantic core file ${file} must stay host-agnostic`);
}

const c = 0.8048647766597806;
const s = Math.sqrt(1 - c * c);
const v2 = normalizedVector(Float32Array.from([1, 0]));
const v3 = normalizedVector(Float32Array.from([c, s]));
const conditionCosine = 0.9;
const v3Condition = normalizedVector(Float32Array.from([conditionCosine, Math.sqrt(1 - conditionCosine * conditionCosine)]));
assert.equal(cosineBp(v2, v3), 8048, 'behavior #2/#3 cosine must truncate to 8048bp');
assert.equal(cosineBp(v2, v3Condition), 8999, 'condition #2/#3 cosine must remain above behavior score');

const habit2 = {
  condition: 'When designing or fixing user-facing setup/control UX',
  behavior: 'Make the main setup/control command the complete normal-user surface for all relevant settings and actions; keep direct subcommands only as advanced shortcuts.',
};
const habit3 = {
  condition: 'When exposing configuration and actions for user-level operational features.',
  behavior: 'Make one canonical setup command/menu the default control surface for all standard tasks; keep extra subcommands as optional advanced shortcuts and avoid requiring users to hunt through hidden commands.',
};
assert.equal(habitEmbeddingInputV1({ ...habit2, evidence_summary: 'POISON' }), habitEmbeddingInputV1(habit2), 'embedding input must ignore residual/evidence-like fields');
assert.equal(habitEmbeddingInputV1(habit2), `${habit2.condition.toLowerCase()}\n${habit2.behavior.toLowerCase()}`);

const policy = { enabled: true, provider: 'fixture', model: 'fixture-2d', dimensions: 2, reviewThresholdBp: 7500, strongThresholdBp: 8500, timeoutMs: 1000 };
assert.equal(sanitizePolicy({ ...policy, reviewThresholdBp: 9000, strongThresholdBp: 8000 }).strongThresholdBp, 9000, 'strong threshold must never fall below review threshold');
assert.equal(sanitizePolicy({ ...policy, reviewThresholdBp: 0, strongThresholdBp: 0 }).reviewThresholdBp, 0, 'explicit zero review threshold must be preserved');
const provider = {
  id: 'fixture:fixture-2d:2',
  provider: 'fixture',
  model: 'fixture-2d',
  dimensions: 2,
  async embed(texts) {
    return texts.map((text) => {
      if (text === habitConditionEmbeddingInputV1(habit2) || text === habitBehaviorEmbeddingInputV1(habit2)) return v2;
      if (text === habitConditionEmbeddingInputV1(habit3)) return v3Condition;
      if (text === habitBehaviorEmbeddingInputV1(habit3)) return v3;
      return normalizedVector(Float32Array.from([0, 1]));
    });
  },
};
const unavailableProvider = { ...provider, async embed() { throw new Error('fixture provider down'); } };

function refs(prefix = 'a') {
  return [1, 2, 3].map((seq) => ({ file_generation: 'active', seq, checksum: String(prefix).slice(0, 1).repeat(63) + String(seq) }));
}
function dates() { return ['2026-07-07T01:00:00.000Z', '2026-07-07T02:00:00.000Z', '2026-07-08T01:00:00.000Z']; }
function habitData(overrides = {}) {
  return { schema_version: 2, record_kind: 'candidate_habit_v1', status: 'candidate', active: false, injectable: false, condition: 'When x', behavior: 'Do y', polarity: 1, confidence_bp: 9000, source_refs: refs(), source_dates: dates(), ...overrides };
}
function observations(prefix = 'b') {
  return refs(prefix).map((ref, index) => ({ id: `obs-${prefix}-${index + 1}`, user_id: 'owner', file_generation: ref.file_generation, seq: ref.seq, checksum: ref.checksum, created_at: dates()[index] }));
}
function proposalBatch(proposal) {
  return { schema_version: 1, user_id: 'owner', batch_id: 'semantic-batch', created_at: '2026-07-09T01:00:00.000Z', proposals: [proposal] };
}
function rewriteDuplicateRow(db, relation, overrides = {}) {
  const row = {
    user_id: relation.user_id,
    pair_key: relation.pair_key,
    habit_a: relation.habit_a,
    habit_b: relation.habit_b,
    canonical_habit_id: relation.canonical_habit_id ?? null,
    duplicate_habit_id: relation.duplicate_habit_id ?? null,
    similarity_bp: Number(relation.similarity_bp),
    threshold_bp: Number(relation.threshold_bp),
    method: relation.method,
    provider: relation.provider ?? null,
    model: relation.model ?? null,
    dimensions: relation.dimensions === null ? null : Number(relation.dimensions),
    decision: relation.decision,
    data_json: relation.data_json,
    created_at: relation.created_at,
    updated_at: relation.updated_at,
    decided_at: relation.decided_at ?? null,
    ...overrides,
  };
  const checksum = checksumJson({ table: 'habit_duplicates', row });
  const changed = db.prepare('UPDATE habit_duplicates SET method=?, decision=?, data_json=?, checksum=?, updated_at=?, decided_at=? WHERE id=? AND checksum=?')
    .run(row.method, row.decision, row.data_json, checksum, row.updated_at, row.decided_at, relation.id, relation.checksum);
  assert.equal(changed.changes, 1, 'test relation rewrite must use current checksum');
  return db.prepare('SELECT * FROM habit_duplicates WHERE id=?').get(relation.id);
}
function replaceHabitWording(db, habitId, overrides, now) {
  const before = db.prepare('SELECT * FROM habits WHERE id=?').get(habitId);
  const data = { ...JSON.parse(before.data_json), record_kind: before.record_kind, schema_version: before.schema_version, status: before.status, habit_id: before.habit_id, condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, activation: before.activation, staleness: before.staleness, ...overrides };
  const row = buildTypedStorageRow('habits', { id: before.id, userId: before.user_id, data, createdAt: before.created_at, updatedAt: now });
  const changed = db.prepare('UPDATE habits SET record_kind=?,schema_version=?,status=?,habit_id=?,condition=?,behavior=?,polarity=?,confidence_bp=?,activation=?,staleness=?,data_json=?,checksum=?,updated_at=? WHERE id=? AND checksum=?')
    .run(row.record_kind,row.schema_version,row.status,row.habit_id,row.condition,row.behavior,row.polarity,row.confidence_bp,row.activation,row.staleness,row.data_json,row.checksum,row.updated_at,before.id,before.checksum);
  assert.equal(changed.changes, 1, 'test habit wording rewrite must use current checksum');
  return db.prepare('SELECT * FROM habits WHERE id=?').get(habitId);
}
const proposal2 = { proposal_id: 'p2', kind: 'habit_candidate', candidate_key: 'setup-surface-a', ...habit2, polarity: 1, confidence_bp: 9000, source_refs: refs('b'), evidence_summary: 'three examples', ambiguous: false };
const proposal3 = { proposal_id: 'p3', kind: 'habit_candidate', candidate_key: 'setup-surface-b', ...habit3, polarity: 1, confidence_bp: 9000, source_refs: refs('b'), evidence_summary: 'three examples', ambiguous: false };

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-semantic-'));
const root = await ensurePrivateRoot(join(temp, 'state'));
const storage = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
try {
  assert.equal(storage.db.prepare('PRAGMA user_version').get().user_version, 6);
  assert.ok(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='habit_embeddings'").get());
  assert.ok(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='habit_duplicates'").get());

  const active2 = insertStorageRecord(storage.db, 'habits', { id: 'habit-2', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-07T00:00:00.000Z' });
  const result = await consolidateProposalBatch({ db: storage.db, userId: 'owner', proposalBatch: proposalBatch(proposal3), observations: observations(), semantic: { policy, provider } });
  assert.equal(result.inserted.candidates, 1);
  const candidate = storage.db.prepare("SELECT id, status, data_json FROM habits WHERE id <> 'habit-2'").get();
  assert.equal(candidate.status, 'candidate');
  assert.equal(JSON.parse(candidate.data_json).review_status, 'duplicate_resolution', 'semantic duplicate proposal must not be normal review');
  assert.equal(listPendingReviewItems(storage.db, { userId: 'owner' }).items.some((item) => item.id === candidate.id), false, 'duplicate-resolution candidate hidden from normal suggestions');
  const routedEvidence = storage.db.prepare('SELECT habit_id FROM evidence WHERE user_id = ? ORDER BY id').get('owner').habit_id;
  assert.notEqual(routedEvidence, 'habit-2', 'duplicate proposal evidence must stay on pending duplicate until human resolution');
  const canonicalAfterRoute = storage.db.prepare("SELECT condition, behavior, data_json FROM habits WHERE id = 'habit-2'").get();
  assert.equal(canonicalAfterRoute.condition, habit2.condition, 'duplicate proposal routing must not rewrite canonical habit wording before user resolution');
  assert.equal(JSON.parse(canonicalAfterRoute.data_json).source_refs.length, 3, 'duplicate proposal routing must not silently merge canonical residual before user resolution');
  const relation = listHabitDuplicates(storage.db, { userId: 'owner', decision: 'pending' })[0];
  assert.equal(relation.similarity_bp, 8048);
  assert.equal(relation.canonical_habit_id, 'habit-2');
  assert.equal(JSON.stringify(relation).includes('0.8048647766597806'), false, 'relation stores bp metadata, not raw vector/cosine payload');
  assert.equal(JSON.parse(relation.data_json).pending_evidence_route_habit_id, 'habit-2', 'deterministic pending evidence route to canonical side is recorded for later resolution');
  assert.equal(JSON.parse(relation.data_json).scoring_method, 'habit_dedupe_field_min_v1', 'proposal relation must retain scoring-method metadata consistently');
  assert.ok(storage.db.prepare("SELECT id FROM habit_duplicate_audit WHERE action = 'proposal_duplicate_route'").get(), 'proposal-time pending evidence route must be audited');

  const cachedRow = storage.db.prepare('SELECT embedding_input_version, embedding_input_checksum FROM habit_embeddings WHERE habit_id = ? AND embedding_input_version = ?').get('habit-2', SEMANTIC_CONDITION_EMBEDDING_INPUT_VERSION);
  const cached = getCachedHabitEmbedding(storage.db, { userId: 'owner', habitId: 'habit-2', embeddingInputVersion: cachedRow.embedding_input_version, embeddingInputChecksum: cachedRow.embedding_input_checksum, habitRowChecksum: active2.checksum, provider: policy.provider, model: policy.model, dimensions: policy.dimensions });
  assert.ok(cached, 'embedding cache should be readable by exact provider/model/dim/checksum');

  const gateUnavailable = await checkSemanticActivationGate(storage.db, { userId: 'owner', targetHabitId: candidate.id, policy, provider: unavailableProvider, now: '2026-07-09T01:05:00.000Z' });
  assert.equal(gateUnavailable.pass, false);
  assert.equal(gateUnavailable.reason, 'semantic_unavailable', 'enabled semantic gate must fail closed when provider fails');

  const archiveChecksum = storage.db.prepare("SELECT checksum FROM habits WHERE id = 'habit-2'").get().checksum;
  const archive = archiveHideHabit(storage.db, { userId: 'owner', habitId: 'habit-2', checksum: archiveChecksum, now: '2026-07-09T01:06:00.000Z' });
  assert.equal(archive.status, 'archived');
  assert.equal(listApprovedHabitsForSetup(storage.db, { userId: 'owner' }).some((row) => row.id === 'habit-2'), false, 'archive/hide removes habit from approved browser');
  assert.equal(selectActiveSelectorSnapshot(storage.db, { userId: 'owner' }).some((row) => row.id === 'habit-2'), false, 'archive/hide prevents selector use');
  assert.equal(listHabitDuplicates(storage.db, { userId: 'owner', decision: 'archived_duplicate' }).length, 1, 'archive/hide resolves open duplicate relation with audit-preserving archived decision');
  assert.ok(listPendingReviewItems(storage.db, { userId: 'owner' }).items.some((item) => item.id === routedEvidence), 'archive/hide relation resolution must restore hidden candidate to normal review');

  const proposalRaceStorage = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state-proposal-race')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(proposalRaceStorage.db, 'habits', { id: 'race-active-2', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T01:10:00.000Z' });
    let changedDuringEmbedding = false;
    const raceProvider = { ...provider, async embed(texts, options) {
      const vectors = await provider.embed(texts, options);
      if (!changedDuringEmbedding) {
        replaceHabitWording(proposalRaceStorage.db, 'race-active-2', { behavior: `${habit2.behavior} Materially changed while comparison was running.` }, '2026-07-09T01:10:30.000Z');
        changedDuringEmbedding = true;
      }
      return vectors;
    } };
    await assert.rejects(() => consolidateProposalBatch({ db: proposalRaceStorage.db, userId: 'owner', proposalBatch: proposalBatch(proposal3), observations: observations(), semantic: { policy, provider: raceProvider } }), /Semantic duplicate comparison changed; retry Analyze/, 'proposal route must fail closed when matched approved wording changes before writer transaction');
    assert.equal(changedDuringEmbedding, true);
    assert.equal(proposalRaceStorage.db.prepare('SELECT COUNT(*) count FROM habits').get().count, 1, 'stale proposal comparison must not insert candidate');
    assert.equal(proposalRaceStorage.db.prepare('SELECT COUNT(*) count FROM evidence').get().count, 0, 'stale proposal comparison must not insert evidence');
    assert.equal(proposalRaceStorage.db.prepare('SELECT COUNT(*) count FROM habit_duplicates').get().count, 0, 'stale proposal comparison must not create relation with fresh wording hashes and stale score');
  } finally {
    proposalRaceStorage.db.close();
  }

  const storage2 = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state2')), { allowInit: true, userId: 'owner' });
  try {
    const c2 = insertStorageRecord(storage2.db, 'habits', { id: 'candidate-2', userId: 'owner', data: habitData({ ...habit2 }), now: '2026-07-09T02:00:00.000Z' });
    const c3 = insertStorageRecord(storage2.db, 'habits', { id: 'candidate-3', userId: 'owner', data: habitData({ ...habit3 }), now: '2026-07-09T02:01:00.000Z' });
    const law = lawSnapshotForTest('semantic law');
    const first = await acceptCandidateHabit(storage2.db, { userId: 'owner', habitId: 'candidate-2', checksum: c2.checksum, law, now: '2026-07-09T02:02:00.000Z', semantic: { policy, provider } });
    assert.equal(first.activated, true, 'first duplicate candidate may activate when no active duplicate exists yet');
    const second = await acceptCandidateHabit(storage2.db, { userId: 'owner', habitId: 'candidate-3', checksum: c3.checksum, law, now: '2026-07-09T02:03:00.000Z', semantic: { policy, provider } });
    assert.equal(second.activated, false, 'second duplicate approval must be blocked');
    assert.equal(second.semantic.reason, 'semantic_duplicate', JSON.stringify(second.semantic));
    assert.equal(listHabitDuplicates(storage2.db, { userId: 'owner', decision: 'pending' })[0].similarity_bp, 8048);
    assert.equal(listPendingReviewItems(storage2.db, { userId: 'owner' }).items.some((item) => item.id === 'candidate-3'), false, 'activation-blocked duplicate candidate must leave normal review until resolved');
  } finally {
    storage2.db.close();
  }

  const storage3 = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state3')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(storage3.db, 'habits', { id: 'active-2', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T03:00:00.000Z' });
    insertStorageRecord(storage3.db, 'habits', { id: 'active-3', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit3 }), now: '2026-07-09T03:01:00.000Z' });
    const scan = await scanAndBackfillSemanticDuplicates(storage3.db, { userId: 'owner', policy, provider, now: '2026-07-09T03:02:00.000Z' });
    assert.equal(scan.checked, 2);
    assert.equal(scan.relations[0].similarity_bp, 8048, 'backfill detects existing #2/#3 duplicate');
    const keep = resolveHabitDuplicate(storage3.db, { userId: 'owner', duplicateId: scan.relations[0].id, checksum: scan.relations[0].checksum, action: 'keep_separate', reason: 'different product context', now: '2026-07-09T03:03:00.000Z' });
    assert.equal(keep.decision, 'kept_separate');
    const kept = listHabitDuplicates(storage3.db, { userId: 'owner', decision: 'kept_separate' })[0];
    assert.match(JSON.parse(kept.data_json).resolution.reason, /different product context/, 'keep-separate decision must store a human reason');
    assert.ok(getKeptSeparateDuplicate(storage3.db, { userId: 'owner', habitId: 'active-2', otherHabitId: 'active-3', provider: 'future-provider', model: 'future-model', dimensions: 99 }), 'wording-hash keep-separate proof must survive scoring/provider method changes');
    const keptRescan = await scanAndBackfillSemanticDuplicates(storage3.db, { userId: 'owner', policy, provider, now: '2026-07-09T03:04:00.000Z' });
    assert.equal(keptRescan.relations.length, 0, 'unchanged kept-separate pair must not be proposed again');
    replaceHabitWording(storage3.db, 'active-3', { behavior: `${habit3.behavior} Changed meaning.` }, '2026-07-09T03:05:00.000Z');
    assert.equal(getKeptSeparateDuplicate(storage3.db, { userId: 'owner', habitId: 'active-2', otherHabitId: 'active-3', provider: policy.provider, model: policy.model, dimensions: policy.dimensions }), undefined, 'changed wording must invalidate kept-separate suppression');
  } finally {
    storage3.db.close();
  }

  const legacyStorage = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state-legacy-kept')), { allowInit: true, userId: 'owner' });
  try {
    const legacy2 = insertStorageRecord(legacyStorage.db, 'habits', { id: 'legacy-active-2', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T03:10:00.000Z' });
    const legacy3 = insertStorageRecord(legacyStorage.db, 'habits', { id: 'legacy-active-3', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit3 }), now: '2026-07-09T03:11:00.000Z' });
    const legacyScan = await scanAndBackfillSemanticDuplicates(legacyStorage.db, { userId: 'owner', policy, provider, now: '2026-07-09T03:12:00.000Z' });
    resolveHabitDuplicate(legacyStorage.db, { userId: 'owner', duplicateId: legacyScan.relations[0].id, checksum: legacyScan.relations[0].checksum, action: 'keep_separate', reason: 'legacy distinct contexts', now: '2026-07-09T03:13:00.000Z' });
    for (const [habit, row, vector] of [[habit2, legacy2, v2], [habit3, legacy3, v3]]) {
      const text = habitEmbeddingInputV1(habit);
      upsertCachedHabitEmbedding(legacyStorage.db, { userId: 'owner', habitId: row.id, embeddingInputVersion: SEMANTIC_EMBEDDING_INPUT_VERSION, embeddingInputChecksum: embeddingInputChecksum(text, SEMANTIC_EMBEDDING_INPUT_VERSION), habitRowChecksum: row.checksum, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, vector, now: '2026-07-09T03:14:00.000Z' });
    }
    const currentKept = listHabitDuplicates(legacyStorage.db, { userId: 'owner', decision: 'kept_separate' })[0];
    const legacyMethod = `embedding:${policy.provider}:${policy.model}:${policy.dimensions}:${SEMANTIC_EMBEDDING_INPUT_VERSION}`;
    const legacyKept = rewriteDuplicateRow(legacyStorage.db, currentKept, { method: legacyMethod, data_json: JSON.stringify({ resolution: { action: 'keep_separate', reason: 'legacy distinct contexts' } }), updated_at: '2026-07-09T03:15:00.000Z' });
    assert.ok(getKeptSeparateDuplicate(legacyStorage.db, { userId: 'owner', habitId: 'legacy-active-2', otherHabitId: 'legacy-active-3', provider: 'future-provider', model: 'future-model', dimensions: 99 }), 'valid legacy whole-input cache proof must preserve unchanged kept-separate decision');
    legacyStorage.db.prepare("UPDATE habit_embeddings SET row_checksum=? WHERE habit_id='legacy-active-2' AND embedding_input_version=?").run('0'.repeat(64), SEMANTIC_EMBEDDING_INPUT_VERSION);
    assert.equal(getKeptSeparateDuplicate(legacyStorage.db, { userId: 'owner', habitId: 'legacy-active-2', otherHabitId: 'legacy-active-3', provider: policy.provider, model: policy.model, dimensions: policy.dimensions }), undefined, 'corrupt legacy cache proof must fail closed to human re-review');
    const repaired2 = legacyStorage.db.prepare("SELECT * FROM habits WHERE id='legacy-active-2'").get();
    upsertCachedHabitEmbedding(legacyStorage.db, { userId: 'owner', habitId: repaired2.id, embeddingInputVersion: SEMANTIC_EMBEDDING_INPUT_VERSION, embeddingInputChecksum: embeddingInputChecksum(habitEmbeddingInputV1(habit2), SEMANTIC_EMBEDDING_INPUT_VERSION), habitRowChecksum: repaired2.checksum, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, vector: v2, now: '2026-07-09T03:16:00.000Z' });
    assert.ok(getKeptSeparateDuplicate(legacyStorage.db, { userId: 'owner', habitId: 'legacy-active-2', otherHabitId: 'legacy-active-3', provider: policy.provider, model: policy.model, dimensions: policy.dimensions }), 'repaired valid legacy proof must be accepted');
    replaceHabitWording(legacyStorage.db, 'legacy-active-3', { condition: `${habit3.condition} changed` }, '2026-07-09T03:17:00.000Z');
    assert.equal(getKeptSeparateDuplicate(legacyStorage.db, { userId: 'owner', habitId: 'legacy-active-2', otherHabitId: 'legacy-active-3', provider: policy.provider, model: policy.model, dimensions: policy.dimensions }), undefined, 'legacy kept-separate proof must not survive changed wording');
    assert.equal(legacyKept.method, legacyMethod);
  } finally {
    legacyStorage.db.close();
  }

  const obsoleteStorage = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state-obsolete-pending')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(obsoleteStorage.db, 'habits', { id: 'obsolete-active', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T03:20:00.000Z' });
    insertStorageRecord(obsoleteStorage.db, 'habits', { id: 'obsolete-candidate', userId: 'owner', data: habitData({ ...habit3, review_status: 'approved_pending_eligibility', approved_identity: { candidate_id: 'obsolete-candidate', condition: habit3.condition.toLowerCase(), behavior: habit3.behavior.toLowerCase(), polarity: 1, approved_at: '2026-07-09T03:19:00.000Z' } }), now: '2026-07-09T03:21:00.000Z' });
    const obsoleteScan = await scanAndBackfillSemanticDuplicates(obsoleteStorage.db, { userId: 'owner', policy, provider, statuses: ['active', 'candidate'], now: '2026-07-09T03:22:00.000Z' });
    assert.equal(JSON.parse(obsoleteStorage.db.prepare("SELECT data_json FROM habits WHERE id='obsolete-candidate'").get().data_json).review_status, 'duplicate_resolution');
    const pending = rewriteDuplicateRow(obsoleteStorage.db, obsoleteScan.relations.find((row) => row.habit_a === 'obsolete-candidate' || row.habit_b === 'obsolete-candidate'), { method: `embedding:${policy.provider}:${policy.model}:${policy.dimensions}:${SEMANTIC_EMBEDDING_INPUT_VERSION}`, updated_at: '2026-07-09T03:23:00.000Z' });
    const repaired = await scanAndBackfillSemanticDuplicates(obsoleteStorage.db, { userId: 'owner', policy, provider, now: '2026-07-09T03:24:00.000Z' });
    assert.deepEqual(repaired.threshold_reconciliation.dismissed, [pending.id], 'explicit scan must transactionally dismiss obsolete pending scoring-method relation');
    assert.equal(listHabitDuplicates(obsoleteStorage.db, { userId: 'owner', decision: 'dismissed_threshold_change' }).length, 1);
    assert.equal(JSON.parse(obsoleteStorage.db.prepare("SELECT data_json FROM habits WHERE id='obsolete-candidate'").get().data_json).review_status, 'approved_pending_eligibility', 'obsolete relation cleanup must restore prior approved-waiting state');
    const cleanupAudit = obsoleteStorage.db.prepare("SELECT data_json FROM habit_duplicate_audit WHERE duplicate_id=? AND action='dismiss_semantic_policy_change'").get(pending.id);
    assert.equal(JSON.parse(cleanupAudit.data_json).reason, 'obsolete_scoring_method', 'obsolete cleanup must retain precise audit reason');
  } finally {
    obsoleteStorage.db.close();
  }

  const multiStorage = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state-multi-pending')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(multiStorage.db, 'habits', { id: 'multi-active-a', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T03:30:00.000Z' });
    insertStorageRecord(multiStorage.db, 'habits', { id: 'multi-active-b', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T03:31:00.000Z' });
    insertStorageRecord(multiStorage.db, 'habits', { id: 'multi-candidate', userId: 'owner', data: habitData({ ...habit3 }), now: '2026-07-09T03:32:00.000Z' });
    await scanAndBackfillSemanticDuplicates(multiStorage.db, { userId: 'owner', policy, provider, statuses: ['active', 'candidate'], now: '2026-07-09T03:33:00.000Z' });
    const candidateRelations = listHabitDuplicates(multiStorage.db, { userId: 'owner', decision: 'pending' }).filter((row) => row.habit_a === 'multi-candidate' || row.habit_b === 'multi-candidate').sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(candidateRelations.length, 2, 'candidate must retain both independent pending relations');
    resolveHabitDuplicate(multiStorage.db, { userId: 'owner', duplicateId: candidateRelations[0].id, checksum: candidateRelations[0].checksum, action: 'keep_separate', reason: 'first relation differs', now: '2026-07-09T03:34:00.000Z' });
    assert.equal(JSON.parse(multiStorage.db.prepare("SELECT data_json FROM habits WHERE id='multi-candidate'").get().data_json).review_status, 'duplicate_resolution', 'resolving one relation must not expose candidate while another remains pending');
    assert.equal(listPendingReviewItems(multiStorage.db, { userId: 'owner' }).items.some((item) => item.id === 'multi-candidate'), false);
    const secondCurrent = multiStorage.db.prepare('SELECT * FROM habit_duplicates WHERE id=?').get(candidateRelations[1].id);
    resolveHabitDuplicate(multiStorage.db, { userId: 'owner', duplicateId: secondCurrent.id, checksum: secondCurrent.checksum, action: 'keep_separate', reason: 'second relation differs', now: '2026-07-09T03:35:00.000Z' });
    assert.equal(JSON.parse(multiStorage.db.prepare("SELECT data_json FROM habits WHERE id='multi-candidate'").get().data_json).review_status, 'kept_separate', 'candidate may return to review only after final pending relation resolves');
    assert.ok(listPendingReviewItems(multiStorage.db, { userId: 'owner' }).items.some((item) => item.id === 'multi-candidate'));
  } finally {
    multiStorage.db.close();
  }

  const storage4 = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state4')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(storage4.db, 'habits', { id: 'active-2', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T04:00:00.000Z' });
    insertStorageRecord(storage4.db, 'habits', { id: 'active-3', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit3 }), now: '2026-07-09T04:01:00.000Z' });
    await scanAndBackfillSemanticDuplicates(storage4.db, { userId: 'owner', policy, provider, now: '2026-07-09T04:02:00.000Z' });
    const raised = { ...policy, reviewThresholdBp: 8100 };
    const threshold = reconcileSemanticDuplicateThresholds(storage4.db, { userId: 'owner', policy: raised, now: '2026-07-09T04:03:00.000Z' });
    assert.equal(threshold.dismissed.length, 1, 'raising review threshold above 8048bp dismisses pending duplicate');
    assert.equal(listHabitDuplicates(storage4.db, { userId: 'owner', decision: 'dismissed_threshold_change' }).length, 1, 'threshold-change dismissal is persisted/audited');
  } finally {
    storage4.db.close();
  }

  const storage6 = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state6')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(storage6.db, 'habits', { id: 'old-active-2', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T04:10:00.000Z' });
    insertStorageRecord(storage6.db, 'habits', { id: 'new-candidate-3', userId: 'owner', data: habitData({ ...habit3 }), now: '2026-07-09T04:11:00.000Z' });
    const scan = await scanAndBackfillSemanticDuplicates(storage6.db, { userId: 'owner', policy, provider, now: '2026-07-09T04:12:00.000Z', statuses: ['active', 'candidate'] });
    assert.equal(listPendingReviewItems(storage6.db, { userId: 'owner' }).items.some((item) => item.id === 'new-candidate-3'), false, 'scan/backfill duplicate candidate must leave normal review until resolved');
    const supersedeHabits = storage6.db.prepare("SELECT * FROM habits WHERE id IN ('old-active-2','new-candidate-3') ORDER BY id").all();
    const supersedePlan = planHabitDuplicateResolution(scan.relations[0], supersedeHabits, 'supersede');
    assert.equal(supersedePlan.survivor.id, 'new-candidate-3', 'supersede preview must identify the exact wording that resolver retains');
    assert.equal(supersedePlan.other.id, 'old-active-2', 'supersede preview must identify the exact approved habit that resolver archives');
    const supersede = resolveHabitDuplicate(storage6.db, { userId: 'owner', duplicateId: scan.relations[0].id, checksum: scan.relations[0].checksum, action: 'supersede', reason: 'new wording is clearer', law: lawSnapshotForTest('semantic supersede law'), now: '2026-07-09T04:13:00.000Z' });
    assert.equal(supersede.decision, 'superseded');
    assert.equal(storage6.db.prepare("SELECT status FROM habits WHERE id = 'old-active-2'").get().status, 'archived', 'supersede archives old active habit');
    assert.equal(storage6.db.prepare("SELECT status FROM habits WHERE id = 'new-candidate-3'").get().status, 'active', 'supersede promotes replacement candidate to approved status');
  } finally {
    storage6.db.close();
  }

  const storage7 = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state7')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(storage7.db, 'habits', { id: 'old-active-2', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T04:20:00.000Z' });
    insertStorageRecord(storage7.db, 'habits', { id: 'new-candidate-3', userId: 'owner', data: habitData({ ...habit3 }), now: '2026-07-09T04:21:00.000Z' });
    insertStorageRecord(storage7.db, 'habits', { id: 'conflicting-active', userId: 'owner', data: habitData({ status: 'active', active: true, condition: habit3.condition, behavior: 'Do the opposite in this context', polarity: -1 }), now: '2026-07-09T04:22:00.000Z' });
    const scan = await scanAndBackfillSemanticDuplicates(storage7.db, { userId: 'owner', policy, provider, now: '2026-07-09T04:23:00.000Z', statuses: ['active', 'candidate'] });
    assert.throws(() => resolveHabitDuplicate(storage7.db, { userId: 'owner', duplicateId: scan.relations[0].id, checksum: scan.relations[0].checksum, action: 'supersede', reason: 'new wording is clearer', law: lawSnapshotForTest('semantic supersede law'), now: '2026-07-09T04:24:00.000Z' }), /conflict check/, 'supersede replacement must run conflict gate before activation');
  } finally {
    storage7.db.close();
  }

  const lawRoot = await ensurePrivateRoot(join(temp, 'state-law-freshness'));
  const lawStorage = await initExperienceStorage(lawRoot, { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(lawStorage.db, 'habits', { id: 'law-old-active', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T04:25:00.000Z' });
    insertStorageRecord(lawStorage.db, 'habits', { id: 'law-new-candidate', userId: 'owner', data: habitData({ ...habit3 }), now: '2026-07-09T04:26:00.000Z' });
    const lawScan = await scanAndBackfillSemanticDuplicates(lawStorage.db, { userId: 'owner', policy, provider, now: '2026-07-09T04:27:00.000Z', statuses: ['active', 'candidate'] });
    const lawFile = join(lawRoot, 'law.md');
    await writeFile(lawFile, 'original safety instructions', { mode: 0o600 });
    const staleLaw = await readConfiguredLawSnapshot(lawRoot, { law_path: 'law.md' });
    await writeFile(lawFile, 'changed safety instructions', { mode: 0o600 });
    assert.throws(() => resolveHabitDuplicate(lawStorage.db, { userId: 'owner', duplicateId: lawScan.relations[0].id, checksum: lawScan.relations[0].checksum, action: 'supersede', reason: 'new wording is clearer', law: staleLaw, now: '2026-07-09T04:28:00.000Z' }), /safety file changed/, 'supersede must synchronously revalidate law freshness inside its writer transaction');
    assert.equal(lawStorage.db.prepare("SELECT status FROM habits WHERE id = 'law-old-active'").get().status, 'active', 'stale-law rejection must leave the approved habit unchanged');
    assert.equal(lawStorage.db.prepare("SELECT status FROM habits WHERE id = 'law-new-candidate'").get().status, 'candidate', 'stale-law rejection must leave replacement candidate unchanged');
    assert.equal(listHabitDuplicates(lawStorage.db, { userId: 'owner', decision: 'pending' }).length, 1, 'stale-law rejection must leave duplicate relation pending');
  } finally {
    lawStorage.db.close();
  }

  const storage8 = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state8')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(storage8.db, 'habits', { id: 'older-candidate-2', userId: 'owner', data: habitData({ ...habit2 }), now: '2026-07-09T04:30:00.000Z' });
    insertStorageRecord(storage8.db, 'habits', { id: 'newer-active-3', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit3 }), now: '2026-07-09T04:31:00.000Z' });
    const scan = await scanAndBackfillSemanticDuplicates(storage8.db, { userId: 'owner', policy, provider, now: '2026-07-09T04:32:00.000Z', statuses: ['active', 'candidate'] });
    const mergeHabits = storage8.db.prepare("SELECT * FROM habits WHERE id IN ('older-candidate-2','newer-active-3') ORDER BY id").all();
    const mergePlan = planHabitDuplicateResolution(scan.relations[0], mergeHabits, 'merge');
    assert.equal(mergePlan.survivor.id, 'newer-active-3', 'merge preview must mirror approved-side protection when canonical role reverses');
    assert.equal(mergePlan.other.id, 'older-candidate-2');
    assert.throws(() => resolveHabitDuplicate(storage8.db, { userId: 'owner', duplicateId: scan.relations[0].id, checksum: scan.relations[0].checksum, action: 'merge', reason: 'stale comparison must fail', expectedHabitChecksums: { 'newer-active-3': mergePlan.survivor.checksum, 'older-candidate-2': 'stale-checksum' }, now: '2026-07-09T04:32:30.000Z' }), /Duplicate habit changed/, 'resolver must reject when either displayed habit changed after comparison');
    assert.equal(listHabitDuplicates(storage8.db, { userId: 'owner', decision: 'pending' }).length, 1, 'stale habit preview rejection must leave relation pending');
    assert.equal(storage8.db.prepare("SELECT status FROM habits WHERE id = 'newer-active-3'").get().status, 'active');
    assert.equal(storage8.db.prepare("SELECT status FROM habits WHERE id = 'older-candidate-2'").get().status, 'candidate');
    const merge = resolveHabitDuplicate(storage8.db, { userId: 'owner', duplicateId: scan.relations[0].id, checksum: scan.relations[0].checksum, action: 'merge', reason: 'same behavior', now: '2026-07-09T04:33:00.000Z' });
    assert.equal(merge.decision, 'merged');
    assert.equal(storage8.db.prepare("SELECT status FROM habits WHERE id = 'newer-active-3'").get().status, 'active', 'merge must keep approved side active when paired with older candidate');
    assert.equal(storage8.db.prepare("SELECT status FROM habits WHERE id = 'older-candidate-2'").get().status, 'archived', 'merge archives candidate duplicate instead of active approved habit');
  } finally {
    storage8.db.close();
  }

  const disabledStorage = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state-disabled')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(disabledStorage.db, 'habits', { id: 'disabled-old-active', userId: 'owner', data: habitData({ status: 'disabled', active: false, ...habit2 }), now: '2026-07-09T04:34:00.000Z' });
    insertStorageRecord(disabledStorage.db, 'habits', { id: 'disabled-new-candidate', userId: 'owner', data: habitData({ ...habit3 }), now: '2026-07-09T04:35:00.000Z' });
    const disabledScan = await scanAndBackfillSemanticDuplicates(disabledStorage.db, { userId: 'owner', policy, provider, now: '2026-07-09T04:36:00.000Z', statuses: ['disabled', 'candidate'] });
    const disabledHabits = disabledStorage.db.prepare("SELECT * FROM habits WHERE id IN ('disabled-old-active','disabled-new-candidate') ORDER BY id").all();
    const disabledPlan = planHabitDuplicateResolution(disabledScan.relations[0], disabledHabits, 'supersede');
    assert.equal(disabledPlan.survivor.id, 'disabled-new-candidate');
    assert.equal(disabledPlan.other.id, 'disabled-old-active');
    resolveHabitDuplicate(disabledStorage.db, { userId: 'owner', duplicateId: disabledScan.relations[0].id, checksum: disabledScan.relations[0].checksum, action: 'supersede', reason: 'clearer wording while disabled', law: lawSnapshotForTest('disabled semantic supersede law'), now: '2026-07-09T04:37:00.000Z' });
    assert.equal(disabledStorage.db.prepare("SELECT status FROM habits WHERE id = 'disabled-new-candidate'").get().status, 'disabled', 'supersede must preserve disabled approved state on replacement wording');
    assert.equal(disabledStorage.db.prepare("SELECT status FROM habits WHERE id = 'disabled-old-active'").get().status, 'archived');
  } finally {
    disabledStorage.db.close();
  }

  const storage12 = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state12')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(storage12.db, 'habits', { id: 'promote-active-2', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T04:45:00.000Z' });
    insertStorageRecord(storage12.db, 'habits', { id: 'promote-candidate-3', userId: 'owner', data: habitData({ ...habit3, review_status: 'approved_pending_eligibility' }), now: '2026-07-09T04:46:00.000Z' });
    const promotion = await promoteApprovedPendingCandidates(storage12.db, { userId: 'owner', law: lawSnapshotForTest('promotion law'), now: '2026-07-09T04:47:00.000Z', semantic: { policy, provider } });
    assert.equal(promotion.promoted.length, 0);
    assert.equal(promotion.blocked[0].reason, 'semantic_duplicate', 'background promotion must block semantic duplicate without stale checksum failure');
    assert.equal(listPendingReviewItems(storage12.db, { userId: 'owner' }).items.some((item) => item.id === 'promote-candidate-3'), false, 'promotion-blocked duplicate candidate must leave normal review until resolved');
  } finally {
    storage12.db.close();
  }

  const storage10 = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state10')), { allowInit: true, userId: 'owner' });
  try {
    const result = await consolidateProposalBatch({ db: storage10.db, userId: 'owner', proposalBatch: { schema_version: 1, user_id: 'owner', batch_id: 'same-batch', created_at: '2026-07-09T04:50:00.000Z', proposals: [proposal2, proposal3] }, observations: observations('b'), semantic: { policy, provider } });
    assert.equal(result.inserted.candidates, 2);
    assert.equal(listHabitDuplicates(storage10.db, { userId: 'owner', decision: 'pending' }).length, 0, 'same-batch candidates must not create semantic duplicate relations');
    const normalReviewIds = listPendingReviewItems(storage10.db, { userId: 'owner' }).items.map((item) => item.id);
    assert.equal(normalReviewIds.length, 2, 'both same-batch candidates must remain visible for normal human review');
  } finally {
    storage10.db.close();
  }

  const storage11 = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state11')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(storage11.db, 'habits', { id: 'threshold-active-2', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T04:55:00.000Z' });
    insertStorageRecord(storage11.db, 'habits', { id: 'threshold-candidate-3', userId: 'owner', data: habitData({ ...habit3 }), now: '2026-07-09T04:56:00.000Z' });
    await scanAndBackfillSemanticDuplicates(storage11.db, { userId: 'owner', policy, provider, now: '2026-07-09T04:57:00.000Z', statuses: ['active', 'candidate'] });
    assert.equal(listPendingReviewItems(storage11.db, { userId: 'owner' }).items.some((item) => item.id === 'threshold-candidate-3'), false, 'scan hides candidate duplicate');
    const threshold = reconcileSemanticDuplicateThresholds(storage11.db, { userId: 'owner', policy: { ...policy, reviewThresholdBp: 8100 }, now: '2026-07-09T04:58:00.000Z' });
    assert.equal(threshold.dismissed.length, 1);
    assert.ok(listPendingReviewItems(storage11.db, { userId: 'owner' }).items.some((item) => item.id === 'threshold-candidate-3'), 'threshold dismissal restores hidden candidate to normal review');
  } finally {
    storage11.db.close();
  }

  const root9 = await ensurePrivateRoot(join(temp, 'state9'));
  const storage9 = await initExperienceStorage(root9, { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(storage9.db, 'habits', { id: 'runner-zero-active-2', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T04:40:00.000Z' });
    const runnerObservations = observations('b');
    const modelOutput = { schema_version: 1, user_id: 'owner', file_generation: 'active', batch_id: 'runner-zero', model: 'fixture-model', created_at: '2026-07-09T04:41:00.000Z', observations_read: { seq_start: 1, seq_end: 3, checksum: runnerObservations.at(-1).checksum }, proposals: [proposal3] };
    const runner = await runConsolidationOnce({ root: root9, db: storage9.db, userId: 'owner', observations: runnerObservations, modelOutput, model: 'fixture-model', semantic: { policy: { ...policy, reviewThresholdBp: 0, strongThresholdBp: 0 }, provider }, dryRun: false, now: '2026-07-09T04:41:00.000Z' });
    assert.equal(runner.ok, true, JSON.stringify(runner));
    assert.equal(listHabitDuplicates(storage9.db, { userId: 'owner', decision: 'pending' })[0].threshold_bp, 0, 'runConsolidationOnce semantic override must preserve explicit zero threshold');
  } finally {
    storage9.db.close();
  }

  const root5 = await ensurePrivateRoot(join(temp, 'state5'));
  const storage5 = await initExperienceStorage(root5, { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(storage5.db, 'habits', { id: 'runner-active-2', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T05:00:00.000Z' });
    const runnerObservations = observations('b');
    const modelOutput = { schema_version: 1, user_id: 'owner', file_generation: 'active', batch_id: 'runner-semantic', model: 'fixture-model', created_at: '2026-07-09T05:01:00.000Z', observations_read: { seq_start: 1, seq_end: 3, checksum: runnerObservations.at(-1).checksum }, proposals: [proposal3] };
    const runner = await runConsolidationOnce({ root: root5, db: storage5.db, userId: 'owner', observations: runnerObservations, modelOutput, model: 'fixture-model', semantic: { policy, provider }, dryRun: false, now: '2026-07-09T05:01:00.000Z' });
    assert.equal(runner.ok, true, JSON.stringify(runner));
    const runnerCandidate = storage5.db.prepare("SELECT status, data_json FROM habits WHERE id <> 'runner-active-2'").get();
    assert.equal(JSON.parse(runnerCandidate.data_json).review_status, 'duplicate_resolution', 'runner/analyze path must thread semantic duplicate routing');
    const runnerRelation = listHabitDuplicates(storage5.db, { userId: 'owner', decision: 'pending' })[0];
    assert.equal(JSON.parse(runnerRelation.data_json).pending_evidence_route_habit_id, 'runner-active-2', 'runner/analyze path must record canonical pending evidence route');
    assert.notEqual(storage5.db.prepare('SELECT habit_id FROM evidence WHERE user_id = ? ORDER BY id').get('owner').habit_id, 'runner-active-2', 'runner/analyze path must defer evidence merge until user resolution');
    const keepRunner = resolveHabitDuplicate(storage5.db, { userId: 'owner', duplicateId: runnerRelation.id, checksum: runnerRelation.checksum, action: 'keep_separate', reason: 'separate runner context', now: '2026-07-09T05:02:00.000Z' });
    assert.equal(keepRunner.decision, 'kept_separate');
    assert.ok(listPendingReviewItems(storage5.db, { userId: 'owner' }).items.some((item) => item.type === 'candidate' && JSON.parse(item.data_json).review_status === 'kept_separate'), 'keep-separate duplicate candidate must become visible in normal review');
  } finally {
    storage5.db.close();
  }
} finally {
  storage.db.close();
}
await rm(temp, { recursive: true, force: true });
console.log('agent-experience phase10 semantic dedupe checks passed');
