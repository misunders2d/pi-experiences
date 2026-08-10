#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { activateExperience, insertExperienceCandidate } from '../extensions/agent-experience/src/experience/storage.ts';
import { buildExperienceCandidate } from '../extensions/agent-experience/src/experience/schema.ts';
import { boundedOmpAdvisorQuery, buildOmpExperienceAdvisorContext } from '../extensions/agent-experience/src/host/omp.ts';
import { buildPiExperienceContext } from '../extensions/agent-experience/src/host/pi.ts';
import { STORAGE_SCHEMA_SQL } from '../extensions/agent-experience/src/storage/schema.ts';

const NOW = '2026-08-09T12:00:00.000Z';
const kinds = ['habit', 'preference', 'constraint', 'fact', 'decision', 'episode', 'goal'];
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
db.exec(STORAGE_SCHEMA_SQL);

for (const kind of kinds) {
  const candidate = buildExperienceCandidate({
    id: `${kind}-private-id`,
    userId: 'owner',
    kind,
    scope: kind === 'goal' ? { kind: 'runtime', key: 'pi' } : { kind: 'user' },
    authority: kind === 'habit' || kind === 'constraint' ? 'explicit_user' : 'reviewed_inference',
    applicability: `When ${kind} applies`,
    content: `Use approved ${kind} context`,
    rationale: kind === 'decision' || kind === 'episode' ? `${kind} rationale` : undefined,
    exceptions: [],
    supersedes: [],
    conflictsWith: [],
    confidenceBp: 9000,
    validFrom: NOW,
    lastConfirmedAt: NOW,
    provenance: [{ source: 'conversation', host: 'omp', evidenceId: `${kind}-evidence`, observedAt: NOW }],
  });
  const stored = insertExperienceCandidate(db, candidate, { now: NOW });
  activateExperience(db, {
    userId: 'owner',
    id: stored.id,
    reviewedChecksum: stored.checksum,
    approvalId: `final-${kind}`,
    now: NOW,
  });
}

const config = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, embedding_enabled: true };
const embeddingAdapter = {
  provider: 'test',
  model: 'missing-vectors',
  dimensions: 3,
  async embed() { throw new Error('vectors unavailable'); },
};
const input = {
  userId: 'owner',
  now: NOW,
  query: 'current request',
  activeRequestExperienceIds: kinds.map(kind => `${kind}-private-id`),
  config,
  embeddingAdapter,
  currentScope: { runtime: 'omp' },
};

const omp = await buildOmpExperienceAdvisorContext(db, input);
assert.equal(omp.experienceCount, 6);
assert.equal(omp.assistantContextCount, 5);
assert.match(omp.context, /Only kind=habit entries can define runtime habit policy/);
assert.match(omp.context, /A request that matches a habit's approved trigger is not by itself an override/);
assert.match(omp.context, /report the habit violation first/);
const ompPayload = JSON.parse(omp.context.split('\n').at(-1));
assert.deepEqual(new Set(ompPayload.experienceContext.map(item => item.kind)), new Set(kinds.filter(kind => kind !== 'goal')));
assert.equal('assistantContext' in ompPayload, false);
assert.equal(/private-id|approval-|evidence/.test(omp.context), false);
assert.equal(omp.attributions.size, 1);
assert.deepEqual(omp.policies, [
  {
    attribution: [...omp.attributions.keys()][0],
    source: 'Experience',
    condition: 'When habit applies',
    behavior: 'Use approved habit context',
  },
]);
assert.equal(JSON.stringify(omp.policies).includes('private-id'), false);
assert.equal((await buildOmpExperienceAdvisorContext(db, { ...input, currentScope: { runtime: 'pi' } })).experienceCount, 7);

const boundedQuery = boundedOmpAdvisorQuery(Array.from({ length: 20 }, (_, index) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', name: 'bash', arguments: { command: `${'x'.repeat(3000)}-command-${index}` } }],
})));
assert.equal(boundedQuery.includes('-command-0'), false);
assert.equal(boundedQuery.includes('-command-19'), true);
assert.ok(boundedQuery.length <= 24_000);
const cyclic = { role: 'assistant', content: [] };
cyclic.content.push(cyclic);
const pathologicalQuery = boundedOmpAdvisorQuery([
  cyclic,
  { content: Array.from({ length: 10_000 }, (_, index) => ({ index, value: 'x'.repeat(10_000) })) },
]);
assert.ok(pathologicalQuery.length <= 24_000);
const hugeKeyQuery = boundedOmpAdvisorQuery([{ ['private-' + 'x'.repeat(1_000_000)]: 'value' }]);
assert.ok(hugeKeyQuery.length <= 24_000);
assert.ok(hugeKeyQuery.length < 1_000);
const prioritizedQuery = boundedOmpAdvisorQuery([
  { role: 'user', content: 'Plan my summer vacation' },
  ...Array.from({ length: 14 }, (_, index) => ({
    role: index % 2 === 0 ? 'assistant' : 'toolResult',
    content: `${'x'.repeat(3000)}-noise-${index}`,
  })),
  { role: 'assistant', content: 'I will plan the trip now' },
]);
assert.ok(prioritizedQuery.startsWith('user: Plan my summer vacation'));
assert.equal(prioritizedQuery.includes('I will plan the trip now'), true);
assert.equal(prioritizedQuery.includes('-noise-'), false);
const realisticQuery = boundedOmpAdvisorQuery([
  { role: 'user', content: [{ type: 'text', text: 'Plan my summer vacation' }], attribution: 'user', timestamp: 1 },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'I started generic planning', textSignature: 'private-signature' }],
    provider: 'provider-name',
    usage: { input: 999999, output: 1 },
    providerPayload: { private: 'payload' },
  },
]);
assert.equal(realisticQuery.includes('Plan my summer vacation'), true);
assert.equal(realisticQuery.includes('I started generic planning'), true);
assert.equal(realisticQuery.includes('private-signature'), false);
assert.equal(realisticQuery.includes('provider-name'), false);
assert.equal(realisticQuery.includes('999999'), false);
assert.equal(realisticQuery.includes('payload'), false);
const crowdedQuery = boundedOmpAdvisorQuery([
  ...Array.from({ length: 10 }, (_, index) => ({
    role: 'user',
    content: `${'u'.repeat(2000)}-user-${index}`,
  })),
  { role: 'assistant', content: 'LATEST_ASSISTANT_ACTION' },
]);
assert.equal(crowdedQuery.includes('-user-9'), true);
assert.equal(crowdedQuery.includes('LATEST_ASSISTANT_ACTION'), true);
assert.equal(crowdedQuery.includes('-user-0'), false);
const longGapQuery = boundedOmpAdvisorQuery([
  { role: 'user', content: 'CURRENT_USER_REQUEST' },
  ...Array.from({ length: 20 }, (_, index) => ({
    role: 'toolResult',
    content: `${'t'.repeat(2000)}-tool-${index}`,
  })),
  { role: 'assistant', content: 'LATEST_ASSISTANT_AFTER_TOOLS' },
]);
assert.equal(longGapQuery.includes('CURRENT_USER_REQUEST'), true);
assert.equal(longGapQuery.includes('LATEST_ASSISTANT_AFTER_TOOLS'), true);
assert.equal(longGapQuery.includes('-tool-'), false);

const pi = await buildPiExperienceContext(db, { ...input, currentScope: { runtime: 'pi' } });
assert.deepEqual(pi.selectorGuidance, [{ condition: 'When habit applies', behavior: 'Use approved habit context' }]);
assert.deepEqual(new Set(pi.assistantContext.modelPayload.map(item => item.kind)), new Set(kinds.filter(kind => kind !== 'habit')));
assert.equal(JSON.stringify(pi).includes('private-id'), false);

db.close();
console.log('agent-experience phase30 dual-host adapter checks passed');
