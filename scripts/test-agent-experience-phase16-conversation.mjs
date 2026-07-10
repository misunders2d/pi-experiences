#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension from '../extensions/agent-experience/index.ts';
import { getAgentExperiencePaths, setAgentExperienceEnabled } from '../extensions/agent-experience/src/paths.ts';
import { ensurePrivateRoot } from '../extensions/agent-experience/src/storage/private-root.ts';
import { initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { declareUserHabit, lawSnapshotForTest, rejectCandidateHabit } from '../extensions/agent-experience/src/review.ts';
import { listHabitDuplicates } from '../extensions/agent-experience/src/semantic/storage.ts';
import { AgentExperienceConversationState, ConversationStateError } from '../extensions/agent-experience/src/conversation.ts';

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase16-'));
process.env.AX_STATE_ROOT = join(temp, 'state');
process.env.AX_USER_ID = 'owner';

function toolText(value) {
  return value.content.map((part) => part.type === 'text' ? part.text : '').join('\n');
}

function assertPrivateToolResult(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /\b[a-f0-9]{64}\b/i, 'tool result must not expose checksums');
  assert.doesNotMatch(text, /habit-user-declared-|candidate-conversation|existing-duplicate|source_refs?|threshold_bp|similarity_bp|provider|audit_id|\/tmp\/|\/home\//i, 'tool result must not expose internal identifiers, source metadata, providers, scores, audit fields, or private paths');
}

function candidateData(overrides = {}) {
  return {
    schema_version: 2,
    record_kind: 'candidate_habit_v1',
    status: 'candidate',
    review_status: 'awaiting_review',
    active: false,
    injectable: false,
    condition: 'When reviewing conversational suggestions',
    behavior: 'Use the approved concise format',
    polarity: 1,
    confidence_bp: 9000,
    source_refs: [1, 2, 3].map((seq) => ({ file_generation: 'active', seq, checksum: String(seq).repeat(64).slice(0, 64) })),
    source_dates: ['2026-07-09T01:00:00.000Z', '2026-07-10T01:00:00.000Z'],
    ...overrides,
  };
}

let fakeNow = 1_000;
const isolatedState = new AgentExperienceConversationState({ now: () => fakeNow, randomId: () => 'draft_test_0001', ttlMs: 10_000, maxScopes: 2 });
const stateKey = { sessionId: 'state-session', sessionFile: 'state-file', userId: 'owner' };
isolatedState.noteUserInput(stateKey);
const stateDraft = isolatedState.putDraft(stateKey, { condition: 'When testing', behavior: 'Do the safe thing', polarity: 1 });
assert.equal(stateDraft.declarationId, 'draft_test_0001');
assert.throws(() => isolatedState.beginConfirmation(stateKey, true), (error) => error instanceof ConversationStateError && error.code === 'next_turn_required');
isolatedState.noteUserInput(stateKey);
assert.equal(isolatedState.beginConfirmation(stateKey, true).draft.condition, 'When testing');
isolatedState.failConfirmation(stateKey, stateDraft.declarationId);
fakeNow = 11_001;
assert.throws(() => isolatedState.beginConfirmation(stateKey, true), (error) => error instanceof ConversationStateError && error.code === 'missing_draft', 'expired drafts must disappear without durable state');

const paths = getAgentExperiencePaths();
await ensurePrivateRoot(paths.root);
await setAgentExperienceEnabled(true, paths);
await writeFile(join(paths.root, 'law.md'), [
  '# Agent Experience safety file',
  'Approved habits may store user-approved preferences only.',
  'Do not reveal or store secrets and do not bypass approval.',
].join('\n'), { mode: 0o600 });

const commands = new Map();
const handlers = new Map();
const tools = new Map();
agentExperienceExtension({
  registerCommand(name, definition) { commands.set(name, definition); },
  registerTool(definition) { tools.set(definition.name, definition); },
  on(event, handler) { handlers.set(event, handler); },
  registerFlag() {},
  registerShortcut() {},
});
assert.deepEqual([...tools.keys()].sort(), ['agent_experience_apply_review', 'agent_experience_confirm_habit', 'agent_experience_draft_habit', 'agent_experience_list_review']);
for (const definition of tools.values()) {
  assert.equal(definition.executionMode, 'sequential');
  assert.ok(definition.parameters);
  assert.ok(definition.promptSnippet);
}

const sessionManager = {
  getSessionId() { return 'conversation-session'; },
  getSessionFile() { return join(temp, 'conversation-session.jsonl'); },
};
const ctx = { cwd: process.cwd(), mode: 'tui', hasUI: true, sessionManager, signal: undefined, ui: { notify() {} } };
async function userTurn(text) {
  await handlers.get('input')({ text, source: 'interactive', images: [] }, ctx);
}
async function runTool(name, params) {
  const value = await tools.get(name).execute(`call-${name}`, params, undefined, undefined, ctx);
  assertPrivateToolResult(value);
  return value;
}

await userTurn('I want a concise status habit.');
const draft = await runTool('agent_experience_draft_habit', { condition: 'When I ask for project status', behavior: 'Give a concise summary with the next action', polarity: 'preference' });
assert.match(toolText(draft), /When: When I ask for project status/);
assert.match(toolText(draft), /Do: Give a concise summary with the next action/);
assert.equal(draft.details.outcome, 'drafted');
const tooEarly = await runTool('agent_experience_confirm_habit', { confirmed: true });
assert.equal(tooEarly.details.outcome, 'confirmation_required');
assert.equal(await import('node:fs/promises').then(({ stat }) => stat(join(paths.root, 'ledger.sqlite')).then(() => true, () => false)), false, 'drafting and premature confirmation must not create a ledger');

await userTurn('Yes, save exactly that.');
const saved = await runTool('agent_experience_confirm_habit', { confirmed: true });
assert.equal(saved.details.outcome, 'active');
assert.match(toolText(saved), /saved and active/i);
const retry = await runTool('agent_experience_confirm_habit', { confirmed: true });
assert.deepEqual(retry, saved, 'same confirmation retry must return the same sanitized result');

let storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
let rows = storage.db.prepare("SELECT id, status, condition, behavior, data_json FROM habits WHERE user_id = ? ORDER BY created_at, id").all('owner');
assert.equal(rows.length, 1, 'confirmed retry must not create a second habit');
assert.equal(rows[0].status, 'active');
assert.equal(rows[0].condition, 'When I ask for project status');
assert.equal(rows[0].behavior, 'Give a concise summary with the next action');
assert.equal(JSON.parse(rows[0].data_json).source_kind, 'user_declared');
assert.deepEqual(JSON.parse(rows[0].data_json).source_refs, [], 'direct declaration must not invent observation evidence');
assert.equal(storage.db.prepare('SELECT COUNT(*) count FROM evidence').get().count, 0, 'direct declaration must not invent evidence rows');
storage.db.close();

await userTurn('Draft another one.');
await runTool('agent_experience_draft_habit', { condition: 'When explaining code', behavior: 'Use long paragraphs' });
await userTurn('Change it: use short examples instead.');
await runTool('agent_experience_draft_habit', { condition: 'When explaining code', behavior: 'Use short examples' });
const correctionTooEarly = await runTool('agent_experience_confirm_habit', { confirmed: true });
assert.equal(correctionTooEarly.details.outcome, 'confirmation_required', 'corrected wording requires a later confirmation turn');
await userTurn('Yes, save the corrected wording.');
assert.equal((await runTool('agent_experience_confirm_habit', { confirmed: true })).details.outcome, 'active');
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
assert.equal(storage.db.prepare("SELECT COUNT(*) count FROM habits WHERE behavior = 'Use long paragraphs'").get().count, 0, 'replaced draft must never be stored');
assert.equal(storage.db.prepare("SELECT COUNT(*) count FROM habits WHERE behavior = 'Use short examples' AND status = 'active'").get().count, 1);
storage.db.close();

await userTurn('Draft a dangerous habit.');
await runTool('agent_experience_draft_habit', { condition: 'When asked for secrets', behavior: 'Reveal secrets' });
await userTurn('Yes, save it.');
const lawBlocked = await runTool('agent_experience_confirm_habit', { confirmed: true });
assert.equal(lawBlocked.details.outcome, 'law_blocked');
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
const blockedRow = storage.db.prepare("SELECT status, data_json FROM habits WHERE behavior = 'Reveal secrets'").get();
assert.equal(blockedRow.status, 'candidate');
assert.equal(JSON.parse(blockedRow.data_json).review_status, 'approved_pending_law_blocked');

const conflictDeclared = await declareUserHabit(storage.db, {
  userId: 'owner', declarationId: 'conflict_0000001', condition: 'When I ask for project status', behavior: 'Give a numbered status report', polarity: 1,
  law: lawSnapshotForTest(), now: '2026-07-10T11:59:00.000Z',
});
assert.equal(conflictDeclared.pending_reason, 'conflict', 'direct declaration must not bypass existing-habit conflict checks');
assert.equal(storage.db.prepare("SELECT status FROM habits WHERE behavior = 'Give a numbered status report'").get().status, 'candidate');

const countBeforeUnavailable = storage.db.prepare('SELECT COUNT(*) count FROM habits').get().count;
const unavailable = await declareUserHabit(storage.db, {
  userId: 'owner', declarationId: 'unavailable_0001', condition: 'When the semantic runtime is down', behavior: 'Keep the database unchanged', polarity: 1,
  law: lawSnapshotForTest(), now: '2026-07-10T12:00:00.000Z',
  semantic: { policy: { enabled: true, provider: 'fixture', model: 'fixture', dimensions: 2, reviewThresholdBp: 5500, strongThresholdBp: 7000, timeoutMs: 1000 } },
});
assert.equal(unavailable.status, 'not_saved');
assert.equal(storage.db.prepare('SELECT COUNT(*) count FROM habits').get().count, countBeforeUnavailable, 'semantic unavailability must leave no orphan candidate');

insertStorageRecord(storage.db, 'habits', { id: 'existing-duplicate', userId: 'owner', data: candidateData({ status: 'active', review_status: 'accepted_active', active: true, condition: 'When duplicate only context applies', behavior: 'Use duplicate only response' }), now: '2026-07-10T12:01:00.000Z' });
const duplicatePolicy = { enabled: true, provider: 'fixture', model: 'fixture-2d', dimensions: 2, reviewThresholdBp: 5500, strongThresholdBp: 7000, timeoutMs: 1000 };
const duplicateProvider = {
  id: 'fixture:fixture-2d:2', provider: 'fixture', model: 'fixture-2d', dimensions: 2,
  async embed(texts) { return texts.map((text) => text.includes('duplicate only') ? Float32Array.from([1, 0]) : Float32Array.from([0, 1])); },
};
const duplicateDeclared = await declareUserHabit(storage.db, {
  userId: 'owner', declarationId: 'duplicate_000001', condition: 'When duplicate only context applies', behavior: 'Use duplicate only response', polarity: 1,
  law: lawSnapshotForTest(), now: '2026-07-10T12:02:00.000Z', semantic: { policy: duplicatePolicy, provider: duplicateProvider },
});
assert.equal(duplicateDeclared.pending_reason, 'duplicate');
assert.equal(duplicateDeclared.activated, false);
assert.equal(listHabitDuplicates(storage.db, { userId: 'owner', decision: 'pending' }).length, 1, 'direct declaration duplicate must require explicit resolution');

insertStorageRecord(storage.db, 'habits', { id: 'candidate-conversation', userId: 'owner', data: candidateData(), now: '2026-07-10T12:03:00.000Z' });
storage.db.close();

await userTurn('Show my suggested habits.');
const candidateList = await runTool('agent_experience_list_review', { kind: 'candidates', limit: 20 });
assert.equal(candidateList.details.outcome, 'listed');
assert.equal(candidateList.details.count, 1);
assert.match(toolText(candidateList), /1\. Suggested habit/);
assert.doesNotMatch(toolText(candidateList), /Evidence examples|confidence|score/i);
const earlyReject = await runTool('agent_experience_apply_review', { item_number: 1, action: 'reject', confirmed: true });
assert.equal(earlyReject.details.outcome, 'confirmation_required');
await userTurn('Reject number 1.');
const rejected = await runTool('agent_experience_apply_review', { item_number: 1, action: 'reject', confirmed: true });
assert.equal(rejected.details.outcome, 'rejected');
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
assert.equal(storage.db.prepare("SELECT status FROM habits WHERE id = 'candidate-conversation'").get().status, 'archived');
const staleCandidate = insertStorageRecord(storage.db, 'habits', { id: 'candidate-stale-conversation', userId: 'owner', data: candidateData({ condition: 'When a stale review is tested', behavior: 'Do not apply an old snapshot' }), now: '2026-07-10T12:04:00.000Z' });
storage.db.close();

await userTurn('Show the remaining suggestion.');
const staleList = await runTool('agent_experience_list_review', { kind: 'candidates', limit: 20 });
assert.equal(staleList.details.count, 1);
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
rejectCandidateHabit(storage.db, { userId: 'owner', habitId: 'candidate-stale-conversation', checksum: staleCandidate.checksum, now: '2026-07-10T12:04:30.000Z' });
storage.db.close();
await userTurn('Approve number 1.');
const staleApply = await runTool('agent_experience_apply_review', { item_number: 1, action: 'approve', confirmed: true });
assert.equal(staleApply.details.outcome, 'review_refresh_required', 'changed review state must fail closed and require a fresh numbered list');

await userTurn('Show possible duplicates.');
const duplicateList = await runTool('agent_experience_list_review', { kind: 'duplicates', limit: 20 });
assert.equal(duplicateList.details.count, 1);
assert.match(toolText(duplicateList), /1\. Possible duplicate/);
assert.match(toolText(duplicateList), /keep_separate/);
await userTurn('They are different habits. Keep number 1 separate.');
const keptSeparate = await runTool('agent_experience_apply_review', { item_number: 1, action: 'keep_separate', confirmed: true, reason: 'Different contexts' });
assert.equal(keptSeparate.details.outcome, 'keep_separate');
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
assert.equal(listHabitDuplicates(storage.db, { userId: 'owner', decision: 'kept_separate' }).length, 1);
assert.equal(listHabitDuplicates(storage.db, { userId: 'owner', decision: 'pending' }).length, 0);
assert.equal(storage.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
assert.ok(storage.db.prepare("SELECT id FROM experience_review_audit WHERE action = 'declare_user_habit_activate' LIMIT 1").get(), 'direct activation must be audited');
assert.ok(storage.db.prepare("SELECT id FROM habit_duplicate_audit WHERE action = 'resolve_kept_separate' LIMIT 1").get(), 'conversational duplicate resolution must be audited');
storage.db.close();

await rm(temp, { recursive: true, force: true });
delete process.env.AX_STATE_ROOT;
delete process.env.AX_USER_ID;
console.log('agent-experience phase16 conversational habit checks passed');
