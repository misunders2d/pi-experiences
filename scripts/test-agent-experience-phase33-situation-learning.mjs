import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCapturedCausalContext } from '../extensions/agent-experience/src/capture/lineage.ts';
import { checksumJson, sha256Hex } from '../extensions/agent-experience/src/storage/checksum.ts';
import { initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { buildCompactHabitContext } from '../extensions/agent-experience/src/consolidate/context.ts';
import { __normalizeAgentExperienceConsolidationModelOutputForTest as normalize, __runAgentExperienceAllOffForTest, __setAgentExperienceAllOffSystemdForTest } from '../extensions/agent-experience/index.ts';
import { getProposalReadWatermark } from '../extensions/agent-experience/src/consolidate/commit.ts';
import { activationEligibilityFromHabit } from '../extensions/agent-experience/src/review.ts';
import { runConsolidationOnce } from '../extensions/agent-experience/src/consolidate/runner.ts';
import { acquireOwnedLock } from '../extensions/agent-experience/src/storage/locks.ts';
import { appendObservation } from '../extensions/agent-experience/src/storage/observations.ts';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { getAgentExperiencePaths, readAgentExperienceConfig, writeAgentExperienceConfig } from '../extensions/agent-experience/src/paths.ts';

const execFileAsync = promisify(execFile);
import {
  EPISODE_FRONTIER_KIND,
  MAX_EPISODE_FRONTIERS_PER_USER,
  buildSituationBatch,
  clampAndPurgeEpisodeFrontiers,
  persistedSituationEvidence,
  situationEvidenceEligibility,
  validateSituationEvidenceForProposal,
} from '../extensions/agent-experience/src/consolidate/situations.ts';

const h = value => sha256Hex(String(value));
const userId = 'owner';

function observation({ generation, seq, createdAt, lineage, turn, parent = null, user = 'request', assistant = 'answer', known = true, prior }) {
  const base = {
    id: `obs-${generation}-${seq}`,
    seq,
    user_id: userId,
    origin: { source: 'local_interactive' },
    prev_pair_ref: prior ? `${prior.seq}:${prior.checksum}` : null,
    payload_redacted: {
      kind: 'conversation_pair_v1',
      close_reason: 'agent_settled',
      user_text_redacted: user,
      assistant_text_redacted: assistant,
      user_char_count: user.length,
      assistant_char_count: assistant.length,
      input_created_at: createdAt,
      completed_at: createdAt,
      causal_context: { lineage_ref: lineage, turn_ref: turn, parent_turn_ref: parent, independence_known: known },
    },
    created_at: createdAt,
  };
  return { ...base, checksum: checksumJson(base), file_generation: generation };
}

function assessmentsFor(batch, admissible = new Map()) {
  return batch.units.filter(unit => admissible.has(unit.evidence_unit_ref)).map(unit => {
    const accepted = admissible.get(unit.evidence_unit_ref);
    const sourceText = unit.kind === 'linked_turn' ? unit.linked_user_turn_redacted : unit.user_statement_redacted;
    return {
      unit_ref: unit.evidence_unit_ref,
      objective: unit.situation_redacted || unit.user_statement_redacted || 'No durable objective established',
      constraints: [],
      consequential_action: unit.action_redacted || 'No consequential assistant action established',
      actual_user_feedback: accepted || 'unknown',
      support_quotes: accepted ? [{ role: 'user', quote: sourceText }] : [],
      mechanism: { classification: accepted ? 'inferred' : 'unknown', summary: accepted ? 'User-role evidence supports this bounded interpretation' : 'No reusable mechanism established' },
      unknowns: accepted ? ['Broader applicability still requires independent evidence'] : ['Whether this turn contains reusable feedback'],
      applicability: accepted ? 'Comparable future situations' : 'Not established',
      exceptions: [],
      durability: accepted ? 'durable_reusable' : 'task_local',
    };
  });
}

function rawOutput(batch, batchId, proposals = [], admissible = new Map()) {
  return { batch_id: batchId, assessments: assessmentsFor(batch, admissible), proposals };
}

function modelInput(observations, situationBatch, habitContext = []) {
  const first = observations[0];
  const last = observations.at(-1);
  return {
    model: 'test/model', userId, observations, habitContext, situationBatch,
    expected: { file_generation: first.file_generation, seq_start: first.seq, seq_end: last.seq, read_checksum: last.checksum },
  };
}

function rowData(db, id) {
  const row = db.prepare('SELECT * FROM habits WHERE id = ?').get(id);
  return { row, data: JSON.parse(row.data_json) };
}

// Capture identity: branch replay is stable; copied fork roots stay one lineage;
// parented empty-history forks conservatively become independence-unknown.
const rootEntry = { type: 'message', id: 'u-root', parentId: null, timestamp: '2026-07-01T00:00:00.000Z', message: { role: 'user' } };
const answerEntry = { type: 'message', id: 'a-root', parentId: 'u-root', timestamp: '2026-07-01T00:00:01.000Z', message: { role: 'assistant' } };
const manager = (branch, header) => ({ getBranch: () => branch, getHeader: () => header });
const original = resolveCapturedCausalContext(manager([rootEntry, answerEntry], { timestamp: '2026-07-01T00:00:00.000Z' }), null);
const copiedFork = resolveCapturedCausalContext(manager([rootEntry, answerEntry], { timestamp: '2026-07-02T00:00:00.000Z', parentSession: '/not-persisted' }), null);
assert.ok(original && copiedFork);
assert.equal(copiedFork.lineage_ref, original.lineage_ref);
assert.equal(copiedFork.turn_ref, original.turn_ref);
assert.equal(copiedFork.independence_known, true);
const newForkRoot = { ...rootEntry, id: 'new-root', timestamp: '2026-07-03T00:00:01.000Z' };
assert.equal(resolveCapturedCausalContext(manager([newForkRoot], { timestamp: '2026-07-03T00:00:00.000Z', parentSession: '/not-persisted' }), null)?.independence_known, false);
assert.equal(resolveCapturedCausalContext(manager([rootEntry, { ...newForkRoot, parentId: rootEntry.id }], { timestamp: '2026-07-01T00:00:00.000Z' }), null), undefined, 'ambiguous multiple later users must abstain');

const root = await mkdtemp(join(tmpdir(), 'pi-exp-situations-'));
try {
  const storage = await initExperienceStorage(root, { allowInit: true, userId });
  const { db } = storage;

  // Cross-generation late feedback resolves only through a checksum-protected frontier.
  const lineage = h('late-lineage');
  const actionTurn = h('late-action');
  const action = observation({ generation: 'g1', seq: 1, createdAt: '2026-07-01T00:00:00.000Z', lineage, turn: actionTurn, user: 'Draft a concise summary', assistant: 'Long summary' });
  const frontierBatch = buildSituationBatch(db, { userId, observations: [action], retentionDays: 7, now: '2026-07-01T01:00:00.000Z' });
  const zero1 = normalize(rawOutput(frontierBatch, 'zero-1'), modelInput([action], frontierBatch), { habitsOnly: true });
  assert.equal((await runConsolidationOnce({ root, db, userId, observations: [action], modelOutput: zero1, model: 'test/model', situationBatch: frontierBatch, now: '2026-07-01T01:00:00.000Z' })).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contexts WHERE record_kind = ?').get(EPISODE_FRONTIER_KIND).count, 1);

  const feedback = observation({ generation: 'g2', seq: 1, createdAt: '2026-07-02T00:00:00.000Z', lineage, turn: h('late-feedback'), parent: actionTurn, user: 'This should be much shorter next time', assistant: 'Understood' });
  const lateBatch = buildSituationBatch(db, { userId, observations: [feedback], retentionDays: 7, now: '2026-07-02T01:00:00.000Z' });
  const lateOutcome = lateBatch.units.find(unit => unit.kind === 'linked_turn');
  assert.ok(lateOutcome);
  assert.equal(lateOutcome.historical_source_ref.file_generation, 'g1');
  assert.deepEqual(lateOutcome.current_source_refs.map(ref => ref.file_generation), ['g2']);
  assert.throws(() => validateSituationEvidenceForProposal({ source_refs: lateOutcome.current_source_refs, evidence_unit_refs: [h('forged')], evidence_basis: 'inferred_pattern' }, lateBatch), /unavailable/);
  const lateProposal = { proposal_id: 'p-late', kind: 'habit_candidate', candidate_key: 'concise', condition: 'When writing summaries', behavior: 'Keep the summary concise', polarity: 1, confidence_bp: 9000, evidence_unit_refs: [lateOutcome.evidence_unit_ref], evidence_basis: 'inferred_pattern', ambiguous: false };
  assert.throws(() => normalize({ batch_id: 'missing-assessment', assessments: [], proposals: [lateProposal] }, modelInput([feedback], lateBatch), { habitsOnly: true }), /inadmissible_situation_assessment/);
  const unrelated = rawOutput(lateBatch, 'unrelated', [lateProposal]);
  assert.throws(() => normalize(unrelated, modelInput([feedback], lateBatch), { habitsOnly: true }), /inadmissible_situation_assessment/, 'neutral next turn cannot become feedback');
  const forged = rawOutput(lateBatch, 'forged', [lateProposal], new Map([[lateOutcome.evidence_unit_ref, 'user_reported_feedback']]));
  forged.assessments.find(item => item.unit_ref === lateOutcome.evidence_unit_ref).support_quotes = [{ role: 'assistant', quote: lateOutcome.action_redacted }];
  assert.throws(() => normalize(forged, modelInput([feedback], lateBatch), { habitsOnly: true }), /role_bound_quote/);
  const inferredUnknown = rawOutput(lateBatch, 'inferred-unknown', [lateProposal], new Map([[lateOutcome.evidence_unit_ref, 'user_reported_feedback']]));
  inferredUnknown.assessments[0].mechanism = { classification: 'unknown', summary: 'Mechanism is not established' };
  assert.throws(() => normalize(inferredUnknown, modelInput([feedback], lateBatch), { habitsOnly: true }), /inadmissible_situation_assessment/, 'inferred lessons still require a supported mechanism');

  const lateOutput = normalize(rawOutput(lateBatch, 'late', [lateProposal], new Map([[lateOutcome.evidence_unit_ref, 'user_reported_feedback']])), modelInput([feedback], lateBatch), { habitsOnly: true });
  const lateResult = await runConsolidationOnce({ root, db, userId, observations: [feedback], modelOutput: lateOutput, model: 'test/model', situationBatch: lateBatch, now: '2026-07-02T01:00:00.000Z' });
  assert.equal(lateResult.ok, true);
  const lateCandidateId = lateResult.result.candidate_ids[0];
  const lateCandidate = rowData(db, lateCandidateId);
  assert.equal(lateCandidate.data.evidence_protocol, 'situation_v2');
  assert.equal(lateCandidate.data.evidence_units.length, 1);
  assert.equal(lateCandidate.data.review_status, 'collecting_evidence');
  assert.equal('exact_user_quote' in lateCandidate.data, false);
  const replayCounts = { habits: db.prepare('SELECT COUNT(*) count FROM habits').get().count, evidence: db.prepare('SELECT COUNT(*) count FROM evidence').get().count };
  await assert.rejects(() => runConsolidationOnce({ root, db, userId, observations: [feedback], modelOutput: lateOutput, model: 'test/model', situationBatch: lateBatch, now: '2026-07-02T01:00:00.000Z' }), /authoritative runner snapshot/, 'stale replay must fail before mutation');
  assert.deepEqual({ habits: db.prepare('SELECT COUNT(*) count FROM habits').get().count, evidence: db.prepare('SELECT COUNT(*) count FROM evidence').get().count }, replayCounts);

  // Three outcomes from three known lineages over two days become reviewable.
  const records = [];
  const outcomeIds = [];
  let prior;
  for (let index = 0; index < 3; index++) {
    const l = h(`lineage-${index}`);
    const actionRef = h(`action-${index}`);
    const a = observation({ generation: 'g3', seq: records.length + 1, createdAt: index < 2 ? '2026-07-03T00:00:00.000Z' : '2026-07-04T00:00:00.000Z', lineage: l, turn: actionRef, user: 'Write a release summary', assistant: 'Verbose release summary', prior });
    records.push(a); prior = a;
    const f = observation({ generation: 'g3', seq: records.length + 1, createdAt: index < 2 ? '2026-07-03T00:01:00.000Z' : '2026-07-04T00:01:00.000Z', lineage: l, turn: h(`feedback-${index}`), parent: actionRef, user: 'Shorter is better', assistant: 'Okay', prior });
    records.push(f); prior = f;
  }
  const repeatedBatch = buildSituationBatch(db, { userId, observations: records, retentionDays: 7, now: '2026-07-04T01:00:00.000Z' });
  outcomeIds.push(...repeatedBatch.units.filter(unit => unit.kind === 'linked_turn').map(unit => unit.evidence_unit_ref));
  assert.equal(outcomeIds.length, 3);
  const repeatedOutput = normalize(rawOutput(repeatedBatch, 'repeated', [{ proposal_id: 'p-repeat', kind: 'habit_candidate', candidate_key: 'concise', condition: 'When writing summaries', behavior: 'Keep the summary concise', polarity: 1, confidence_bp: 9200, evidence_unit_refs: outcomeIds, evidence_basis: 'inferred_pattern', ambiguous: false }], new Map(outcomeIds.map(id => [id, 'user_reported_feedback']))), modelInput(records, repeatedBatch, buildCompactHabitContext(db, { userId })), { habitsOnly: true });
  const repeatedResult = await runConsolidationOnce({ root, db, userId, observations: records, modelOutput: repeatedOutput, model: 'test/model', situationBatch: repeatedBatch, now: '2026-07-04T01:00:00.000Z' });
  const repeatedCandidate = rowData(db, repeatedResult.result.candidate_ids[0]);
  assert.equal(repeatedCandidate.data.review_status, 'awaiting_review');
  assert.deepEqual(activationEligibilityFromHabit(repeatedCandidate.row), { eligible: true, unique_observations: 4, distinct_days: 3, dates: ['2026-07-02', '2026-07-03', '2026-07-04'] });
  const sameLineage = persistedSituationEvidence(repeatedBatch.units.filter(unit => unit.kind === 'linked_turn').map(unit => ({ ...unit, lineage_ref: h('one-lineage') })), 'inferred_pattern');
  assert.equal(situationEvidenceEligibility({}, sameLineage, 'inferred_pattern').independent_lineages, 1, 'branches/turns from one lineage count once');

  // One exact explicit durable preference is reviewable, but its quotation is transient.
  const explicit = observation({ generation: 'g4', seq: 1, createdAt: '2026-07-05T00:00:00.000Z', lineage: h('explicit-lineage'), turn: h('explicit-turn'), user: 'Always keep my release summaries under five bullets', assistant: 'Understood' });
  const explicitBatch = buildSituationBatch(db, { userId, observations: [explicit], retentionDays: 7, now: '2026-07-05T01:00:00.000Z' });
  const statement = explicitBatch.units.find(unit => unit.kind === 'explicit_user_statement');
  const exactQuote = 'Always keep my release summaries under five bullets';
  const explicitRaw = rawOutput(explicitBatch, 'explicit', [{ proposal_id: 'p-explicit', kind: 'habit_candidate', candidate_key: 'five-bullets', condition: 'When writing release summaries', behavior: 'Use no more than five bullets', polarity: 1, confidence_bp: 9800, evidence_unit_refs: [statement.evidence_unit_ref], evidence_basis: 'explicit_durable_preference', exact_user_quote: exactQuote, ambiguous: false }], new Map([[statement.evidence_unit_ref, 'explicit_durable_preference']]));
  explicitRaw.assessments[0].mechanism = { classification: 'unknown', summary: 'No inferred causal mechanism is needed for an exact future preference' };
  const explicitOutput = normalize(explicitRaw, modelInput([explicit], explicitBatch), { habitsOnly: true });
  const explicitResult = await runConsolidationOnce({ root, db, userId, observations: [explicit], modelOutput: explicitOutput, model: 'test/model', situationBatch: explicitBatch, now: '2026-07-05T01:00:00.000Z' });
  const explicitCandidate = rowData(db, explicitResult.result.candidate_ids[0]);
  assert.equal(explicitCandidate.data.review_status, 'awaiting_review');
  assert.equal(activationEligibilityFromHabit(explicitCandidate.row).eligible, true);
  assert.equal(JSON.stringify(explicitCandidate.data).includes(exactQuote), false);
  assert.throws(() => validateSituationEvidenceForProposal({ source_refs: statement.current_source_refs, evidence_unit_refs: [statement.evidence_unit_ref], evidence_basis: 'explicit_durable_preference', exact_user_quote: 'not the exact statement' }, explicitBatch), /quote mismatch/);

  // Invalid output may quarantine, but cannot advance coverage or apply its frontier.
  const invalid = observation({ generation: 'g5', seq: 1, createdAt: '2026-07-06T00:00:00.000Z', lineage: h('invalid-lineage'), turn: h('invalid-turn') });
  const invalidBatch = buildSituationBatch(db, { userId, observations: [invalid], retentionDays: 7, now: '2026-07-06T01:00:00.000Z' });
  const contextsBefore = db.prepare('SELECT COUNT(*) count FROM contexts WHERE record_kind = ?').get(EPISODE_FRONTIER_KIND).count;
  const badOutput = normalize(rawOutput(invalidBatch, 'invalid'), modelInput([invalid], invalidBatch), { habitsOnly: true });
  badOutput.observations_read.checksum = h('wrong');
  const invalidResult = await runConsolidationOnce({ root, db, userId, observations: [invalid], modelOutput: badOutput, model: 'test/model', situationBatch: invalidBatch, now: '2026-07-06T01:00:00.000Z' });
  assert.equal(invalidResult.ok, false);
  assert.equal(getProposalReadWatermark(db, userId, 'g5'), null);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contexts WHERE record_kind = ?').get(EPISODE_FRONTIER_KIND).count, contextsBefore);

  // Cancellation between the read-only situation snapshot and model commit mutates nothing.
  const cancelled = observation({ generation: 'g-cancel', seq: 1, createdAt: '2026-07-06T02:00:00.000Z', lineage: h('cancel-lineage'), turn: h('cancel-turn') });
  const cancelContextsBefore = db.prepare('SELECT COUNT(*) count FROM contexts WHERE record_kind = ?').get(EPISODE_FRONTIER_KIND).count;
  const cancelledSnapshot = buildSituationBatch(db, { userId, observations: [cancelled], retentionDays: 7, now: '2026-07-06T03:00:00.000Z' });
  assert.ok(cancelledSnapshot.transition.upserts.length > 0);
  assert.equal(getProposalReadWatermark(db, userId, 'g-cancel'), null);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contexts WHERE record_kind = ?').get(EPISODE_FRONTIER_KIND).count, cancelContextsBefore);

  // A frontier write failure rolls candidate/read/frontier changes back together.
  const rollback = observation({ generation: 'g6', seq: 1, createdAt: '2026-07-07T00:00:00.000Z', lineage: h('rollback-lineage'), turn: h('rollback-turn') });
  const rollbackBatch = buildSituationBatch(db, { userId, observations: [rollback], retentionDays: 7, now: '2026-07-07T01:00:00.000Z' });
  const colliding = rollbackBatch.transition.upserts[0];
  insertStorageRecord(db, 'contexts', { id: colliding.id, userId, data: { record_kind: 'different_private_context_v1', schema_version: 1, status: 'active', marker: true }, now: '2026-07-07T00:30:00.000Z' });
  const rollbackOutput = normalize(rawOutput(rollbackBatch, 'rollback'), modelInput([rollback], rollbackBatch), { habitsOnly: true });
  await assert.rejects(() => runConsolidationOnce({ root, db, userId, observations: [rollback], modelOutput: rollbackOutput, model: 'test/model', situationBatch: rollbackBatch, now: '2026-07-07T01:00:00.000Z' }), /stable id collision/);
  assert.equal(getProposalReadWatermark(db, userId, 'g6'), null);

  // Capacity and expiry are deterministic; legacy/missing lineage creates no v2 units.
  const many = [];
  prior = undefined;
  for (let index = 0; index < 70; index++) {
    const item = observation({ generation: 'g7', seq: index + 1, createdAt: `2026-07-08T00:${String(index % 60).padStart(2, '0')}:00.000Z`, lineage: h(`capacity-lineage-${index}`), turn: h(`capacity-turn-${index}`), prior });
    many.push(item); prior = item;
  }
  const capacityBatch = buildSituationBatch(db, { userId, observations: many, retentionDays: 7, now: '2026-07-08T02:00:00.000Z' });
  const capacityOutput = normalize(rawOutput(capacityBatch, 'capacity'), modelInput(many, capacityBatch), { habitsOnly: true });
  await runConsolidationOnce({ root, db, userId, observations: many, modelOutput: capacityOutput, model: 'test/model', situationBatch: capacityBatch, now: '2026-07-08T02:00:00.000Z' });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contexts WHERE record_kind = ?').get(EPISODE_FRONTIER_KIND).count, MAX_EPISODE_FRONTIERS_PER_USER);
  db.exec('BEGIN IMMEDIATE');
  clampAndPurgeEpisodeFrontiers(db, { userId, retentionDays: 7, now: '2026-07-16T03:00:00.000Z' });
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contexts WHERE record_kind = ?').get(EPISODE_FRONTIER_KIND).count, 0);

  const alreadyExpired = observation({ generation: 'g-expired', seq: 1, createdAt: '2026-07-01T00:00:00.000Z', lineage: h('expired-lineage'), turn: h('expired-turn') });
  assert.equal(buildSituationBatch(db, { userId, observations: [alreadyExpired], retentionDays: 7, now: '2026-07-09T00:00:00.000Z' }).transition.upserts.length, 0, 'old observations do not get a fresh retention window');
  const shorten = observation({ generation: 'g-shorten', seq: 1, createdAt: '2026-07-10T00:00:00.000Z', lineage: h('shorten-lineage'), turn: h('shorten-turn') });
  const shortenBatch = buildSituationBatch(db, { userId, observations: [shorten], retentionDays: 30, now: '2026-07-11T00:00:00.000Z' });
  const shortenOutput = normalize(rawOutput(shortenBatch, 'shorten'), modelInput([shorten], shortenBatch), { habitsOnly: true });
  await runConsolidationOnce({ root, db, userId, observations: [shorten], modelOutput: shortenOutput, model: 'test/model', situationBatch: shortenBatch, config: { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, observation_retention_days: 30 }, now: '2026-07-11T00:00:00.000Z' });
  db.exec('BEGIN IMMEDIATE');
  clampAndPurgeEpisodeFrontiers(db, { userId, retentionDays: 7, now: '2026-07-18T00:00:00.000Z' });
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contexts WHERE record_kind = ?').get(EPISODE_FRONTIER_KIND).count, 0, 'shortened retention is anchored to observed_at');

  const legacyBase = { id: 'legacy', seq: 1, user_id: userId, origin: { source: 'test' }, prev_pair_ref: null, payload_redacted: { kind: 'conversation_pair_v1', user_text_redacted: 'legacy', assistant_text_redacted: 'legacy answer' }, created_at: '2026-07-20T00:00:00.000Z' };
  const legacy = { ...legacyBase, checksum: checksumJson(legacyBase), file_generation: 'g8' };
  assert.equal(buildSituationBatch(db, { userId, observations: [legacy], retentionDays: 7, now: '2026-07-20T01:00:00.000Z' }).units.length, 0);
  // Max configured 500-record input keeps later sources represented while output may assess none or <=6 cited units.
  const maxRecords = [];
  let maxPrior;
  for (let index = 0; index < 500; index++) {
    const pair = index < 12;
    const pairIndex = Math.floor(index / 2);
    const isFeedback = pair && index % 2 === 1;
    const record = observation({ generation: 'g-max', seq: index + 1, createdAt: index < 250 ? '2026-07-20T04:00:00.000Z' : '2026-07-21T04:00:00.000Z', lineage: h(`max-lineage-${pair ? pairIndex : index}`), turn: h(`max-turn-${index}`), parent: isFeedback ? h(`max-turn-${index - 1}`) : null, user: isFeedback ? 'Use the saved state instead of restarting' : `Bounded request ${index}`, assistant: 'Bounded action', prior: maxPrior });
    maxRecords.push(record); maxPrior = record;
  }
  const maxBatch = buildSituationBatch(db, { userId, observations: maxRecords, retentionDays: 7, now: '2026-07-21T05:00:00.000Z' });
  assert.ok(maxBatch.units.some(unit => unit.current_source_refs.some(ref => ref.seq === 500)), 'input-unit bound must not discard later captured sources before watermark advance');
  assert.equal(normalize({ batch_id: 'max-empty', assessments: [], proposals: [] }, modelInput(maxRecords, maxBatch), { habitsOnly: true }).proposals.length, 0);
  const citedSix = maxBatch.units.filter(unit => unit.kind === 'linked_turn').slice(0, 6);
  const citedProposal = { proposal_id: 'max-cited', kind: 'habit_candidate', candidate_key: 'resume-state', condition: 'When continuing saved work', behavior: 'Resume from saved state instead of restarting', polarity: 1, confidence_bp: 9000, evidence_unit_refs: citedSix.map(unit => unit.evidence_unit_ref), evidence_basis: 'inferred_pattern', ambiguous: false };
  const citedAssessments = new Map(citedSix.map(unit => [unit.evidence_unit_ref, 'user_reported_feedback']));
  assert.equal(normalize(rawOutput(maxBatch, 'max-cited', [citedProposal], citedAssessments), modelInput(maxRecords, maxBatch), { habitsOnly: true }).proposals.length, 1, 'bounded six-assessment cited subset is valid');
  const sevenLinked = maxBatch.units.slice(0, 7);
  assert.throws(() => normalize(rawOutput(maxBatch, 'too-many-assessments', [], new Map(sevenLinked.map(unit => [unit.evidence_unit_ref, 'user_reported_feedback']))), modelInput(maxRecords, maxBatch), { habitsOnly: true }), /invalid_situation_assessments/, 'assessment output cap is six');
  assert.throws(() => normalize(rawOutput(maxBatch, 'too-many-proposals', [citedProposal, { ...citedProposal, proposal_id: 'max-cited-2' }, { ...citedProposal, proposal_id: 'max-cited-3' }, { ...citedProposal, proposal_id: 'max-cited-4' }], citedAssessments), modelInput(maxRecords, maxBatch), { habitsOnly: true }), /invalid_proposal_count/, 'new contract permits at most three proposals');
  const missingCited = rawOutput(maxBatch, 'max-missing', [citedProposal], new Map(citedSix.slice(0, 5).map(unit => [unit.evidence_unit_ref, 'user_reported_feedback'])));
  assert.throws(() => normalize(missingCited, modelInput(maxRecords, maxBatch), { habitsOnly: true }), /inadmissible_situation_assessment/, 'every cited unit needs assessment');

  const advisorBase = { id: 'advisor', seq: 1, user_id: userId, origin: { source: 'advisor_finding' }, prev_pair_ref: null, payload_redacted: { kind: 'advisor_finding_v1', event_fingerprint: h('advisor-event'), primary_behavior_redacted: 'Assistant claim', approved_behavior_redacted: 'Advisor concern' }, created_at: '2026-07-20T02:00:00.000Z' };
  const advisor = { ...advisorBase, checksum: checksumJson(advisorBase), file_generation: 'g-advisor' };
  const habitCountBeforeAdvisor = db.prepare('SELECT COUNT(*) count FROM habits').get().count;
  const advisorResult = await runConsolidationOnce({ root, db, userId, observations: [advisor], modelOutput: { batch_id: 'advisor-bypass', proposals: [{ proposal_id: 'advisor-p', kind: 'habit_candidate', candidate_key: 'advisor', condition: 'When doing work', behavior: 'Follow the advisor concern', polarity: 1, confidence_bp: 9000, source_refs: [{ file_generation: 'g-advisor', seq: 1, checksum: advisor.checksum }], ambiguous: false }] }, model: 'test/model', config: DEFAULT_AGENT_EXPERIENCE_CONFIG, now: '2026-07-20T03:00:00.000Z' });
  assert.equal(advisorResult.ok, false, 'Advisor output cannot bypass assessment and lineage gates');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM habits').get().count, habitCountBeforeAdvisor);
  const advisorQuarantine = db.prepare("SELECT output_json FROM model_output_quarantine WHERE file_generation='g-advisor'").get();
  assert.ok(advisorQuarantine && !advisorQuarantine.output_json.includes('Advisor concern') && !advisorQuarantine.output_json.includes('Follow the advisor'), 'new-contract quarantine stores static metadata only');

  // All-off must acquire Analyze lock before even inspecting or mutating systemd/config.
  const oldRootEnv = process.env.AX_STATE_ROOT;
  const offRoot = join(root, 'all-off-busy');
  process.env.AX_STATE_ROOT = offRoot;
  await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, capture_enabled: true, consolidation_enabled: true, timer_enabled: true }, getAgentExperiencePaths());
  const heldAnalyze = await acquireOwnedLock(offRoot, 'analyze', { waitMs: 0 });
  let systemdCalls = 0;
  __setAgentExperienceAllOffSystemdForTest({ inspect: async () => { systemdCalls += 1; throw new Error('must not inspect while busy'); }, disable: async () => { systemdCalls += 1; } });
  try {
    const notices = [];
    await __runAgentExperienceAllOffForTest({ ui: { notify: message => notices.push(message) } });
    assert.equal(systemdCalls, 0);
    assert.equal((await readAgentExperienceConfig(getAgentExperiencePaths())).config.enabled, true);
    assert.ok(notices.some(message => String(message).includes('Analyze is active')));
  } finally {
    __setAgentExperienceAllOffSystemdForTest();
    await heldAnalyze.release();
  }

  // Actual source CLI path cannot accept causal observations without assessment proof.
  const cliRoot = join(root, 'cli-missing-proof');
  process.env.AX_STATE_ROOT = cliRoot;
  await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, consolidation_enabled: true, consolidation_model: 'test/model' }, getAgentExperiencePaths());
  await appendObservation(cliRoot, { userId, origin: { source: 'local_interactive' }, payload: { kind: 'conversation_pair_v1', user_text_redacted: 'Keep this concise', assistant_text_redacted: 'Done', causal_context: { lineage_ref: h('cli-lineage'), turn_ref: h('cli-turn'), parent_turn_ref: null, independence_known: true } }, createdAt: '2026-07-21T00:00:00.000Z' });
  const fixturePath = join(cliRoot, 'missing-proof.json');
  await writeFile(fixturePath, JSON.stringify({ batch_id: 'cli-missing-proof', proposals: [] }));
  await assert.rejects(
    () => execFileAsync(process.execPath, ['--experimental-strip-types', './bin/experience-consolidate.mjs', 'now', '--root', cliRoot, '--fixture-output', fixturePath], { cwd: new URL('..', import.meta.url), env: { ...process.env, AX_STATE_ROOT: cliRoot } }),
    error => error.code === 2 && String(error.stdout).includes('invalid_situation_assessments'),
  );
  if (oldRootEnv === undefined) delete process.env.AX_STATE_ROOT; else process.env.AX_STATE_ROOT = oldRootEnv;

  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('agent-experience phase33 situation learning checks passed');
