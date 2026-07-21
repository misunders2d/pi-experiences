#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension, { __normalizeAgentExperienceConsolidationModelOutputForTest } from '../extensions/agent-experience/index.ts';
import {
  __getObservationIoDiagnosticsForTest,
  __resetObservationIoDiagnosticsForTest,
  appendObservation,
  observationChecksumForTest,
  purgeExpiredObservationArchives,
  readCurrentObservationManifest,
  readValidatedObservationRange,
  rotateObservationGenerationIfFullyRead,
} from '../extensions/agent-experience/src/storage/observations.ts';
import { buildCompactHabitContext } from '../extensions/agent-experience/src/consolidate/context.ts';
import { getProposalReadWatermark } from '../extensions/agent-experience/src/consolidate/commit.ts';
import { runConsolidationOnce } from '../extensions/agent-experience/src/consolidate/runner.ts';
import { listPendingReviewItems } from '../extensions/agent-experience/src/review.ts';
import { canonicalJson } from '../extensions/agent-experience/src/storage/checksum.ts';
import { ensurePrivateRoot, resolvePrivatePath } from '../extensions/agent-experience/src/storage/private-root.ts';
import { initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';

async function newRoot(prefix) {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  return { parent, root: await ensurePrivateRoot(join(parent, 'state')) };
}

function payload(index) {
  return { kind: 'conversation_pair_v1', user_text_redacted: `user example ${index}`, assistant_text_redacted: `assistant example ${index}`, close_reason: 'agent_end' };
}

async function assertBoundedAppendAndCrashRecovery() {
  const { parent, root } = await newRoot('agent-experience-observation-tail-');
  try {
    __resetObservationIoDiagnosticsForTest();
    for (let index = 0; index < 300; index += 1) {
      await appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: payload(index), id: `bounded-${index}`, createdAt: `2026-06-${String(1 + (index % 20)).padStart(2, '0')}T00:00:00.000Z` });
    }
    let diagnostics = __getObservationIoDiagnosticsForTest();
    assert.equal(diagnostics.full_scans, 1, 'legacy bootstrap scans once only');
    assert.ok(diagnostics.bounded_bytes_read < 1_000_000, 'append tail validation remains bounded instead of rereading full history');

    const first = await readValidatedObservationRange(root, { userId: 'owner', maxRecords: 3, maxBytes: 70000 });
    assert.deepEqual(first.records.map((row) => row.seq), [1, 2, 3]);
    const second = await readValidatedObservationRange(root, { userId: 'owner', afterSeq: 3, afterChecksum: first.records.at(-1).checksum, maxRecords: 3, maxBytes: 70000 });
    assert.deepEqual(second.records.map((row) => row.seq), [4, 5, 6]);
    const snapshotManifest = await readCurrentObservationManifest(root);
    const snapshotBounded = await readValidatedObservationRange(root, { userId: 'owner', afterSeq: 3, afterChecksum: first.records.at(-1).checksum, maxRecords: 10, maxBytes: 70000, expectedGeneration: snapshotManifest.file_generation, throughSeq: 5 });
    assert.deepEqual(snapshotBounded.records.map((row) => row.seq), [4, 5], 'snapshot-bounded reads must stop at the action-start sequence even when newer records exist');
    assert.equal(snapshotBounded.total_unread, 2);
    assert.equal(snapshotBounded.has_more, false);
    const snapshotBatch1 = await readValidatedObservationRange(root, { userId: 'owner', maxRecords: 2, maxBytes: 70000, expectedGeneration: snapshotManifest.file_generation, throughSeq: 6 });
    assert.deepEqual(snapshotBatch1.records.map((row) => row.seq), [1, 2]);
    assert.equal(snapshotBatch1.has_more, true);
    const snapshotBatch2 = await readValidatedObservationRange(root, { userId: 'owner', afterSeq: 2, afterChecksum: snapshotBatch1.records.at(-1).checksum, maxRecords: 2, maxBytes: 70000, expectedGeneration: snapshotManifest.file_generation, throughSeq: 6 });
    assert.deepEqual(snapshotBatch2.records.map((row) => row.seq), [3, 4]);
    assert.equal(snapshotBatch2.has_more, true);
    const snapshotBatch3 = await readValidatedObservationRange(root, { userId: 'owner', afterSeq: 4, afterChecksum: snapshotBatch2.records.at(-1).checksum, maxRecords: 2, maxBytes: 70000, expectedGeneration: snapshotManifest.file_generation, throughSeq: 6 });
    assert.deepEqual(snapshotBatch3.records.map((row) => row.seq), [5, 6]);
    assert.equal(snapshotBatch3.has_more, false, 'final batch must close a fixed snapshot after three bounded reads');
    await assert.rejects(() => readValidatedObservationRange(root, { userId: 'owner', expectedGeneration: 'wrong-generation', throughSeq: 5 }), /generation changed/i);
    await assert.rejects(() => readValidatedObservationRange(root, { userId: 'owner', throughSeq: snapshotManifest.last_seq + 1 }), /boundary is invalid/i);
    await assert.rejects(() => readValidatedObservationRange(root, { userId: 'other', afterSeq: 3, afterChecksum: first.records.at(-1).checksum }), /user_id mismatch|watermark checksum/i);

    const manifest = await readCurrentObservationManifest(root);
    const crashBase = {
      id: 'crash-complete',
      seq: manifest.last_seq + 1,
      user_id: 'owner',
      origin: { source: 'test' },
      prev_pair_ref: manifest.last_pair_ref,
      payload_redacted: payload('crash-complete'),
      created_at: '2026-07-09T02:00:00.000Z',
    };
    const crashRecord = { ...crashBase, checksum: observationChecksumForTest(crashBase) };
    await appendFile(resolvePrivatePath(root, 'observations.jsonl'), `${canonicalJson(crashRecord)}\n`);
    const recovered = await readCurrentObservationManifest(root);
    assert.equal(recovered.last_seq, crashRecord.seq, 'complete JSON append without index/manifest is recovered');
    assert.equal(recovered.last_checksum, crashRecord.checksum);

    await appendFile(resolvePrivatePath(root, 'observations.jsonl'), '{"partial":');
    const afterPartial = await appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: payload('after-partial'), id: 'after-partial', createdAt: '2026-07-09T02:01:00.000Z' });
    assert.equal(afterPartial.record.seq, crashRecord.seq + 1, 'partial crash tail is quarantined and does not consume a sequence');
    assert.ok((await readdir(resolvePrivatePath(root, 'recovered-tails'))).length >= 1);

    await appendFile(resolvePrivatePath(root, 'observations.idx'), Buffer.alloc(4, 0xff));
    const afterIndexPartial = await appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: payload('after-index-partial'), id: 'after-index-partial', createdAt: '2026-07-09T02:02:00.000Z' });
    assert.equal(afterIndexPartial.record.seq, crashRecord.seq + 2, 'partial index entry is truncated before next append');

    const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) => appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: payload(`concurrent-${index}`), id: `concurrent-${index}`, createdAt: '2026-07-09T03:00:00.000Z' })));
    const seqs = concurrent.map((item) => item.record.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 12 }, (_, index) => afterIndexPartial.record.seq + index + 1), 'concurrent appends serialize into contiguous sequence numbers');
    diagnostics = __getObservationIoDiagnosticsForTest();
    assert.equal(diagnostics.full_scans, 1, 'crash recovery and concurrency do not trigger whole-history scans');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function assertRotationAndRetention() {
  const { parent, root } = await newRoot('agent-experience-observation-rotation-');
  try {
    await appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: payload(1), id: 'rotate-1', createdAt: '2026-07-01T00:00:00.000Z' });
    const second = await appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: payload(2), id: 'rotate-2', createdAt: '2026-07-02T00:00:00.000Z' });
    const staleTail = second.manifest;
    await appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: payload(3), id: 'rotate-3', createdAt: '2026-07-03T00:00:00.000Z' });
    const stale = await rotateObservationGenerationIfFullyRead(root, { userId: 'owner', fileGeneration: staleTail.file_generation, seq: staleTail.last_seq, checksum: staleTail.last_checksum, retentionDays: 7, now: '2026-07-09T04:00:00.000Z' });
    assert.equal(stale.rotated, false, 'capture race prevents premature rotation');

    let current = await readCurrentObservationManifest(root);
    await assert.rejects(() => rotateObservationGenerationIfFullyRead(root, { userId: 'owner', fileGeneration: current.file_generation, seq: current.last_seq, checksum: current.last_checksum, retentionDays: 7, now: '2026-07-09T04:01:00.000Z', _testFailurePhase: 'prepared' }), /Injected observation rotation failure/);
    const recoveredPrepared = await readCurrentObservationManifest(root);
    assert.equal(recoveredPrepared.file_generation, current.file_generation, 'prepared-phase interruption rolls back old generation');
    assert.equal(recoveredPrepared.last_seq, 3);

    current = recoveredPrepared;
    await assert.rejects(() => rotateObservationGenerationIfFullyRead(root, { userId: 'owner', fileGeneration: current.file_generation, seq: current.last_seq, checksum: current.last_checksum, retentionDays: 7, now: '2026-07-09T04:02:00.000Z', _testFailurePhase: 'moved' }), /Injected observation rotation failure/);
    const recoveredMoved = await readCurrentObservationManifest(root);
    assert.notEqual(recoveredMoved.file_generation, current.file_generation, 'moved-phase interruption completes a fresh generation');
    assert.equal(recoveredMoved.last_seq, 0);
    assert.equal((await readValidatedObservationRange(root, { userId: 'owner' })).records.length, 0);
    assert.equal(existsSync(resolvePrivatePath(root, 'observation-archive', current.file_generation, 'observations.jsonl')), true);

    assert.deepEqual((await purgeExpiredObservationArchives(root, { now: '2026-07-16T04:01:59.999Z' })).deleted, [], 'archive remains before configured expiry');
    assert.deepEqual((await purgeExpiredObservationArchives(root, { now: '2026-07-16T04:02:00.000Z' })).deleted, [current.file_generation], 'archive source text deletes exactly at retention boundary');
    assert.equal(existsSync(resolvePrivatePath(root, 'observation-archive', current.file_generation)), false);

    const newRecord = await appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: payload('new-generation'), id: 'new-generation-1', createdAt: '2026-07-16T05:00:00.000Z' });
    assert.equal(newRecord.record.seq, 1, 'new generation restarts its own sequence');
    assert.equal(newRecord.manifest.file_generation, recoveredMoved.file_generation);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function rawHabitOutput(input, refs, overrides = {}) {
  return {
    batch_id: overrides.batch_id || 'cross-batch',
    proposals: [{
      proposal_id: overrides.proposal_id || 'cross-batch-proposal',
      kind: 'habit_candidate',
      candidate_key: 'evidence-first-status',
      condition: 'When reporting completion status',
      behavior: 'State only evidence-backed completion and name anything unverified',
      polarity: 1,
      confidence_bp: 9000,
      source_refs: refs.map((record) => ({ file_generation: record.file_generation, seq: record.seq, checksum: record.checksum })),
      evidence_summary: 'Repeated requests for evidence-backed status.',
      ambiguous: false,
    }],
  };
}

async function assertCrossBatchContextAndContradiction() {
  const { parent, root } = await newRoot('agent-experience-cross-batch-');
  try {
    await appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: payload('batch-1a'), id: 'batch-1a', createdAt: '2026-07-08T08:00:00.000Z' });
    await appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: payload('batch-1b'), id: 'batch-1b', createdAt: '2026-07-08T09:00:00.000Z' });
    await appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: payload('batch-2'), id: 'batch-2', createdAt: '2026-07-09T08:00:00.000Z' });
    const storage = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
    try {
      const firstRange = await readValidatedObservationRange(root, { userId: 'owner', maxRecords: 2, maxBytes: 70000 });
      const firstInput = { model: 'openai-codex/gpt-5.5', userId: 'owner', observations: firstRange.records, habitContext: [], expected: { file_generation: firstRange.manifest.file_generation, seq_start: 1, seq_end: 2, read_checksum: firstRange.records.at(-1).checksum } };
      const firstOutput = __normalizeAgentExperienceConsolidationModelOutputForTest(rawHabitOutput(firstInput, firstRange.records, { batch_id: 'cross-1', proposal_id: 'cross-1' }), firstInput);
      assert.equal(firstOutput.proposals[0].evidence_stage, 'collecting');
      const firstCommit = await runConsolidationOnce({ root, db: storage.db, userId: 'owner', observations: firstRange.records, modelOutput: firstOutput, model: 'openai-codex/gpt-5.5', now: '2026-07-09T09:00:00.000Z' });
      assert.equal(firstCommit.ok, true);
      assert.equal(listPendingReviewItems(storage.db, { userId: 'owner' }).items.length, 0, 'subthreshold cross-batch candidate remains hidden');

      const context = buildCompactHabitContext(storage.db, { userId: 'owner' });
      assert.equal(context.length, 1);
      assert.equal(context[0].unique_observations, 2);
      const watermark = getProposalReadWatermark(storage.db, 'owner', firstRange.manifest.file_generation);
      const secondRange = await readValidatedObservationRange(root, { userId: 'owner', afterSeq: watermark.seq, afterChecksum: watermark.checksum, maxRecords: 2, maxBytes: 70000 });
      assert.deepEqual(secondRange.records.map((record) => record.seq), [3]);
      const secondInput = { model: 'openai-codex/gpt-5.5', userId: 'owner', observations: secondRange.records, habitContext: context, expected: { file_generation: secondRange.manifest.file_generation, seq_start: 3, seq_end: 3, read_checksum: secondRange.records[0].checksum } };
      const secondOutput = __normalizeAgentExperienceConsolidationModelOutputForTest(rawHabitOutput(secondInput, secondRange.records, { batch_id: 'cross-2', proposal_id: 'cross-2' }), secondInput);
      assert.equal(secondOutput.proposals[0].evidence_stage, 'reviewable');
      const secondCommit = await runConsolidationOnce({ root, db: storage.db, userId: 'owner', observations: secondRange.records, modelOutput: secondOutput, model: 'openai-codex/gpt-5.5', now: '2026-07-09T09:01:00.000Z' });
      assert.equal(secondCommit.ok, true);
      const visible = listPendingReviewItems(storage.db, { userId: 'owner' });
      assert.equal(visible.items.length, 1, 'compact context promotes same identity into review only after combined threshold');
      const merged = storage.db.prepare("SELECT data_json FROM habits WHERE user_id='owner' AND status='candidate'").get();
      const mergedData = JSON.parse(merged.data_json);
      assert.equal(mergedData.source_refs.length, 3);
      assert.equal(new Set(mergedData.source_dates.map((date) => date.slice(0, 10))).size, 2);

      insertStorageRecord(storage.db, 'habits', { id: 'old-active', userId: 'owner', data: { record_kind: 'candidate_habit_v1', schema_version: 2, status: 'active', review_status: 'accepted_active', active: true, injectable: false, condition: 'When reporting a release result', behavior: 'Say the release is complete before checking evidence', polarity: 1, confidence_bp: 9000, source_refs: [], source_dates: [] }, now: '2026-07-09T09:02:00.000Z' });
      const contradictionRecord = await appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: payload('correction'), id: 'correction', createdAt: '2026-07-10T09:00:00.000Z' });
      const contradictionRange = await readValidatedObservationRange(root, { userId: 'owner', afterSeq: 3, afterChecksum: secondRange.records[0].checksum, maxRecords: 2, maxBytes: 70000 });
      const contradictionContext = buildCompactHabitContext(storage.db, { userId: 'owner' });
      const correctionInput = { model: 'openai-codex/gpt-5.5', userId: 'owner', observations: contradictionRange.records, habitContext: contradictionContext, expected: { file_generation: contradictionRange.manifest.file_generation, seq_start: contradictionRecord.record.seq, seq_end: contradictionRecord.record.seq, read_checksum: contradictionRecord.record.checksum } };
      const correctionRaw = {
        batch_id: 'correction-batch',
        proposals: [{ proposal_id: 'correction-1', kind: 'correction_split', candidate_key: 'release-evidence-correction', old_condition: 'When reporting a release result', old_behavior: 'Say the release is complete before checking evidence', new_condition: 'When reporting a release result', new_behavior: 'Check concrete evidence before saying the release is complete', confidence_bp: 9000, source_refs: [{ file_generation: contradictionRange.manifest.file_generation, seq: contradictionRecord.record.seq, checksum: contradictionRecord.record.checksum }], evidence_summary: 'Direct correction requires evidence first.', ambiguous: false }],
      };
      const correctionOutput = __normalizeAgentExperienceConsolidationModelOutputForTest(correctionRaw, correctionInput);
      assert.equal(correctionOutput.proposals[0].evidence_stage, 'reviewable');
      const correctionCommit = await runConsolidationOnce({ root, db: storage.db, userId: 'owner', observations: contradictionRange.records, modelOutput: correctionOutput, model: 'openai-codex/gpt-5.5', now: '2026-07-10T09:01:00.000Z' });
      assert.equal(correctionCommit.ok, true);
      const old = storage.db.prepare("SELECT status, data_json FROM habits WHERE id='old-active'").get();
      assert.equal(old.status, 'dormant', 'strong exact correction suppresses old active habit');
      assert.equal(JSON.parse(old.data_json).review_status, 'contradicted_pending_review');
      assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM habits WHERE condition=? AND behavior=? AND polarity=-1").get('When reporting a release result', 'Say the release is complete before checking evidence').count, 0, 'qualifying old-negative half does not become a duplicate candidate');
      const replacement = storage.db.prepare("SELECT status, data_json FROM habits WHERE behavior=? AND polarity=1").get('Check concrete evidence before saying the release is complete');
      assert.equal(replacement.status, 'candidate', 'replacement remains unapproved candidate');
      assert.notEqual(JSON.parse(replacement.data_json).review_status, 'accepted_active');
      assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM experience_review_audit WHERE target_id='old-active' AND action='suppress_contradicted_habit'").get().count, 1);
    } finally {
      storage.db.close();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

await assertBoundedAppendAndCrashRecovery();
await assertRotationAndRetention();
await assertCrossBatchContextAndContradiction();
console.log('agent-experience phase12 observation and incremental Analyze checks passed');
