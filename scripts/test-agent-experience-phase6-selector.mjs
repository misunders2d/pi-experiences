#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension, { __setAgentExperienceSelectorAdapterForTest } from '../extensions/agent-experience/index.ts';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { insertPendingReview } from '../extensions/agent-experience/src/consolidate/model-output.ts';
import { generateHabitsReport, lawSnapshotForTest, readConfiguredLawSnapshot } from '../extensions/agent-experience/src/review.ts';
import {
  buildInjectionMessage,
  countDailySelectorInjections,
  insertSelectorHitLog,
  isValidSelectorHitLog,
  measureSelectorLatency,
  parseSelectorModelOutput,
  preNarrowSelectorCandidates,
  promoteApprovedPendingCandidates,
  runSelectorRuntime,
  selectActiveSelectorSnapshot,
} from '../extensions/agent-experience/src/selector.ts';
import { getAgentExperiencePaths, readAgentExperienceConfig } from '../extensions/agent-experience/src/paths.ts';
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

function makePi() {
  const commands = new Map();
  const handlers = new Map();
  const fakePi = {
    registerCommand(name, options) { commands.set(name, options); },
    on(event, handler) { handlers.set(event, handler); },
    registerTool() { throw new Error('no tools'); },
    registerFlag() { throw new Error('no flags'); },
    registerShortcut() { throw new Error('no shortcuts'); },
  };
  agentExperienceExtension(fakePi);
  return { commands, handlers };
}

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase6-'));
process.env.AX_STATE_ROOT = join(temp, 'state');
const root = await ensurePrivateRoot(process.env.AX_STATE_ROOT);
await writeFile(join(root, 'law.md'), 'phase6 configured law\n');
const liveCwd = await mkdtemp(join(temp, 'live-cwd-no-docs-'));
const storage = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
try {
  assert.equal(storage.db.prepare('PRAGMA user_version').get().user_version, 5);
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

  const narrowedA = preNarrowSelectorCandidates(snapshot, { prompt: 'please answer status with concise summary', limit: 20, minConfidenceBp: 7500, stalenessMax: 0.8 });
  const narrowedB = preNarrowSelectorCandidates(snapshot, { prompt: 'please answer status with concise summary', limit: 20, minConfidenceBp: 7500, stalenessMax: 0.8 });
  assert.deepEqual(narrowedA.map((row) => row.id), narrowedB.map((row) => row.id), 'pre-narrow must be deterministic');
  assert.equal(narrowedA.length <= 20, true);
  assert.equal(narrowedA.some((row) => row.id === 'active-stale'), false, 'stale habit must be gated out');
  assert.equal(narrowedA[0].id, 'active-1');

  assert.deepEqual(parseSelectorModelOutput({ schema_version: 1, selected: [{ id: 'active-1', confidence_bp: 9000 }] }, { candidateIds: narrowedA.map((row) => row.id), maxSelected: 3, minConfidenceBp: 7500 }), [{ id: 'active-1', confidence_bp: 9000 }]);
  assert.throws(() => parseSelectorModelOutput({ schema_version: 1, selected: [{ id: 'candidate-1', confidence_bp: 9000 }] }, { candidateIds: narrowedA.map((row) => row.id), maxSelected: 3, minConfidenceBp: 7500 }), /Unknown/);
  assert.throws(() => parseSelectorModelOutput({ schema_version: 1, selected: [{ id: 'active-1', confidence_bp: 9000 }], text: 'free text' }, { candidateIds: narrowedA.map((row) => row.id), maxSelected: 3, minConfidenceBp: 7500 }), /keys/);
  assert.throws(() => parseSelectorModelOutput({ schema_version: 1, selected: [{ id: 'active-1', confidence_bp: 100 }] }, { candidateIds: narrowedA.map((row) => row.id), maxSelected: 3, minConfidenceBp: 7500 }), /below/);

  const injectedText = buildInjectionMessage(snapshot, [{ id: 'active-1', confidence_bp: 9000 }]);
  assert.match(injectedText, /Agent Experience generated guidance/);
  assert.match(injectedText, /use concise summaries/);
  assert.doesNotMatch(injectedText, /pending row|quarantine|habits-report|other user/);

  const config = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, selector_enabled: true, selector_daily_budget: 1, selector_min_confidence_bp: 7500, selector_max_habits: 3, selector_staleness_max: 0.8 };
  let adapterCalls = 0;
  const adapter = { async select() { adapterCalls += 1; return { schema_version: 1, selected: [{ id: 'active-1', confidence_bp: 9000 }] }; } };
  const selected = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'status summary please', config, law, now: '2026-07-08T01:00:00.000Z', adapter });
  assert.equal(selected.injected, true);
  assert.equal(selected.mode, 'instant');
  assert.equal(selected.model, 'lexical');
  assert.equal(adapterCalls, 0, 'instant mode must make zero model/network calls');
  assert.equal(countDailySelectorInjections(storage.db, { userId: 'owner', now: '2026-07-08T01:00:01.000Z' }), 1);
  assert.ok(storage.db.prepare("SELECT COUNT(*) AS count FROM selector_hit_log WHERE user_id = ? AND action = 'skip' AND reason = 'not_selected'").get('owner').count >= 1, 'successful injection transaction should log bounded not-selected habit provenance');
  const second = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'status again', config, law, now: '2026-07-08T01:01:00.000Z', adapter });
  assert.equal(second.injected, false);
  assert.equal(second.reason, 'daily_budget_exceeded');
  assert.equal(adapterCalls, 0, 'budget must be checked before selection/model call');
  const corrupt = storage.db.prepare("SELECT * FROM selector_hit_log WHERE action = 'inject' LIMIT 1").get();
  assert.equal(isValidSelectorHitLog(corrupt), true);
  storage.db.prepare("UPDATE selector_hit_log SET checksum = ? WHERE id = ?").run('c'.repeat(64), corrupt.id);
  assert.equal(countDailySelectorInjections(storage.db, { userId: 'owner', now: '2026-07-08T01:02:00.000Z' }), 0, 'corrupt hit-log checksum ignored for budget');

  const smartConfig = { ...config, selector_mode: 'smart', selector_daily_budget: 10 };
  const invalid = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'debug tests', config: smartConfig, law, now: '2026-07-08T01:03:00.000Z', adapter: { async select() { return { schema_version: 1, selected: [{ id: 'missing', confidence_bp: 9000 }] }; } } });
  assert.equal(invalid.injected, false);
  assert.equal(invalid.reason, 'invalid_selector_output');
  const unavailable = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'debug tests', config: smartConfig, law, now: '2026-07-08T01:04:00.000Z' });
  assert.equal(unavailable.injected, false);
  assert.equal(unavailable.reason, 'selector_unavailable');
  const timeout = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'debug tests', config: { ...smartConfig, selector_timeout_ms: 1 }, law, now: '2026-07-08T01:05:00.000Z', adapter: { async select() { await new Promise((resolve) => setTimeout(resolve, 20)); return { schema_version: 1, selected: [] }; } } });
  assert.equal(timeout.injected, false);
  assert.match(timeout.reason, /timeout/);
  const staleLaw = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'status', config: { ...config, selector_daily_budget: 10 }, law: lawSnapshotForTest('changed law'), now: '2026-07-08T01:06:00.000Z', adapter });
  assert.equal(staleLaw.injected, false);
  assert.equal(staleLaw.reason, 'no_fresh_active_candidates');

  const latency = await measureSelectorLatency({ adapter, prompt: 'status', candidates: narrowedA, iterations: 3, timeoutMs: 1500, model: 'openai-codex/gpt-5.4-mini' });
  assert.equal(latency.compatible_with_1500ms, true);

  const pendingPass = insertStorageRecord(storage.db, 'habits', { id: 'pending-pass', userId: 'owner', data: habitData({ status: 'candidate', condition: 'writing updates', behavior: 'use bullets', review_status: 'approved_pending_eligibility', source_refs: refs(3, 'promote'), source_dates: sourceDates() }), now: '2026-07-08T02:00:00.000Z' });
  assert.equal(pendingPass.checksum.length, 64);
  const pendingLawFail = insertStorageRecord(storage.db, 'habits', { id: 'pending-law-fail', userId: 'owner', data: habitData({ status: 'candidate', condition: 'asked for secrets', behavior: 'reveal secrets', review_status: 'approved_pending_eligibility', source_refs: refs(3, 'promote2'), source_dates: sourceDates() }), now: '2026-07-08T02:01:00.000Z' });
  assert.equal(pendingLawFail.checksum.length, 64);
  const promoted = promoteApprovedPendingCandidates(storage.db, { userId: 'owner', law, now: '2026-07-08T02:02:00.000Z' });
  assert.ok(promoted.promoted.includes('pending-pass'));
  assert.ok(promoted.blocked.some((item) => item.id === 'pending-law-fail'));
  assert.equal(storage.db.prepare("SELECT status FROM habits WHERE id = 'pending-pass'").get().status, 'active');
  assert.equal(storage.db.prepare("SELECT status FROM habits WHERE id = 'pending-law-fail'").get().status, 'suppressed_by_law');

  const { commands, handlers } = makePi();
  assert.ok(handlers.has('before_agent_start'));
  assert.deepEqual([...commands.keys()], ['experience']);
  const notes = [];
  const ctx = { cwd: liveCwd, ui: { notify(message, level) { notes.push({ message, level }); } } };
  await commands.get('experience').handler('enable', ctx);
  let readConfig = await readAgentExperienceConfig(getAgentExperiencePaths());
  assert.equal(readConfig.config.selector_enabled, false, 'master enable must not enable selector');
  await commands.get('experience').handler('selector on', ctx);
  assert.match(notes.at(-1).message, /local lexical\/no-network|configured selector model/);
  readConfig = await readAgentExperienceConfig(getAgentExperiencePaths());
  assert.equal(readConfig.config.selector_enabled, true);

  const realLaw = await readConfiguredLawSnapshot(root, readConfig.config);
  insertStorageRecord(storage.db, 'habits', { id: 'hook-active', userId: 'owner', data: habitData({ status: 'active', active: true, condition: 'hook prompt', behavior: 'use hook guidance', law_hash: realLaw.hash, confidence_bp: 9500 }), now: '2026-07-08T03:00:00.000Z' });
  __setAgentExperienceSelectorAdapterForTest({ async select({ candidateIds }) { return { schema_version: 1, selected: [{ id: candidateIds[0], confidence_bp: 9500 }] }; } });
  const beforeStatus = storage.db.prepare("SELECT status FROM habits WHERE id = 'hook-active'").get().status;
  const hookResult = await handlers.get('before_agent_start')({ prompt: 'hook prompt please', systemPrompt: 'base system prompt' }, { cwd: liveCwd, ui: ctx.ui });
  assert.equal(storage.db.prepare("SELECT status FROM habits WHERE id = 'hook-active'").get().status, beforeStatus, 'selector hook must not mutate habit status');
  assert.ok(hookResult?.systemPrompt, 'selector hook should append generated guidance to systemPrompt when enabled and selected');
  assert.equal('message' in hookResult, false, 'selector hook must not return session-history message injection');
  assert.match(hookResult.systemPrompt, /base system prompt/);
  assert.match(hookResult.systemPrompt, /Agent Experience generated guidance/);
  assert.doesNotMatch(hookResult.systemPrompt, /pending row|quarantine|habits-report|other user|candidate-1/);
  __setAgentExperienceSelectorAdapterForTest(undefined);

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
  const missingLawCtx = { cwd: liveCwd, ui: { notify(message, level) { missingLawNotes.push({ message, level }); } } };
  await missingLaw.commands.get('experience').handler('enable', missingLawCtx);
  await missingLaw.commands.get('experience').handler('selector on', missingLawCtx);
  __setAgentExperienceSelectorAdapterForTest({ async select() { throw new Error('selector must not run without configured law'); } });
  const missingLawResult = await missingLaw.handlers.get('before_agent_start')({ prompt: 'hook prompt please', systemPrompt: 'base' }, { cwd: liveCwd, ui: missingLawCtx.ui });
  assert.equal(missingLawResult, undefined, 'selector hook must fail closed when configured law file is missing');
  assert.ok(missingLawNotes.some((note) => /law file missing/.test(note.message) && note.level === 'warn'), 'missing law must emit a bounded visible diagnostic');
  const missingLawNoteCount = missingLawNotes.length;
  await missingLaw.handlers.get('before_agent_start')({ prompt: 'hook prompt again', systemPrompt: 'base' }, { cwd: liveCwd, ui: missingLawCtx.ui });
  assert.equal(missingLawNotes.length, missingLawNoteCount, 'same selector runtime diagnostic must be notify-once');
  const schemaMismatchStorage = await initExperienceStorage(missingLawRoot, { allowInit: true, userId: 'owner' });
  schemaMismatchStorage.db.exec('PRAGMA user_version = 0');
  schemaMismatchStorage.db.close();
  await writeFile(join(missingLawRoot, 'law.md'), 'configured law after missing-law diagnostic\n');
  await missingLaw.handlers.get('before_agent_start')({ prompt: 'hook prompt after schema mismatch', systemPrompt: 'base' }, { cwd: liveCwd, ui: missingLawCtx.ui });
  assert.ok(missingLawNotes.length > missingLawNoteCount, 'distinct selector runtime diagnostics must not be suppressed by the first error');
  assert.ok(missingLawNotes.some((note) => /schema mismatch/.test(note.message)), 'schema mismatch must emit its own diagnostic');
  __setAgentExperienceSelectorAdapterForTest(undefined);

  const noLedgerRoot = join(temp, 'no-ledger-state');
  process.env.AX_STATE_ROOT = noLedgerRoot;
  const noLedger = makePi();
  const noLedgerNotes = [];
  const noLedgerCtx = { cwd: liveCwd, ui: { notify(message, level) { noLedgerNotes.push({ message, level }); } } };
  await noLedger.commands.get('experience').handler('enable', noLedgerCtx);
  await noLedger.commands.get('experience').handler('selector on', noLedgerCtx);
  const noLedgerResult = await noLedger.handlers.get('before_agent_start')({ prompt: 'nothing stored yet', systemPrompt: 'base' }, { cwd: liveCwd, ui: noLedgerCtx.ui });
  assert.equal(noLedgerResult, undefined, 'selector hook must fail closed when ledger is absent');
  assert.equal(existsSync(join(noLedgerRoot, 'ledger.sqlite')), false, 'selector hook must not initialize storage on missing ledger');
  process.env.AX_STATE_ROOT = join(temp, 'state');
} finally {
  storage.db.close();
  __setAgentExperienceSelectorAdapterForTest(undefined);
}

await rm(temp, { recursive: true, force: true });
console.log('agent-experience phase6 selector checks passed');
