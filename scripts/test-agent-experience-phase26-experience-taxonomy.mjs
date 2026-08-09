#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  activateExperience,
  disableExperience,
  getExperience,
  insertExperienceCandidate,
  listEligibleExperiences,
  supersedeExperience,
} from '../extensions/agent-experience/src/experience/storage.ts';
import { applyStorageMigrations } from '../extensions/agent-experience/src/storage/migrations.ts';
import { STORAGE_SCHEMA_SQL } from '../extensions/agent-experience/src/storage/schema.ts';
import { insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';
import {
  buildExperienceCandidate,
  computeExperienceChecksum,
  experienceApprovalIdentity,
  isExperienceEligible,
  validateExperienceRecord,
} from '../extensions/agent-experience/src/experience/schema.ts';
import { EXPERIENCE_KINDS } from '../extensions/agent-experience/src/experience/types.ts';

const NOW = '2026-08-09T12:00:00.000Z';

function candidate(kind = 'habit', overrides = {}) {
  return buildExperienceCandidate({
    id: `experience-${kind}`,
    userId: 'owner',
    kind,
    scope: { kind: 'user' },
    authority: kind === 'episode' ? 'observed_outcome' : 'reviewed_inference',
    applicability: `When ${kind} context applies`,
    content: `Approved ${kind} content`,
    rationale: kind === 'decision' ? 'Reviewed decision rationale' : undefined,
    exceptions: kind === 'constraint' ? ['Unless the user explicitly overrides it'] : [],
    confidenceBp: 8000,
    validFrom: '2026-08-01T00:00:00.000Z',
    lastConfirmedAt: '2026-08-02T00:00:00.000Z',
    supersedes: [],
    conflictsWith: [],
    provenance: [{
      source: kind === 'episode' ? 'conversation' : 'explicit_user',
      host: 'omp',
      evidenceId: `evidence-${kind}`,
      observedAt: '2026-08-01T00:00:00.000Z',
    }],
    ...overrides,
  });
}

function recheck(record, patch) {
  const changed = { ...record, ...patch };
  changed.checksum = computeExperienceChecksum(changed);
  return validateExperienceRecord(changed);
}

for (const kind of EXPERIENCE_KINDS) {
  const record = candidate(kind);
  assert.equal(validateExperienceRecord(record).kind, kind);
}

const base = candidate();
assert.throws(() => validateExperienceRecord({ ...base, unknown: true }), /unknown field/);
assert.throws(() => recheck(base, { status: 'unknown' }), /status/);
assert.throws(() => recheck(base, { scope: { kind: 'repository' } }), /requires a key/);
assert.throws(() => recheck(base, { scope: { kind: 'user', key: 'unexpected' } }), /must not have a key/);
assert.throws(() => recheck(base, { authority: 'system' }), /authority/);
assert.throws(() => recheck(base, { applicability: '   ' }), /applicability/);
assert.throws(() => recheck(base, { content: '' }), /content/);
assert.throws(() => recheck(base, { confidenceBp: 10001 }), /confidenceBp/);
assert.throws(() => recheck(base, { validFrom: 'not-a-date' }), /validFrom/);
assert.throws(() => recheck(base, { expiresAt: '2026-07-01T00:00:00.000Z' }), /expiresAt/);
assert.throws(() => recheck(base, { conflictsWith: [base.id] }), /itself/);
assert.throws(() => recheck(base, { provenance: [] }), /provenance/);
assert.throws(() => validateExperienceRecord({ ...base, checksum: '0'.repeat(64) }), /checksum mismatch/);

const active = recheck(base, { status: 'active' });
assert.equal(isExperienceEligible(active, { userId: 'owner', now: NOW }), true);
assert.equal(isExperienceEligible(active, { userId: 'other', now: NOW }), false);
const expired = recheck(base, { status: 'active', expiresAt: '2026-08-05T00:00:00.000Z' });
assert.equal(isExperienceEligible(expired, { userId: 'owner', now: NOW }), false);
assert.notEqual(experienceApprovalIdentity(base), experienceApprovalIdentity({ ...base, content: 'changed' }));

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
db.exec(STORAGE_SCHEMA_SQL);
const { schemaVersion: _schemaVersion, status: _status, checksum: _checksum, ...candidateInput } = base;
const storedCandidate = insertExperienceCandidate(db, candidateInput, { now: NOW });
assert.deepEqual(getExperience(db, { userId: 'owner', id: base.id }), storedCandidate);
assert.deepEqual(listEligibleExperiences(db, { userId: 'owner', now: NOW }), []);
assert.throws(
  () => activateExperience(db, { userId: 'owner', id: base.id, reviewedChecksum: '0'.repeat(64), approvalId: 'approval-wrong', now: NOW }),
  /changed after review/,
);
const storedActive = activateExperience(db, {
  userId: 'owner',
  id: base.id,
  reviewedChecksum: storedCandidate.checksum,
  approvalId: 'approval-base',
  now: NOW,
});
assert.equal(storedActive.status, 'active');
assert.deepEqual(listEligibleExperiences(db, { userId: 'owner', now: NOW }).map(record => record.id), [base.id]);

const replacementCandidate = candidate('preference', {
  id: 'experience-replacement',
  kind: 'habit',
  applicability: 'When the replacement context applies',
  content: 'Approved replacement content',
});
const {
  schemaVersion: _replacementSchemaVersion,
  status: _replacementStatus,
  checksum: _replacementChecksum,
  ...replacementInput
} = replacementCandidate;
const storedReplacement = insertExperienceCandidate(db, replacementInput, { now: NOW });
activateExperience(db, {
  userId: 'owner',
  id: storedReplacement.id,
  reviewedChecksum: storedReplacement.checksum,
  approvalId: 'approval-replacement',
  now: NOW,
});
assert.equal(supersedeExperience(db, {
  userId: 'owner',
  id: base.id,
  replacementId: storedReplacement.id,
  now: '2026-08-09T12:01:00.000Z',
}).status, 'superseded');
assert.deepEqual(
  getExperience(db, { userId: 'owner', id: storedReplacement.id }).supersedes,
  [base.id],
);
assert.equal(disableExperience(db, {
  userId: 'owner',
  id: storedReplacement.id,
  now: '2026-08-09T12:02:00.000Z',
}).status, 'disabled');
assert.deepEqual(listEligibleExperiences(db, { userId: 'owner', now: NOW }), []);

const migrationDb = new DatabaseSync(':memory:');
migrationDb.exec('PRAGMA foreign_keys=ON');
migrationDb.exec(STORAGE_SCHEMA_SQL);
migrationDb.exec('PRAGMA user_version=6');
insertStorageRecord(migrationDb, 'habits', {
  id: 'legacy-active',
  userId: 'owner',
  now: '2026-07-01T00:00:00.000Z',
  data: {
    record_kind: 'habit_v1',
    schema_version: 1,
    status: 'active',
    habit_id: 'legacy-active',
    condition: 'When Legacy Applies',
    behavior: 'Do Legacy Thing',
    polarity: 1,
    confidence_bp: 8000,
    activation: 1,
    staleness: 0,
    approved_identity: {
      candidate_id: 'legacy-active',
      condition: 'when legacy applies',
      behavior: 'do legacy thing',
      polarity: 1,
      approved_at: '2026-07-01T00:00:00.000Z',
    },
  },
});
insertStorageRecord(migrationDb, 'habits', {
  id: 'legacy-candidate',
  userId: 'owner',
  now: '2026-07-02T00:00:00.000Z',
  data: {
    record_kind: 'habit_v1',
    schema_version: 1,
    status: 'candidate',
    habit_id: 'legacy-candidate',
    condition: 'When Candidate Applies',
    behavior: 'Do Candidate Thing',
    polarity: 1,
    confidence_bp: 6000,
    activation: 0,
    staleness: 0,
  },
});
insertStorageRecord(migrationDb, 'habits', {
  id: 'legacy-corrupt',
  userId: 'owner',
  now: '2026-07-03T00:00:00.000Z',
  data: {
    record_kind: 'habit_v1',
    schema_version: 1,
    status: 'active',
    habit_id: 'legacy-corrupt',
    condition: 'When Corrupt Applies',
    behavior: 'Do Corrupt Thing',
    polarity: 1,
    confidence_bp: 8000,
    activation: 1,
    staleness: 0,
    approved_identity: {
      candidate_id: 'legacy-corrupt',
      condition: 'when corrupt applies',
      behavior: 'do corrupt thing',
      polarity: 1,
    },
  },
});
migrationDb.prepare("UPDATE habits SET checksum = 'invalid' WHERE id = 'legacy-corrupt'").run();
applyStorageMigrations(migrationDb, NOW);
const migratedActive = getExperience(migrationDb, { userId: 'owner', id: 'legacy-active' });
assert.equal(migratedActive.status, 'active');
assert.equal(migratedActive.applicability, 'When Legacy Applies');
assert.equal(migratedActive.content, 'Do Legacy Thing');
assert.equal(getExperience(migrationDb, { userId: 'owner', id: 'legacy-candidate' }).status, 'candidate');
assert.equal(getExperience(migrationDb, { userId: 'owner', id: 'legacy-corrupt' }), undefined);
const migrationQuarantine = migrationDb
  .prepare("SELECT payload_json FROM pending_review WHERE id = 'legacy-experience-migration:owner:legacy-corrupt'")
  .get();
assert.equal(JSON.parse(migrationQuarantine.payload_json).reason, 'legacy_checksum_mismatch');
assert.deepEqual(
  listEligibleExperiences(migrationDb, { userId: 'owner', now: NOW }).map(record => record.id),
  ['legacy-active'],
);
db.close();
migrationDb.close();

console.log('agent-experience phase26 taxonomy checks passed');
