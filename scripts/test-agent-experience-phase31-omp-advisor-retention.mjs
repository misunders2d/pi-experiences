#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { buildExperienceCandidate } from '../extensions/agent-experience/src/experience/schema.ts';
import { activateExperience, insertExperienceCandidate } from '../extensions/agent-experience/src/experience/storage.ts';
import {
  buildOmpExperienceAdvisorContext,
  extractOmpAdvisorTranscriptFindings,
  retainOmpAdvisorTranscriptFindings,
} from '../extensions/agent-experience/src/host/omp.ts';
import { readValidatedObservationRange } from '../extensions/agent-experience/src/storage/observations.ts';
import { STORAGE_SCHEMA_SQL } from '../extensions/agent-experience/src/storage/schema.ts';

const NOW = '2026-08-09T12:00:00.000Z';
const root = await mkdtemp(join(tmpdir(), 'agent-experience-omp-retention-'));
const sessionFile = join(root, 'session.jsonl');
const sessionDir = sessionFile.slice(0, -'.jsonl'.length);
await mkdir(sessionDir);
await writeFile(sessionFile, '');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
db.exec(STORAGE_SCHEMA_SQL);
const candidate = buildExperienceCandidate({
  id: 'habit-private-id',
  userId: 'owner',
  kind: 'habit',
  scope: { kind: 'user' },
  authority: 'explicit_user',
  applicability: 'When making a verified claim',
  content: 'Use checked output instead of assumptions.',
  exceptions: [],
  supersedes: [],
  conflictsWith: [],
  confidenceBp: 9000,
  validFrom: NOW,
  lastConfirmedAt: NOW,
  provenance: [{ source: 'conversation', host: 'omp', evidenceId: 'private-evidence', observedAt: NOW }],
});
const stored = insertExperienceCandidate(db, candidate, { now: NOW });
activateExperience(db, {
  userId: 'owner',
  id: stored.id,
  reviewedChecksum: stored.checksum,
  approvalId: 'private-approval',
  now: NOW,
});
const config = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, advisor_enabled: true };
const contribution = await buildOmpExperienceAdvisorContext(db, {
  userId: 'owner',
  now: NOW,
  query: 'current request',
  activeRequestExperienceIds: [stored.id],
  config,
  currentScope: { runtime: 'omp' },
});
assert.equal(contribution.attributions.size, 1);
const attribution = [...contribution.attributions.keys()][0];
const context = [
  '### Session update',
  'Sensitive primary transcript must not persist: person@example.invalid',
  contribution.context,
].join('\n');
const transcript = [
  { type: 'session', id: 'advisor-session' },
  { type: 'message', message: { role: 'user', content: context, synthetic: true, attribution: 'agent' } },
  { type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'advise-0', name: 'advise', arguments: { note: 'Generic finding.', severity: 'blocker' } },
    { type: 'toolCall', id: 'advise-1', name: 'advise', arguments: { note: 'Verify the actual output. token=abcdefghijk', severity: 'concern', attribution } },
    { type: 'toolCall', id: 'advise-2', name: 'advise', arguments: { note: 'Duplicate finding.', severity: 'blocker', attribution } },
  ] } },
].map(value => JSON.stringify(value)).join('\n') + '\n';
await writeFile(join(sessionDir, '__advisor.jsonl'), transcript);

const extracted = extractOmpAdvisorTranscriptFindings(transcript, NOW, contribution.attributions);
assert.equal(extracted.length, 1, 'one OMP reviewer turn may retain at most one attributable finding');
assert.equal(extracted[0].severity, 'concern');
assert.equal(extracted[0].attribution, attribution);
assert.equal(extractOmpAdvisorTranscriptFindings(transcript, NOW, new Map()).length, 0, 'a transcript marker alone cannot authorize retention');

const retentionInput = {
  root,
  db,
  config,
  userId: 'owner',
  sessionFile,
  attributions: contribution.attributions,
  now: NOW,
};
const first = await retainOmpAdvisorTranscriptFindings(retentionInput);
const second = await retainOmpAdvisorTranscriptFindings(retentionInput);
assert.deepEqual(first, { appended: 1 });
assert.deepEqual(second, { appended: 0 });

const range = await readValidatedObservationRange(root, { userId: 'owner' });
assert.equal(range.records.length, 1);
assert.equal(range.records[0].origin.source, 'advisor_finding');
assert.equal(range.records[0].payload_redacted.approved_behavior_redacted, 'Use checked output instead of assumptions.');
assert.equal(range.records[0].payload_redacted.primary_behavior_redacted, '[OMP native Advisor attributed advice to one approved Experience]');
const persisted = await readFile(join(root, 'observations.jsonl'), 'utf8');
assert.doesNotMatch(persisted, /person@example\.invalid|abcdefghijk|Duplicate finding|Generic finding|habit-private-id|private-approval|private-evidence/);

db.close();
await rm(root, { recursive: true, force: true });
console.log('agent-experience phase31 OMP Advisor retention checks passed');
