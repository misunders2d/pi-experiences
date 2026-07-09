#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension from '../extensions/agent-experience/index.ts';
import { getAgentExperiencePaths, readAgentExperienceConfig, writeAgentExperienceConfig } from '../extensions/agent-experience/src/paths.ts';
import {
  assertPathInsidePrivateRoot,
  ensurePrivateRoot,
  normalizeUserId,
  openSensitiveFileForWrite,
  privateStatMode,
  resolvePrivatePath,
} from '../extensions/agent-experience/src/storage/private-root.ts';
import { redactJson, redactText, containsUnredactedSensitiveText } from '../extensions/agent-experience/src/storage/redaction.ts';
import { canonicalJson, checksumJson } from '../extensions/agent-experience/src/storage/checksum.ts';
import {
  getTableInfo,
  initExperienceStorage,
  openExistingExperienceStorage,
  insertStorageRecord,
  selectStorageRecordsByUser,
} from '../extensions/agent-experience/src/storage/sqlite.ts';
import { appendObservation } from '../extensions/agent-experience/src/storage/observations.ts';
import { createBackup, listBackups, restoreBackup } from '../extensions/agent-experience/src/storage/backup.ts';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { readConfiguredLawSnapshot } from '../extensions/agent-experience/src/review.ts';

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase2-'));
process.env.AX_STATE_ROOT = join(temp, 'state');
const paths = getAgentExperiencePaths();
assert.equal(existsSync(paths.root), false, 'module imports must not create state root');

const commands = new Map();
const handlers = new Map();
const fakePi = {
  registerCommand(name, options) { commands.set(name, options); },
  registerTool() { throw new Error('Agent Experience must not register tools'); },
  on(event, handler) { handlers.set(event, handler); },
  registerShortcut() { throw new Error('Agent Experience must not register shortcuts'); },
  registerFlag() { throw new Error('Agent Experience must not register flags'); },
};
agentExperienceExtension(fakePi);
assert.deepEqual([...commands.keys()], ['experience']);
assert.deepEqual([...handlers.keys()].sort(), ['agent_end', 'before_agent_start', 'input', 'session_shutdown']);
assert.equal(existsSync(paths.root), false, 'extension load must not create state root');
const notes = [];
const ctx = { cwd: process.cwd(), ui: { notify(message, level) { notes.push({ message, level }); } } };
await commands.get('experience').handler('status', ctx);
assert.equal(existsSync(paths.root), false, 'status must not create state root');

assert.equal(normalizeUserId(undefined), 'owner');
assert.equal(normalizeUserId('   '), 'owner');
assert.equal(normalizeUserId(' user-a '), 'user-a');
assert.throws(() => normalizeUserId('bad/user'), /Invalid/);
assert.throws(() => normalizeUserId('bad\\user'), /Invalid/);
assert.throws(() => normalizeUserId('bad\nuser'), /Invalid/);
assert.throws(() => resolvePrivatePath(paths.root, '..'), /Unsafe/);

const root = await ensurePrivateRoot(paths.root);
assert.equal(await privateStatMode(root), 0o700, 'private root must be 0700');
const outside = await mkdtemp(join(tmpdir(), 'agent-experience-outside-'));
const linkPath = resolvePrivatePath(root, 'escape-link');
await symlink(outside, linkPath);
await assert.rejects(() => assertPathInsidePrivateRoot(root, join(linkPath, 'x')), /escapes/);
await writeFile(join(temp, 'outside-config.toml'), 'enabled = true\n');
await symlink(join(temp, 'outside-config.toml'), paths.configPath);
await assert.rejects(() => readAgentExperienceConfig(paths), /regular private file/);
await rm(paths.configPath, { force: true });
await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true }, paths);
await assert.rejects(() => readConfiguredLawSnapshot(root, { law_path: '../outside-law.md' }), /inside private state/);
await writeFile(join(temp, 'outside-law.md'), 'outside law\n');
await symlink(join(temp, 'outside-law.md'), resolvePrivatePath(root, 'law.md'));
await assert.rejects(() => readConfiguredLawSnapshot(root, { law_path: 'law.md' }), /regular private file/);
await rm(resolvePrivatePath(root, 'law.md'), { force: true });

const realParent = await mkdtemp(join(tmpdir(), 'agent-experience-real-parent-'));
const aliasParent = join(temp, 'alias-parent');
await symlink(realParent, aliasParent);
const aliasRoot = join(aliasParent, 'state');
await ensurePrivateRoot(aliasRoot);
const aliasFile = resolvePrivatePath(aliasRoot, 'ok.txt');
const aliasHandle = await openSensitiveFileForWrite(aliasRoot, aliasFile);
await aliasHandle.writeFile('ok');
await aliasHandle.close();
assert.equal(await privateStatMode(join(realParent, 'state', 'ok.txt')), 0o600, 'symlinked parent root should still permit contained writes');

const sensitive = {
  email: 'phase2@example.invalid',
  phone: '+1 212 555 0101',
  apiKey: 'sk_phase2_fake_token_1234567890',
  nested: { authorization: 'Bearer phase2fake1234567890', path: '/home/example/private-file', macPath: '/Users/example/private-file' },
};
const redacted = redactJson(sensitive);
assert.equal(containsUnredactedSensitiveText(redacted), false, 'redacted JSON must contain no sensitive fixture text');
assert.equal(containsUnredactedSensitiveText(redactText(JSON.stringify(sensitive))), false, 'redacted text must contain no sensitive fixture text');
assert.equal(containsUnredactedSensitiveText('api_key=abcdefghijklmnopqrstuvwxyz'), true);
assert.equal(containsUnredactedSensitiveText('api_key="abcdefghijklmnopqrstuvwxyz"'), true);
assert.equal(containsUnredactedSensitiveText(redactText('api_key="abcdefghijklmnopqrstuvwxyz"')), false);
assert.equal(containsUnredactedSensitiveText(redactText('api_key=abcdefghijklmnopqrstuvwxyz')), false);
assert.equal(containsUnredactedSensitiveText('aaaabbbbccccddddeeeeffff.gggghhhhiiiijjjjkkkkllll.mmmmnnnnooooppppqqqqrrrr'), true);
assert.equal(containsUnredactedSensitiveText(redactText('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')), false);
assert.equal(containsUnredactedSensitiveText('/tmp/pi-secret-file'), true);
assert.equal(containsUnredactedSensitiveText('/media/misunderstood/DATA/private'), true);
assert.equal(containsUnredactedSensitiveText(redactText('/media/misunderstood/DATA/private')), false);
assert.equal(sensitive.email, 'phase2@example.invalid', 'redactJson must not mutate caller input');

const a = { b: 2, a: { z: 9, c: 3 } };
const b = { a: { c: 3, z: 9 }, b: 2 };
assert.equal(canonicalJson(a), canonicalJson(b));
assert.equal(checksumJson(a), checksumJson(b));
assert.notEqual(checksumJson(a), checksumJson({ ...a, b: 3 }));

await assert.rejects(() => initExperienceStorage(root, { allowInit: false }), /allowInit=true/);
const storage = await initExperienceStorage(root, { allowInit: true, userId: 'user-a' });
let backup;
try {
  assert.equal(storage.userId, 'user-a');
  const hotPathStorage = await openExistingExperienceStorage(root, { userId: 'user-a' });
  assert.equal(hotPathStorage.userId, 'user-a');
  hotPathStorage.db.close();
  assert.equal(await privateStatMode(storage.dbPath), 0o600, 'sqlite db must be 0600');
  for (const table of ['habits', 'evidence', 'contexts']) {
    const column = getTableInfo(storage.db, table).find((row) => row.name === 'user_id');
    assert.ok(column, `${table}.user_id exists`);
    assert.equal(String(column.type).toUpperCase(), 'TEXT');
    assert.equal(column.notnull, 1);
    assert.equal(column.dflt_value, "'owner'");
  }
  assert.throws(() => getTableInfo(storage.db, 'habits); DROP TABLE habits;--'), /Unsupported/);
  assert.throws(() => insertStorageRecord(storage.db, 'bad', { id: 'x', data: {} }), /Unsupported/);
  assert.throws(() => selectStorageRecordsByUser(storage.db, 'bad', 'user-a'), /Unsupported/);
  for (const table of ['habits', 'evidence', 'contexts']) {
    insertStorageRecord(storage.db, table, { id: `${table}-a`, userId: 'user-a', data: sensitive, now: '2026-07-07T00:00:00.000Z' });
    insertStorageRecord(storage.db, table, { id: `${table}-b`, userId: 'user-b', data: { safe: true }, now: '2026-07-07T00:00:00.000Z' });
    const onlyA = selectStorageRecordsByUser(storage.db, table, 'user-a');
    assert.deepEqual(onlyA.map((row) => row.id), [`${table}-a`], `${table} query must not mix users`);
    assert.equal(containsUnredactedSensitiveText(onlyA), false, `${table} helper must store redacted data`);
  }

  await assert.rejects(() => appendObservation(root, { userId: 'user-a', origin: { source: 'rpc' }, payload: sensitive }), /Unsupported/);
  const observation = await appendObservation(root, {
    userId: 'user-a',
    origin: { source: 'test', command: 'phase2' },
    payload: sensitive,
    id: 'obs-1',
    createdAt: '2026-07-07T00:00:00.000Z',
  });
  assert.equal(await privateStatMode(observation.path), 0o600, 'observation JSONL must be 0600');
  assert.equal(observation.record.user_id, 'user-a');
  assert.ok(observation.record.payload_redacted);
  assert.equal(containsUnredactedSensitiveText(observation.record), false, 'observation record must be redacted');
  const { checksum, ...observationWithoutChecksum } = observation.record;
  assert.equal(checksum, checksumJson(observationWithoutChecksum));
  assert.equal(observation.record.seq, 1);
  assert.equal(observation.record.prev_pair_ref, null);
  assert.equal('payload' in observation.record, false);
  assert.equal('raw' in observation.record, false);
  const observationText = await readFile(observation.path, 'utf8');
  assert.equal(containsUnredactedSensitiveText(observationText), false, 'observation JSONL must not contain sensitive fixture text');

  backup = await createBackup(root, { backupId: 'phase2-backup', createdAt: '2026-07-07T00:00:01.000Z' });
  assert.equal(await privateStatMode(backup.manifestPath), 0o600, 'backup manifest must be 0600');
  assert.equal(containsUnredactedSensitiveText(backup.manifest), false, 'backup manifest must not contain sensitive fixture text');
  assert.deepEqual((await listBackups(root)).map((item) => item.backup_id), ['phase2-backup']);
  await assert.rejects(() => restoreBackup(root, 'phase2-backup'), /allowOverwrite=true/);
  await assert.rejects(() => restoreBackup(root, 'phase2-backup', { allowOverwrite: true }), /confirmDatabaseClosed=true/);
} finally {
  storage.db.close();
}

await writeFile(resolvePrivatePath(root, 'backups', 'phase2-backup', 'manifest.json'), JSON.stringify({ ...backup.manifest, artifacts: [{ name: '../evil', checksum: 'x', bytes: 1 }] }));
await assert.rejects(() => restoreBackup(root, 'phase2-backup', { allowOverwrite: true, confirmDatabaseClosed: true }), /Unknown backup artifact|Unsafe/);
await writeFile(resolvePrivatePath(root, 'backups', 'phase2-backup', 'manifest.json'), canonicalJson(backup.manifest));
await rm(resolvePrivatePath(root, 'ledger.sqlite'), { force: true });
await rm(resolvePrivatePath(root, 'ledger.sqlite-wal'), { force: true });
await rm(resolvePrivatePath(root, 'ledger.sqlite-shm'), { force: true });
await rm(resolvePrivatePath(root, 'observations.jsonl'), { force: true });
const restored = await restoreBackup(root, 'phase2-backup', { allowOverwrite: true, confirmDatabaseClosed: true });
assert.ok(restored.restored.includes('ledger.sqlite'), 'restore should include sqlite artifact');
assert.ok(restored.restored.includes('observations.jsonl'), 'restore should include observation artifact');

const restoredStorage = await initExperienceStorage(root, { allowInit: true, userId: 'user-a' });
try {
  assert.deepEqual(selectStorageRecordsByUser(restoredStorage.db, 'habits', 'user-a').map((row) => row.id), ['habits-a']);
  assert.deepEqual(selectStorageRecordsByUser(restoredStorage.db, 'evidence', 'user-a').map((row) => row.id), ['evidence-a']);
  assert.deepEqual(selectStorageRecordsByUser(restoredStorage.db, 'contexts', 'user-a').map((row) => row.id), ['contexts-a']);
} finally {
  restoredStorage.db.close();
}
const restoredObservationText = await readFile(resolvePrivatePath(root, 'observations.jsonl'), 'utf8');
assert.match(restoredObservationText, /obs-1/);
assert.equal(containsUnredactedSensitiveText(restoredObservationText), false, 'restored JSONL must not contain sensitive fixture text');

const rootEntries = await readdir(root);
assert.ok(rootEntries.includes('ledger.sqlite'));
assert.ok(rootEntries.includes('observations.jsonl'));
assert.ok(rootEntries.includes('backups'));
for (const entry of rootEntries.filter((name) => name.startsWith('ledger.sqlite-'))) {
  const mode = (await stat(join(root, entry))).mode & 0o777;
  assert.ok([0o600, 0o644].includes(mode), 'sqlite sidecar files should remain inside private root');
}

await rm(outside, { recursive: true, force: true });
await rm(realParent, { recursive: true, force: true });
console.log('agent-experience phase2 storage checks passed');
