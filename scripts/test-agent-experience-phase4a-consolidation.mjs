#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension from '../extensions/agent-experience/index.ts';
import { getAgentExperiencePaths } from '../extensions/agent-experience/src/paths.ts';
import { canonicalJson } from '../extensions/agent-experience/src/storage/checksum.ts';
import { ensurePrivateRoot, resolvePrivatePath } from '../extensions/agent-experience/src/storage/private-root.ts';
import { buildTypedStorageRow, initExperienceStorage, insertStorageRecord, selectStorageRecordsByUser, loadSqlite } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { observationChecksumForTest, observationPairRefForTest } from '../extensions/agent-experience/src/storage/observations.ts';
import { validateObservationRecords, readValidatedObservationGeneration } from '../extensions/agent-experience/src/consolidate/observations.ts';
import { validateProposalBatch } from '../extensions/agent-experience/src/consolidate/proposals.ts';
import { consolidateProposalBatch } from '../extensions/agent-experience/src/consolidate/commit.ts';
import { calculateStaleness, hasRepetitionEligibility, recentContradictionCount } from '../extensions/agent-experience/src/consolidate/math.ts';

function makePi() {
  const commands = new Map();
  const handlers = new Map();
  const fakePi = {
    registerCommand(name, options) { commands.set(name, options); },
    on(event, handler) { handlers.set(event, handler); },
    registerTool() {},
    registerFlag() { throw new Error('no flags'); },
    registerShortcut() { throw new Error('no shortcuts'); },
  };
  agentExperienceExtension(fakePi);
  return { commands, handlers };
}

function ctx(notes = []) {
  return { cwd: process.cwd(), ui: { notify(message, level) { notes.push({ message, level }); } } };
}

function makeObservation({ seq, userId = 'owner', previous = null, createdAt, safe }) {
  const base = {
    id: `obs-${seq}-${safe}`,
    seq,
    user_id: userId,
    origin: { source: 'test', command: 'phase4a' },
    prev_pair_ref: previous ? observationPairRefForTest(previous) : null,
    payload_redacted: { kind: 'conversation_pair_v1', safe, redacted_fixture: true },
    created_at: createdAt,
  };
  return { ...base, checksum: observationChecksumForTest(base) };
}

async function writeObservationFile(root, fileName, records) {
  await ensurePrivateRoot(root);
  await writeFile(resolvePrivatePath(root, fileName), records.map((record) => canonicalJson(record)).join('\n') + '\n', { mode: 0o600 });
}

function validBatch(records, overrides = {}) {
  return {
    schema_version: 1,
    user_id: overrides.user_id || 'owner',
    batch_id: overrides.batch_id || 'batch-1',
    created_at: overrides.created_at || '2026-07-07T00:10:00.000Z',
    proposals: overrides.proposals || [{
      proposal_id: 'proposal-1',
      kind: 'habit_candidate',
      candidate_key: 'concise-answer-style',
      condition: 'When answering simple status questions',
      behavior: 'Answer with a concise verified summary',
      polarity: 1,
      confidence_bp: 9000,
      source_refs: records.map((record) => ({ file_generation: record.file_generation || 'active', seq: record.seq, checksum: record.checksum })),
      evidence_summary: 'pre-redacted fixture summary',
    }],
  };
}

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase4a-'));
process.env.AX_STATE_ROOT = join(temp, 'state-noop');
process.env.AX_USER_ID = 'owner';
const paths = getAgentExperiencePaths();
const { commands, handlers } = makePi();
assert.deepEqual([...commands.keys()], ['experience']);
assert.deepEqual([...handlers.keys()].sort(), ['agent_end', 'agent_settled', 'before_agent_start', 'before_provider_request', 'context', 'input', 'session_before_compact', 'session_compact', 'session_shutdown', 'session_start', 'tool_execution_end', 'tool_execution_start']);
assert.equal(existsSync(paths.root), false, 'import/load must not create state');
await commands.get('experience').handler('status', ctx());
assert.equal(existsSync(paths.root), false, 'status must not create state');

const root = await ensurePrivateRoot(join(temp, 'state'));
const r1 = makeObservation({ seq: 1, createdAt: '2026-07-05T00:00:00.000Z', safe: 'day1-a phase4a@example.invalid' });
const r2 = makeObservation({ seq: 2, previous: r1, createdAt: '2026-07-05T01:00:00.000Z', safe: 'day1-b' });
const r3 = makeObservation({ seq: 3, previous: r2, createdAt: '2026-07-06T00:00:00.000Z', safe: 'day2-a' });
await writeObservationFile(root, 'observations.jsonl', [r1, r2, r3]);
const observations = await readValidatedObservationGeneration(root, { file_generation: 'active', path: 'observations.jsonl' }, 'owner');
assert.deepEqual(observations.map((record) => record.seq), [1, 2, 3]);
assert.equal(observations[0].file_generation, 'active');

assert.throws(() => validateObservationRecords({ records: [{ ...r1, checksum: 'bad' }], userId: 'owner', fileGeneration: 'active' }), /checksum/i);
assert.throws(() => validateObservationRecords({ records: [{ ...r1, user_id: 'other' }], userId: 'owner', fileGeneration: 'active' }), /user_id/i);
assert.throws(() => validateObservationRecords({ records: [{ ...r1, origin: { source: 'rpc' } }], userId: 'owner', fileGeneration: 'active' }), /origin/i);
assert.throws(() => validateObservationRecords({ records: [{ ...r1, payload_redacted: { kind: 'unknown' } }], userId: 'owner', fileGeneration: 'active' }), /payload kind/i);
assert.throws(() => validateObservationRecords({ records: [{ ...r1, file_generation: 'active' }], userId: 'owner', fileGeneration: 'active' }), /unsupported field/i);
const gap = makeObservation({ seq: 3, previous: r1, createdAt: '2026-07-06T00:00:00.000Z', safe: 'gap' });
assert.throws(() => validateObservationRecords({ records: [r1, gap], userId: 'owner', fileGeneration: 'active' }), /seq/i);

const batch = validBatch(observations);
const validatedBatch = validateProposalBatch(batch, 'owner');
assert.equal(validatedBatch.checksum.length, 64);
assert.throws(() => validateProposalBatch({ ...batch, user_id: 'other' }, 'owner'), /user_id/i);
assert.throws(() => validateProposalBatch({ ...batch, proposals: [{ ...batch.proposals[0], ambiguous: true }] }, 'owner'), /Ambiguous/i);
assert.throws(() => validateProposalBatch({ ...batch, proposals: [{ ...batch.proposals[0], source_refs: [] }] }, 'owner'), /source_refs/i);
assert.throws(() => validateProposalBatch({ ...batch, proposals: [{ ...batch.proposals[0], extra: true }] }, 'owner'), /unsupported field/i);

const storage = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
try {
  assert.equal(storage.db.prepare('PRAGMA user_version').get().user_version, 6);
  const result = await consolidateProposalBatch({ db: storage.db, userId: 'owner', proposalBatch: batch, observations });
  assert.equal(result.watermark_after.file_generation, 'active');
  assert.equal(result.watermark_after.seq, 3);
  assert.equal(result.watermark_after.checksum, r3.checksum);
  assert.equal(result.inserted.candidates, 1);
  assert.equal(result.inserted.evidence, 1);
  assert.equal(result.inserted.audit, 1);
  assert.equal(result.inserted.watermark, 1);
  const habitColumns = storage.db.prepare('PRAGMA table_info(habits)').all().map((row) => row.name);
  for (const column of ['record_kind', 'schema_version', 'status', 'condition', 'behavior', 'polarity', 'confidence_bp', 'activation', 'staleness', 'data_json', 'checksum']) assert.ok(habitColumns.includes(column), `typed habits column ${column} exists`);
  assert.ok(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_habits_user_status'").get());
  assert.throws(() => storage.db.prepare("INSERT INTO habits (id, user_id, record_kind, schema_version, status, polarity, confidence_bp, activation, staleness, data_json, checksum, created_at, updated_at) VALUES ('bad-status', 'owner', 'candidate_habit_v1', 2, 'pending_review', 0, 0, 0, 0, '{}', 'x', '2026-07-07T00:00:00.000Z', '2026-07-07T00:00:00.000Z')").run(), /constraint|CHECK/i);
  const habits = selectStorageRecordsByUser(storage.db, 'habits', 'owner');
  const evidence = selectStorageRecordsByUser(storage.db, 'evidence', 'owner');
  assert.equal(habits.length, 1);
  assert.equal(evidence.length, 1);
  assert.equal(habits[0].status, 'candidate');
  assert.equal(habits[0].record_kind, 'candidate_habit_v1');
  assert.equal(habits[0].condition, 'When answering simple status questions');
  assert.equal(habits[0].behavior, 'Answer with a concise verified summary');
  assert.equal(habits[0].confidence_bp, 9000);
  assert.equal(habits[0].polarity, 1);
  const habitData = JSON.parse(habits[0].data_json);
  assert.equal(habitData.active, false);
  assert.equal(habitData.injectable, false);
  const firstHabitRow = storage.db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?').get(result.candidate_ids[0], 'owner');
  const reviewedRow = buildTypedStorageRow('habits', { id: firstHabitRow.id, userId: 'owner', data: { ...JSON.parse(firstHabitRow.data_json), condition: firstHabitRow.condition, behavior: firstHabitRow.behavior, polarity: firstHabitRow.polarity, confidence_bp: firstHabitRow.confidence_bp, record_kind: firstHabitRow.record_kind, schema_version: firstHabitRow.schema_version, status: firstHabitRow.status, review_status: 'approved_pending_eligibility', active: false, injectable: false, law_hash: 'accepted-law-hash' }, createdAt: firstHabitRow.created_at, updatedAt: '2026-07-07T00:20:00.000Z' });
  storage.db.prepare('UPDATE habits SET data_json = ?, checksum = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(reviewedRow.data_json, reviewedRow.checksum, reviewedRow.updated_at, reviewedRow.id, reviewedRow.user_id);
  const dbText = canonicalJson([...habits, ...evidence, ...storage.db.prepare('SELECT data_json FROM consolidation_audit').all()]);
  assert.equal(dbText.includes('phase4a@example.invalid'), false, 'raw observation text must not be stored in consolidation rows');

  const rerun = await consolidateProposalBatch({ db: storage.db, userId: 'owner', proposalBatch: batch, observations });
  assert.equal(rerun.inserted.candidates, 0);
  assert.equal(rerun.inserted.evidence, 0);
  assert.equal(rerun.inserted.audit, 0);
  assert.equal(rerun.inserted.watermark, 0);
  assert.equal(selectStorageRecordsByUser(storage.db, 'habits', 'owner').length, 1);
  assert.equal(selectStorageRecordsByUser(storage.db, 'evidence', 'owner').length, 1);
  const mergedReviewedData = JSON.parse(storage.db.prepare('SELECT data_json FROM habits WHERE id = ?').get(result.candidate_ids[0]).data_json);
  assert.equal(mergedReviewedData.review_status, 'approved_pending_eligibility', 'candidate consolidation merge must preserve review marker');
  assert.equal(mergedReviewedData.law_hash, 'accepted-law-hash', 'candidate consolidation merge must preserve accept-time law metadata until promotion recheck');

  await assert.rejects(() => consolidateProposalBatch({ db: storage.db, userId: 'owner', proposalBatch: { ...batch, proposals: [{ ...batch.proposals[0], source_refs: [{ file_generation: 'rotated-fixture', seq: 1, checksum: r1.checksum }] }] }, observations }), /generation|Observation set mismatch|not found/i);
  const beforeWatermark = storage.db.prepare('SELECT seq, checksum FROM consolidation_watermarks WHERE user_id = ? AND file_generation = ?').get('owner', 'active');
  assert.equal(beforeWatermark.seq, 3);
  await assert.rejects(() => consolidateProposalBatch({ db: storage.db, userId: 'owner', proposalBatch: { ...batch, batch_id: 'bad-batch', proposals: [{ ...batch.proposals[0], proposal_id: 'bad-proposal', source_refs: [{ file_generation: 'active', seq: 2, checksum: '0'.repeat(64) }] }] }, observations }), /checksum/i);
  const afterFailed = storage.db.prepare('SELECT seq, checksum FROM consolidation_watermarks WHERE user_id = ? AND file_generation = ?').get('owner', 'active');
  assert.deepEqual(afterFailed, beforeWatermark, 'failed proposal must not advance watermark');
} finally {
  storage.db.close();
}

const rotatedRoot = await ensurePrivateRoot(join(temp, 'rotated'));
const a1 = makeObservation({ seq: 1, createdAt: '2026-07-05T00:00:00.000Z', safe: 'active-one' });
await writeObservationFile(rotatedRoot, 'observations.jsonl', [a1]);
const z1 = makeObservation({ seq: 1, createdAt: '2026-07-06T00:00:00.000Z', safe: 'rotated-one' });
await writeObservationFile(rotatedRoot, 'rotated-fixture.jsonl', [z1]);
const activeRecords = await readValidatedObservationGeneration(rotatedRoot, { file_generation: 'active', path: 'observations.jsonl' }, 'owner');
const rotatedRecords = await readValidatedObservationGeneration(rotatedRoot, { file_generation: 'rotated-fixture', path: 'rotated-fixture.jsonl' }, 'owner');
const rotatedStorage = await initExperienceStorage(rotatedRoot, { allowInit: true, userId: 'owner' });
try {
  await consolidateProposalBatch({ db: rotatedStorage.db, userId: 'owner', proposalBatch: validBatch(activeRecords, { batch_id: 'active-batch' }), observations: activeRecords });
  await consolidateProposalBatch({ db: rotatedStorage.db, userId: 'owner', proposalBatch: validBatch(rotatedRecords, { batch_id: 'rotated-batch', proposals: [{ ...validBatch(rotatedRecords).proposals[0], proposal_id: 'rotated-proposal', candidate_key: 'rotated-key', source_refs: rotatedRecords.map((record) => ({ file_generation: 'rotated-fixture', seq: record.seq, checksum: record.checksum })) }] }), observations: rotatedRecords });
  const watermarks = rotatedStorage.db.prepare('SELECT file_generation, seq, checksum FROM consolidation_watermarks WHERE user_id = ? ORDER BY file_generation').all('owner');
  assert.deepEqual(watermarks.map((row) => [row.file_generation, row.seq]), [['active', 1], ['rotated-fixture', 1]]);
  assert.notEqual(watermarks[0].checksum, watermarks[1].checksum, 'same seq in different generations must be distinct by checksum/generation');
  assert.equal(selectStorageRecordsByUser(rotatedStorage.db, 'habits', 'owner').length, 1, 'same normalized habit re-extracted from different generations merges to one typed candidate');
} finally {
  rotatedStorage.db.close();
}

assert.equal(calculateStaleness({ daysSinceLastAffirmation: 0, recentContradictionCount: 0 }), 0);
assert.ok(calculateStaleness({ daysSinceLastAffirmation: 0, recentContradictionCount: 1 }) > 0);
assert.ok(calculateStaleness({ daysSinceLastAffirmation: 10, recentContradictionCount: 0 }) > calculateStaleness({ daysSinceLastAffirmation: 1, recentContradictionCount: 0 }));
const stale = calculateStaleness({ daysSinceLastAffirmation: 1000, recentContradictionCount: 1000 });
assert.ok(stale >= 0 && stale < 1);
assert.throws(() => calculateStaleness({ daysSinceLastAffirmation: 1, recentContradictionCount: 0, lambda: 0 }), /lambda/i);
assert.throws(() => calculateStaleness({ daysSinceLastAffirmation: Number.NaN, recentContradictionCount: 0 }), /daysSinceLastAffirmation/i);
assert.throws(() => calculateStaleness({ daysSinceLastAffirmation: 1, recentContradictionCount: Number.POSITIVE_INFINITY }), /recentContradictionCount/i);
assert.equal(recentContradictionCount([
  { polarity: 1, confidence_bp: 7500, observed_at: '2026-07-01T00:00:00.000Z' },
  { polarity: -1, confidence_bp: 9000, observed_at: '2026-07-02T01:00:00.000Z' },
  { polarity: -1, confidence_bp: 9000, observed_at: '2026-07-02T02:00:00.000Z' },
  { polarity: -1, confidence_bp: 9000, observed_at: '2026-07-03T00:00:00.000Z' },
]), 2);
assert.equal(hasRepetitionEligibility(['2026-07-05T00:00:00.000Z', '2026-07-05T01:00:00.000Z', '2026-07-06T00:00:00.000Z']), true);
assert.equal(hasRepetitionEligibility(['2026-07-05T00:00:00.000Z', '2026-07-05T01:00:00.000Z', '2026-07-05T02:00:00.000Z']), false);
assert.throws(() => hasRepetitionEligibility(['not-a-date', '2026-07-05T01:00:00.000Z', '2026-07-06T02:00:00.000Z']), /Invalid evidence date/i);

const migrationRoot = await ensurePrivateRoot(join(temp, 'migration'));
const sqlite = await loadSqlite();
const oldDb = new sqlite.DatabaseSync(resolvePrivatePath(migrationRoot, 'ledger.sqlite'), { open: true });
oldDb.exec(`
CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE habits (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'owner', data_json TEXT NOT NULL, checksum TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE evidence (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'owner', data_json TEXT NOT NULL, checksum TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE contexts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'owner', data_json TEXT NOT NULL, checksum TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
INSERT INTO migrations (version, applied_at) VALUES (1, '2026-07-07T00:00:00.000Z');
PRAGMA user_version = 1;
`);
oldDb.close();
const migrated = await initExperienceStorage(migrationRoot, { allowInit: true, userId: 'owner' });
try {
  insertStorageRecord(migrated.db, 'habits', { id: 'legacy-compatible', userId: 'owner', data: { safe: true }, now: '2026-07-07T00:00:00.000Z' });
  assert.equal(selectStorageRecordsByUser(migrated.db, 'habits', 'owner').map((row) => row.id).includes('legacy-compatible'), true);
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 6);
  assert.ok(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='consolidation_watermarks'").get());
} finally {
  migrated.db.close();
}

await rm(temp, { recursive: true, force: true });
console.log('agent-experience phase4a consolidation checks passed');
