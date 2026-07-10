#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initExperienceStorage, openExistingExperienceStorage, insertStorageRecord, selectStorageRecordsByUser } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { applyStorageMigrations } from '../extensions/agent-experience/src/storage/migrations.ts';
import { appendObservation } from '../extensions/agent-experience/src/storage/observations.ts';
import { createBackup, prevalidateBackup, recoverInterruptedRestore, restoreBackup } from '../extensions/agent-experience/src/storage/backup.ts';
import { canonicalJson, checksumJson, sha256Hex } from '../extensions/agent-experience/src/storage/checksum.ts';
import { ensurePrivateRoot, resolvePrivatePath } from '../extensions/agent-experience/src/storage/private-root.ts';

async function digest(path) {
  return sha256Hex(await readFile(path));
}

async function newRoot(prefix) {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  return { parent, root: await ensurePrivateRoot(join(parent, 'state')) };
}

async function assertFutureSchemaImmutable() {
  const { parent, root } = await newRoot('agent-experience-future-schema-');
  try {
    const dbPath = resolvePrivatePath(root, 'ledger.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE sentinel (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sentinel VALUES ('future', 'keep'); PRAGMA user_version=999;");
    db.close();
    const beforeHash = await digest(dbPath);
    const beforeStat = await stat(dbPath);

    await assert.rejects(() => initExperienceStorage(root, { allowInit: true, userId: 'owner' }), /newer than this extension.*999/i);
    await assert.rejects(() => openExistingExperienceStorage(root, { userId: 'owner' }), /newer than this extension.*999/i);
    const direct = new DatabaseSync(dbPath);
    assert.throws(() => applyStorageMigrations(direct), /newer than this extension.*999/i);
    assert.equal(direct.prepare('PRAGMA user_version').get().user_version, 999);
    assert.equal(direct.prepare("SELECT value FROM sentinel WHERE id='future'").get().value, 'keep');
    direct.close();

    assert.equal(await digest(dbPath), beforeHash, 'future-schema database bytes remain unchanged');
    assert.equal((await stat(dbPath)).mtimeMs, beforeStat.mtimeMs, 'future-schema database mtime remains unchanged');
    assert.equal(existsSync(`${dbPath}-wal`), false, 'future-schema rejection creates no WAL');
    assert.equal(existsSync(`${dbPath}-shm`), false, 'future-schema rejection creates no SHM');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function assertV5MigrationAndCurrentVerification() {
  const { parent, root } = await newRoot('agent-experience-v5-migration-');
  try {
    const initial = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
    insertStorageRecord(initial.db, 'habits', { id: 'v5-preserved', userId: 'owner', data: { record_kind: 'habit_candidate_v1', schema_version: 1, status: 'candidate', condition: 'when testing migration', behavior: 'preserve this row', polarity: 1, confidence_bp: 8000 }, now: '2026-07-09T00:00:00.000Z' });
    initial.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    initial.db.close();
    const dbPath = resolvePrivatePath(root, 'ledger.sqlite');
    const downgradeFixture = new DatabaseSync(dbPath);
    downgradeFixture.exec('PRAGMA journal_mode=DELETE; DELETE FROM migrations WHERE version=6; PRAGMA user_version=5;');
    downgradeFixture.close();

    const migrated = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 6);
    assert.deepEqual(selectStorageRecordsByUser(migrated.db, 'habits', 'owner').map((row) => row.id), ['v5-preserved']);
    assert.equal(migrated.db.prepare('SELECT COUNT(*) AS count FROM migrations WHERE version=6').get().count, 1);
    migrated.db.close();

    const second = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
    assert.equal(second.db.prepare('SELECT COUNT(*) AS count FROM migrations WHERE version=6').get().count, 1, 'migration rerun is idempotent');
    assert.deepEqual(selectStorageRecordsByUser(second.db, 'habits', 'owner').map((row) => row.id), ['v5-preserved']);
    second.db.close();

    const malformedParent = await mkdtemp(join(tmpdir(), 'agent-experience-malformed-current-'));
    const malformedRoot = await ensurePrivateRoot(join(malformedParent, 'state'));
    const malformedPath = resolvePrivatePath(malformedRoot, 'ledger.sqlite');
    const malformed = new DatabaseSync(malformedPath);
    malformed.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); PRAGMA user_version=6;');
    malformed.close();
    await assert.rejects(() => initExperienceStorage(malformedRoot, { allowInit: true, userId: 'owner' }), /missing table/i);
    await rm(malformedParent, { recursive: true, force: true });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function assertBackupRestoreHardening() {
  const { parent, root } = await newRoot('agent-experience-backup-hardening-');
  try {
    const live = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
    insertStorageRecord(live.db, 'habits', { id: 'baseline', userId: 'owner', data: { record_kind: 'habit_candidate_v1', schema_version: 1, status: 'candidate', condition: 'when backing up', behavior: 'keep baseline', polarity: 1, confidence_bp: 8000 }, now: '2026-07-09T01:00:00.000Z' });

    const backupPromise = createBackup(root, { backupId: 'hot-backup', createdAt: '2026-07-09T01:00:01.000Z' });
    await new Promise((resolve) => setImmediate(resolve));
    for (let index = 0; index < 8; index += 1) {
      insertStorageRecord(live.db, 'contexts', { id: `hot-${index}`, userId: 'owner', data: { record_kind: 'context_v1', schema_version: 1, status: 'candidate', condition: `hot ${index}` }, now: `2026-07-09T01:00:${String(index + 2).padStart(2, '0')}.000Z` });
      await new Promise((resolve) => setImmediate(resolve));
    }
    const backup = await backupPromise;
    assert.deepEqual(backup.manifest.artifacts.map((item) => item.name), ['ledger.sqlite']);
    assert.equal(backup.manifest.privacy.observation_records, 'excluded_short_retention');
    await assert.rejects(() => createBackup(root, { backupId: 'hot-backup' }), /already exists/i);
    const validated = await prevalidateBackup(root, 'hot-backup');
    assert.equal(validated.storageSchemaVersion, 6);
    const snapshotDb = new DatabaseSync(validated.artifacts.find((item) => item.name === 'ledger.sqlite').path, { readOnly: true });
    assert.equal(snapshotDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(snapshotDb.prepare("SELECT COUNT(*) AS count FROM habits WHERE id='baseline'").get().count, 1);
    snapshotDb.close();

    insertStorageRecord(live.db, 'habits', { id: 'post-backup', userId: 'owner', data: { record_kind: 'habit_candidate_v1', schema_version: 1, status: 'candidate', condition: 'after backup', behavior: 'must survive failed restore only', polarity: 1, confidence_bp: 8000 }, now: '2026-07-09T01:01:00.000Z' });
    await appendObservation(root, { userId: 'owner', origin: { source: 'test' }, payload: { user: 'saved after backup', assistant: 'ephemeral' }, id: 'post-backup-observation', createdAt: '2026-07-09T01:01:01.000Z' });
    live.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    live.db.close();

    await assert.rejects(() => restoreBackup(root, 'hot-backup', { allowOverwrite: true, confirmDatabaseClosed: true, _testFailurePhase: 'live_moved' }), /Injected restore failure/);
    let reopened = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
    assert.equal(selectStorageRecordsByUser(reopened.db, 'habits', 'owner').some((row) => row.id === 'post-backup'), true, 'caught restore failure rolls back old state');
    reopened.db.close();

    await assert.rejects(() => restoreBackup(root, 'hot-backup', { allowOverwrite: true, confirmDatabaseClosed: true, _testFailurePhase: 'installed', _testSimulateCrash: true }), /Injected restore failure/);
    assert.equal(existsSync(resolvePrivatePath(root, '.restore-journal.json')), true, 'simulated crash leaves recovery journal');
    assert.deepEqual(await recoverInterruptedRestore(root), { recovered: true, outcome: 'old' });
    reopened = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
    assert.equal(selectStorageRecordsByUser(reopened.db, 'habits', 'owner').some((row) => row.id === 'post-backup'), true, 'pre-commit crash recovers old generation');
    reopened.db.close();

    await writeFile(resolvePrivatePath(root, 'ledger.sqlite-wal'), 'stale-wal');
    await writeFile(resolvePrivatePath(root, 'ledger.sqlite-shm'), 'stale-shm');
    await assert.rejects(() => restoreBackup(root, 'hot-backup', { allowOverwrite: true, confirmDatabaseClosed: true, _testFailurePhase: 'committed', _testSimulateCrash: true }), /Injected restore failure/);
    assert.deepEqual(await recoverInterruptedRestore(root), { recovered: true, outcome: 'new' });
    assert.equal(existsSync(resolvePrivatePath(root, 'ledger.sqlite-wal')), false, 'committed restore removes stale WAL');
    assert.equal(existsSync(resolvePrivatePath(root, 'ledger.sqlite-shm')), false, 'committed restore removes stale SHM');
    assert.equal(existsSync(resolvePrivatePath(root, 'observations.jsonl')), true, 'storage-v2 restore starts a fresh observation generation');
    assert.equal(await readFile(resolvePrivatePath(root, 'observations.jsonl'), 'utf8'), '', 'fresh restored generation excludes prior ephemeral observations');
    reopened = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
    assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(selectStorageRecordsByUser(reopened.db, 'habits', 'owner').some((row) => row.id === 'baseline'), true);
    assert.equal(selectStorageRecordsByUser(reopened.db, 'habits', 'owner').some((row) => row.id === 'post-backup'), false, 'committed recovery keeps restored generation');
    reopened.db.close();

    const manifestPath = resolvePrivatePath(root, 'backups', 'hot-backup', 'manifest.json');
    const originalManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const liveHashBeforeTamper = await digest(resolvePrivatePath(root, 'ledger.sqlite'));
    const tamperedBase = { ...originalManifest, artifacts: [...originalManifest.artifacts, { name: '../evil', checksum: '0'.repeat(64), bytes: 0 }] };
    delete tamperedBase.manifest_checksum;
    const tampered = { ...tamperedBase, manifest_checksum: checksumJson({ kind: 'agent_experience_backup_manifest_v2', ...tamperedBase }) };
    await writeFile(manifestPath, canonicalJson(tampered));
    await assert.rejects(() => restoreBackup(root, 'hot-backup', { allowOverwrite: true, confirmDatabaseClosed: true }), /Unknown backup artifact/);
    assert.equal(await digest(resolvePrivatePath(root, 'ledger.sqlite')), liveHashBeforeTamper, 'prevalidation failure leaves live DB unchanged');
    await writeFile(manifestPath, canonicalJson(originalManifest));

    const backupLedger = resolvePrivatePath(root, 'backups', 'hot-backup', 'ledger.sqlite');
    const savedLedger = resolvePrivatePath(root, 'backups', 'hot-backup', 'ledger.saved');
    await copyFile(backupLedger, savedLedger);
    await rm(backupLedger);
    await symlink(savedLedger, backupLedger);
    await assert.rejects(() => prevalidateBackup(root, 'hot-backup'), /symlink/i);
    await rm(backupLedger);
    await copyFile(savedLedger, backupLedger);
    await rm(savedLedger);

    const outside = join(parent, 'outside-sidecar');
    await writeFile(outside, 'outside');
    await symlink(outside, resolvePrivatePath(root, 'ledger.sqlite-wal'));
    await assert.rejects(() => restoreBackup(root, 'hot-backup', { allowOverwrite: true, confirmDatabaseClosed: true }), /symlink/i);
    await rm(resolvePrivatePath(root, 'ledger.sqlite-wal'));
    assert.equal(await digest(resolvePrivatePath(root, 'ledger.sqlite')), liveHashBeforeTamper, 'symlink target rejection leaves live DB unchanged');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

await assertFutureSchemaImmutable();
await assertV5MigrationAndCurrentVerification();
await assertBackupRestoreHardening();
console.log('agent-experience phase11 storage hardening checks passed');
