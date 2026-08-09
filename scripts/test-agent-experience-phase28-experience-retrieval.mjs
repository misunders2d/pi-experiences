#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import {
  buildExperienceContextPack,
  prepareExperienceVectors,
  retrieveExperienceCandidates,
  revalidateExperienceCandidate,
} from '../extensions/agent-experience/src/experience/retrieval.ts';
import { buildExperienceCandidate, experienceApprovalIdentity } from '../extensions/agent-experience/src/experience/schema.ts';
import { activateExperience, disableExperience, insertExperienceCandidate } from '../extensions/agent-experience/src/experience/storage.ts';
import { STORAGE_SCHEMA_SQL } from '../extensions/agent-experience/src/storage/schema.ts';
import { LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_PROVIDER } from '../extensions/agent-experience/src/semantic/local-model-manifest.ts';

const NOW = '2026-08-09T12:00:00.000Z';
const config = {
  ...DEFAULT_AGENT_EXPERIENCE_CONFIG,
  enabled: true,
  advisor_enabled: true,
  selector_enabled: true,
  embedding_enabled: true,
  selector_min_confidence_bp: 5000,
  selector_staleness_max: 0.9,
};

function vectorFor(text) {
  const vector = new Float32Array(LOCAL_EMBEDDING_DIMENSIONS);
  const lower = text.toLowerCase();
  if (lower.includes('sqlite') || lower.includes('storage')) vector[0] = 1;
  else if (lower.includes('branch') || lower.includes('release')) vector[1] = 1;
  else if (lower.includes('verify') || lower.includes('completion')) vector[2] = 1;
  else vector[3] = 1;
  return vector;
}
const embeddingAdapter = {
  provider: LOCAL_EMBEDDING_PROVIDER,
  model: LOCAL_EMBEDDING_MODEL,
  dimensions: LOCAL_EMBEDDING_DIMENSIONS,
  async embed(texts) { return texts.map(vectorFor); },
};

function candidate(kind, id, applicability, content, overrides = {}) {
  return buildExperienceCandidate({
    id,
    userId: overrides.userId || 'owner',
    kind,
    scope: { kind: 'user' },
    authority: kind === 'episode' ? 'observed_outcome' : 'explicit_user',
    applicability,
    content,
    ...(kind === 'decision' || kind === 'episode' ? { rationale: `Rationale for ${kind}` } : {}),
    exceptions: [],
    supersedes: [],
    conflictsWith: [],
    confidenceBp: 8500,
    validFrom: NOW,
    lastConfirmedAt: NOW,
    provenance: [{ source: 'explicit_user', host: 'omp', evidenceId: `${id}-evidence`, observedAt: NOW }],
    ...overrides,
  });
}

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
db.exec(STORAGE_SCHEMA_SQL);
const records = [
  candidate('habit', 'habit-verify', 'When claiming completion', 'Verify the actual result'),
  candidate('preference', 'preference-table', 'When presenting choices', 'Use a concise comparison table'),
  candidate('constraint', 'constraint-publish', 'When preparing releases', 'Do not publish packages'),
  candidate('fact', 'fact-branch', 'When choosing the release branch', 'Releases ship from the main branch'),
  candidate('decision', 'decision-sqlite', 'For local storage', 'Use SQLite as the canonical store'),
  candidate('episode', 'episode-pack', 'When validating packed installs', 'A source build passed while a packed asset was missing'),
  candidate('goal', 'goal-migration', 'For the current migration', 'Complete both host adapters'),
];
for (const record of records) {
  insertExperienceCandidate(db, record, { now: NOW });
  activateExperience(db, {
    userId: 'owner',
    id: record.id,
    reviewedChecksum: record.checksum,
    approvalId: `approval-${record.id}`,
    now: NOW,
  });
}
insertExperienceCandidate(db, candidate('fact', 'candidate-hidden', 'When hidden', 'Candidate content'), { now: NOW });
insertExperienceCandidate(db, candidate('fact', 'other-user-fact', 'When private', 'Other user content', { userId: 'other' }), { now: NOW });

const prepared = await prepareExperienceVectors(db, { userId: 'owner', now: NOW, config, embeddingAdapter });
assert.deepEqual(prepared, { total: 7, cached: 0, prepared: 7 });
const retrieved = await retrieveExperienceCandidates(db, {
  userId: 'owner',
  now: NOW,
  query: 'Which storage choice uses SQLite?',
  config,
  embeddingAdapter,
});
assert.equal(retrieved[0].experience.id, 'decision-sqlite');
assert.equal(retrieved.some(item => item.experience.id === 'candidate-hidden'), false);
assert.equal(retrieved.some(item => item.experience.userId !== 'owner'), false);
assert.equal(retrieved.some(item => item.experience.kind === 'decision'), true);

const allKinds = await retrieveExperienceCandidates(db, {
  userId: 'owner',
  now: NOW,
  query: 'storage branch release verify completion choice package migration packed install',
  activeRequestExperienceIds: records.map(record => record.id),
  config,
  embeddingAdapter,
});
assert.deepEqual(new Set(allKinds.map(item => item.experience.kind)), new Set(['habit', 'preference', 'constraint', 'fact', 'decision', 'episode', 'goal']));
const advisorPack = buildExperienceContextPack(allKinds, 'advisor');
const assistantPack = buildExperienceContextPack(allKinds, 'assistant_context');
assert.deepEqual(new Set(advisorPack.modelPayload.map(item => item.kind)), new Set(['habit']));
assert.deepEqual(new Set(assistantPack.modelPayload.map(item => item.kind)), new Set(['preference', 'constraint', 'fact', 'decision', 'episode', 'goal']));
for (const id of records.map(record => record.id)) {
  assert.equal(advisorPack.summary.includes(id) || assistantPack.summary.includes(id), false, 'summaries do not expose internal ids');
}
assert.equal(JSON.stringify(assistantPack.modelPayload).includes('approval-'), false);
assert.equal(JSON.stringify(assistantPack.modelPayload).includes('evidence'), false);
assert.deepEqual(assistantPack.modelPayload.find(item => item.kind === 'decision').scope, { kind: 'user' });
assert.equal(assistantPack.modelPayload.find(item => item.kind === 'decision').authority, 'explicit_user');
assert.equal(assistantPack.modelPayload.find(item => item.kind === 'decision').rationale, 'Rationale for decision');

const selected = allKinds.find(item => item.experience.id === 'decision-sqlite');
assert.equal(revalidateExperienceCandidate(db, { userId: 'owner', now: NOW, alias: selected.alias, candidates: allKinds, config }).id, 'decision-sqlite');
disableExperience(db, { userId: 'owner', id: 'decision-sqlite', now: '2026-08-09T12:01:00.000Z' });
assert.throws(
  () => revalidateExperienceCandidate(db, { userId: 'owner', now: NOW, alias: selected.alias, candidates: allKinds, config }),
  /experience_snapshot_changed/,
);

const activeFallback = await retrieveExperienceCandidates(db, {
  userId: 'owner',
  now: NOW,
  query: 'missing vector fallback',
  activeRequestExperienceIds: ['fact-branch'],
  config,
  embeddingAdapter: { ...embeddingAdapter, model: 'wrong-model' },
});
assert.deepEqual(activeFallback.map(item => item.experience.id), ['fact-branch']);

const activeDecision = records.find(record => record.id === 'decision-sqlite');
assert.equal(experienceApprovalIdentity(activeDecision).length, 64);

db.close();
console.log('agent-experience phase28 experience retrieval checks passed');
