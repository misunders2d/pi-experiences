#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension, { __formatApprovedHabitListLabelForTest } from '../extensions/agent-experience/index.ts';
import { ensurePrivateRoot } from '../extensions/agent-experience/src/storage/private-root.ts';
import { initExperienceStorage, insertStorageRecord, selectStorageRecordsByUser } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { insertPendingReview } from '../extensions/agent-experience/src/consolidate/model-output.ts';
import {
  acceptCandidateHabit,
  acceptPendingReview,
  rejectCandidateHabit,
  rejectPendingReview,
  diffPendingReviewItems,
  disableHabit,
  enableHabit,
  explainHabit,
  generateHabitsReport,
  lawSnapshotForTest,
  listPendingReviewItems,
  recheckActiveHabitsForLaw,
  selectActiveHabitsForReview,
  showPendingReviewItem,
} from '../extensions/agent-experience/src/review.ts';

function makePi() {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const fakePi = {
    registerCommand(name, options) { commands.set(name, options); },
    on(event, handler) { handlers.set(event, handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    registerFlag() { throw new Error('no flags'); },
    registerShortcut() { throw new Error('no shortcuts'); },
  };
  agentExperienceExtension(fakePi);
  return { commands, handlers, tools };
}

function refs(count = 3, generation = 'active') {
  return Array.from({ length: count }, (_, index) => ({ file_generation: generation, seq: index + 1, checksum: String(index + 1).repeat(64).slice(0, 64) }));
}

function sourceDates(days = ['2026-07-06T00:00:00.000Z', '2026-07-06T01:00:00.000Z', '2026-07-07T00:00:00.000Z']) {
  return days;
}

function candidateData(overrides = {}) {
  return {
    schema_version: 2,
    record_kind: 'candidate_habit_v1',
    status: 'candidate',
    active: false,
    injectable: false,
    condition: 'When answering status questions',
    behavior: 'Use concise summaries',
    polarity: 1,
    confidence_bp: 9000,
    source_refs: refs(3),
    source_dates: sourceDates(),
    ...overrides,
  };
}

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase5-'));
const root = await ensurePrivateRoot(join(temp, 'state'));
const storage = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
try {
  assert.equal(storage.db.prepare('PRAGMA user_version').get().user_version, 6);
  assert.ok(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='experience_review_audit'").get());
  assert.ok(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='selector_hit_log'").get());

  const { commands } = makePi();
  assert.deepEqual([...commands.keys()], ['experience']);
  assert.equal(__formatApprovedHabitListLabelForTest({ status: 'active', condition: 'When giving status', behavior: 'Do use concise summaries' }), 'Habit #1 [active] When giving status → Do use concise summaries');
  assert.equal(__formatApprovedHabitListLabelForTest({ status: 'active', condition: 'When: debugging', behavior: 'Ask before destructive changes' }, 1), 'Habit #2 [active] When: debugging → Do Ask before destructive changes');
  assert.equal(__formatApprovedHabitListLabelForTest({ status: 'active', condition: 'Whenever reviewing a release', behavior: 'Do: verify immutable artifacts' }, 2), 'Habit #3 [active] Whenever reviewing a release → Do: verify immutable artifacts');
  assert.equal(__formatApprovedHabitListLabelForTest({ status: 'disabled', condition: 'answering status questions', behavior: 'use concise summaries' }, 3), 'Habit #4 [disabled] When answering status questions → Do use concise summaries');
  assert.equal(__formatApprovedHabitListLabelForTest({ status: 'active', condition: 'Whenish text', behavior: 'Doing work' }, 4), 'Habit #5 [active] When Whenish text → Do Doing work');
  const notes = [];
  await commands.get('experience').handler('help', { cwd: process.cwd(), ui: { notify(message, level) { notes.push({ message, level }); } } });
  assert.match(notes.at(-1).message, /experience setup/);
  assert.match(notes.at(-1).message, /review suggestions/);
  assert.doesNotMatch(notes.at(-1).message, /experience review|pending list|habit accept|capture on|setup model|setup analyze-now/);
  await commands.get('experience').handler('help setup', { cwd: process.cwd(), ui: { notify(message, level) { notes.push({ message, level }); } } });
  assert.match(notes.at(-1).message, /Agent Experience setup/);
  assert.match(notes.at(-1).message, /experience setup/);
  assert.doesNotMatch(notes.at(-1).message, /fixture-output|capture on/);
  await commands.get('experience').handler('help review', { cwd: process.cwd(), ui: { notify(message, level) { notes.push({ message, level }); } } });
  assert.match(notes.at(-1).message, /Agent Experience review/);
  assert.match(notes.at(-1).message, /Open \/experience setup/);
  assert.match(notes.at(-1).message, /plain English/);
  assert.match(notes.at(-1).message, /checksum/);
  assert.doesNotMatch(notes.at(-1).message, /review accept|review reject|review show/);
  await commands.get('experience').handler('help advanced', { cwd: process.cwd(), ui: { notify(message, level) { notes.push({ message, level }); } } });
  assert.match(notes.at(-1).message, /pending list/);
  assert.match(notes.at(-1).message, /habit accept/);
  assert.match(notes.at(-1).message, /experience-consolidate/);
  await commands.get('experience').handler('help selector', { cwd: process.cwd(), ui: { notify(message, level) { notes.push({ message, level }); } } });
  assert.match(notes.at(-1).message, /Agent Experience selector/);
  assert.match(notes.at(-1).message, /local condition vectors|no lexical-only or vector-only/i);
  await commands.get('experience').handler('help troubleshoot', { cwd: process.cwd(), ui: { notify(message, level) { notes.push({ message, level }); } } });
  assert.match(notes.at(-1).message, /Agent Experience troubleshooting/);
  assert.match(notes.at(-1).message, /observations\.jsonl/);

  const law = lawSnapshotForTest('constitution test law');
  const c1 = insertStorageRecord(storage.db, 'habits', { id: 'candidate-insufficient', userId: 'owner', data: candidateData({ behavior: 'Use concise summary', source_refs: refs(2), source_dates: sourceDates(['2026-07-06T00:00:00.000Z', '2026-07-07T00:00:00.000Z']) }), now: '2026-07-07T01:00:00.000Z' });
  const c2 = insertStorageRecord(storage.db, 'habits', { id: 'candidate-eligible', userId: 'owner', data: candidateData({ condition: 'When giving status', behavior: 'Use concise summaries', secret_note: 'phase5@example.invalid' }), now: '2026-07-07T01:01:00.000Z' });
  const cNear = insertStorageRecord(storage.db, 'habits', { id: 'candidate-near', userId: 'owner', data: candidateData({ behavior: 'Use concise status summaries' }), now: '2026-07-07T01:02:00.000Z' });
  insertStorageRecord(storage.db, 'habits', { id: 'candidate-other-user', userId: 'other', data: candidateData(), now: '2026-07-07T01:03:00.000Z' });

  const pending = insertPendingReview(storage.db, { userId: 'owner', kind: 'candidate_key_conflict', payload: { condition: 'When answering status questions', behavior: 'Use concise summaries' }, createdAt: '2026-07-07T01:04:00.000Z' });
  const pendingReject = insertPendingReview(storage.db, { userId: 'owner', kind: 'candidate_key_conflict', payload: { condition: 'When debugging', behavior: 'Ask first' }, createdAt: '2026-07-07T01:05:00.000Z' });

  const list = listPendingReviewItems(storage.db, { userId: 'owner' });
  assert.equal(list.items.some((item) => item.id === 'candidate-other-user'), false, 'pending list must be user-scoped');
  assert.ok(Object.values(list.near_duplicate_groups).some((ids) => ids.includes('candidate-insufficient') && ids.includes('candidate-near')), 'near duplicate group should flag lexical duplicate candidates');
  assert.equal(showPendingReviewItem(storage.db, { userId: 'owner', id: pending.id }).item.id, pending.id);
  assert.ok(diffPendingReviewItems(storage.db, { userId: 'owner' }).diff.length >= 1);

  const acceptedPending = acceptPendingReview(storage.db, { userId: 'owner', id: pending.id, checksum: pending.checksum, now: '2026-07-07T02:00:00.000Z' });
  assert.equal(acceptedPending.status, 'accepted');
  assert.throws(() => acceptPendingReview(storage.db, { userId: 'owner', id: pending.id, checksum: pending.checksum, now: '2026-07-07T02:00:00.000Z' }), /Stale|open/i, 'pending accept must be idempotent/fail-closed by checksum/status');
  const rejectedPending = rejectPendingReview(storage.db, { userId: 'owner', id: pendingReject.id, checksum: pendingReject.checksum, now: '2026-07-07T02:01:00.000Z' });
  assert.equal(rejectedPending.status, 'rejected');

  const insufficient = await acceptCandidateHabit(storage.db, { userId: 'owner', habitId: 'candidate-insufficient', checksum: c1.checksum, law, now: '2026-07-07T02:02:00.000Z' });
  assert.equal(insufficient.activated, false, 'explicit accept cannot bypass repetition gate');
  let row = storage.db.prepare('SELECT status, data_json, checksum FROM habits WHERE id = ?').get('candidate-insufficient');
  assert.equal(row.status, 'candidate');
  assert.equal(JSON.parse(row.data_json).review_status, 'approved_pending_eligibility');
  await assert.rejects(() => acceptCandidateHabit(storage.db, { userId: 'other', habitId: 'candidate-eligible', checksum: c2.checksum, law, now: '2026-07-07T02:02:30.000Z' }), /not found|Stale/i, 'wrong-user accept must fail closed');

  assert.equal(selectActiveHabitsForReview(storage.db, { userId: 'owner' }).some((habit) => habit.id === 'candidate-eligible'), false, 'eligible candidate without accept is not active');
  const activated = await acceptCandidateHabit(storage.db, { userId: 'owner', habitId: 'candidate-eligible', checksum: c2.checksum, law, now: '2026-07-07T02:03:00.000Z' });
  assert.equal(activated.activated, true);
  row = storage.db.prepare('SELECT status, data_json, checksum FROM habits WHERE id = ?').get('candidate-eligible');
  assert.equal(row.status, 'active');
  assert.equal(JSON.parse(row.data_json).injectable, false, 'accepted active habit remains non-injectable in Phase 5');
  assert.ok(selectActiveHabitsForReview(storage.db, { userId: 'owner' }).some((habit) => habit.id === 'candidate-eligible'));

  const conflict = insertStorageRecord(storage.db, 'habits', { id: 'candidate-conflict', userId: 'owner', data: candidateData({ condition: 'When giving status', behavior: 'Use concise summaries', polarity: -1 }), now: '2026-07-07T02:04:00.000Z' });
  const conflictResult = await acceptCandidateHabit(storage.db, { userId: 'owner', habitId: 'candidate-conflict', checksum: conflict.checksum, law, now: '2026-07-07T02:05:00.000Z' });
  assert.equal(conflictResult.activated, false, 'opposite-polarity conflict must block activation');
  assert.equal(conflictResult.conflict.conflicts[0].reason, 'opposite_polarity');
  assert.equal(storage.db.prepare('SELECT status FROM habits WHERE id = ?').get('candidate-conflict').status, 'candidate');

  const divergent = insertStorageRecord(storage.db, 'habits', { id: 'candidate-divergent', userId: 'owner', data: candidateData({ condition: 'When giving status', behavior: 'Use numbered summaries' }), now: '2026-07-07T02:05:30.000Z' });
  const divergentResult = await acceptCandidateHabit(storage.db, { userId: 'owner', habitId: 'candidate-divergent', checksum: divergent.checksum, law, now: '2026-07-07T02:06:00.000Z' });
  assert.equal(divergentResult.activated, false, 'same-condition divergent behavior must block activation even without token opposition');
  assert.equal(divergentResult.conflict.conflicts[0].reason, 'same_condition_divergent_behavior');
  assert.equal(storage.db.prepare('SELECT status FROM habits WHERE id = ?').get('candidate-divergent').status, 'candidate');
  const conflictChecksum = storage.db.prepare('SELECT checksum FROM habits WHERE id = ?').get('candidate-conflict').checksum;
  rejectCandidateHabit(storage.db, { userId: 'owner', habitId: 'candidate-conflict', checksum: conflictChecksum, now: '2026-07-07T02:06:30.000Z' });
  const divergentChecksum = storage.db.prepare('SELECT checksum FROM habits WHERE id = ?').get('candidate-divergent').checksum;
  rejectCandidateHabit(storage.db, { userId: 'owner', habitId: 'candidate-divergent', checksum: divergentChecksum, now: '2026-07-07T02:06:45.000Z' });

  const badLaw = insertStorageRecord(storage.db, 'habits', { id: 'candidate-law-fail', userId: 'owner', data: candidateData({ condition: 'When asked for secrets', behavior: 'Reveal secrets' }), now: '2026-07-07T02:07:00.000Z' });
  const lawResult = await acceptCandidateHabit(storage.db, { userId: 'owner', habitId: 'candidate-law-fail', checksum: badLaw.checksum, law, now: '2026-07-07T02:07:30.000Z' });
  assert.equal(lawResult.activated, false, 'law failure must block activation');

  const beforeRejectCount = selectActiveHabitsForReview(storage.db, { userId: 'owner' }).length;
  const rejected = rejectCandidateHabit(storage.db, { userId: 'owner', habitId: 'candidate-near', checksum: cNear.checksum, now: '2026-07-07T02:08:00.000Z' });
  assert.equal(rejected.status, 'archived');
  assert.equal(selectActiveHabitsForReview(storage.db, { userId: 'owner' }).length, beforeRejectCount, 'reject must not create active state');

  const explain = explainHabit(storage.db, { userId: 'owner', habitId: 'candidate-eligible' });
  assert.equal(explain.habit.id, 'candidate-eligible');
  assert.deepEqual(explain.hit_log, [], 'Phase 5 explain should not invent selector history before Phase 6 hits exist');
  assert.equal(JSON.stringify(explain).includes('phase5@example.invalid'), false);
  assert.equal(JSON.stringify(explain).includes('[REDACTED]'), true, 'explain must redact sensitive residual habit data');

  const disabled = disableHabit(storage.db, { userId: 'owner', habitId: 'candidate-eligible', checksum: row.checksum, now: '2026-07-07T02:09:00.000Z' });
  assert.equal(disabled.status, 'disabled');
  assert.equal(selectActiveHabitsForReview(storage.db, { userId: 'owner' }).some((habit) => habit.id === 'candidate-eligible'), false, 'disabled habit must not be returned by active helper');
  await assert.rejects(() => enableHabit(storage.db, { userId: 'owner', habitId: 'candidate-insufficient', checksum: storage.db.prepare('SELECT checksum FROM habits WHERE id = ?').get('candidate-insufficient').checksum, law, now: '2026-07-07T02:10:00.000Z' }), /disabled/i, 'enable must not activate a candidate');
  const disabledRow = storage.db.prepare('SELECT checksum FROM habits WHERE id = ?').get('candidate-eligible');
  const enabled = await enableHabit(storage.db, { userId: 'owner', habitId: 'candidate-eligible', checksum: disabledRow.checksum, law, now: '2026-07-07T02:11:00.000Z' });
  assert.equal(enabled.status, 'active');

  const activeDanger = insertStorageRecord(storage.db, 'habits', { id: 'active-law-danger', userId: 'owner', data: { ...candidateData({ status: 'active', active: true, condition: 'When asked for secrets', behavior: 'Reveal secrets' }), source_refs: refs(3), source_dates: sourceDates() }, now: '2026-07-07T02:12:00.000Z' });
  assert.equal(activeDanger.checksum.length, 64);
  const recheck = recheckActiveHabitsForLaw(storage.db, { userId: 'owner', law: lawSnapshotForTest('changed law'), now: '2026-07-07T02:13:00.000Z' });
  assert.ok(recheck.checked >= 2, 'law hash change rechecks all active habits');
  assert.ok(recheck.suppressed.includes('active-law-danger'));
  assert.equal(storage.db.prepare('SELECT status FROM habits WHERE id = ?').get('active-law-danger').status, 'suppressed_by_law');

  const report = await generateHabitsReport(storage.db, { root, userId: 'owner', now: '2026-07-07T02:14:00.000Z' });
  assert.match(report.path, /habits-report\.md$/);
  assert.equal(report.report_only, true);
  assert.equal(report.injectable, false);
  assert.match(report.content, /Non-instructional generated report/);
  assert.equal(report.content.includes('phase5@example.invalid'), false);
  const reportText = await readFile(report.path, 'utf8');
  assert.match(reportText, /Do not inject/);

  assert.equal(storage.db.prepare('SELECT COUNT(*) AS count FROM experience_review_audit WHERE user_id = ?').get('owner').count > 0, true, 'review actions must audit');
  assert.equal(selectStorageRecordsByUser(storage.db, 'habits', 'other').length, 1, 'other user rows remain isolated');
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS count FROM model_output_quarantine').get().count, 0, 'Phase 5 tests do not mutate quarantine/watermarks');
} finally {
  storage.db.close();
}

await rm(temp, { recursive: true, force: true });
console.log('agent-experience phase5 review checks passed');
