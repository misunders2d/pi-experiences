#!/usr/bin/env node
// Consolidation identity/evidence regression (unit-level, no model/prompt/runner):
// feeds crafted output into normalizeConsolidationModelOutput and asserts that
// evidence accumulates on an existing habitContext identity (matched by the
// NORMALIZED condition/behavior/polarity) instead of forking into a paraphrased
// near-duplicate. This guards the cross-batch evidence-matching mechanism the
// consolidation prompt steers toward. It does NOT measure recall/yield.
import assert from 'node:assert/strict';
import { normalizeConsolidationModelOutput } from '../extensions/agent-experience/src/consolidate/model-adapter.ts';
import { validateObservationRecords } from '../extensions/agent-experience/src/consolidate/observations.ts';
import { observationChecksumForTest, observationPairRefForTest } from '../extensions/agent-experience/src/storage/observations.ts';

function makeObservation({ seq, userId = 'owner', previous = null, createdAt, safe }) {
  const base = {
    id: `obs-${seq}-${safe}`,
    seq,
    user_id: userId,
    origin: { source: 'test', command: 'phase21' },
    prev_pair_ref: previous ? observationPairRefForTest(previous) : null,
    payload_redacted: { kind: 'conversation_pair_v1', safe, redacted_fixture: true },
    created_at: createdAt,
  };
  return { ...base, checksum: observationChecksumForTest(base) };
}

// A synthetic repeated correction pattern: three observations across two days.
const r1 = makeObservation({ seq: 1, createdAt: '2026-07-02T00:00:00.000Z', safe: 'asked for concise status; got a wall of text' });
const r2 = makeObservation({ seq: 2, previous: r1, createdAt: '2026-07-02T09:00:00.000Z', safe: 'again wants done-or-blocked with evidence' });
const r3 = makeObservation({ seq: 3, previous: r2, createdAt: '2026-07-03T00:00:00.000Z', safe: 'once more: say blocked, cite evidence, next step' });
const observations = validateObservationRecords({ records: [r1, r2, r3], userId: 'owner', fileGeneration: 'active' });

// Canonical existing identity, already carrying one prior day of evidence.
const identityCondition = 'When reporting whether work is finished';
const identityBehavior = 'State done or blocked, cite concrete evidence, then give the next action.';
const existingIdentity = {
  condition: identityCondition,
  behavior: identityBehavior,
  polarity: 1,
  status: 'active',
  review_status: 'promoted_active',
  confidence_bp: 8200,
  unique_observations: 1,
  distinct_days: 1,
  source_dates: ['2026-07-01'],
};

const expected = { file_generation: 'active', seq_start: 1, seq_end: 3, read_checksum: observations.at(-1).checksum };
// Cite only two of the new observations (across two days); alone that is below the
// three-observation bar, so reaching "reviewable" depends on accumulating onto the
// existing identity.
const twoNewRefs = [{ seq: 2 }, { seq: 3 }];

function proposal(overrides) {
  return {
    proposal_id: overrides.proposal_id,
    kind: 'habit_candidate',
    candidate_key: overrides.candidate_key,
    condition: overrides.condition,
    behavior: overrides.behavior,
    polarity: 1,
    confidence_bp: 8200,
    source_refs: twoNewRefs,
  };
}

// Run 1: proposal REUSES the exact existing wording. Evidence accumulates onto the
// existing identity (1 prior + 2 new across 2 distinct days) and becomes reviewable.
const reuse = normalizeConsolidationModelOutput(
  { proposals: [proposal({ proposal_id: 'p-reuse', candidate_key: 'status-evidence', condition: identityCondition, behavior: identityBehavior })] },
  { model: 'anthropic/claude-fable-5', userId: 'owner', observations, habitContext: [existingIdentity], expected },
);
assert.equal(reuse.proposals.length, 1);
assert.equal(reuse.proposals[0].evidence_stage, 'reviewable', 'exact reuse must accumulate cross-batch evidence to a reviewable suggestion');
assert.equal(reuse.proposals[0].condition, identityCondition, 'reviewable proposal must keep the exact existing condition wording');
assert.equal(reuse.proposals[0].behavior, identityBehavior, 'reviewable proposal must keep the exact existing behavior wording');
assert.equal(reuse.proposals[0].polarity, 1);

// Run 2: proposal PARAPHRASES the same underlying pattern. It no longer matches the
// existing identity, so the accumulated evidence is lost and it stays collecting.
const forked = normalizeConsolidationModelOutput(
  { proposals: [proposal({ proposal_id: 'p-fork', candidate_key: 'status-evidence-alt', condition: 'When you tell me the state of ongoing work', behavior: identityBehavior })] },
  { model: 'anthropic/claude-fable-5', userId: 'owner', observations, habitContext: [existingIdentity], expected },
);
assert.equal(forked.proposals[0].evidence_stage, 'collecting', 'a paraphrased condition forks a near-duplicate and loses the accumulated evidence');

// Run 3: exact wording but NO existing identity present proves that the existing
// identity's evidence — not the two new refs alone — is what tipped run 1.
const noContext = normalizeConsolidationModelOutput(
  { proposals: [proposal({ proposal_id: 'p-fresh', candidate_key: 'status-evidence', condition: identityCondition, behavior: identityBehavior })] },
  { model: 'anthropic/claude-fable-5', userId: 'owner', observations, habitContext: [], expected },
);
assert.equal(noContext.proposals[0].evidence_stage, 'collecting', 'two new observations alone must remain below the reviewable bar');

console.log('agent-experience phase21 consolidation identity/evidence checks passed');
