#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTypedStorageRow, initExperienceStorage, openExistingExperienceStorage, insertStorageRecord, selectStorageRecordsByUser } from '../extensions/agent-experience/src/storage/sqlite.ts';
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
    downgradeFixture.exec('PRAGMA journal_mode=DELETE; DELETE FROM migrations WHERE version=8; PRAGMA user_version=7;');
    downgradeFixture.close();

    const migrated = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.deepEqual(selectStorageRecordsByUser(migrated.db, 'habits', 'owner').map((row) => row.id), ['v5-preserved']);
    assert.equal(migrated.db.prepare('SELECT COUNT(*) AS count FROM migrations WHERE version=8').get().count, 1);
    migrated.db.close();

    const second = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
    assert.equal(second.db.prepare('SELECT COUNT(*) AS count FROM migrations WHERE version=8').get().count, 1, 'migration rerun is idempotent');
    assert.deepEqual(selectStorageRecordsByUser(second.db, 'habits', 'owner').map((row) => row.id), ['v5-preserved']);
    second.db.close();

    const malformedParent = await mkdtemp(join(tmpdir(), 'agent-experience-malformed-current-'));
    const malformedRoot = await ensurePrivateRoot(join(malformedParent, 'state'));
    const malformedPath = resolvePrivatePath(malformedRoot, 'ledger.sqlite');
    const malformed = new DatabaseSync(malformedPath);
    malformed.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); PRAGMA user_version=8;');
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
    assert.equal(validated.storageSchemaVersion, 8);
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

function insertHabitAudit(db, { id, targetId, action, before, after = before, data = {}, createdAt, tamperChecksum = false }) {
  const base = {
    user_id: 'owner',
    target_kind: 'habit',
    target_id: targetId,
    action,
    before_json: canonicalJson(before),
    after_json: canonicalJson(after),
    data_json: canonicalJson(data),
    created_at: createdAt,
  };
  const checksum = tamperChecksum ? 'tampered' : checksumJson({ table: 'experience_review_audit', row: base });
  db.prepare('INSERT INTO experience_review_audit (id,user_id,target_kind,target_id,action,before_json,after_json,data_json,checksum,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, base.user_id, base.target_kind, base.target_id, base.action, base.before_json, base.after_json, base.data_json, checksum, base.created_at);
}

function damageHabit(db, before, patch, updatedAt) {
  const damaged = buildTypedStorageRow('habits', { id: before.id, userId: before.user_id, data: { ...JSON.parse(before.data_json), ...patch, status: before.status }, createdAt: before.created_at, updatedAt });
  db.prepare("UPDATE habits SET record_kind=?,schema_version=?,status=?,habit_id=?,condition=?,behavior=?,polarity=?,confidence_bp=?,activation=?,staleness=?,data_json=?,checksum=?,updated_at=? WHERE id=?")
    .run(damaged.record_kind, damaged.schema_version, damaged.status, damaged.habit_id, damaged.condition, damaged.behavior, damaged.polarity, damaged.confidence_bp, damaged.activation, damaged.staleness, damaged.data_json, damaged.checksum, damaged.updated_at, damaged.id);
}

async function assertDamagedApprovedHabitRecovery() {
  const { parent, root } = await newRoot('agent-experience-damaged-habit-');
  try {
    const initial = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
    insertStorageRecord(initial.db, 'habits', {
      id: 'damaged-approved',
      userId: 'owner',
      data: {
        record_kind: 'habit_candidate_v1',
        schema_version: 1,
        status: 'candidate',
        condition: 'When validating storage recovery',
        behavior: 'Restore the exact verified habit wording.',
        polarity: 1,
        confidence_bp: 9100,
        review_status: 'approved_pending_eligibility',
        approved_identity: {
          candidate_id: 'damaged-approved',
          condition: 'when validating storage recovery',
          behavior: 'restore the exact verified habit wording.',
          polarity: 1,
        },
      },
      now: '2026-08-31T08:00:00.000Z',
    });
    const before = initial.db.prepare("SELECT * FROM habits WHERE id='damaged-approved'").get();
    insertHabitAudit(initial.db, { id: 'pre-damage', targetId: before.id, action: 'promotion_semantic_blocked', before, createdAt: '2026-08-31T08:01:00.000Z' });
    damageHabit(initial.db, before, {}, '2026-08-31T08:02:00.000Z');

    insertStorageRecord(initial.db, 'habits', {
      id: 'damaged-reapproval',
      userId: 'owner',
      data: {
        record_kind: 'habit_candidate_v1', schema_version: 1, status: 'candidate',
        condition: 'When recovering reapproval damage', behavior: 'Recover from the verified reapproval audit.', polarity: 1, confidence_bp: 9000,
        review_status: 'approved_pending_eligibility',
        approved_identity: { candidate_id: 'damaged-reapproval', condition: 'when recovering reapproval damage', behavior: 'recover from the verified reapproval audit.', polarity: 1 },
      },
      now: '2026-08-31T08:03:00.000Z',
    });
    const reapprovalBefore = initial.db.prepare("SELECT * FROM habits WHERE id='damaged-reapproval'").get();
    const reapprovalIdentity = JSON.parse(reapprovalBefore.data_json).approved_identity;
    insertHabitAudit(initial.db, { id: 'pre-reapproval-damage', targetId: reapprovalBefore.id, action: 'promotion_requires_reapproval', before: reapprovalBefore, data: { approved_identity: reapprovalIdentity }, createdAt: '2026-08-31T08:04:00.000Z' });
    damageHabit(initial.db, reapprovalBefore, { approved_identity: null, approval_invalidated: { reason: 'material_identity_change' }, review_status: 'candidate_reapproval_required' }, '2026-08-31T08:05:00.000Z');

    insertStorageRecord(initial.db, 'habits', {
      id: 'damaged-tampered-audit', userId: 'owner',
      data: { record_kind: 'habit_candidate_v1', schema_version: 1, status: 'candidate', condition: 'When audit integrity fails', behavior: 'Quarantine instead of trusting the audit.', polarity: 1, confidence_bp: 9000, review_status: 'approved_pending_eligibility', approved_identity: { candidate_id: 'damaged-tampered-audit', condition: 'when audit integrity fails', behavior: 'quarantine instead of trusting the audit.', polarity: 1 } },
      now: '2026-08-31T08:06:00.000Z',
    });
    const tamperedBefore = initial.db.prepare("SELECT * FROM habits WHERE id='damaged-tampered-audit'").get();
    insertHabitAudit(initial.db, { id: 'tampered-audit', targetId: tamperedBefore.id, action: 'promotion_semantic_blocked', before: tamperedBefore, createdAt: '2026-08-31T08:07:00.000Z', tamperChecksum: true });
    damageHabit(initial.db, tamperedBefore, {}, '2026-08-31T08:08:00.000Z');

    initial.db.prepare("INSERT INTO habits (id,user_id,record_kind,schema_version,status,habit_id,condition,behavior,polarity,confidence_bp,activation,staleness,data_json,checksum,created_at,updated_at) VALUES ('damaged-malformed','owner','legacy_record_v1',1,'candidate',NULL,NULL,NULL,0,0,0,0,'{','invalid','2026-08-31T08:09:00.000Z','2026-08-31T08:09:00.000Z')").run();
    initial.db.exec('DELETE FROM migrations WHERE version=8; PRAGMA user_version=7;');
    initial.db.close();

    const recovered = await openExistingExperienceStorage(root, { userId: 'owner' });
    const row = recovered.db.prepare("SELECT * FROM habits WHERE id='damaged-approved'").get();
    assert.equal(row.condition, before.condition);
    assert.equal(row.behavior, before.behavior);
    assert.equal(row.polarity, before.polarity);
    assert.equal(row.confidence_bp, before.confidence_bp);
    assert.equal(row.record_kind, before.record_kind);
    assert.equal(recovered.db.prepare("SELECT COUNT(*) count FROM experience_review_audit WHERE target_id='damaged-approved' AND action='repair_damaged_habit_typed_fields'").get().count, 1);
    const recoveredReapproval = recovered.db.prepare("SELECT * FROM habits WHERE id='damaged-reapproval'").get();
    assert.equal(recoveredReapproval.condition, reapprovalBefore.condition, 'recovery must use the verified reapproval audit when approved_identity was cleared');
    assert.equal(recoveredReapproval.behavior, reapprovalBefore.behavior);
    assert.equal(recovered.db.prepare("SELECT condition FROM habits WHERE id='damaged-tampered-audit'").get().condition, null, 'tampered audit checksum must never be trusted');
    assert.equal(recovered.db.prepare("SELECT COUNT(*) count FROM pending_review WHERE kind='damaged_habit_recovery' AND id IN ('damaged-habit-recovery:owner:damaged-tampered-audit','damaged-habit-recovery:owner:damaged-malformed')").get().count, 2, 'bad audit and malformed row must quarantine without blocking ledger open');
    assert.equal(recovered.db.prepare('PRAGMA user_version').get().user_version, 8);
    recovered.db.close();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}


await assertFutureSchemaImmutable();
await assertV5MigrationAndCurrentVerification();
await assertBackupRestoreHardening();
await assertDamagedApprovedHabitRecovery();
console.log('agent-experience phase11 storage hardening checks passed');
