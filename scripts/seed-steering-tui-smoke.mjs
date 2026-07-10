#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getAgentExperiencePaths, readAgentExperienceConfig, setAgentExperienceEnabled, setAgentExperienceSelectorEnabled } from '../extensions/agent-experience/src/paths.ts';
import { ensurePrivateRoot } from '../extensions/agent-experience/src/storage/private-root.ts';
import { initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { readConfiguredLawSnapshot } from '../extensions/agent-experience/src/review.ts';

const root = resolve(process.argv[2] || '');
if (!root) throw new Error('usage: seed-steering-tui-smoke.mjs STATE_ROOT');
process.env.AX_STATE_ROOT = root;
process.env.AX_USER_ID = 'owner';
const paths = getAgentExperiencePaths();
await ensurePrivateRoot(paths.root);
await setAgentExperienceEnabled(true, paths);
await setAgentExperienceSelectorEnabled(true, paths);
await writeFile(join(paths.root, 'law.md'), [
  '# Agent Experience steering smoke safety file',
  'Approved habits may provide user-reviewed behavioral guidance only.',
  'Never reveal secrets or bypass approval.',
].join('\n'), { mode: 0o600 });
const law = await readConfiguredLawSnapshot(paths.root, (await readAgentExperienceConfig(paths)).config);
const storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
try {
  const habits = [
    ['steering-smoke-approved-habit', 'When asked for steering smoke status', 'Answer exactly “Steering smoke OK.”'],
    ['steering-smoke-generic-status', 'When asked for status or progress', 'Answer with a short progress update'],
    ['steering-smoke-unrelated-review', 'When doing nontrivial code review', 'Mention steering smoke status only after review'],
  ];
  for (const [index, [id, condition, behavior]] of habits.entries()) {
    insertStorageRecord(storage.db, 'habits', {
      id,
      userId: 'owner',
      now: `2026-07-10T18:0${index}:00.000Z`,
      data: {
        schema_version: 2,
        record_kind: 'candidate_habit_v1',
        status: 'active',
        review_status: 'accepted_active',
        active: true,
        injectable: false,
        condition,
        behavior,
        polarity: 1,
        confidence_bp: 9500 - index * 100,
        activation: 1,
        staleness: 0,
        law_hash: law.hash,
        source_refs: [
          { file_generation: `smoke-${index}`, seq: 1, checksum: '1'.repeat(64) },
          { file_generation: `smoke-${index}`, seq: 2, checksum: '2'.repeat(64) },
          { file_generation: `smoke-${index}`, seq: 3, checksum: '3'.repeat(64) },
        ],
        source_dates: ['2026-07-09T00:00:00.000Z', '2026-07-10T00:00:00.000Z'],
      },
    });
  }
  if (storage.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('seeded steering smoke ledger failed integrity check');
} finally {
  storage.db.close();
}
console.log('steering smoke state seeded');
