#!/usr/bin/env node
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getAgentExperiencePaths, readAgentExperienceConfig, setAgentExperienceEnabled, setAgentExperienceSelectorEnabled } from '../extensions/agent-experience/src/paths.ts';
import { ensurePrivateRoot } from '../extensions/agent-experience/src/storage/private-root.ts';
import { initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { readConfiguredLawSnapshot } from '../extensions/agent-experience/src/review.ts';
import { filterEligibleSelectorCandidates, selectActiveSelectorSnapshot } from '../extensions/agent-experience/src/selector.ts';
import { prepareSelectorConditionVectors } from '../extensions/agent-experience/src/selector-vector.ts';
import { createLocalEmbeddingAdapter } from '../extensions/agent-experience/src/semantic/local-adapter.ts';
import { getLocalEmbeddingAssetStatus } from '../extensions/agent-experience/src/semantic/local-model.ts';

const root = resolve(process.argv[2] || '');
if (!root) throw new Error('usage: seed-steering-tui-smoke.mjs STATE_ROOT');
process.env.AX_STATE_ROOT = root;
process.env.AX_USER_ID = 'owner';
const paths = getAgentExperiencePaths();
await ensurePrivateRoot(paths.root);
const assetSourceRoot = process.env.AX_SELECTOR_MODEL_SOURCE_ROOT ? resolve(process.env.AX_SELECTOR_MODEL_SOURCE_ROOT) : undefined;
let assetStatus = await getLocalEmbeddingAssetStatus(paths.root, { deep: true });
if (!assetStatus.ready && assetSourceRoot) {
  await mkdir(join(paths.root, 'models'), { recursive: true, mode: 0o700 });
  await cp(join(assetSourceRoot, 'models', 'local-embedding'), join(paths.root, 'models', 'local-embedding'), { recursive: true, force: false });
  assetStatus = await getLocalEmbeddingAssetStatus(paths.root, { deep: true });
}
if (!assetStatus.ready) throw new Error('steering smoke requires prepared local assets; set AX_SELECTOR_MODEL_SOURCE_ROOT');
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
  const embedding = createLocalEmbeddingAdapter(paths.root, { idleMs: 300_000 });
  try {
    const active = filterEligibleSelectorCandidates(selectActiveSelectorSnapshot(storage.db, { userId: 'owner' }), { minConfidenceBp: 7500, stalenessMax: 0.8 });
    await prepareSelectorConditionVectors(storage.db, { userId: 'owner', candidates: active, embeddingAdapter: embedding, now: '2026-07-10T18:10:00.000Z' });
  } finally {
    await embedding.close();
  }
  if (storage.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('seeded steering smoke ledger failed integrity check');
} finally {
  storage.db.close();
}
console.log('steering smoke state seeded');
