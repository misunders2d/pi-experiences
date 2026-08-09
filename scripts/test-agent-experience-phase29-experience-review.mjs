#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerAgentExperienceConversationalTools } from '../extensions/agent-experience/src/conversational-tools.ts';
import { buildExperienceCandidate } from '../extensions/agent-experience/src/experience/schema.ts';
import { getExperience, insertExperienceCandidate } from '../extensions/agent-experience/src/experience/storage.ts';
import {
  approveReviewedExperience,
  disableReviewedExperience,
  formatExperienceReviewItem,
  keepReviewedExperienceSeparate,
  listExperienceReviewItems,
  rejectReviewedExperience,
  supersedeWithReviewedExperience,
} from '../extensions/agent-experience/src/review.ts';
import { STORAGE_SCHEMA_SQL } from '../extensions/agent-experience/src/storage/schema.ts';

const NOW = '2026-08-09T12:00:00.000Z';
function candidate(id, content, overrides = {}) {
  return buildExperienceCandidate({
    id,
    userId: 'owner',
    kind: 'decision',
    scope: { kind: 'repository', key: 'example/repo' },
    authority: 'explicit_user',
    applicability: 'For repository storage',
    content,
    rationale: 'Reviewed storage rationale',
    exceptions: [],
    confidenceBp: 9000,
    validFrom: NOW,
    lastConfirmedAt: NOW,
    supersedes: [],
    conflictsWith: [],
    provenance: [{ source: 'explicit_user', host: 'omp', evidenceId: `${id}-evidence`, observedAt: NOW }],
    ...overrides,
  });
}
function approve(db, record, at = NOW) {
  insertExperienceCandidate(db, record, { now: at });
  return approveReviewedExperience(db, {
    userId: 'owner',
    recordId: record.id,
    reviewedChecksum: record.checksum,
    approvalId: `approval-${record.id}`,
    now: at,
  });
}

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
db.exec(STORAGE_SCHEMA_SQL);
const base = candidate('decision-base', 'Use SQLite');
approve(db, base);
const separateCandidate = candidate('decision-separate', 'Use PostgreSQL', { conflictsWith: [base.id] });
insertExperienceCandidate(db, separateCandidate, { now: NOW });
const reviewItems = listExperienceReviewItems(db, {
  userId: 'owner',
  statuses: ['candidate'],
  kinds: ['decision'],
  scope: { kind: 'repository', key: 'example/repo' },
});
assert.equal(reviewItems.length, 1);
assert.equal(reviewItems[0].kind, 'decision');
assert.equal(reviewItems[0].authority, 'explicit_user');
assert.equal(reviewItems[0].rationale, 'Reviewed storage rationale');
assert.equal(reviewItems[0].conflictCount, 1);
const display = formatExperienceReviewItem(reviewItems[0]);
assert.equal(display.includes(separateCandidate.id), false);
assert.equal(display.includes(separateCandidate.checksum), false);
assert.match(display, /decision · candidate · repository:example\/repo · explicit_user/);
assert.throws(
  () => approveReviewedExperience(db, { userId: 'owner', recordId: separateCandidate.id, reviewedChecksum: separateCandidate.checksum, approvalId: 'unsafe', now: NOW }),
  /conflicts require explicit review/,
);
const separated = keepReviewedExperienceSeparate(db, {
  userId: 'owner',
  recordId: separateCandidate.id,
  otherRecordId: base.id,
  reviewedChecksum: separateCandidate.checksum,
  now: '2026-08-09T12:01:00.000Z',
});
assert.deepEqual(separated.conflictsWith, []);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM experience_relations WHERE source_id = ? AND relation = 'conflicts_with'").get(separateCandidate.id).count, 0);
approveReviewedExperience(db, { userId: 'owner', recordId: separated.id, reviewedChecksum: separated.checksum, approvalId: 'approval-separate', now: '2026-08-09T12:02:00.000Z' });
assert.equal(getExperience(db, { userId: 'owner', id: separated.id }).status, 'active');

const prior = candidate('decision-prior', 'Use local files', { applicability: 'For audit storage' });
approve(db, prior, '2026-08-09T12:03:00.000Z');
const replacement = candidate('decision-replacement', 'Use SQLite for audit storage', {
  applicability: 'For audit storage',
  conflictsWith: [prior.id],
});
insertExperienceCandidate(db, replacement, { now: '2026-08-09T12:04:00.000Z' });
supersedeWithReviewedExperience(db, {
  userId: 'owner',
  recordId: prior.id,
  replacementId: replacement.id,
  reviewedReplacementChecksum: replacement.checksum,
  approvalId: 'approval-replacement',
  now: '2026-08-09T12:05:00.000Z',
});
const superseded = getExperience(db, { userId: 'owner', id: prior.id });
const activeReplacement = getExperience(db, { userId: 'owner', id: replacement.id });
assert.equal(superseded.status, 'superseded');
assert.equal(activeReplacement.status, 'active');
assert.deepEqual(activeReplacement.supersedes, [prior.id]);
assert.deepEqual(activeReplacement.conflictsWith, []);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM experience_relations WHERE source_id = ? AND relation = 'conflicts_with'").get(replacement.id).count, 0);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM experience_relations WHERE source_id = ? AND relation = 'supersedes' AND target_id = ?").get(replacement.id, prior.id).count, 1);

const rejected = candidate('decision-rejected', 'Use an obsolete store', { applicability: 'For obsolete storage' });
insertExperienceCandidate(db, rejected, { now: NOW });
assert.equal(rejectReviewedExperience(db, { userId: 'owner', recordId: rejected.id, reviewedChecksum: rejected.checksum, now: NOW }).status, 'disabled');
assert.throws(
  () => rejectReviewedExperience(db, { userId: 'owner', recordId: rejected.id, reviewedChecksum: rejected.checksum, now: NOW }),
  /changed after review/,
);
const disabled = disableReviewedExperience(db, {
  userId: 'owner',
  recordId: activeReplacement.id,
  reviewedChecksum: activeReplacement.checksum,
  now: '2026-08-09T12:06:00.000Z',
});
assert.equal(disabled.status, 'disabled');

const tools = [];
registerAgentExperienceConversationalTools({ registerTool(tool) { tools.push(tool); } });
const listTool = tools.find(tool => tool.name === 'agent_experience_list_experiences');
const applyTool = tools.find(tool => tool.name === 'agent_experience_apply_experience_review');
assert.ok(listTool);
assert.ok(applyTool);
assert.match(listTool.description, /kind, scope, authority, rationale, and conflicts/);
assert.match(applyTool.description, /explicit user decision/);

db.close();
console.log('agent-experience phase29 Experience review checks passed');
