#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension, { __setAgentExperienceSelectorAdapterForTest, __setAgentExperienceSelectorEmbeddingAdapterForTest } from '../extensions/agent-experience/index.ts';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { insertPendingReview } from '../extensions/agent-experience/src/consolidate/model-output.ts';
import { generateHabitsReport, lawSnapshotForTest, readConfiguredLawSnapshot } from '../extensions/agent-experience/src/review.ts';
import {
  buildInjectionMessage,
  buildSelectorJudgeAliases,
  buildSelectorPrompt,
  insertSelectorHitLog,
  isValidSelectorHitLog,
  filterEligibleSelectorCandidates,
  mapSelectorJudgmentsToOriginalIds,
  measureSelectorLatency,
  parseSelectorModelOutput,
  promoteApprovedPendingCandidates,
  runSelectorRuntime,
  selectActiveSelectorSnapshot,
} from '../extensions/agent-experience/src/selector.ts';
import { prepareSelectorConditionVectors } from '../extensions/agent-experience/src/selector-vector.ts';
import { LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_PROVIDER } from '../extensions/agent-experience/src/semantic/local-model-manifest.ts';
import { getAgentExperiencePaths, readAgentExperienceConfig, setAgentExperienceSelectorEnabled } from '../extensions/agent-experience/src/paths.ts';
import { buildHabitSteeringEntry, formatHabitSteeringEntry, HABIT_STEERING_ENTRY_TYPE } from '../extensions/agent-experience/src/steering-note.ts';
import { ensurePrivateRoot } from '../extensions/agent-experience/src/storage/private-root.ts';
import { initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';

function refs(count = 3, generation = 'active') {
  return Array.from({ length: count }, (_, index) => ({ file_generation: generation, seq: index + 1, checksum: String(index + 1).repeat(64).slice(0, 64) }));
}

function sourceDates(days = ['2026-07-06T00:00:00.000Z', '2026-07-06T01:00:00.000Z', '2026-07-07T00:00:00.000Z']) {
  return days;
}

function habitData(overrides = {}) {
  return {
    schema_version: 2,
    record_kind: 'candidate_habit_v1',
    status: 'candidate',
    active: false,
    injectable: false,
    condition: 'answering status questions',
    behavior: 'use concise summaries',
    polarity: 1,
    confidence_bp: 9000,
    activation: 1,
    staleness: 0,
    source_refs: refs(3),
    source_dates: sourceDates(),
    ...overrides,
  };
}

function makePi(options = {}) {
  const commands = new Map();
  const handlers = new Map();
  const renderers = new Map();
  const entries = [];
  const operations = [];
  const fakePi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    on(event, handler) { handlers.set(event, handler); },
    registerTool() {},
    registerEntryRenderer(type, renderer) {
      if (options.rendererError) throw new Error('renderer unavailable');
      renderers.set(type, renderer);
    },
    appendEntry(type, data) {
      operations.push('append');
      if (options.appendError) throw new Error('append unavailable');
      entries.push({ type, data });
    },
    registerFlag() { throw new Error('no flags'); },
    registerShortcut() { throw new Error('no shortcuts'); },
  };
  agentExperienceExtension(fakePi);
  return { commands, handlers, renderers, entries, operations };
}

const steeringCandidate = {
  id: 'selected-internal-id', user_id: 'owner', condition: 'When reporting status', behavior: 'Use concise evidence', polarity: 1,
  confidence_bp: 9000, activation: 1, staleness: 0, checksum: 'a'.repeat(64), law_hash: 'law',
};
const steeringEntry = buildHabitSteeringEntry({ candidates: [steeringCandidate], selected: [{ id: steeringCandidate.id }], createdAt: '2026-07-08T00:00:00.000Z' });
assert.deepEqual(Object.keys(steeringEntry).sort(), ['count', 'created_at', 'habits', 'schema_version']);
assert.deepEqual(steeringEntry.habits, [{ condition: steeringCandidate.condition, behavior: steeringCandidate.behavior }]);
assert.doesNotMatch(JSON.stringify(steeringEntry), /selected-internal-id|confidence|checksum|provider|source|prompt/i);
assert.equal(formatHabitSteeringEntry(steeringEntry, false), '◇ Steered by habit · When reporting status');
assert.equal(formatHabitSteeringEntry(steeringEntry, true), '◇ Steered by habit\n  When: When reporting status\n  Do: Use concise evidence');
assert.equal(formatHabitSteeringEntry({ broken: true }, true), '◇ Steering provenance unavailable');
assert.throws(() => buildHabitSteeringEntry({ candidates: [{ ...steeringCandidate, behavior: 'Email user@example.invalid' }], selected: [{ id: steeringCandidate.id }], createdAt: '2026-07-08T00:00:00.000Z' }), /sensitive/i);
assert.throws(() => buildHabitSteeringEntry({ candidates: [{ ...steeringCandidate, behavior: 'x'.repeat(1001) }], selected: [{ id: steeringCandidate.id }], createdAt: '2026-07-08T00:00:00.000Z' }), /wording/i);
const secondSteeringCandidate = { ...steeringCandidate, id: 'second-internal-id', condition: 'When discussing security', behavior: 'State material risks' };
const multiSteeringEntry = buildHabitSteeringEntry({ candidates: [steeringCandidate, secondSteeringCandidate], selected: [{ id: steeringCandidate.id }, { id: secondSteeringCandidate.id }], createdAt: '2026-07-08T00:00:00.000Z' });
assert.equal(formatHabitSteeringEntry(multiSteeringEntry, false), '◇ Steered by habit · When reporting status\n◇ Steered by habit · When discussing security');
assert.doesNotMatch(formatHabitSteeringEntry(multiSteeringEntry, false), /2 approved habits|habit steering/i, 'collapsed marker must identify exact habits, not show an opaque count');

function unit(index) {
  const vector = new Float32Array(LOCAL_EMBEDDING_DIMENSIONS);
  vector[index] = 1;
  return vector;
}
const phase6Vectors = { status: unit(0), debug: unit(1), hook: unit(2), unrelated: unit(3) };
let phase6EmbeddingCalls = 0;
const phase6Embedding = {
  id: `${LOCAL_EMBEDDING_PROVIDER}:${LOCAL_EMBEDDING_MODEL}:${LOCAL_EMBEDDING_DIMENSIONS}`,
  provider: LOCAL_EMBEDDING_PROVIDER,
  model: LOCAL_EMBEDDING_MODEL,
  dimensions: LOCAL_EMBEDDING_DIMENSIONS,
  async embed(texts, { signal } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    phase6EmbeddingCalls += 1;
    return texts.map((text) => {
      const value = String(text).toLowerCase();
      if (/status/.test(value)) return phase6Vectors.status;
      if (/debug/.test(value)) return phase6Vectors.debug;
      if (/hook prompt/.test(value)) return phase6Vectors.hook;
      return phase6Vectors.unrelated;
    });
  },
};
function judgments(candidateIds, selectedIds = []) {
  const selected = new Set(selectedIds);
  return { schema_version: 3, judgments: candidateIds.map((id) => selected.has(id)
    ? { id, applicable: true, confidence_bp: 9500, reason: 'current_applicability' }
    : { id, applicable: false, confidence_bp: 9500, reason: 'not_currently_relevant' }) };
}

function aliasForCondition(prompt, pattern) {
  const match = JSON.parse(prompt).candidates.find((candidate) => pattern.test(candidate.condition));
  assert.ok(match, `expected aliased candidate matching ${pattern}`);
  assert.match(match.id, /^c[1-9][0-9]*$/);
  return match.id;
}

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase6-'));
process.env.AX_STATE_ROOT = join(temp, 'state');
const root = await ensurePrivateRoot(process.env.AX_STATE_ROOT);
await writeFile(join(root, 'law.md'), 'phase6 configured law\n');
const liveCwd = await mkdtemp(join(temp, 'live-cwd-no-docs-'));
const storage = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
try {
  assert.equal(storage.db.prepare('PRAGMA user_version').get().user_version, 6);
  assert.ok(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='selector_hit_log'").get());

  const law = lawSnapshotForTest('phase6 law');
  insertStorageRecord(storage.db, 'habits', { id: 'active-1', userId: 'owner', data: habitData({ status: 'active', active: true, condition: 'answering status questions', behavior: 'use concise summaries', law_hash: law.hash, injectable: false }), now: '2026-07-08T00:00:00.000Z' });
  insertStorageRecord(storage.db, 'habits', { id: 'active-2', userId: 'owner', data: habitData({ status: 'active', active: true, condition: 'debugging tests', behavior: 'ask before broad changes', law_hash: law.hash, confidence_bp: 8200 }), now: '2026-07-08T00:01:00.000Z' });
  insertStorageRecord(storage.db, 'habits', { id: 'active-stale', userId: 'owner', data: habitData({ status: 'active', active: true, condition: 'writing docs', behavior: 'use examples', law_hash: law.hash, staleness: 0.95 }), now: '2026-07-08T00:02:00.000Z' });
  insertStorageRecord(storage.db, 'habits', { id: 'candidate-1', userId: 'owner', data: habitData(), now: '2026-07-08T00:03:00.000Z' });
  insertStorageRecord(storage.db, 'habits', { id: 'disabled-1', userId: 'owner', data: habitData({ status: 'disabled', condition: 'disabled habit', behavior: 'do not include' }), now: '2026-07-08T00:04:00.000Z' });
  insertStorageRecord(storage.db, 'habits', { id: 'suppressed-1', userId: 'owner', data: habitData({ status: 'suppressed_by_law', condition: 'suppressed habit', behavior: 'do not include' }), now: '2026-07-08T00:05:00.000Z' });
  insertStorageRecord(storage.db, 'habits', { id: 'archived-1', userId: 'owner', data: habitData({ status: 'archived', condition: 'archived habit', behavior: 'do not include' }), now: '2026-07-08T00:06:00.000Z' });
  insertStorageRecord(storage.db, 'habits', { id: 'dormant-1', userId: 'owner', data: habitData({ status: 'dormant', condition: 'dormant habit', behavior: 'do not include' }), now: '2026-07-08T00:07:00.000Z' });
  insertStorageRecord(storage.db, 'habits', { id: 'other-active', userId: 'other', data: habitData({ status: 'active', active: true, condition: 'other user secret', behavior: 'do not leak', law_hash: law.hash }), now: '2026-07-08T00:08:00.000Z' });
  insertStorageRecord(storage.db, 'evidence', { id: 'evidence-1', userId: 'owner', data: habitData({ status: 'active', condition: 'evidence row', behavior: 'do not inject', habit_id: 'active-1' }), now: '2026-07-08T00:09:00.000Z' });
  insertPendingReview(storage.db, { userId: 'owner', kind: 'candidate_key_conflict', payload: { condition: 'pending row', behavior: 'do not inject' }, createdAt: '2026-07-08T00:10:00.000Z' });
  storage.db.prepare("INSERT INTO model_output_quarantine (id, user_id, file_generation, seq_start, seq_end, reason, model, output_json, checksum, created_at, row_checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run('q1', 'owner', 'active', 1, 1, 'bad', 'model', '{}', 'a'.repeat(64), '2026-07-08T00:11:00.000Z', 'b'.repeat(64));
  const report = await generateHabitsReport(storage.db, { root, userId: 'owner', now: '2026-07-08T00:12:00.000Z' });
  assert.match(report.path, /habits-report\.md$/);

  const snapshot = selectActiveSelectorSnapshot(storage.db, { userId: 'owner' });
  assert.deepEqual(snapshot.map((row) => row.id).sort(), ['active-1', 'active-2', 'active-stale']);
  assert.equal(selectActiveSelectorSnapshot(storage.db, { userId: 'other' }).map((row) => row.id).includes('other-active'), true);
  assert.equal(snapshot.some((row) => /candidate|disabled|suppressed|archived|dormant|evidence|pending|quarantine/i.test(`${row.id} ${row.condition} ${row.behavior}`)), false);

  const narrowedA = filterEligibleSelectorCandidates(snapshot, { minConfidenceBp: 7500, stalenessMax: 0.8 });
  const narrowedB = filterEligibleSelectorCandidates(snapshot, { minConfidenceBp: 7500, stalenessMax: 0.8 });
  assert.deepEqual(narrowedA.map((row) => row.id), narrowedB.map((row) => row.id), 'eligibility filter must be deterministic');
  assert.equal(narrowedA.some((row) => row.id === 'active-stale'), false, 'stale habit must be gated out');
  await prepareSelectorConditionVectors(storage.db, { userId: 'owner', candidates: narrowedA, embeddingAdapter: phase6Embedding, now: '2026-07-08T00:30:00.000Z' });

  const smartPrompt = buildSelectorPrompt(narrowedA, { prompt: 'please read sergey@example.invalid and /home/misunderstood/private-file before selecting', maxHabits: 3 });
  assert.doesNotMatch(smartPrompt, /sergey@example\.invalid|\/home\/misunderstood\/private-file|use concise summaries|ask before broad changes/i, 'judge prompt must redact request and exclude behavior');
  assert.match(smartPrompt, /redacted/i, 'judge prompt should preserve only redacted request signal');

  const longOriginalId = `habit-user-declared-${'a'.repeat(40)}`;
  const aliasPacket = buildSelectorJudgeAliases([{ ...narrowedA[0], id: longOriginalId }, narrowedA[1]]);
  assert.deepEqual(aliasPacket.candidateIds, ['c1', 'c2']);
  assert.throws(() => buildSelectorJudgeAliases([narrowedA[0], narrowedA[0]]), /Invalid selector candidates/);
  const aliasPrompt = buildSelectorPrompt(aliasPacket.candidates, { prompt: 'status', maxHabits: 3 });
  assert.doesNotMatch(aliasPrompt, new RegExp(longOriginalId));
  const selectedAliases = parseSelectorModelOutput(judgments(aliasPacket.candidateIds, ['c1']), { candidateIds: aliasPacket.candidateIds, maxSelected: 3, minConfidenceBp: 7500 });
  assert.deepEqual(mapSelectorJudgmentsToOriginalIds(selectedAliases, aliasPacket.originalIdByAlias), [{ id: longOriginalId, confidence_bp: 9500 }]);
  assert.throws(() => parseSelectorModelOutput(judgments([longOriginalId], [longOriginalId]), { candidateIds: aliasPacket.candidateIds, maxSelected: 3, minConfidenceBp: 7500 }), /coverage|Unknown/);

  assert.deepEqual(parseSelectorModelOutput(judgments(narrowedA.map((row) => row.id), ['active-1']), { candidateIds: narrowedA.map((row) => row.id), maxSelected: 3, minConfidenceBp: 7500 }), [{ id: 'active-1', confidence_bp: 9500 }]);
  assert.throws(() => parseSelectorModelOutput({ schema_version: 3, judgments: [{ id: 'candidate-1', applicable: true, confidence_bp: 9000, reason: 'current_applicability' }] }, { candidateIds: narrowedA.map((row) => row.id), maxSelected: 3, minConfidenceBp: 7500 }), /coverage|Unknown/);
  assert.throws(() => parseSelectorModelOutput({ ...judgments(narrowedA.map((row) => row.id)), text: 'free text' }, { candidateIds: narrowedA.map((row) => row.id), maxSelected: 3, minConfidenceBp: 7500 }), /keys/);

  const injectedText = buildInjectionMessage(snapshot, [{ id: 'active-1', confidence_bp: 9000 }]);
  assert.match(injectedText, /Agent Experience approved habit guidance/);
  assert.match(injectedText, /Do: use concise summaries/);
  assert.doesNotMatch(injectedText, /confidence_bp/);
  assert.doesNotMatch(injectedText, /pending row|quarantine|habits-report|other user/);

  const config = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, selector_enabled: true, selector_min_confidence_bp: 7500, selector_max_habits: 3, selector_staleness_max: 0.8 };
  let adapterCalls = 0;
  const adapter = { async select({ candidateIds, prompt }) { adapterCalls += 1; assert.deepEqual(candidateIds, JSON.parse(prompt).candidates.map((candidate) => candidate.id)); return judgments(candidateIds, [aliasForCondition(prompt, /answering status questions/i)]); } };
  const selected = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'status summary please', config, law, now: '2026-07-08T01:00:00.000Z', adapter, embeddingAdapter: phase6Embedding });
  assert.equal(selected.injected, true);
  assert.equal(selected.mode, 'vector_judge');
  assert.equal(selected.model, config.selector_model);
  assert.deepEqual(selected.selected, [{ id: 'active-1', confidence_bp: 9500 }], 'runtime must restore original habit ids immediately after strict alias parsing');
  assert.equal(adapterCalls, 1, 'every successful selection must use the bounded applicability judge after local vectors');
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM selector_hit_log WHERE user_id = ? AND action = 'inject' AND selected = 1").get('owner').count, 1);
  const second = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'status again', config, law, now: '2026-07-08T01:01:00.000Z', adapter, embeddingAdapter: phase6Embedding });
  assert.equal(second.injected, true, 'every genuinely matching message may receive guidance without a daily quota');
  for (let index = 0; index < 25; index += 1) {
    const repeated = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'status again', config, law, now: `2026-07-08T02:${String(index).padStart(2, '0')}:00.000Z`, adapter, embeddingAdapter: phase6Embedding });
    assert.equal(repeated.injected, true, `vector+judge guidance must remain available beyond the former daily cap (${index + 1}/25)`);
  }
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM selector_hit_log WHERE user_id = ? AND action = 'inject' AND selected = 1").get('owner').count, 27);
  assert.equal(adapterCalls, 27, 'each eligible repeated request must be judged once');
  const corrupt = storage.db.prepare("SELECT * FROM selector_hit_log WHERE action = 'inject' LIMIT 1").get();
  assert.equal(isValidSelectorHitLog(corrupt), true);
  storage.db.prepare("UPDATE selector_hit_log SET checksum = ? WHERE id = ?").run('c'.repeat(64), corrupt.id);
  assert.equal(isValidSelectorHitLog(storage.db.prepare("SELECT * FROM selector_hit_log WHERE id = ?").get(corrupt.id)), false, 'hit-log integrity remains independently verifiable without quota semantics');

  const invalid = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'debug tests', config, law, now: '2026-07-08T01:03:00.000Z', embeddingAdapter: phase6Embedding, adapter: { async select({ candidateIds }) { return { schema_version: 3, judgments: candidateIds.map((id) => ({ id: id === candidateIds[0] ? 'missing' : id, applicable: false, confidence_bp: 9000, reason: 'not_currently_relevant' })) }; } } });
  assert.equal(invalid.injected, false);
  assert.equal(invalid.reason, 'invalid_selector_output');
  const unavailable = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'debug tests', config, law, now: '2026-07-08T01:04:00.000Z', embeddingAdapter: phase6Embedding });
  assert.equal(unavailable.injected, false);
  assert.equal(unavailable.reason, 'selector_unavailable');
  const timeout = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'debug tests', config: { ...config, selector_timeout_ms: 1 }, law, now: '2026-07-08T01:05:00.000Z', embeddingAdapter: phase6Embedding, adapter: { async select() { await new Promise((resolve) => setTimeout(resolve, 20)); return judgments([]); } } });
  assert.equal(timeout.injected, false);
  assert.match(timeout.reason, /timeout/);
  const staleLaw = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'status', config, law: lawSnapshotForTest('changed law'), now: '2026-07-08T01:06:00.000Z', adapter, embeddingAdapter: phase6Embedding });
  assert.equal(staleLaw.injected, false);
  assert.equal(staleLaw.reason, 'no_fresh_active_candidates');

  const latency = await measureSelectorLatency({ adapter, prompt: 'status', candidates: narrowedA, iterations: 3, timeoutMs: 1500, model: 'openai-codex/gpt-5.4-mini' });
  assert.equal(latency.compatible_with_1500ms, true);

  const pendingPass = insertStorageRecord(storage.db, 'habits', { id: 'pending-pass', userId: 'owner', data: habitData({ status: 'candidate', condition: 'writing updates', behavior: 'use bullets', review_status: 'approved_pending_eligibility', source_refs: refs(3, 'promote'), source_dates: sourceDates() }), now: '2026-07-08T02:00:00.000Z' });
  assert.equal(pendingPass.checksum.length, 64);
  const pendingLawFail = insertStorageRecord(storage.db, 'habits', { id: 'pending-law-fail', userId: 'owner', data: habitData({ status: 'candidate', condition: 'asked for secrets', behavior: 'reveal secrets', review_status: 'approved_pending_eligibility', source_refs: refs(3, 'promote2'), source_dates: sourceDates() }), now: '2026-07-08T02:01:00.000Z' });
  assert.equal(pendingLawFail.checksum.length, 64);
  await assert.rejects(() => promoteApprovedPendingCandidates(storage.db, { userId: 'owner', law, now: '2026-07-08T02:02:00.000Z' }), /explicit semantic dedupe policy/, 'background promotion must fail closed when semantic policy is omitted');
  const promoted = await promoteApprovedPendingCandidates(storage.db, { userId: 'owner', law, now: '2026-07-08T02:02:00.000Z', semantic: { policy: { enabled: false } } });
  assert.ok(promoted.promoted.includes('pending-pass'));
  assert.ok(promoted.blocked.some((item) => item.id === 'pending-law-fail'));
  assert.equal(storage.db.prepare("SELECT status FROM habits WHERE id = 'pending-pass'").get().status, 'active');
  assert.equal(storage.db.prepare("SELECT status FROM habits WHERE id = 'pending-law-fail'").get().status, 'suppressed_by_law');

  const { commands, handlers, renderers, entries, operations } = makePi();
  assert.ok(handlers.has('before_agent_start'));
  assert.deepEqual([...commands.keys()], ['experience']);
  assert.ok(renderers.has(HABIT_STEERING_ENTRY_TYPE), 'extension must register the TUI-only steering provenance renderer');
  const notes = [];
  const mainSessionManager = { getSessionId: () => 'phase6-main', getSessionFile: () => join(temp, 'phase6-main.jsonl') };
  const ctx = { cwd: liveCwd, mode: 'tui', model: { api: 'openai-completions' }, sessionManager: mainSessionManager, ui: { notify(message, level) { notes.push({ message, level }); } } };
  await commands.get('experience').handler('enable', ctx);
  let readConfig = await readAgentExperienceConfig(getAgentExperiencePaths());
  assert.equal(readConfig.config.selector_enabled, false, 'master enable must not enable selector');
  __setAgentExperienceSelectorEmbeddingAdapterForTest(phase6Embedding);
  const realLaw = await readConfiguredLawSnapshot(root, readConfig.config);
  insertStorageRecord(storage.db, 'habits', { id: 'hook-active', userId: 'owner', data: habitData({ status: 'active', active: true, condition: 'hook prompt', behavior: 'use hook guidance', law_hash: realLaw.hash, confidence_bp: 9500 }), now: '2026-07-08T03:00:00.000Z' });
  const hookSnapshot = filterEligibleSelectorCandidates(selectActiveSelectorSnapshot(storage.db, { userId: 'owner' }), { minConfidenceBp: 7500, stalenessMax: 0.8 });
  await prepareSelectorConditionVectors(storage.db, { userId: 'owner', candidates: hookSnapshot, embeddingAdapter: phase6Embedding, now: '2026-07-08T03:00:01.000Z' });
  await setAgentExperienceSelectorEnabled(true);
  readConfig = await readAgentExperienceConfig(getAgentExperiencePaths());
  assert.equal(readConfig.config.selector_enabled, true);
  let hookSelectorCalls = 0;
  __setAgentExperienceSelectorAdapterForTest({ async select({ candidateIds, prompt }) { hookSelectorCalls += 1; operations.push('assess'); return judgments(candidateIds, [aliasForCondition(prompt, /hook prompt/i)]); } });
  const beforeStatus = storage.db.prepare("SELECT status FROM habits WHERE id = 'hook-active'").get().status;
  const embeddingsBeforeHook = phase6EmbeddingCalls;
  const hookResult = handlers.get('before_agent_start')({ prompt: 'hook prompt please', systemPrompt: 'base system prompt' }, ctx);
  operations.push('submitted');
  assert.equal(hookResult, undefined, 'before_agent_start must stay synchronous and must not modify the system prompt');
  assert.equal(hookSelectorCalls, 0, 'submission hook must not start model assessment before Pi renders the user message');
  assert.equal(phase6EmbeddingCalls, embeddingsBeforeHook, 'submission hook must not start local prompt embedding before Pi renders the user message');
  assert.deepEqual(operations, ['submitted']);
  assert.equal(entries.length, 0, 'marker must wait for the response-specific context boundary');
  assert.equal(storage.db.prepare("SELECT status FROM habits WHERE id = 'hook-active'").get().status, beforeStatus, 'submission hook must not mutate habit status');
  const userContext = [{ role: 'user', content: [{ type: 'text', text: 'hook prompt please' }], timestamp: Date.now() }];
  const otherSessionCtx = { ...ctx, sessionManager: { getSessionId: () => 'phase6-other', getSessionFile: () => join(temp, 'phase6-other.jsonl') } };
  assert.equal(await handlers.get('context')({ messages: userContext }, otherSessionCtx), undefined, 'same prompt in another session must not inherit or consume pending steering');
  assert.equal(entries.length, 0);
  const previousUserId = process.env.AX_USER_ID;
  try {
    process.env.AX_USER_ID = 'phase6-other-user';
    assert.equal(await handlers.get('context')({ messages: userContext }, ctx), undefined, 'same prompt and session under another user must not inherit or consume pending steering');
    assert.equal(entries.length, 0);
  } finally {
    if (previousUserId === undefined) delete process.env.AX_USER_ID;
    else process.env.AX_USER_ID = previousUserId;
  }
  const contextResult = await handlers.get('context')({ messages: userContext }, ctx);
  operations.push('context-returned');
  assert.equal(contextResult, undefined, 'selector context must never add a user/custom guidance message');
  assert.equal(hookSelectorCalls, 1, 'first provider-context boundary must assess the rendered user message exactly once');
  assert.ok(phase6EmbeddingCalls > embeddingsBeforeHook, 'first provider-context boundary must perform the deferred local prompt embedding');
  assert.deepEqual(operations, ['submitted', 'assess', 'context-returned'], 'assessment must run only after user submission/rendering');
  assert.equal(entries.length, 0, 'marker must wait until a valid system-level provider payload is prepared');
  const providerPayload = { messages: [{ role: 'developer', content: 'base system' }, { role: 'user', content: 'hook prompt please' }] };
  const providerResult = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
  operations.push('provider-returned');
  assert.deepEqual(operations, ['submitted', 'assess', 'context-returned', 'append', 'provider-returned'], 'provider payload preparation must precede marker commit and response work');
  assert.equal(entries.length, 1, 'one steered response must append exactly one provenance entry');
  assert.equal(entries[0].type, HABIT_STEERING_ENTRY_TYPE);
  assert.deepEqual(entries[0].data.habits, [{ condition: 'hook prompt', behavior: 'use hook guidance' }]);
  assert.doesNotMatch(JSON.stringify(entries[0]), /hook-active|"confidence|"checksum|"provider|"source_ref|"prompt_hash|"audit/i, 'session provenance must contain approved wording only');
  assert.match(providerResult.messages[0].content, /agent_experience_response_guidance/);
  assert.match(providerResult.messages[0].content, /When: hook prompt/);
  assert.match(providerResult.messages[0].content, /Do: use hook guidance/);
  assert.doesNotMatch(JSON.stringify(providerResult.messages[1]), /agent_experience_response_guidance|hook guidance/, 'habit guidance must never enter user content');
  assert.deepEqual(providerPayload, { messages: [{ role: 'developer', content: 'base system' }, { role: 'user', content: 'hook prompt please' }] }, 'provider adapter must not mutate its input');
  const toolLoopContext = [...userContext, { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }], timestamp: Date.now() }, { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: Date.now() }];
  assert.equal(await handlers.get('context')({ messages: toolLoopContext }, ctx), undefined, 'tool-loop context must remain unchanged');
  const toolLoopProvider = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
  assert.equal(entries.length, 1, 'tool-loop provider calls must not append duplicate response markers');
  assert.match(toolLoopProvider.messages[0].content, /When: hook prompt/);
  await handlers.get('agent_end')({ messages: [] }, ctx);
  assert.equal(await handlers.get('context')({ messages: userContext }, ctx), undefined, 'automatic retry context must remain unchanged');
  const retryProvider = handlers.get('before_provider_request')({ payload: providerResult }, ctx);
  assert.equal((JSON.stringify(retryProvider).match(/<agent_experience_response_guidance>/g) || []).length, 1, 'automatic retry payload must retain exactly one system guidance block until agent_settled');
  assert.equal(entries.length, 1, 'automatic retries must not append duplicate markers');
  const followUpResult = await handlers.get('context')({ messages: [...toolLoopContext, { role: 'user', content: [{ type: 'text', text: 'different queued follow-up' }], timestamp: Date.now() }] }, ctx);
  assert.equal(followUpResult, undefined, 'a new queued user message must never inherit the previous response steering');
  assert.equal(handlers.get('before_provider_request')({ payload: providerPayload }, ctx), undefined, 'changed user boundary must clear old provider guidance state');
  assert.equal(entries.length, 1);

  const entryCountBeforeNoSelection = entries.length;
  const noSelectionMessages = [{ role: 'user', content: [{ type: 'text', text: 'words with no matching habit' }] }];
  const noSelectionResult = handlers.get('before_agent_start')({ prompt: 'words with no matching habit', systemPrompt: 'base' }, ctx);
  assert.equal(noSelectionResult, undefined);
  const callsBeforeNoSelection = hookSelectorCalls;
  assert.equal(await handlers.get('context')({ messages: noSelectionMessages }, ctx), undefined);
  const callsAfterNoSelection = hookSelectorCalls;
  assert.equal(await handlers.get('context')({ messages: noSelectionMessages }, ctx), undefined);
  assert.equal(hookSelectorCalls, callsAfterNoSelection, 'no-selection tool-loop context must not retry assessment');
  assert.ok(callsAfterNoSelection - callsBeforeNoSelection <= 1, 'one user message may launch at most one applicability judgment');
  assert.equal(entries.length, entryCountBeforeNoSelection, 'an unsteered answer must append no marker and prepare no system guidance');
  assert.equal(handlers.get('before_provider_request')({ payload: providerPayload }, ctx), undefined);

  const canceled = makePi();
  const canceledController = new AbortController();
  canceledController.abort(new Error('canceled test response'));
  const canceledCtx = { ...ctx, signal: canceledController.signal, sessionManager: { getSessionId: () => 'phase6-canceled', getSessionFile: () => join(temp, 'phase6-canceled.jsonl') } };
  canceled.handlers.get('before_agent_start')({ prompt: 'hook prompt please', systemPrompt: 'base' }, canceledCtx);
  assert.equal(await canceled.handlers.get('context')({ messages: userContext }, canceledCtx), undefined, 'canceled selector context must remain unchanged');
  assert.equal(canceled.handlers.get('before_provider_request')({ payload: providerPayload }, canceledCtx), undefined, 'canceled selection must prepare no provider guidance');
  assert.equal(canceled.entries.length, 0, 'canceled selection must append no marker');

  const overwritten = makePi();
  const overwrittenCtx = { cwd: liveCwd, mode: 'tui', model: { api: 'openai-completions' }, sessionManager: { getSessionId: () => 'phase6-overwrite', getSessionFile: () => join(temp, 'phase6-overwrite.jsonl') }, ui: { notify() {} } };
  await overwritten.handlers.get('before_agent_start')({ prompt: 'hook prompt please', systemPrompt: 'base' }, overwrittenCtx);
  await overwritten.handlers.get('before_agent_start')({ prompt: 'hook prompt now', systemPrompt: 'base' }, overwrittenCtx);
  assert.equal(await overwritten.handlers.get('context')({ messages: userContext }, overwrittenCtx), undefined, 'older same-session context must not consume a newer pending turn');
  const overwrittenResult = await overwritten.handlers.get('context')({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hook prompt now' }] }] }, overwrittenCtx);
  assert.equal(overwrittenResult, undefined);
  const overwrittenProvider = overwritten.handlers.get('before_provider_request')({ payload: providerPayload }, overwrittenCtx);
  assert.match(overwrittenProvider.messages[0].content, /When: hook prompt/);
  assert.deepEqual(overwritten.entries.at(-1).data.habits, [{ condition: 'hook prompt', behavior: 'use hook guidance' }]);
  await overwritten.handlers.get('agent_settled')({}, overwrittenCtx);
  assert.equal(overwritten.handlers.get('before_provider_request')({ payload: providerPayload }, overwrittenCtx), undefined, 'settlement must clear transient provider guidance');

  const unsupported = makePi();
  const unsupportedNotes = [];
  const unsupportedCtx = { cwd: liveCwd, mode: 'tui', model: { api: 'custom-unknown-api' }, sessionManager: { getSessionId: () => 'phase6-unsupported', getSessionFile: () => join(temp, 'phase6-unsupported.jsonl') }, ui: { notify(message, level) { unsupportedNotes.push({ message, level }); } } };
  unsupported.handlers.get('before_agent_start')({ prompt: 'hook prompt please', systemPrompt: 'base' }, unsupportedCtx);
  await unsupported.handlers.get('context')({ messages: userContext }, unsupportedCtx);
  assert.equal(unsupported.handlers.get('before_provider_request')({ payload: providerPayload }, unsupportedCtx), undefined, 'unsupported provider APIs must fail closed');
  assert.equal(unsupported.entries.length, 0, 'unsupported provider APIs must not commit a marker');
  assert.ok(unsupportedNotes.some((note) => /could not accept verified system-level guidance/.test(note.message)));
  unsupportedCtx.model = { api: 'openai-completions' };
  assert.equal(unsupported.handlers.get('before_provider_request')({ payload: providerPayload }, unsupportedCtx), undefined, 'unsupported first provider attempt must leave a no-guidance tombstone');

  const appendFailure = makePi({ appendError: true });
  const appendFailureNotes = [];
  const appendFailureCtx = { cwd: liveCwd, mode: 'tui', model: { api: 'openai-completions' }, sessionManager: { getSessionId: () => 'phase6-append-failure', getSessionFile: () => join(temp, 'phase6-append-failure.jsonl') }, ui: { notify(message, level) { appendFailureNotes.push({ message, level }); } } };
  const appendFailureResult = appendFailure.handlers.get('before_agent_start')({ prompt: 'hook prompt please', systemPrompt: 'base' }, appendFailureCtx);
  assert.equal(appendFailureResult, undefined);
  const callsBeforeAppendFailure = hookSelectorCalls;
  const appendFailureContext = await appendFailure.handlers.get('context')({ messages: userContext }, appendFailureCtx);
  assert.equal(appendFailureContext, undefined, 'selector context must remain unchanged before provenance commit');
  const appendFailureProvider = appendFailure.handlers.get('before_provider_request')({ payload: providerPayload }, appendFailureCtx);
  assert.equal(appendFailureProvider, undefined, 'append failure must return the original provider payload implicitly and suppress guidance');
  assert.equal(appendFailure.entries.length, 0);
  assert.ok(appendFailureNotes.some((note) => /provenance marker could not be recorded/.test(note.message)));
  assert.doesNotMatch(JSON.stringify(appendFailureNotes), /hook prompt|hook guidance|provider|model|checksum/i, 'provenance failure diagnostic must be static and sanitized');
  const callsAfterAppendFailure = hookSelectorCalls;
  assert.equal(await appendFailure.handlers.get('context')({ messages: userContext }, appendFailureCtx), undefined, 'failed provenance must retain a no-guidance tombstone');
  assert.equal(appendFailure.handlers.get('before_provider_request')({ payload: providerPayload }, appendFailureCtx), undefined, 'failed provenance must not apply guidance on retry');
  assert.equal(hookSelectorCalls, callsAfterAppendFailure, 'provenance failure must not retry selector assessment');
  assert.equal(callsAfterAppendFailure, callsBeforeAppendFailure + 1);

  const rendererFailure = makePi({ rendererError: true });
  const rendererFailureNotes = [];
  const rendererFailureCtx = { cwd: liveCwd, mode: 'tui', sessionManager: { getSessionId: () => 'phase6-renderer-failure', getSessionFile: () => join(temp, 'phase6-renderer-failure.jsonl') }, ui: { notify(message, level) { rendererFailureNotes.push({ message, level }); } } };
  const logsBeforeRendererFailure = storage.db.prepare('SELECT COUNT(*) count FROM selector_hit_log').get().count;
  const rendererFailureResult = await rendererFailure.handlers.get('before_agent_start')({ prompt: 'hook prompt please', systemPrompt: 'base' }, rendererFailureCtx);
  assert.equal(rendererFailureResult, undefined, 'unrenderable provenance must suppress habit guidance before selection');
  assert.equal(await rendererFailure.handlers.get('context')({ messages: userContext }, rendererFailureCtx), undefined);
  assert.equal(storage.db.prepare('SELECT COUNT(*) count FROM selector_hit_log').get().count, logsBeforeRendererFailure, 'renderer-unavailable path must not run selector or log an injection');
  assert.ok(rendererFailureNotes.some((note) => /response-specific visual provenance is unavailable/.test(note.message)));

  const nonTui = makePi();
  const nonTuiCtx = { cwd: liveCwd, mode: 'rpc', sessionManager: { getSessionId: () => 'phase6-rpc', getSessionFile: () => join(temp, 'phase6-rpc.jsonl') }, ui: { notify() {} } };
  const logsBeforeNonTui = storage.db.prepare('SELECT COUNT(*) count FROM selector_hit_log').get().count;
  const nonTuiResult = await nonTui.handlers.get('before_agent_start')({ prompt: 'hook prompt please', systemPrompt: 'base' }, nonTuiCtx);
  assert.equal(nonTuiResult, undefined, 'non-TUI interfaces must not receive invisible habit steering');
  assert.equal(await nonTui.handlers.get('context')({ messages: userContext }, nonTuiCtx), undefined);
  assert.equal(storage.db.prepare('SELECT COUNT(*) count FROM selector_hit_log').get().count, logsBeforeNonTui);
  assert.equal(nonTui.entries.length, 0);

  const lateNonTui = makePi();
  const lateNonTuiCtx = { ...ctx, sessionManager: { getSessionId: () => 'phase6-late-non-tui', getSessionFile: () => join(temp, 'phase6-late-non-tui.jsonl') } };
  lateNonTui.handlers.get('before_agent_start')({ prompt: 'hook prompt please', systemPrompt: 'base' }, lateNonTuiCtx);
  assert.equal(await lateNonTui.handlers.get('context')({ messages: userContext }, lateNonTuiCtx), undefined);
  assert.equal(lateNonTui.handlers.get('before_provider_request')({ payload: providerPayload }, { ...lateNonTuiCtx, mode: 'rpc' }), undefined, 'provider hook must independently suppress guidance outside TUI mode');
  assert.equal(lateNonTui.entries.length, 0, 'late non-TUI provider boundary must append no marker');
  assert.equal(lateNonTui.handlers.get('before_provider_request')({ payload: providerPayload }, lateNonTuiCtx), undefined, 'late non-TUI boundary must leave a no-guidance tombstone');

  await commands.get('experience').handler('capture on', ctx);
  await handlers.get('input')({ text: 'hello', source: 'interactive' }, { sessionManager: { getSessionId: () => 's1', getSessionFile: () => join(temp, 's1.jsonl') } });
  await handlers.get('agent_end')({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'world' }] }] }, { sessionManager: { getSessionId: () => 's1', getSessionFile: () => join(temp, 's1.jsonl') } });
  const beforeObservationCount = storage.db.prepare('SELECT COUNT(*) AS count FROM evidence').get().count;
  await commands.get('experience').handler('disable', ctx);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS count FROM evidence').get().count, beforeObservationCount, 'disable must not flush capture buffers into observation/evidence rows');
  await commands.get('experience').handler('capture off', ctx);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS count FROM evidence').get().count, beforeObservationCount, 'capture off must not write observations');

  const explain = (await import('../extensions/agent-experience/src/review.ts')).explainHabit(storage.db, { userId: 'owner', habitId: 'hook-active' });
  assert.ok(Array.isArray(explain.hit_log));
  assert.equal(JSON.stringify(explain.hit_log).includes('hook prompt please'), false, 'hit logs must not expose raw prompt');
  const logsText = JSON.stringify(storage.db.prepare('SELECT data_json, prompt_hash FROM selector_hit_log').all());
  assert.equal(logsText.includes('hook prompt please'), false, 'selector hit-log data must not store raw prompt');
  assert.equal(logsText.includes('omitted'), true, 'selector hit-log prompt hash must omit linkable prompt derivatives');
  const reportText = await readFile(report.path, 'utf8');
  assert.doesNotMatch(reportText, /hook guidance/);

  const missingLawRoot = join(temp, 'missing-law-state');
  process.env.AX_STATE_ROOT = missingLawRoot;
  const missingLawStorage = await initExperienceStorage(missingLawRoot, { allowInit: true, userId: 'owner' });
  missingLawStorage.db.close();
  const missingLaw = makePi();
  const missingLawNotes = [];
  const missingLawCtx = { cwd: liveCwd, mode: 'tui', sessionManager: { getSessionId: () => 'phase6-missing-law', getSessionFile: () => join(temp, 'phase6-missing-law.jsonl') }, ui: { notify(message, level) { missingLawNotes.push({ message, level }); } } };
  await missingLaw.commands.get('experience').handler('enable', missingLawCtx);
  await setAgentExperienceSelectorEnabled(true);
  __setAgentExperienceSelectorAdapterForTest({ async select() { throw new Error('selector must not run without configured law'); } });
  const missingLawResult = missingLaw.handlers.get('before_agent_start')({ prompt: 'hook prompt please', systemPrompt: 'base' }, missingLawCtx);
  assert.equal(missingLawResult, undefined, 'submission hook must remain nonblocking when configured law is missing');
  assert.equal(missingLawNotes.some((note) => /safety file is missing/.test(note.message)), false, 'law validation must wait until after user-message rendering');
  await missingLaw.handlers.get('context')({ messages: userContext }, missingLawCtx);
  const missingLawWarning = missingLawNotes.find((note) => /safety file is missing/.test(note.message) && note.level === 'warn');
  assert.ok(missingLawWarning, 'missing safety file must emit one bounded visible diagnostic');
  assert.match(missingLawWarning.message, /turned off/);
  assert.doesNotMatch(missingLawWarning.message, /setup use-habits off|law file missing|selector skipped/i);
  assert.equal((await readAgentExperienceConfig(getAgentExperiencePaths())).config.selector_enabled, false, 'missing safety file turns reminders off to stop repeated warnings');
  const missingLawNoteCount = missingLawNotes.length;
  missingLaw.handlers.get('before_agent_start')({ prompt: 'hook prompt again', systemPrompt: 'base' }, missingLawCtx);
  await missingLaw.handlers.get('context')({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hook prompt again' }] }] }, missingLawCtx);
  assert.equal(missingLawNotes.length, missingLawNoteCount, 'disabled selector must not keep warning every turn');
  await setAgentExperienceSelectorEnabled(true);
  const schemaMismatchStorage = await initExperienceStorage(missingLawRoot, { allowInit: true, userId: 'owner' });
  schemaMismatchStorage.db.exec('PRAGMA user_version = 999');
  schemaMismatchStorage.db.close();
  await writeFile(join(missingLawRoot, 'law.md'), 'configured law after missing-law diagnostic\n');
  missingLaw.handlers.get('before_agent_start')({ prompt: 'hook prompt after schema mismatch', systemPrompt: 'base' }, missingLawCtx);
  await missingLaw.handlers.get('context')({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hook prompt after schema mismatch' }] }] }, missingLawCtx);
  assert.ok(missingLawNotes.length > missingLawNoteCount, 'distinct selector runtime diagnostics must not be suppressed by the first error');
  assert.ok(missingLawNotes.some((note) => /newer than this extension|schema mismatch/.test(note.message)), 'schema mismatch must emit its own diagnostic');
  __setAgentExperienceSelectorAdapterForTest(undefined);

  const noLedgerRoot = join(temp, 'no-ledger-state');
  process.env.AX_STATE_ROOT = noLedgerRoot;
  const noLedger = makePi();
  const noLedgerNotes = [];
  const noLedgerCtx = { cwd: liveCwd, mode: 'tui', sessionManager: { getSessionId: () => 'phase6-no-ledger', getSessionFile: () => join(temp, 'phase6-no-ledger.jsonl') }, ui: { notify(message, level) { noLedgerNotes.push({ message, level }); } } };
  await noLedger.commands.get('experience').handler('enable', noLedgerCtx);
  await setAgentExperienceSelectorEnabled(true);
  const noLedgerResult = noLedger.handlers.get('before_agent_start')({ prompt: 'nothing stored yet', systemPrompt: 'base' }, noLedgerCtx);
  assert.equal(noLedgerResult, undefined, 'submission hook must remain nonblocking when ledger is absent');
  assert.equal(existsSync(join(noLedgerRoot, 'ledger.sqlite')), false, 'submission hook must not initialize storage');
  await noLedger.handlers.get('context')({ messages: [{ role: 'user', content: [{ type: 'text', text: 'nothing stored yet' }] }] }, noLedgerCtx);
  assert.equal(existsSync(join(noLedgerRoot, 'ledger.sqlite')), false, 'post-render selector assessment must not initialize a missing ledger');
  process.env.AX_STATE_ROOT = join(temp, 'state');
} finally {
  storage.db.close();
  __setAgentExperienceSelectorAdapterForTest(undefined);
  __setAgentExperienceSelectorEmbeddingAdapterForTest(undefined);
}

await rm(temp, { recursive: true, force: true });
console.log('agent-experience phase6 selector checks passed');
