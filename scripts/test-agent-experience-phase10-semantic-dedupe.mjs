#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { ensurePrivateRoot } from '../extensions/agent-experience/src/storage/private-root.ts';
import { habitEmbeddingInputV1, cosineBp, normalizedVector } from '../extensions/agent-experience/src/semantic/core.ts';
import { getCachedHabitEmbedding, listHabitDuplicates } from '../extensions/agent-experience/src/semantic/storage.ts';
import { checkSemanticActivationGate, reconcileSemanticDuplicateThresholds, sanitizePolicy, scanAndBackfillSemanticDuplicates } from '../extensions/agent-experience/src/semantic/service.ts';
import { consolidateProposalBatch } from '../extensions/agent-experience/src/consolidate/commit.ts';
import { runConsolidationOnce } from '../extensions/agent-experience/src/consolidate/runner.ts';
import { acceptCandidateHabit, archiveHideHabit, lawSnapshotForTest, listApprovedHabitsForSetup, listPendingReviewItems, resolveHabitDuplicate } from '../extensions/agent-experience/src/review.ts';
import { promoteApprovedPendingCandidates, selectActiveSelectorSnapshot } from '../extensions/agent-experience/src/selector.ts';

const semanticFiles = await readdir(new URL('../extensions/agent-experience/src/semantic/', import.meta.url));
for (const file of semanticFiles.filter((name) => name.endsWith('.ts'))) {
  const text = await readFile(new URL(`../extensions/agent-experience/src/semantic/${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(text, /@earendil-works\/pi-|pi-tui|ExtensionCommandContext|\.\.\/\.\.\//, `semantic core file ${file} must stay host-agnostic`);
}

const c = 0.8048647766597806;
const s = Math.sqrt(1 - c * c);
const v2 = normalizedVector(Float32Array.from([1, 0]));
const v3 = normalizedVector(Float32Array.from([c, s]));
assert.equal(cosineBp(v2, v3), 8048, 'real #2/#3 cosine must truncate to 8048bp');

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
      if (text === habitEmbeddingInputV1(habit2)) return v2;
      if (text === habitEmbeddingInputV1(habit3)) return v3;
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
  assert.ok(storage.db.prepare("SELECT id FROM habit_duplicate_audit WHERE action = 'proposal_duplicate_route'").get(), 'proposal-time pending evidence route must be audited');

  const cached = getCachedHabitEmbedding(storage.db, { userId: 'owner', habitId: 'habit-2', embeddingInputChecksum: storage.db.prepare('SELECT embedding_input_checksum FROM habit_embeddings WHERE habit_id = ?').get('habit-2').embedding_input_checksum, habitRowChecksum: active2.checksum, provider: policy.provider, model: policy.model, dimensions: policy.dimensions });
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
  } finally {
    storage3.db.close();
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
    const scan = await scanAndBackfillSemanticDuplicates(storage6.db, { userId: 'owner', policy, provider, now: '2026-07-09T04:12:00.000Z' });
    assert.equal(listPendingReviewItems(storage6.db, { userId: 'owner' }).items.some((item) => item.id === 'new-candidate-3'), false, 'scan/backfill duplicate candidate must leave normal review until resolved');
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
    const scan = await scanAndBackfillSemanticDuplicates(storage7.db, { userId: 'owner', policy, provider, now: '2026-07-09T04:23:00.000Z' });
    assert.throws(() => resolveHabitDuplicate(storage7.db, { userId: 'owner', duplicateId: scan.relations[0].id, checksum: scan.relations[0].checksum, action: 'supersede', reason: 'new wording is clearer', law: lawSnapshotForTest('semantic supersede law'), now: '2026-07-09T04:24:00.000Z' }), /conflict check/, 'supersede replacement must run conflict gate before activation');
  } finally {
    storage7.db.close();
  }

  const storage8 = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state8')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(storage8.db, 'habits', { id: 'older-candidate-2', userId: 'owner', data: habitData({ ...habit2 }), now: '2026-07-09T04:30:00.000Z' });
    insertStorageRecord(storage8.db, 'habits', { id: 'newer-active-3', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit3 }), now: '2026-07-09T04:31:00.000Z' });
    const scan = await scanAndBackfillSemanticDuplicates(storage8.db, { userId: 'owner', policy, provider, now: '2026-07-09T04:32:00.000Z' });
    const merge = resolveHabitDuplicate(storage8.db, { userId: 'owner', duplicateId: scan.relations[0].id, checksum: scan.relations[0].checksum, action: 'merge', reason: 'same behavior', now: '2026-07-09T04:33:00.000Z' });
    assert.equal(merge.decision, 'merged');
    assert.equal(storage8.db.prepare("SELECT status FROM habits WHERE id = 'newer-active-3'").get().status, 'active', 'merge must keep approved side active when paired with older candidate');
    assert.equal(storage8.db.prepare("SELECT status FROM habits WHERE id = 'older-candidate-2'").get().status, 'archived', 'merge archives candidate duplicate instead of active approved habit');
  } finally {
    storage8.db.close();
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
    assert.equal(listHabitDuplicates(storage10.db, { userId: 'owner', decision: 'pending' })[0].similarity_bp, 8048, 'same-batch semantic duplicate must create pending relation');
    const normalReviewIds = listPendingReviewItems(storage10.db, { userId: 'owner' }).items.map((item) => item.id);
    assert.equal(normalReviewIds.length, 1, 'same-batch duplicate should hide only routed duplicate from normal review');
  } finally {
    storage10.db.close();
  }

  const storage11 = await initExperienceStorage(await ensurePrivateRoot(join(temp, 'state11')), { allowInit: true, userId: 'owner' });
  try {
    insertStorageRecord(storage11.db, 'habits', { id: 'threshold-active-2', userId: 'owner', data: habitData({ status: 'active', active: true, ...habit2 }), now: '2026-07-09T04:55:00.000Z' });
    insertStorageRecord(storage11.db, 'habits', { id: 'threshold-candidate-3', userId: 'owner', data: habitData({ ...habit3 }), now: '2026-07-09T04:56:00.000Z' });
    await scanAndBackfillSemanticDuplicates(storage11.db, { userId: 'owner', policy, provider, now: '2026-07-09T04:57:00.000Z' });
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
