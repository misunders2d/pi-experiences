#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import agentExperienceExtension from '../extensions/agent-experience/index.ts';
import { createBackup } from '../extensions/agent-experience/src/storage/backup.ts';
import { initExperienceStorage, openExistingExperienceStorage } from '../extensions/agent-experience/src/storage/sqlite.ts';
import {
  backupExperienceDatabaseWithRuntime,
  openExperienceDatabaseWithRuntime,
  resolveAgentExperienceHost,
} from '../extensions/agent-experience/src/storage/runtime.ts';

assert.equal(resolveAgentExperienceHost({ host: 'omp' }, {}), 'omp');
assert.equal(resolveAgentExperienceHost({ host: 'pi' }, { Bun: { version: '1.3.14' } }), 'pi');
assert.equal(resolveAgentExperienceHost({}, { Bun: { version: '1.3.14' } }), 'omp');
assert.equal(resolveAgentExperienceHost({}, {}), 'pi');

const opened = [];
class FakeBunDatabase {
  constructor(path, options) {
    this.path = path;
    this.options = options;
    this.executed = [];
    opened.push(this);
  }
  exec(sql) { this.executed.push(sql); }
  serialize() { return new Uint8Array([83, 81, 76]); }
}
const bunRuntime = { kind: 'bun', Database: FakeBunDatabase };

const writable = await openExperienceDatabaseWithRuntime('/tmp/experience.sqlite', { create: true, timeout: 1234 }, bunRuntime);
assert.deepEqual(writable.options, { create: true, readwrite: true });
assert.deepEqual(writable.executed, ['PRAGMA busy_timeout = 1234']);

const readonly = await openExperienceDatabaseWithRuntime('/tmp/experience.sqlite', { readOnly: true, timeout: 5000 }, bunRuntime);
assert.deepEqual(readonly.options, { readonly: true });
assert.deepEqual(readonly.executed, ['PRAGMA busy_timeout = 5000']);

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-runtime-'));
try {
  const snapshot = join(temp, 'snapshot.sqlite');
  await backupExperienceDatabaseWithRuntime(writable, snapshot, bunRuntime);
  assert.deepEqual([...await readFile(snapshot)], [83, 81, 76]);
} finally {
  await rm(temp, { recursive: true, force: true });
}

if (typeof globalThis.Bun?.version === 'string') {
  const realTemp = await mkdtemp(join(tmpdir(), 'agent-experience-bun-sqlite-'));
  try {
    const storage = await initExperienceStorage(realTemp, { allowInit: true, userId: 'owner' });
    assert.equal(Number(storage.db.prepare('PRAGMA user_version').get().user_version) > 0, true);
    storage.db.close();
    const reopened = await openExistingExperienceStorage(realTemp, { userId: 'owner' });
    reopened.db.close();
    const backup = await createBackup(realTemp, { backupId: 'bun-runtime' });
    const snapshot = await openExperienceDatabaseWithRuntime(join(backup.backupDir, 'ledger.sqlite'), { readOnly: true, timeout: 5000 });
    assert.equal(String(snapshot.prepare('PRAGMA integrity_check').get().integrity_check).toLowerCase(), 'ok');
    snapshot.close();

    const ompHandlers = new Map();
    agentExperienceExtension({
      registerCommand() {},
      registerTool() {},
      on(event, handler) { ompHandlers.set(event, handler); },
    });
    assert.equal(ompHandlers.has('advisor_context'), true, 'host-less Bun API must use OMP native Advisor routing');
    const notes = [];
    ompHandlers.get('before_agent_start')(
      { prompt: 'current request', systemPrompt: 'base' },
      { ui: { notify(message) { notes.push(message); } } },
    );
    assert.deepEqual(notes, [], 'OMP must not attempt Pi visual-provenance steering');
  } finally {
    await rm(realTemp, { recursive: true, force: true });
  }
}

console.log('agent-experience phase32 runtime compatibility checks passed');
