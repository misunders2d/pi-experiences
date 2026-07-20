#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension from '../extensions/agent-experience/index.ts';
import { getAgentExperiencePaths, readAgentExperienceConfig } from '../extensions/agent-experience/src/paths.ts';
import { classifyCaptureInput } from '../extensions/agent-experience/src/capture/origin.ts';
import { CapturePairBuffer, buildPairPayload } from '../extensions/agent-experience/src/capture/buffer.ts';
import { extractSingleFinalAssistantText, MAX_CAPTURE_ASSISTANT_CHARS } from '../extensions/agent-experience/src/capture/extract.ts';
import { appendObservation, observationPairRefForTest, observationChecksumForTest } from '../extensions/agent-experience/src/storage/observations.ts';
import { containsUnredactedSensitiveText } from '../extensions/agent-experience/src/storage/redaction.ts';
import { canonicalJson } from '../extensions/agent-experience/src/storage/checksum.ts';
import { ensurePrivateRoot, resolvePrivatePath, privateStatMode } from '../extensions/agent-experience/src/storage/private-root.ts';

function makePi() {
  const commands = new Map();
  const handlers = new Map();
  const fakePi = {
    registerCommand(name, options) { commands.set(name, options); },
    on(event, handler) { handlers.set(event, handler); },
    registerTool() {},
    registerFlag() { throw new Error('no flags'); },
    registerShortcut() { throw new Error('no shortcuts'); },
  };
  agentExperienceExtension(fakePi);
  assert.deepEqual([...commands.keys()], ['experience']);
  assert.deepEqual([...handlers.keys()].sort(), ['agent_end', 'agent_settled', 'before_agent_start', 'context', 'input', 'session_before_compact', 'session_compact', 'session_shutdown', 'session_start', 'tool_execution_end', 'tool_execution_start']);
  return { commands, handlers };
}

function ctx(notes = []) {
  const sessionManager = {
    getSessionId: () => 'session-1',
    getSessionFile: () => '/tmp/pi-session-1.jsonl',
    getLeafId: () => 'leaf-1',
    getBranch: () => [],
    getEntries: () => [],
    getCwd: () => process.cwd(),
    getSessionName: () => undefined,
  };
  return { cwd: process.cwd(), mode: 'tui', hasUI: true, sessionManager, ui: { notify(message, level) { notes.push({ message, level }); } } };
}

async function readObservationLines(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase3-'));
process.env.AX_STATE_ROOT = join(temp, 'state');
process.env.AX_USER_ID = 'owner';
const paths = getAgentExperiencePaths();
const { commands, handlers } = makePi();
assert.equal(existsSync(paths.root), false, 'load must not create state');

const notes = [];
await commands.get('experience').handler('status', ctx(notes));
assert.equal(existsSync(paths.root), false, 'status must not create state');
await handlers.get('input')({ type: 'input', text: 'phase3@example.invalid', source: 'interactive' }, ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }, ctx(notes));
assert.equal(existsSync(paths.root), false, 'capture-off hooks must not create state');

assert.equal(classifyCaptureInput({ text: 'ok', source: 'interactive', sessionId: 's', sessionFile: 'f', userId: 'u' }).allow, true);
for (const source of ['rpc', 'extension', 'tool', 'unknown']) {
  assert.equal(classifyCaptureInput({ text: 'ok', source, sessionId: 's', sessionFile: 'f', userId: 'u' }).allow, false);
}
assert.equal(classifyCaptureInput({ text: 'ok', source: 'interactive', streamingBehavior: 'followUp', sessionId: 's', sessionFile: 'f', userId: 'u' }).allow, false);
assert.equal(classifyCaptureInput({ text: 'ok', source: 'interactive', images: [{ type: 'image' }], sessionId: 's', sessionFile: 'f', userId: 'u' }).allow, false);
assert.equal(classifyCaptureInput({ text: 'x'.repeat(17 * 1024), source: 'interactive', sessionId: 's', sessionFile: 'f', userId: 'u' }).allow, false);

// event.messages is RUN-SCOPED. Its shape depends on the run type: the INITIAL run
// (runAgentLoop) starts with the triggering user prompt(s) then appends assistant and
// tool messages; a CONTINUATION/retry run (runAgentLoopContinue) starts empty. Because
// extract reads ONLY assistant messages, both shapes work; it concatenates visible text
// from every assistant message in the run.
assert.equal(extractSingleFinalAssistantText([{ role: 'assistant', content: [{ type: 'text', text: 'one' }] }]), 'one');
assert.equal(extractSingleFinalAssistantText([]), undefined);
// Tool-heavy run: assistant(text+toolCall) → toolResult → assistant(text); tool results and thinking are ignored.
assert.equal(extractSingleFinalAssistantText([
  { role: 'assistant', content: [{ type: 'text', text: 'calling a tool' }, { type: 'toolCall', id: 't1' }] },
  { role: 'toolResult', content: [{ type: 'text', text: 'tool output ignored' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'final answer' }, { type: 'thinking', thinking: 'hidden' }] },
]), 'calling a tool\nfinal answer');
// Tool-only FINAL message keeps earlier same-run assistant text (the fix for tool-heavy coding turns).
assert.equal(extractSingleFinalAssistantText([
  { role: 'assistant', content: [{ type: 'text', text: 'earlier same-run conclusion' }] },
  { role: 'toolResult', content: [{ type: 'text', text: 'ignored' }] },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-only' }] },
]), 'earlier same-run conclusion');
// Runs with no assistant text (image-only, tool-result-only) → drop.
assert.equal(extractSingleFinalAssistantText([{ role: 'assistant', content: [{ type: 'image', data: 'x' }] }]), undefined);
assert.equal(extractSingleFinalAssistantText([{ role: 'toolResult', content: [{ type: 'text', text: 'no assistant text' }] }]), undefined);
// Hidden (display:false) assistant messages are skipped.
assert.equal(extractSingleFinalAssistantText([
  { role: 'assistant', content: [{ type: 'text', text: 'shown' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'hidden' }], display: false },
]), 'shown');
assert.equal(extractSingleFinalAssistantText([{ role: 'assistant', content: [{ type: 'text', text: 'only hidden' }], display: false }]), undefined);
// Run-level failure: a run whose TERMINAL assistant message failed/aborted/truncated
// yields NOTHING for the whole run, including earlier same-run text.
assert.equal(extractSingleFinalAssistantText([{ role: 'assistant', content: [{ type: 'text', text: 'partial error output' }], stopReason: 'error' }]), undefined);
assert.equal(extractSingleFinalAssistantText([{ role: 'assistant', content: [{ type: 'text', text: 'aborted output' }], stopReason: 'aborted' }]), undefined);
assert.equal(extractSingleFinalAssistantText([{ role: 'assistant', content: [{ type: 'text', text: 'truncated half answer' }], stopReason: 'length' }]), undefined, 'terminal stopReason length (truncated mid-answer) must be rejected');
// Tool-heavy failed run: the earlier "working before tool" text must NOT be captured.
assert.equal(extractSingleFinalAssistantText([
  { role: 'assistant', content: [{ type: 'text', text: 'working before tool' }, { type: 'toolCall', id: 't1' }], stopReason: 'toolUse' },
  { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'terminal error text' }], stopReason: 'error' },
]), undefined, 'a failed run must drop its earlier same-run text, not only the final error message');
// Successful tool-heavy run (terminal stopReason "stop") still captures all its text.
assert.equal(extractSingleFinalAssistantText([
  { role: 'assistant', content: [{ type: 'text', text: 'working on it' }, { type: 'toolCall', id: 't1' }], stopReason: 'toolUse' },
  { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'final conclusion' }], stopReason: 'stop' },
]), 'working on it\nfinal conclusion');
// Oversized concatenation keeps the tail and marks truncation, staying within the bound.
const oversizedTail = 'TAIL_END_MARKER';
const oversized = extractSingleFinalAssistantText([{ role: 'assistant', content: [{ type: 'text', text: `${'x'.repeat(MAX_CAPTURE_ASSISTANT_CHARS)}${oversizedTail}` }] }]);
assert.ok(oversized.length <= MAX_CAPTURE_ASSISTANT_CHARS, 'truncated capture must stay within the bound');
assert.ok(oversized.endsWith(oversizedTail), 'truncation must keep the tail end where corrections/conclusions live');
assert.match(oversized, /truncated/i, 'truncation must be marked');

const pureBuffer = new CapturePairBuffer();
const key = { sessionId: 's', sessionFile: 'f', userId: 'owner' };
const appended = [];
await pureBuffer.acceptInput({ key, text: 'u1', origin: { source: 'local_interactive' }, createdAt: 't1' }, async (pair, reason) => { appended.push({ pair, reason }); });
assert.equal(pureBuffer.stateForTest(key), 'pending');
pureBuffer.recordAgentEnd(key, 'a1', 't2');
assert.equal(pureBuffer.stateForTest(key), 'settling');
assert.deepEqual(appended, [], 'recordAgentEnd must defer persistence, not append');
await pureBuffer.acceptInput({ key, text: 'u2', origin: { source: 'local_interactive' }, createdAt: 't3' }, async (pair, reason) => { appended.push({ pair, reason }); });
assert.deepEqual(appended.map((item) => item.reason), ['next_input']);
assert.equal(appended[0].pair.assistantText, 'a1', 'next-input backstop flushes the accumulated pair');
assert.equal(pureBuffer.stateForTest(key), 'pending');
pureBuffer.clearAll();
assert.equal(pureBuffer.sizeForTest(), 0);

// Across Pi's retry boundary, keep the LAST non-empty run and persist once at settle.
const retryBuffer = new CapturePairBuffer();
const retryAppends = [];
const retryAppend = async (pair, reason) => { retryAppends.push({ reason, text: pair.assistantText }); };
await retryBuffer.acceptInput({ key, text: 'q', origin: { source: 'local_interactive' }, createdAt: 't1' }, retryAppend);
retryBuffer.recordAgentEnd(key, 'retryable partial error', 't2');
retryBuffer.recordAgentEnd(key, undefined, 't3');
retryBuffer.recordAgentEnd(key, '', 't3b');
retryBuffer.recordAgentEnd(key, 'final real answer', 't4');
assert.equal(retryBuffer.stateForTest(key), 'settling');
await retryBuffer.settle(key, retryAppend);
assert.deepEqual(retryAppends, [{ reason: 'agent_settled', text: 'final real answer' }], 'empty runs must not overwrite/drop; settle persists the last non-empty answer');
assert.equal(retryBuffer.stateForTest(key), undefined);
await retryBuffer.settle(key, retryAppend);
assert.equal(retryAppends.length, 1, 'a second settle must not double-persist');

// A mid-run steering user message (a second input while still pending, before
// agent_end) makes correlation ambiguous, so the buffer drops the pair with no
// append. This is why extractSingleFinalAssistantText needs no boundary handling.
const steerBuffer = new CapturePairBuffer();
const steerAppends = [];
await steerBuffer.acceptInput({ key, text: 's1', origin: { source: 'local_interactive' }, createdAt: 't1' }, async (pair, reason) => { steerAppends.push(reason); });
assert.equal(steerBuffer.stateForTest(key), 'pending');
await steerBuffer.acceptInput({ key, text: 's2-steering', origin: { source: 'local_interactive' }, createdAt: 't2' }, async (pair, reason) => { steerAppends.push(reason); });
assert.equal(steerBuffer.stateForTest(key), undefined, 'second input before agent_end drops the ambiguous pair');
assert.deepEqual(steerAppends, [], 'dropped ambiguous pair must not append anything');

await commands.get('experience').handler('enable', ctx(notes));
await commands.get('experience').handler('capture on', ctx(notes));
let configRead = await readAgentExperienceConfig(paths);
assert.equal(configRead.config.enabled, true);
assert.equal(configRead.config.capture_enabled, true);

let observationPath = resolvePrivatePath(paths.root, 'observations.jsonl');
// (1)+(3) Clean single run, INITIAL-run shape: runAgentLoop starts messages with the
// triggering prompt then appends assistant/tool messages. Only assistant text is
// captured; persistence is deferred to the settle boundary, not agent_end.
await handlers.get('input')({ type: 'input', text: 'user phase3@example.invalid', source: 'interactive' }, ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [
  { role: 'user', content: [{ type: 'text', text: 'user phase3@example.invalid' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'working on it' }, { type: 'toolCall', id: 'tool-1' }] },
  { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'assistant +1 212 555 0101 conclusion' }] },
] }, ctx(notes));
assert.equal(existsSync(observationPath), false, 'agent_end alone must not persist before the prompt settles');
await handlers.get('agent_settled')({ type: 'agent_settled' }, ctx(notes));
let records = await readObservationLines(observationPath);
assert.equal(records.length, 1, 'settle persists the accumulated pair');
assert.equal(records[0].seq, 1);
assert.equal(records[0].prev_pair_ref, null);
assert.equal(records[0].origin.source, 'local_interactive');
assert.equal(records[0].payload_redacted.kind, 'conversation_pair_v1');
assert.equal(records[0].payload_redacted.close_reason, 'agent_settled');
assert.match(records[0].payload_redacted.assistant_text_redacted, /^working on it\n/, 'only assistant text is captured; the initial-run prompt must not enter the assistant text');
assert.match(records[0].payload_redacted.assistant_text_redacted, /conclusion$/);
assert.equal(containsUnredactedSensitiveText(records), false, 'captured observation must be redacted');
assert.equal(records[0].checksum, observationChecksumForTest(Object.fromEntries(Object.entries(records[0]).filter(([key]) => key !== 'checksum'))));
await handlers.get('agent_settled')({ type: 'agent_settled' }, ctx(notes));
assert.equal((await readObservationLines(observationPath)).length, 1, 'a second settle after a clean single run must not double-persist');

// (2)+(4) Retryable-error lifecycle: a FAILED multi-message run (terminal stopReason
// "error", with earlier tool-heavy text) → successful continuation → settle → exactly
// one pair carrying ONLY the final answer (the failed run contributes nothing).
await handlers.get('input')({ type: 'input', text: 'retry user', source: 'interactive' }, ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [
  { role: 'assistant', content: [{ type: 'text', text: 'working before failure' }, { type: 'toolCall', id: 'r1' }], stopReason: 'toolUse' },
  { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'partial then error' }], stopReason: 'error' },
] }, ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final corrected answer' }], stopReason: 'stop' }] }, ctx(notes));
await handlers.get('agent_settled')({ type: 'agent_settled' }, ctx(notes));
records = await readObservationLines(observationPath);
assert.equal(records.length, 2, 'retry lifecycle persists exactly one additional pair');
assert.equal(records[1].seq, 2);
assert.equal(records[1].prev_pair_ref, observationPairRefForTest(records[0]));
assert.equal(records[1].payload_redacted.assistant_text_redacted, 'final corrected answer', 'a failed multi-message run must contribute nothing; only the successful answer persists');
assert.equal(records[1].payload_redacted.close_reason, 'agent_settled');

// (3) Exhausted retries: two multi-message runs that each terminate in failure
// (error then aborted) → nothing captured, so no pair persists even though earlier
// same-run tool-heavy text existed.
await handlers.get('input')({ type: 'input', text: 'exhausted user', source: 'interactive' }, ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [
  { role: 'assistant', content: [{ type: 'text', text: 'attempt one work' }, { type: 'toolCall', id: 'e1' }], stopReason: 'toolUse' },
  { role: 'toolResult', content: [{ type: 'text', text: 'output' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'first error output' }], stopReason: 'error' },
] }, ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [
  { role: 'assistant', content: [{ type: 'text', text: 'attempt two work' }, { type: 'toolCall', id: 'e2' }], stopReason: 'toolUse' },
  { role: 'toolResult', content: [{ type: 'text', text: 'output' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'second aborted output' }], stopReason: 'aborted' },
] }, ctx(notes));
await handlers.get('agent_settled')({ type: 'agent_settled' }, ctx(notes));
assert.equal((await readObservationLines(observationPath)).length, 2, 'exhausted multi-message failed runs must persist no pair');

// A new input after a settled pair starts fresh and does not double-write.
await handlers.get('input')({ type: 'input', text: 'next user', source: 'interactive' }, ctx(notes));
assert.equal((await readObservationLines(observationPath)).length, 2, 'a settled pair is gone; a new input starts a fresh pending pair');

// (4) Shutdown before settle: the shutdown backstop persists this pending run's answer.
await handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'answer before shutdown' }] }] }, ctx(notes));
await handlers.get('session_shutdown')({ type: 'session_shutdown', reason: 'quit' }, ctx(notes));
records = await readObservationLines(observationPath);
assert.equal(records.length, 3, 'shutdown backstop persists a settling pair when settle never fired');
assert.equal(records[2].payload_redacted.assistant_text_redacted, 'answer before shutdown');
assert.equal(records[2].payload_redacted.close_reason, 'session_shutdown');

await handlers.get('input')({ type: 'input', text: 'rpc denied', source: 'rpc' }, ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant', content: 'would not write' }] }, ctx(notes));
await handlers.get('agent_settled')({ type: 'agent_settled' }, ctx(notes));
assert.equal((await readObservationLines(observationPath)).length, 3, 'rejected origin must not write');

await handlers.get('input')({ type: 'input', text: 'disable user', source: 'interactive' }, ctx(notes));
await commands.get('experience').handler('disable', ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant', content: 'disable assistant' }] }, ctx(notes));
await handlers.get('agent_settled')({ type: 'agent_settled' }, ctx(notes));
assert.equal((await readObservationLines(observationPath)).length, 3, 'disable mid-run must clear state and not persist');

await commands.get('experience').handler('enable', ctx(notes));
await commands.get('experience').handler('capture on', ctx(notes));
await handlers.get('input')({ type: 'input', text: 'capture off user', source: 'interactive' }, ctx(notes));
await commands.get('experience').handler('capture off', ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant', content: 'capture off assistant' }] }, ctx(notes));
await handlers.get('agent_settled')({ type: 'agent_settled' }, ctx(notes));
assert.equal((await readObservationLines(observationPath)).length, 3, 'capture off mid-run must drop pending pair');
await commands.get('experience').handler('disable', ctx(notes));
assert.equal((await readObservationLines(observationPath)).length, 3, 'disabled/capture-off mode must not flush completed pair');

const diagnosticRoot = await ensurePrivateRoot(join(temp, 'diagnostic-root'));
process.env.AX_STATE_ROOT = diagnosticRoot;
const diagnosticNotes = [];
const diagnostic = makePi();
const diagnosticPaths = getAgentExperiencePaths();
await diagnostic.commands.get('experience').handler('on', ctx(diagnosticNotes));
await mkdir(resolvePrivatePath(diagnosticPaths.root, 'observations.jsonl'));
await diagnostic.handlers.get('input')({ type: 'input', text: 'diagnostic user private@example.invalid', source: 'interactive' }, ctx(diagnosticNotes));
await diagnostic.handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant', content: 'diagnostic assistant' }] }, ctx(diagnosticNotes));
await diagnostic.handlers.get('agent_settled')({ type: 'agent_settled' }, ctx(diagnosticNotes));
assert.match(diagnosticNotes.at(-1).message, /could not save this turn's example/);
assert.doesNotMatch(diagnosticNotes.at(-1).message, /private@example\.invalid|diagnostic user|diagnostic assistant/);
process.env.AX_STATE_ROOT = join(temp, 'state');

const seqRoot = await ensurePrivateRoot(join(temp, 'seq-root'));
const concurrent = await Promise.all(Array.from({ length: 5 }, (_, index) => appendObservation(seqRoot, {
  userId: 'owner',
  origin: { source: 'test', command: `c${index}` },
  payload: { safe: index },
  createdAt: `2026-07-07T00:00:0${index}.000Z`,
})));
assert.equal(concurrent.length, 5);
const seqRecords = await readObservationLines(resolvePrivatePath(seqRoot, 'observations.jsonl'));
assert.deepEqual(seqRecords.map((record) => record.seq), [1, 2, 3, 4, 5]);
for (let i = 1; i < seqRecords.length; i++) assert.equal(seqRecords[i].prev_pair_ref, observationPairRefForTest(seqRecords[i - 1]));

const staleLockRoot = await ensurePrivateRoot(join(temp, 'stale-lock-root'));
const staleLockPath = resolvePrivatePath(staleLockRoot, '.observations.lock');
await writeFile(staleLockPath, canonicalJson({ pid: 99999999, created_at: '2026-07-07T00:00:00.000Z' }));
const oldLockDate = new Date(Date.now() - 60_000);
await utimes(staleLockPath, oldLockDate, oldLockDate);
await appendObservation(staleLockRoot, { userId: 'owner', origin: { source: 'test' }, payload: { recovered: true }, createdAt: '2026-07-07T00:00:00.000Z' });
let staleLockRecords = await readObservationLines(resolvePrivatePath(staleLockRoot, 'observations.jsonl'));
assert.equal(staleLockRecords.length, 1, 'stale dead-process lock must recover without manual cleanup');

await writeFile(staleLockPath, canonicalJson({ pid: 99999999, created_at: new Date().toISOString() }));
await appendObservation(staleLockRoot, { userId: 'owner', origin: { source: 'test' }, payload: { recovered_recent_dead_pid: true }, createdAt: '2026-07-07T00:00:01.000Z' });
staleLockRecords = await readObservationLines(resolvePrivatePath(staleLockRoot, 'observations.jsonl'));
assert.equal(staleLockRecords.length, 2, 'recent dead-process lock must recover within lock timeout');

const partialRoot = await ensurePrivateRoot(join(temp, 'partial-root'));
await appendObservation(partialRoot, { userId: 'owner', origin: { source: 'test' }, payload: { safe: true }, createdAt: '2026-07-07T00:00:00.000Z' });
const partialPath = resolvePrivatePath(partialRoot, 'observations.jsonl');
await appendFile(partialPath, '{"partial":"phase3@example.invalid"');
await appendObservation(partialRoot, { userId: 'owner', origin: { source: 'manual' }, payload: { safe: 2 }, createdAt: '2026-07-07T00:00:01.000Z' });
const partialRecords = await readObservationLines(partialPath);
assert.deepEqual(partialRecords.map((record) => record.seq), [1, 2]);
const recoveredEntries = await readdir(resolvePrivatePath(partialRoot, 'recovered-tails'));
assert.equal(recoveredEntries.length, 1);
const recoveredText = await readFile(join(partialRoot, 'recovered-tails', recoveredEntries[0]), 'utf8');
assert.equal(await privateStatMode(join(partialRoot, 'recovered-tails', recoveredEntries[0])), 0o600);
assert.equal(containsUnredactedSensitiveText(recoveredText), false, 'recovered tail must be redacted');

const legacyRoot = await ensurePrivateRoot(join(temp, 'legacy-root'));
await writeFile(resolvePrivatePath(legacyRoot, 'observations.jsonl'), `${canonicalJson({ id: 'legacy', user_id: 'owner', origin: { source: 'test' }, payload_redacted: { safe: true }, checksum: 'old' })}\n`);
await assert.rejects(() => appendObservation(legacyRoot, { userId: 'owner', origin: { source: 'test' }, payload: { safe: true } }), /seq|checksum|chain/i);
const legacyText = await readFile(resolvePrivatePath(legacyRoot, 'observations.jsonl'), 'utf8');
assert.match(legacyText, /legacy/);

await rm(temp, { recursive: true, force: true });
console.log('agent-experience phase3 capture checks passed');
