#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../extensions/agent-experience/src/storage/checksum.ts';
import { ensurePrivateRoot } from '../extensions/agent-experience/src/storage/private-root.ts';
import { initExperienceStorage, selectStorageRecordsByUser } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { observationChecksumForTest, observationPairRefForTest } from '../extensions/agent-experience/src/storage/observations.ts';
import { validateObservationRecords } from '../extensions/agent-experience/src/consolidate/observations.ts';
import { validateModelOutputBatch, modelOutputToProposalBatch, insertModelOutputQuarantine, processValidatedModelOutput } from '../extensions/agent-experience/src/consolidate/model-output.ts';
import { proposeFromObservations, buildProposalModelPayloadForTest } from '../extensions/agent-experience/src/consolidate/propose.ts';

function makeObservation({ seq, userId = 'owner', previous = null, createdAt, safe }) {
  const base = {
    id: `obs-${seq}-${safe}`,
    seq,
    user_id: userId,
    origin: { source: 'test', command: 'phase4b' },
    prev_pair_ref: previous ? observationPairRefForTest(previous) : null,
    payload_redacted: { kind: 'conversation_pair_v1', safe, redacted_fixture: true },
    created_at: createdAt,
  };
  return { ...base, checksum: observationChecksumForTest(base) };
}

function modelOutput(records, overrides = {}) {
  return {
    schema_version: 1,
    user_id: overrides.user_id || 'owner',
    file_generation: overrides.file_generation || 'active',
    batch_id: overrides.batch_id || 'model-batch-1',
    model: overrides.model || 'openai-codex/gpt-5.5',
    created_at: overrides.created_at || '2026-07-07T01:00:00.000Z',
    observations_read: overrides.observations_read || { seq_start: records[0].seq, seq_end: records.at(-1).seq, checksum: records.at(-1).checksum },
    proposals: overrides.proposals ?? [{
      proposal_id: 'model-proposal-1',
      kind: 'habit_candidate',
      candidate_key: 'concise-status-answer',
      condition: 'When answering status questions',
      behavior: 'Give a concise verified summary',
      polarity: 1,
      confidence_bp: 8800,
      source_refs: records.map((record) => ({ file_generation: record.file_generation, seq: record.seq, checksum: record.checksum })),
      evidence_summary: 'redacted model summary',
    }],
  };
}

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase4b-'));
const root = await ensurePrivateRoot(join(temp, 'state'));
const r1 = makeObservation({ seq: 1, createdAt: '2026-07-07T00:00:00.000Z', safe: 'prefers concise status' });
const r2 = makeObservation({ seq: 2, previous: r1, createdAt: '2026-07-07T00:01:00.000Z', safe: 'asks for verified summaries' });
const observations = validateObservationRecords({ records: [r1, r2], userId: 'owner', fileGeneration: 'active' });
const storage = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
try {
  const output = validateModelOutputBatch(modelOutput(observations), 'owner');
  assert.equal(output.checksum.length, 64);
  const proposalBatch = modelOutputToProposalBatch(output);
  assert.equal(proposalBatch.proposals.length, 1);
  assert.equal(proposalBatch.proposals[0].polarity, 1);

  const result = await processValidatedModelOutput({ db: storage.db, userId: 'owner', output, observations });
  assert.equal(result.candidate_ids.length, 1);
  assert.equal(result.evidence_ids.length, 1);
  assert.equal(result.read_watermark_after.seq, 2);
  assert.equal(selectStorageRecordsByUser(storage.db, 'habits', 'owner').length, 1);
  assert.equal(selectStorageRecordsByUser(storage.db, 'evidence', 'owner').length, 1);

  const repeated = validateModelOutputBatch(modelOutput(observations, { batch_id: 'model-batch-2', proposals: [{ ...modelOutput(observations).proposals[0], proposal_id: 'model-proposal-2' }] }), 'owner');
  const repeatResult = await processValidatedModelOutput({ db: storage.db, userId: 'owner', output: repeated, observations });
  assert.equal(repeatResult.inserted.candidates, 0, 're-extraction must not duplicate candidate');
  assert.equal(repeatResult.inserted.evidence, 0, 're-extraction must not duplicate evidence for same source refs');
  assert.equal(selectStorageRecordsByUser(storage.db, 'habits', 'owner').length, 1);
  assert.equal(selectStorageRecordsByUser(storage.db, 'evidence', 'owner').length, 1);

  const zero = validateModelOutputBatch(modelOutput(observations, { batch_id: 'zero-batch', proposals: [] }), 'owner');
  const zeroResult = await processValidatedModelOutput({ db: storage.db, userId: 'owner', output: zero, observations });
  assert.equal(zeroResult.candidate_ids.length, 0);
  assert.equal(zeroResult.read_watermark_after.seq, 2, 'zero-proposal output advances read coverage');

  assert.throws(() => validateModelOutputBatch({ ...modelOutput(observations), user_id: 'other' }, 'owner'), /user_id/i);
  assert.throws(() => validateModelOutputBatch({ ...modelOutput(observations), schema_version: 99 }, 'owner'), /schema_version/i);
  assert.throws(() => validateModelOutputBatch({ ...modelOutput(observations), proposals: [{ ...modelOutput(observations).proposals[0], ambiguous: true }] }, 'owner'), /Ambiguous/i);
  assert.throws(() => validateModelOutputBatch({ ...modelOutput(observations), proposals: [{ ...modelOutput(observations).proposals[0], source_refs: [] }] }, 'owner'), /source_refs/i);
  assert.throws(() => validateModelOutputBatch({ ...modelOutput(observations), proposals: [{ ...modelOutput(observations).proposals[0], condition: 'phase4b@example.invalid' }] }, 'owner'), /sensitive/i);
  assert.throws(() => validateModelOutputBatch(modelOutput(observations, { proposals: [{ ...modelOutput(observations).proposals[0], condition: 'When working on Agent Experience setup' }] }), 'owner'), /overfit/i, 'project-specific habit conditions must fail closed');
  assert.throws(() => validateModelOutputBatch(modelOutput(observations, { proposals: [{ ...modelOutput(observations).proposals[0], behavior: 'Remember screenshot b0ec176d640243aa for version 0.1.19' }] }), 'owner'), /overfit/i, 'version/hash/screenshot-specific habit behavior must fail closed');
  assert.throws(() => validateModelOutputBatch(modelOutput(observations, { proposals: [{ ...modelOutput(observations).proposals[0], condition: 'When editing /tmp/pi-experiences/index.ts' }] }), 'owner'), /sensitive|overfit/i, 'path-specific habit conditions must fail closed');
  assert.doesNotThrow(() => validateModelOutputBatch(modelOutput(observations, { batch_id: 'durable-tool-category', proposals: [{ ...modelOutput(observations).proposals[0], proposal_id: 'durable-tool-category-proposal', condition: 'When preparing an npm package release', behavior: 'Verify the end-to-end install and update path before calling it done' }] }), 'owner'), 'durable tool/task categories should remain allowed');
  assert.doesNotThrow(() => validateModelOutputBatch(modelOutput(observations, { batch_id: 'durable-ui-category', proposals: [{ ...modelOutput(observations).proposals[0], proposal_id: 'durable-ui-category-proposal', condition: 'When debugging Pi UI confusion', behavior: 'Inspect the real visible UI state before declaring the fix complete' }] }), 'owner'), 'durable Pi UI category should remain allowed');
  const missingSource = validateModelOutputBatch(modelOutput(observations, { batch_id: 'missing-source', proposals: [{ ...modelOutput(observations).proposals[0], proposal_id: 'missing-source-proposal', source_refs: [{ file_generation: 'active', seq: 2, checksum: '0'.repeat(64) }] }] }), 'owner');
  await assert.rejects(() => processValidatedModelOutput({ db: storage.db, userId: 'owner', output: missingSource, observations }), /checksum|source/i);
  assert.equal(storage.db.prepare('SELECT seq FROM proposal_read_watermarks WHERE user_id = ? AND file_generation = ?').get('owner', 'active').seq, 2, 'missing source failure must not advance read coverage');

  const correction = validateModelOutputBatch(modelOutput(observations, { batch_id: 'correction-batch', proposals: [{
    proposal_id: 'correction-1',
    kind: 'correction_split',
    candidate_key: 'answer-style-correction',
    old_condition: 'When answering status questions',
    old_behavior: 'Give long uncertain answers',
    new_condition: 'When answering status questions',
    new_behavior: 'Give concise verified answers',
    confidence_bp: 8100,
    source_refs: observations.map((record) => ({ file_generation: record.file_generation, seq: record.seq, checksum: record.checksum })),
  }] }), 'owner');
  const correctionBatch = modelOutputToProposalBatch(correction);
  assert.deepEqual(correctionBatch.proposals.map((proposal) => proposal.polarity), [-1, 1]);
  assert.equal(correctionBatch.proposals[1].behavior, 'Give concise verified answers', 'replacement behavior is positive, never negative');

  const conflictBadSource = validateModelOutputBatch(modelOutput(observations, { batch_id: 'conflict-bad-source', proposals: [
    { ...modelOutput(observations).proposals[0], proposal_id: 'conflict-bad-a', candidate_key: 'same-key', condition: 'When answering status questions', behavior: 'Give concise answers', source_refs: observations.map((record) => ({ file_generation: record.file_generation, seq: record.seq, checksum: '0'.repeat(64) })) },
    { ...modelOutput(observations).proposals[0], proposal_id: 'conflict-bad-b', candidate_key: 'same-key', condition: 'When answering status questions', behavior: 'Give very long answers', source_refs: observations.map((record) => ({ file_generation: record.file_generation, seq: record.seq, checksum: '0'.repeat(64) })) },
  ] }), 'owner');
  await assert.rejects(() => processValidatedModelOutput({ db: storage.db, userId: 'owner', output: conflictBadSource, observations }), /checksum/i, 'conflict path must reject forged source checksums before pending review');
  const conflict = validateModelOutputBatch(modelOutput(observations, { batch_id: 'conflict-batch', proposals: [
    { ...modelOutput(observations).proposals[0], proposal_id: 'conflict-a', candidate_key: 'same-key', condition: 'When answering status questions', behavior: 'Give concise answers' },
    { ...modelOutput(observations).proposals[0], proposal_id: 'conflict-b', candidate_key: 'same-key', condition: 'When answering status questions', behavior: 'Give very long answers' },
  ] }), 'owner');
  const conflictResult = await processValidatedModelOutput({ db: storage.db, userId: 'owner', output: conflict, observations });
  assert.ok(conflictResult.pending_review_id, 'merge conflict must route to pending review');
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS count FROM pending_review WHERE user_id = ? AND status = ?').get('owner', 'open').count, 1);
  assert.equal(conflictResult.read_watermark_after.seq, 2, 'pending-review conflict must return verified read coverage even on an idempotent range');
  assert.equal(storage.db.prepare('SELECT seq FROM proposal_read_watermarks WHERE user_id = ? AND file_generation = ?').get('owner', 'active').seq, 2, 'idempotent pending-review conflict must preserve verified read coverage');

  const quarantine = insertModelOutputQuarantine(storage.db, { userId: 'owner', fileGeneration: 'active', seqStart: 1, seqEnd: 2, reason: 'invalid_json', model: 'openai-codex/gpt-5.5', output: { bad: 'phase4b@example.invalid' }, createdAt: '2026-07-07T01:02:00.000Z' });
  const quarantineAgain = insertModelOutputQuarantine(storage.db, { userId: 'owner', fileGeneration: 'active', seqStart: 1, seqEnd: 2, reason: 'invalid_json', model: 'openai-codex/gpt-5.5', output: { bad: 'phase4b@example.invalid' }, createdAt: '2026-07-07T01:02:00.000Z' });
  assert.equal(quarantine.inserted, true);
  assert.equal(quarantineAgain.inserted, false, 'quarantine rerun must be idempotent');
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS count FROM model_output_quarantine WHERE user_id = ?').get('owner').count, 1);
  assert.equal(canonicalJson(storage.db.prepare('SELECT output_json FROM model_output_quarantine').all()).includes('phase4b@example.invalid'), false, 'quarantine output must be redacted');
  assert.equal(storage.db.prepare('SELECT seq FROM proposal_read_watermarks WHERE user_id = ? AND file_generation = ?').get('owner', 'active').seq, 2, 'quarantine must not advance read coverage');

  const r3 = makeObservation({ seq: 3, previous: r2, createdAt: '2026-07-07T00:02:00.000Z', safe: 'third' });
  const r4 = makeObservation({ seq: 4, previous: r3, createdAt: '2026-07-07T00:03:00.000Z', safe: 'fourth' });
  const fourObservations = validateObservationRecords({ records: [r1, r2, r3, r4], userId: 'owner', fileGeneration: 'active' });
  const skipped = validateModelOutputBatch(modelOutput(fourObservations, { batch_id: 'skip-batch', observations_read: { seq_start: 4, seq_end: 4, checksum: fourObservations.at(-1).checksum }, proposals: [] }), 'owner');
  await assert.rejects(() => processValidatedModelOutput({ db: storage.db, userId: 'owner', output: skipped, observations: fourObservations }), /skip/i);
  assert.equal(storage.db.prepare('SELECT seq FROM proposal_read_watermarks WHERE user_id = ? AND file_generation = ?').get('owner', 'active').seq, 2, 'skipped coverage failure must not advance read coverage');

  const nextObservations = fourObservations.slice(2);
  const nextConflictBase = modelOutput(nextObservations).proposals[0];
  const nextConflict = validateModelOutputBatch(modelOutput(nextObservations, { batch_id: 'next-conflict-batch', proposals: [
    { ...nextConflictBase, proposal_id: 'next-conflict-a', candidate_key: 'same-next-key', behavior: 'Give concise answers' },
    { ...nextConflictBase, proposal_id: 'next-conflict-b', candidate_key: 'same-next-key', behavior: 'Give detailed answers' },
  ] }), 'owner');
  const nextConflictResult = await processValidatedModelOutput({ db: storage.db, userId: 'owner', output: nextConflict, observations: fourObservations });
  assert.ok(nextConflictResult.pending_review_id, 'a later conflict range must route to pending review');
  assert.equal(nextConflictResult.read_watermark_after.seq, 4, 'pending-review conflict must atomically advance verified read coverage so manual Analyze can continue');
  assert.equal(storage.db.prepare('SELECT seq FROM proposal_read_watermarks WHERE user_id = ? AND file_generation = ?').get('owner', 'active').seq, 4, 'pending-review conflict coverage must persist');

  const payload = buildProposalModelPayloadForTest({ userId: 'owner', model: 'openai-codex/gpt-5.5', observations });
  assert.equal(canonicalJson(payload).includes('phase4b@example.invalid'), false, 'model payload must use redacted/safe observations only');
  assert.ok(payload.instructions.some((line) => /reusable behavioral essence/.test(line)), 'model prompt must require generalized habits, not project-specific summaries');
  assert.ok(payload.instructions.some((line) => /Do not overfit/.test(line)), 'model prompt must forbid overfitting to project/package/tool names');
  assert.ok(payload.instructions.some((line) => /When preparing a release/.test(line)), 'model prompt must show generalized condition example');
  assert.ok(payload.instructions.some((line) => /no proposal/.test(line)), 'model prompt must suppress project-specific-only patterns');
  let seenPayload;
  const proposed = await proposeFromObservations({ userId: 'owner', model: 'openai-codex/gpt-5.5', observations, callModel: (request) => { seenPayload = request.payload; return modelOutput(observations, { batch_id: 'adapter-batch' }); } });
  assert.equal(proposed.batch_id, 'adapter-batch');
  assert.ok(seenPayload);
  assert.equal(canonicalJson(seenPayload).includes('phase4b@example.invalid'), false);
  const piiObservation = validateObservationRecords({ records: [makeObservation({ seq: 1, createdAt: '2026-07-07T00:00:00.000Z', safe: 'phase4b@example.invalid' })], userId: 'owner', fileGeneration: 'active' });
  await assert.rejects(() => proposeFromObservations({ userId: 'owner', model: 'openai-codex/gpt-5.5', observations: piiObservation, callModel: () => modelOutput(piiObservation) }), /unredacted sensitive/i);

  // Aligned with the real consolidation adapter: any provider/model-formatted id is accepted and the default timeout matches (120 s, not the removed 1.5 s).
  let altModelSeen;
  let altTimeoutSeen;
  const altProposed = await proposeFromObservations({ userId: 'owner', model: 'anthropic/claude-fable-5', observations, callModel: (request) => { altModelSeen = request.model; altTimeoutSeen = request.timeout_ms; return modelOutput(observations, { batch_id: 'alt-model-batch', model: 'anthropic/claude-fable-5' }); } });
  assert.equal(altProposed.batch_id, 'alt-model-batch');
  assert.equal(altModelSeen, 'anthropic/claude-fable-5', 'consolidation propose path must no longer hardcode one model');
  assert.equal(altTimeoutSeen, 120000, 'default consolidation timeout must match the adapter contract, not the legacy 1.5 s');
  await assert.rejects(() => proposeFromObservations({ userId: 'owner', model: 'no-slash-model', observations, callModel: () => modelOutput(observations) }), /Unsupported consolidation model/);
  await assert.rejects(() => proposeFromObservations({ userId: 'owner', model: '/leading-slash', observations, callModel: () => modelOutput(observations) }), /Unsupported consolidation model/);
  // Nested provider/model ids (e.g. an OpenRouter path) must be accepted exactly as the production adapter's parseProviderModel accepts them.
  const nestedProposed = await proposeFromObservations({ userId: 'owner', model: 'openrouter/deepseek/deepseek-v4-pro', observations, callModel: (request) => { assert.equal(request.model, 'openrouter/deepseek/deepseek-v4-pro'); return modelOutput(observations, { batch_id: 'nested-model-batch', model: 'openrouter/deepseek/deepseek-v4-pro' }); } });
  assert.equal(nestedProposed.batch_id, 'nested-model-batch');
} finally {
  storage.db.close();
}

await rm(temp, { recursive: true, force: true });
console.log('agent-experience phase4b model-output checks passed');
