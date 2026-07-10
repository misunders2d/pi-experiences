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
import { extractSingleFinalAssistantText } from '../extensions/agent-experience/src/capture/extract.ts';
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
  assert.deepEqual([...handlers.keys()].sort(), ['agent_end', 'before_agent_start', 'input', 'session_shutdown']);
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

assert.equal(extractSingleFinalAssistantText([{ role: 'assistant', content: [{ type: 'text', text: 'one' }] }]), 'one');
assert.equal(extractSingleFinalAssistantText([]), undefined);
assert.equal(extractSingleFinalAssistantText([{ role: 'assistant', content: 'one' }, { role: 'assistant', content: 'two' }]), 'two');
assert.equal(extractSingleFinalAssistantText([{ role: 'assistant', content: [{ type: 'image', data: 'x' }] }]), undefined);
assert.equal(extractSingleFinalAssistantText([{ role: 'assistant', content: [{ type: 'text', text: 'tool turn' }, { type: 'toolCall', id: 't1' }] }]), 'tool turn');
assert.equal(extractSingleFinalAssistantText([{ role: 'assistant', content: [{ type: 'text', text: 'old' }] }, { role: 'assistant', content: [{ type: 'text', text: 'final' }, { type: 'thinking', thinking: 'hidden' }] }]), 'final');
assert.equal(extractSingleFinalAssistantText([{ role: 'assistant', content: [{ type: 'text', text: 'old' }] }, { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-only' }] }]), undefined);

const pureBuffer = new CapturePairBuffer();
const key = { sessionId: 's', sessionFile: 'f', userId: 'owner' };
const appended = [];
await pureBuffer.acceptInput({ key, text: 'u1', origin: { source: 'local_interactive' }, createdAt: 't1' }, async (pair, reason) => { appended.push({ pair, reason }); });
assert.equal(pureBuffer.stateForTest(key), 'pending');
pureBuffer.completeAgentEnd(key, 'a1', 't2');
assert.equal(pureBuffer.stateForTest(key), 'complete');
await pureBuffer.acceptInput({ key, text: 'u2', origin: { source: 'local_interactive' }, createdAt: 't3' }, async (pair, reason) => { appended.push({ pair, reason }); });
assert.deepEqual(appended.map((item) => item.reason), ['next_input']);
assert.equal(pureBuffer.stateForTest(key), 'pending');
pureBuffer.clearAll();
assert.equal(pureBuffer.sizeForTest(), 0);

await commands.get('experience').handler('enable', ctx(notes));
await commands.get('experience').handler('capture on', ctx(notes));
let configRead = await readAgentExperienceConfig(paths);
assert.equal(configRead.config.enabled, true);
assert.equal(configRead.config.capture_enabled, true);

await handlers.get('input')({ type: 'input', text: 'user phase3@example.invalid', source: 'interactive' }, ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [
  { role: 'assistant', content: [{ type: 'text', text: 'older assistant from prior turn' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'assistant +1 212 555 0101' }, { type: 'toolCall', id: 'tool-1' }] },
] }, ctx(notes));
let observationPath = resolvePrivatePath(paths.root, 'observations.jsonl');
let records = await readObservationLines(observationPath);
assert.equal(records.length, 1, 'agent_end must persist immediately without waiting for next input');
assert.equal(records[0].seq, 1);
assert.equal(records[0].prev_pair_ref, null);
assert.equal(records[0].origin.source, 'local_interactive');
assert.equal(records[0].payload_redacted.kind, 'conversation_pair_v1');
assert.equal(records[0].payload_redacted.close_reason, 'agent_end');
assert.equal(containsUnredactedSensitiveText(records), false, 'captured observation must be redacted');
assert.equal(records[0].checksum, observationChecksumForTest(Object.fromEntries(Object.entries(records[0]).filter(([key]) => key !== 'checksum'))));

await handlers.get('input')({ type: 'input', text: 'next user', source: 'interactive' }, ctx(notes));
assert.equal((await readObservationLines(observationPath)).length, 1, 'next input must not double-write already persisted pair');
await handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'second assistant' }] }] }, ctx(notes));
await handlers.get('session_shutdown')({ type: 'session_shutdown', reason: 'quit' }, ctx(notes));
records = await readObservationLines(observationPath);
assert.equal(records.length, 2);
assert.equal(records[1].seq, 2);
assert.equal(records[1].prev_pair_ref, observationPairRefForTest(records[0]));
assert.equal(records[1].payload_redacted.close_reason, 'agent_end');

await handlers.get('input')({ type: 'input', text: 'rpc denied', source: 'rpc' }, ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant', content: 'would not write' }] }, ctx(notes));
assert.equal((await readObservationLines(observationPath)).length, 2, 'rejected origin must not write');

await handlers.get('input')({ type: 'input', text: 'disable user', source: 'interactive' }, ctx(notes));
await commands.get('experience').handler('disable', ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant', content: 'disable assistant' }] }, ctx(notes));
records = await readObservationLines(observationPath);
assert.equal(records.length, 2, 'disable must drop pending capture pair without writing observations');

await commands.get('experience').handler('enable', ctx(notes));
await commands.get('experience').handler('capture on', ctx(notes));
await handlers.get('input')({ type: 'input', text: 'capture off user', source: 'interactive' }, ctx(notes));
await commands.get('experience').handler('capture off', ctx(notes));
await handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant', content: 'capture off assistant' }] }, ctx(notes));
assert.equal((await readObservationLines(observationPath)).length, 2, 'capture off must drop pending pair');
await commands.get('experience').handler('disable', ctx(notes));
assert.equal((await readObservationLines(observationPath)).length, 2, 'disabled/capture-off mode must not flush completed pair');

const diagnosticRoot = await ensurePrivateRoot(join(temp, 'diagnostic-root'));
process.env.AX_STATE_ROOT = diagnosticRoot;
const diagnosticNotes = [];
const diagnostic = makePi();
const diagnosticPaths = getAgentExperiencePaths();
await diagnostic.commands.get('experience').handler('on', ctx(diagnosticNotes));
await mkdir(resolvePrivatePath(diagnosticPaths.root, 'observations.jsonl'));
await diagnostic.handlers.get('input')({ type: 'input', text: 'diagnostic user private@example.invalid', source: 'interactive' }, ctx(diagnosticNotes));
await diagnostic.handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant', content: 'diagnostic assistant' }] }, ctx(diagnosticNotes));
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
