#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { lawSnapshotForTest } from '../extensions/agent-experience/src/review.ts';
import {
  buildSelectorPrompt,
  parseSelectorModelOutput,
  runSelectorRuntime,
  selectActiveSelectorSnapshot,
} from '../extensions/agent-experience/src/selector.ts';
import {
  embedSelectorPromptQueries,
  prepareSelectorConditionVectors,
  unionRetrievedSelectorCandidates,
} from '../extensions/agent-experience/src/selector-vector.ts';
import {
  extractSteeringContext,
  latestUserMessageBoundary,
  MAX_STEERING_CONTEXT_MESSAGES,
  MAX_STEERING_CONTEXT_MESSAGE_CHARS,
} from '../extensions/agent-experience/src/steering-context.ts';
import {
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_PROVIDER,
} from '../extensions/agent-experience/src/semantic/local-model-manifest.ts';
import { initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';

function unit(index) {
  const vector = new Float32Array(LOCAL_EMBEDDING_DIMENSIONS);
  vector[index] = 1;
  return vector;
}

const releaseVector = unit(0);
const vacationVector = unit(1);
const statusVector = unit(2);
const unrelatedVector = unit(3);

function vectorFor(text) {
  const value = String(text).toLowerCase();
  if (/package release|publish the package|ship the package/.test(value)) return releaseVector;
  if (/summer vacation|vacation plan|летн.*отпуск|отпуск.*летн/.test(value)) return vacationVector;
  if (/background task|status progress|status check/.test(value)) return statusVector;
  return unrelatedVector;
}

function fakeEmbeddingAdapter() {
  const batches = [];
  return {
    id: `${LOCAL_EMBEDDING_PROVIDER}:${LOCAL_EMBEDDING_MODEL}:${LOCAL_EMBEDDING_DIMENSIONS}`,
    provider: LOCAL_EMBEDDING_PROVIDER,
    model: LOCAL_EMBEDDING_MODEL,
    dimensions: LOCAL_EMBEDDING_DIMENSIONS,
    async embed(texts, { signal } = {}) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      batches.push([...texts]);
      return texts.map(vectorFor);
    },
    get batches() { return batches; },
  };
}

function refs(prefix) {
  return [1, 2, 3].map((seq) => ({ file_generation: `phase20-${prefix}`, seq, checksum: `${prefix}${seq}`.repeat(64).slice(0, 64) }));
}

function habitData(condition, behavior, lawHash, prefix) {
  return {
    schema_version: 2,
    record_kind: 'candidate_habit_v1',
    status: 'active',
    active: true,
    injectable: false,
    condition,
    behavior,
    polarity: 1,
    confidence_bp: 9000,
    activation: 1,
    staleness: 0,
    law_hash: lawHash,
    source_refs: refs(prefix),
    source_dates: ['2026-07-14T00:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-07-16T00:00:00.000Z'],
  };
}

function judgments(candidateIds, applicable = [], reasonById = {}) {
  const selected = new Set(applicable);
  return {
    schema_version: 3,
    judgments: candidateIds.map((id) => selected.has(id)
      ? { id, applicable: true, confidence_bp: 9500, reason: 'current_applicability' }
      : { id, applicable: false, confidence_bp: 9500, reason: reasonById[id] || 'not_currently_relevant' }),
  };
}

// Pure boundary/extraction: only visible prior user/assistant text survives.
const messages = [
  { role: 'system', content: 'system must not enter context' },
  { role: 'user', content: [{ type: 'text', text: 'Discuss package release.' }] },
  { role: 'assistant', content: [
    { type: 'text', text: 'I can publish the package after validation.' },
    { type: 'thinking', thinking: 'hidden chain must not enter context' },
    { type: 'toolCall', name: 'dangerous_tool', arguments: { secret: 'never' } },
  ] },
  { role: 'custom', customType: 'agent_experience.habit_guidance', content: 'injected guidance must not enter context', display: false },
  { role: 'toolResult', content: [{ type: 'text', text: 'tool result must not enter context' }] },
  { role: 'bashExecution', content: 'shell output must not enter context' },
  { role: 'compactionSummary', summary: 'compaction summary must not enter context' },
  { role: 'branchSummary', summary: 'stale branch summary must not enter context' },
  { role: 'developer', content: 'developer text must not enter context' },
  { role: 'assistant', content: 'hidden assistant must not enter context', display: false },
  { role: 'user', content: [{ type: 'text', text: 'Email user@example.invalid and read /home/private/file.' }] },
  { role: 'user', content: [{ type: 'text', text: 'yes, do that' }] },
];
const boundary = latestUserMessageBoundary(messages);
assert.deepEqual(boundary, { index: messages.length - 1, count: 3, text: 'yes, do that' });
const extracted = extractSteeringContext(messages, boundary.index);
assert.deepEqual(extracted.map((turn) => turn.role), ['user', 'assistant', 'user']);
assert.match(extracted[0].text, /package release/);
assert.match(extracted[1].text, /publish the package/);
assert.match(extracted[2].text, /REDACTED/);
assert.doesNotMatch(JSON.stringify(extracted), /system must|hidden chain|dangerous_tool|injected guidance|tool result|shell output|compaction summary|stale branch|developer text|hidden assistant|example\.invalid|home\/private/);
assert.throws(() => extractSteeringContext(messages, 2), /boundary/i);

const manyMessages = Array.from({ length: 7 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  content: `${index}: ${'x'.repeat(500)}`,
}));
manyMessages.push({ role: 'user', content: 'current' });
const bounded = extractSteeringContext(manyMessages, manyMessages.length - 1);
assert.equal(bounded.length, MAX_STEERING_CONTEXT_MESSAGES);
assert.deepEqual(bounded.map((turn) => Number(turn.text.split(':')[0])), [3, 4, 5, 6]);
assert.equal(bounded.every((turn) => turn.text.length <= MAX_STEERING_CONTEXT_MESSAGE_CHARS), true);

// Dual embeddings use one adapter batch; empty context keeps one query.
const directEmbedding = fakeEmbeddingAdapter();
const oneQuery = await embedSelectorPromptQueries({ prompt: 'yes, do that', embeddingAdapter: directEmbedding });
assert.equal(oneQuery.contextVector, undefined);
assert.equal(directEmbedding.batches.at(-1).length, 1);
const twoQueries = await embedSelectorPromptQueries({ prompt: 'yes, do that', contextualPrompt: 'assistant: publish the package\ncurrent_user: yes, do that', embeddingAdapter: directEmbedding });
assert.ok(twoQueries.contextVector);
assert.equal(directEmbedding.batches.at(-1).length, 2);

// Union is deterministic: primary entry and order win; secondary-only appends.
const candidate = (id) => ({ id, condition: id, behavior: id, confidence_bp: 9000 });
const item = (id, similarityBp, source) => ({ candidate: candidate(id), conditionIdentity: `${source}-${id}`, similarityBp });
const union = unionRetrievedSelectorCandidates({
  primary: [item('a', 9000, 'primary'), item('b', 8000, 'primary')],
  secondary: [item('b', 9999, 'secondary'), item('c', 7000, 'secondary')],
});
assert.deepEqual(union.map((entry) => entry.candidate.id), ['a', 'b', 'c']);
assert.equal(union[1].conditionIdentity, 'primary-b');
const cappedUnion = unionRetrievedSelectorCandidates({
  primary: Array.from({ length: 10 }, (_, index) => item(`p${index}`, 9000 - index, 'primary')),
  secondary: Array.from({ length: 10 }, (_, index) => item(`s${index}`, 8000 - index, 'secondary')),
});
assert.equal(cappedUnion.length, 12);
assert.deepEqual(cappedUnion.slice(-2).map((entry) => entry.candidate.id), ['s0', 's1']);

const law = lawSnapshotForTest('phase20 context selector law');
const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase20-'));
const storage = await initExperienceStorage(join(temp, 'state'), { allowInit: true, userId: 'owner' });
try {
  insertStorageRecord(storage.db, 'habits', {
    id: 'release', userId: 'owner',
    data: habitData('When preparing, publishing, or verifying a package release.', 'Verify artifacts before publication.', law.hash, 'a'),
    now: '2026-07-17T00:00:00.000Z',
  });
  insertStorageRecord(storage.db, 'habits', {
    id: 'vacation', userId: 'owner',
    data: habitData('When discussing or changing a summer vacation plan.', 'Keep vacation plan concise.', law.hash, 'b'),
    now: '2026-07-17T00:01:00.000Z',
  });
  insertStorageRecord(storage.db, 'habits', {
    id: 'status', userId: 'owner',
    data: habitData('When checking status progress for a background task.', 'Give evidence-backed status.', law.hash, 'c'),
    now: '2026-07-17T00:01:30.000Z',
  });
  const candidates = selectActiveSelectorSnapshot(storage.db, { userId: 'owner' });
  const embedding = fakeEmbeddingAdapter();
  await prepareSelectorConditionVectors(storage.db, { userId: 'owner', candidates, embeddingAdapter: embedding, now: '2026-07-17T00:02:00.000Z' });
  embedding.batches.length = 0;
  const config = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, selector_enabled: true, selector_min_confidence_bp: 7500, selector_max_habits: 3, selector_staleness_max: 0.8 };

  // Required proof: assistant proposed action absent from user history; current user adopts it.
  let judgeCalls = 0;
  const assistantFollowUp = await runSelectorRuntime(storage.db, {
    userId: 'owner',
    prompt: 'yes, do that',
    contextTurns: [{ role: 'assistant', text: 'I can publish the package after validation.' }],
    config, law, now: '2026-07-17T01:00:00.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds, prompt }) {
      judgeCalls += 1;
      const payload = JSON.parse(prompt);
      assert.equal(payload.schema_version, 3);
      assert.equal(payload.current_user_request, 'yes, do that');
      assert.deepEqual(payload.context_turns, [{ role: 'assistant', text: 'I can publish the package after validation.' }]);
      assert.ok(candidateIds.includes('release'));
      assert.doesNotMatch(prompt, /Verify artifacts before publication/);
      return judgments(candidateIds, ['release']);
    } },
  });
  assert.equal(assistantFollowUp.injected, true);
  assert.equal(assistantFollowUp.mode, 'vector_judge_ctx');
  assert.equal(judgeCalls, 1);
  assert.equal(embedding.batches.length, 1);
  assert.equal(embedding.batches[0].length, 2, 'current-only and contextual queries must share one local embedding batch');

  embedding.batches.length = 0;
  let noContextJudgeCalls = 0;
  const noContext = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'yes, do that', config, law, now: '2026-07-17T01:01:00.000Z', embeddingAdapter: embedding,
    adapter: { async select() { noContextJudgeCalls += 1; return {}; } },
  });
  assert.equal(noContext.injected, false);
  assert.equal(noContext.reason, 'no_vector_candidates', 'assistant reference must be necessary for this positive case');
  assert.equal(noContextJudgeCalls, 0);
  assert.equal(embedding.batches[0].length, 1, 'empty context must preserve one-query current-only behavior');

  // User-context continuation retrieves vacation, but one judge still decides.
  const userFollowUp = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'make it two weeks',
    contextTurns: [{ role: 'user', text: 'Create a summer vacation plan for July.' }],
    config, law, now: '2026-07-17T01:02:00.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds }) { assert.ok(candidateIds.includes('vacation')); return judgments(candidateIds, ['vacation']); } },
  });
  assert.equal(userFollowUp.injected, true);
  assert.equal(userFollowUp.mode, 'vector_judge_ctx');

  for (const [prompt, contextTurns, selectedId, now] of [
    ['the second option', [{ role: 'assistant', text: 'Option two is to publish the package release after validation.' }], 'release', '2026-07-17T01:02:10.000Z'],
    ['continue', [{ role: 'user', text: 'We are preparing the package release now.' }], 'release', '2026-07-17T01:02:20.000Z'],
    ['is it done?', [{ role: 'assistant', text: 'I am checking status progress for the background task.' }], 'status', '2026-07-17T01:02:30.000Z'],
    ['Сделай его на две недели.', [{ role: 'user', text: 'Составь план летнего отпуска.' }], 'vacation', '2026-07-17T01:02:40.000Z'],
  ]) {
    let calls = 0;
    const result = await runSelectorRuntime(storage.db, {
      userId: 'owner', prompt, contextTurns, config, law, now, embeddingAdapter: embedding,
      adapter: { async select({ candidateIds }) { calls += 1; assert.ok(candidateIds.includes(selectedId)); return judgments(candidateIds, [selectedId]); } },
    });
    assert.equal(result.injected, true, `${prompt} must resolve through bounded context`);
    assert.equal(result.mode, 'vector_judge_ctx');
    assert.equal(calls, 1);
  }

  // Context can widen retrieval, never establish applicability by itself.
  const unrelatedCurrent = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'What is the weather?',
    contextTurns: [{ role: 'assistant', text: 'I can publish the package after validation.' }],
    config, law, now: '2026-07-17T01:03:00.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds }) { return judgments(candidateIds, [], Object.fromEntries(candidateIds.map((id) => [id, 'context_only_applicability']))); } },
  });
  assert.equal(unrelatedCurrent.injected, false);
  assert.equal(unrelatedCurrent.reason, 'empty_selection');
  assert.deepEqual(parseSelectorModelOutput({
    schema_version: 3,
    judgments: [{ id: 'release', applicable: false, confidence_bp: 9500, reason: 'context_only_applicability' }],
  }, { candidateIds: ['release'], maxSelected: 3, minConfidenceBp: 7500 }), []);

  const negated = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: "No, don't publish the package release.",
    contextTurns: [{ role: 'assistant', text: 'I can publish the package after validation.' }],
    config, law, now: '2026-07-17T01:04:00.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds }) { return judgments(candidateIds, [], Object.fromEntries(candidateIds.map((id) => [id, 'negated']))); } },
  });
  assert.equal(negated.injected, false);
  assert.equal(negated.reason, 'empty_selection');

  // Invalid optional context drops to current-only; it never blocks a direct current trigger.
  const invalidContext = Array.from({ length: 5 }, () => ({ role: 'assistant', text: 'irrelevant' }));
  const degraded = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Publish the package release now.', contextTurns: invalidContext,
    config, law, now: '2026-07-17T01:05:00.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds, prompt }) { assert.deepEqual(JSON.parse(prompt).context_turns, []); return judgments(candidateIds, ['release']); } },
  });
  assert.equal(degraded.injected, true);
  assert.equal(degraded.mode, 'vector_judge');

  // Undefined and empty context keep current-only semantics.
  const parity = [];
  for (const contextTurns of [undefined, []]) {
    const result = await runSelectorRuntime(storage.db, {
      userId: 'owner', prompt: 'Publish the package release now.', contextTurns,
      config, law, now: `2026-07-17T01:06:0${parity.length}.000Z`, embeddingAdapter: embedding,
      adapter: { async select({ candidateIds, prompt }) { assert.deepEqual(JSON.parse(prompt).context_turns, []); return judgments(candidateIds, ['release']); } },
    });
    parity.push({ injected: result.injected, mode: result.mode, ids: result.selected.map((entry) => entry.id) });
  }
  assert.deepEqual(parity[0], parity[1]);

  const longPrompt = buildSelectorPrompt([{ ...candidates[0], condition: 'x'.repeat(5000) }], {
    prompt: 'yes',
    contextTurns: [{ role: 'assistant', text: 'Email user@example.invalid and inspect /home/private/file before release.' }],
    maxHabits: 3,
  });
  const longPayload = JSON.parse(longPrompt);
  assert.equal(longPayload.candidates[0].condition.length, 500);
  assert.match(longPayload.context_turns[0].text, /REDACTED/);
  assert.doesNotMatch(longPrompt, /example\.invalid|home\/private/);
  assert.ok(longPrompt.length < 12000);

  const logs = JSON.stringify(storage.db.prepare('SELECT prompt_hash, data_json FROM selector_hit_log ORDER BY created_at').all());
  assert.doesNotMatch(logs, /publish the package|summer vacation|make it two weeks|weather|similarity|context_turns/i);
  assert.match(logs, /vector_judge_ctx/);
  assert.match(logs, /omitted/);
} finally {
  storage.db.close();
  await rm(temp, { recursive: true, force: true });
}

console.log('agent-experience phase20 context selector checks passed');
