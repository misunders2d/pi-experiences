#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { lawSnapshotForTest } from '../extensions/agent-experience/src/review.ts';
import {
  buildContextualRetrievalPrompt,
  buildSelectorPrompt,
  isValidSelectorHitLog,
  parseSelectorModelOutput,
  runSelectorRuntime,
  SELECTOR_CONTEXT_RETRIEVAL_MAX_UTF8_BYTES,
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

const conditionPatternByOriginalId = {
  release: /package release/i,
  vacation: /summer vacation plan/i,
  status: /status progress/i,
};

function aliasForOriginalId(prompt, originalId) {
  const pattern = conditionPatternByOriginalId[originalId];
  assert.ok(pattern, `missing condition pattern for ${originalId}`);
  const match = JSON.parse(prompt).candidates.find((candidate) => pattern.test(candidate.condition));
  assert.ok(match, `expected aliased candidate for ${originalId}`);
  assert.match(match.id, /^c[1-9][0-9]*$/);
  return match.id;
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

// Context retrieval is compact, current-first, newest-first, and Unicode-safe.
const compactContext = buildContextualRetrievalPrompt('ok', [
  { role: 'user', text: `OLDEST_MARKER ${'x'.repeat(100)}` },
  { role: 'assistant', text: `NEWEST_MARKER летний отпуск ${'я'.repeat(100)}` },
]);
assert.ok(compactContext.startsWith('current_user: ok\nassistant: NEWEST_MARKER'));
assert.doesNotMatch(compactContext, /OLDEST_MARKER/);
assert.ok(Buffer.byteLength(compactContext, 'utf8') <= SELECTOR_CONTEXT_RETRIEVAL_MAX_UTF8_BYTES);
assert.doesNotMatch(compactContext, /�/);

// Dual embeddings use one adapter batch; empty context keeps one query.
const directEmbedding = fakeEmbeddingAdapter();
const oneQuery = await embedSelectorPromptQueries({ prompt: 'yes, do that', embeddingAdapter: directEmbedding });
assert.equal(oneQuery.contextVector, undefined);
assert.equal(oneQuery.retrievalMode, 'current_only');
assert.equal(directEmbedding.batches.at(-1).length, 1);
const twoQueries = await embedSelectorPromptQueries({ prompt: 'yes, do that', contextualPrompt: 'current_user: yes, do that\nassistant: publish the package', embeddingAdapter: directEmbedding });
assert.ok(twoQueries.contextVector);
assert.equal(twoQueries.retrievalMode, 'current_plus_context_compact');
assert.equal(directEmbedding.batches.at(-1).length, 2);

const fallbackBatches = [];
const fallbackEmbedding = {
  ...fakeEmbeddingAdapter(),
  async embed(texts, { signal } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    fallbackBatches.push([...texts]);
    if (fallbackBatches.length === 1) throw new Error('local_embedding_input_exceeds_128_tokens');
    return texts.map(vectorFor);
  },
};
const fallbackQuery = await embedSelectorPromptQueries({ prompt: 'publish the package', contextualPrompt: 'context', embeddingAdapter: fallbackEmbedding });
assert.equal(fallbackQuery.retrievalMode, 'current_only_after_context_failure');
assert.equal(fallbackQuery.contextVector, undefined);
assert.deepEqual(fallbackBatches.map((batch) => batch.length), [2, 1]);

const cancellation = new AbortController();
let cancellationCalls = 0;
const cancellationEmbedding = {
  ...fakeEmbeddingAdapter(),
  async embed() {
    cancellationCalls += 1;
    cancellation.abort(new Error('selector_cancelled'));
    throw new Error('local_embedding_aborted');
  },
};
await assert.rejects(() => embedSelectorPromptQueries({ prompt: 'publish the package', contextualPrompt: 'context', embeddingAdapter: cancellationEmbedding, signal: cancellation.signal }), /selector_cancelled/);
assert.equal(cancellationCalls, 1, 'cancellation must never retry');

let failedEmbeddingCalls = 0;
const failedEmbedding = {
  ...fakeEmbeddingAdapter(),
  async embed() { failedEmbeddingCalls += 1; throw new Error(`private prompt must not persist ${failedEmbeddingCalls}`); },
};
await assert.rejects(() => embedSelectorPromptQueries({ prompt: 'publish the package', contextualPrompt: 'context', embeddingAdapter: failedEmbedding }), /private prompt/);
assert.equal(failedEmbeddingCalls, 2, 'non-cancellation fallback is bounded to one retry');

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

  const missingAdapter = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Publish the package release now.', contextTurns: [{ role: 'assistant', text: 'context' }],
    config, law, now: '2026-07-17T00:29:00.000Z',
    adapter: { async select() { throw new Error('judge must not run'); } },
  });
  assert.equal(missingAdapter.reason, 'selector_vectors_unavailable');
  const missingAdapterLog = storage.db.prepare("SELECT * FROM selector_hit_log WHERE action = 'diagnostic' AND created_at = ?").get('2026-07-17T00:29:00.000Z');
  assert.deepEqual(JSON.parse(missingAdapterLog.data_json), { mode: 'vector_judge_ctx', model: config.selector_model, stage: 'embedding_adapter' });
  assert.equal(isValidSelectorHitLog(missingAdapterLog), true);

  // One failed contextual batch retries current-only once; judge remains mandatory.
  const runtimeFallbackBatches = [];
  let runtimeFallbackJudgeCalls = 0;
  const runtimeFallbackEmbedding = {
    ...fakeEmbeddingAdapter(),
    async embed(texts, { signal } = {}) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      runtimeFallbackBatches.push([...texts]);
      if (runtimeFallbackBatches.length === 1) throw new Error('local_embedding_input_exceeds_128_tokens');
      return texts.map(vectorFor);
    },
  };
  const runtimeFallback = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Publish the package release now.',
    contextTurns: [{ role: 'assistant', text: 'Context remains available to the mandatory judge.' }],
    config, law, now: '2026-07-17T00:30:00.000Z', embeddingAdapter: runtimeFallbackEmbedding,
    adapter: { async select({ candidateIds, prompt }) {
      runtimeFallbackJudgeCalls += 1;
      assert.equal(JSON.parse(prompt).context_turns.length, 1);
      return judgments(candidateIds, [aliasForOriginalId(prompt, 'release')]);
    } },
  });
  assert.equal(runtimeFallback.injected, true);
  assert.equal(runtimeFallbackJudgeCalls, 1);
  assert.deepEqual(runtimeFallbackBatches.map((batch) => batch.length), [2, 1]);
  const fallbackLog = storage.db.prepare("SELECT * FROM selector_hit_log WHERE reason = 'selected' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(JSON.parse(fallbackLog.data_json).retrieval_mode, 'current_only_after_context_failure');

  // Failed current-only retry emits only a sanitized durable diagnostic.
  let runtimeFailureCalls = 0;
  const runtimeFailureEmbedding = {
    ...fakeEmbeddingAdapter(),
    async embed() { runtimeFailureCalls += 1; throw new Error('private prompt and raw worker failure'); },
  };
  const failedRuntime = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Publish private-example@example.invalid package.',
    contextTurns: [{ role: 'assistant', text: 'Secret context must not persist.' }],
    config, law, now: '2026-07-17T00:31:00.000Z', embeddingAdapter: runtimeFailureEmbedding,
    adapter: { async select() { throw new Error('judge must not run'); } },
  });
  assert.equal(failedRuntime.injected, false);
  assert.equal(failedRuntime.reason, 'selector_vectors_unavailable');
  assert.equal(runtimeFailureCalls, 2);
  const failureLog = storage.db.prepare("SELECT * FROM selector_hit_log WHERE action = 'diagnostic' AND created_at = ?").get('2026-07-17T00:31:00.000Z');
  assert.equal(failureLog.reason, 'selector_vectors_unavailable');
  assert.equal(failureLog.prompt_hash, 'omitted');
  assert.equal(isValidSelectorHitLog(failureLog), true);
  assert.deepEqual(JSON.parse(failureLog.data_json), { mode: 'vector_judge_ctx', model: config.selector_model, stage: 'prompt_vectors' });
  assert.doesNotMatch(JSON.stringify(failureLog), /private-example|Secret context|raw worker|similarity|\[[0-9]/i);

  // Cancellation never retries and never creates a failure diagnostic.
  const cancelledBefore = storage.db.prepare("SELECT COUNT(*) AS count FROM selector_hit_log WHERE action = 'diagnostic'").get().count;
  const cancelledController = new AbortController();
  cancelledController.abort(new Error('selector_cancelled'));
  let cancelledRuntimeCalls = 0;
  const cancelledRuntimeEmbedding = {
    ...fakeEmbeddingAdapter(),
    async embed() { cancelledRuntimeCalls += 1; throw new Error('must not run'); },
  };
  const cancelledRuntime = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Publish the package.', contextTurns: [{ role: 'assistant', text: 'context' }],
    config, law, now: '2026-07-17T00:32:00.000Z', embeddingAdapter: cancelledRuntimeEmbedding,
    adapter: { async select() { throw new Error('must not run'); } }, signal: cancelledController.signal,
  });
  assert.equal(cancelledRuntime.reason, 'selector_cancelled');
  assert.equal(cancelledRuntimeCalls, 0);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM selector_hit_log WHERE action = 'diagnostic'").get().count, cancelledBefore);

  // Invalid model output is diagnosable without retaining request or context.
  const invalidOutput = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Publish the package release now.', contextTurns: [{ role: 'assistant', text: 'Private context marker.' }],
    config, law, now: '2026-07-17T00:33:00.000Z', embeddingAdapter: embedding,
    adapter: { async select() { return {}; } },
  });
  assert.equal(invalidOutput.reason, 'invalid_selector_output');
  const invalidLog = storage.db.prepare("SELECT * FROM selector_hit_log WHERE action = 'diagnostic' AND created_at = ?").get('2026-07-17T00:33:00.000Z');
  assert.equal(invalidLog.reason, 'invalid_selector_output');
  assert.equal(isValidSelectorHitLog(invalidLog), true);
  assert.doesNotMatch(JSON.stringify(invalidLog), /Publish the package|Private context marker|similarity|\[[0-9]/i);

  const originalIdOutput = await runSelectorRuntime(storage.db, {
    userId: 'owner', prompt: 'Publish the package release now.', contextTurns: [{ role: 'assistant', text: 'Context.' }],
    config, law, now: '2026-07-17T00:34:00.000Z', embeddingAdapter: embedding,
    adapter: { async select({ candidateIds }) {
      return { schema_version: 3, judgments: candidateIds.map((id, index) => ({ id: index === 0 ? 'release' : id, applicable: false, confidence_bp: 9500, reason: 'not_currently_relevant' })) };
    } },
  });
  assert.equal(originalIdOutput.reason, 'invalid_selector_output', 'original long ids must never be accepted as an alias fallback');
  const originalIdLog = storage.db.prepare("SELECT * FROM selector_hit_log WHERE action = 'diagnostic' AND created_at = ?").get('2026-07-17T00:34:00.000Z');
  assert.equal(originalIdLog.reason, 'invalid_selector_output');
  assert.doesNotMatch(JSON.stringify(originalIdLog), /release|Context\./i, 'alias failures must retain only sanitized diagnostics');

  // Required proof: assistant proposed action absent from user history; current user adopts it.
  embedding.batches.length = 0;
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
      const releaseAlias = aliasForOriginalId(prompt, 'release');
      assert.ok(candidateIds.includes(releaseAlias));
      assert.doesNotMatch(prompt, /Verify artifacts before publication|"release"/);
      return judgments(candidateIds, [releaseAlias]);
    } },
  });
  assert.equal(assistantFollowUp.injected, true);
  assert.equal(assistantFollowUp.mode, 'vector_judge_ctx');
  assert.deepEqual(assistantFollowUp.selected, [{ id: 'release', confidence_bp: 9500 }], 'accepted alias must map back to original habit id before downstream use');
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
    adapter: { async select({ candidateIds, prompt }) { const alias = aliasForOriginalId(prompt, 'vacation'); assert.ok(candidateIds.includes(alias)); return judgments(candidateIds, [alias]); } },
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
      adapter: { async select({ candidateIds, prompt: judgePrompt }) { calls += 1; const alias = aliasForOriginalId(judgePrompt, selectedId); assert.ok(candidateIds.includes(alias)); return judgments(candidateIds, [alias]); } },
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
    adapter: { async select({ candidateIds, prompt }) { assert.deepEqual(JSON.parse(prompt).context_turns, []); return judgments(candidateIds, [aliasForOriginalId(prompt, 'release')]); } },
  });
  assert.equal(degraded.injected, true);
  assert.equal(degraded.mode, 'vector_judge');

  // Undefined and empty context keep current-only semantics.
  const parity = [];
  for (const contextTurns of [undefined, []]) {
    const result = await runSelectorRuntime(storage.db, {
      userId: 'owner', prompt: 'Publish the package release now.', contextTurns,
      config, law, now: `2026-07-17T01:06:0${parity.length}.000Z`, embeddingAdapter: embedding,
      adapter: { async select({ candidateIds, prompt }) { assert.deepEqual(JSON.parse(prompt).context_turns, []); return judgments(candidateIds, [aliasForOriginalId(prompt, 'release')]); } },
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
