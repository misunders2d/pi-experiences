#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension from '../extensions/agent-experience/index.ts';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG, formatAgentExperienceConfig, parseAgentExperienceConfig } from '../extensions/agent-experience/src/config.ts';
import { collectAgentExperienceMetrics } from '../extensions/agent-experience/src/metrics.ts';
import { createBackup, restoreBackup } from '../extensions/agent-experience/src/storage/backup.ts';
import { canonicalJson } from '../extensions/agent-experience/src/storage/checksum.ts';
import { ensurePrivateRoot } from '../extensions/agent-experience/src/storage/private-root.ts';
import { initExperienceStorage, insertStorageRecord, selectStorageRecordsByUser } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { observationChecksumForTest, observationPairRefForTest } from '../extensions/agent-experience/src/storage/observations.ts';
import { validateObservationRecords } from '../extensions/agent-experience/src/consolidate/observations.ts';
import { acquireConsolidationLock, runConsolidationOnce } from '../extensions/agent-experience/src/consolidate/runner.ts';
import { lawSnapshotForTest } from '../extensions/agent-experience/src/review.ts';
import { filterEligibleSelectorCandidates, runSelectorRuntime, selectActiveSelectorSnapshot } from '../extensions/agent-experience/src/selector.ts';
import { prepareSelectorConditionVectors } from '../extensions/agent-experience/src/selector-vector.ts';
import { LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_PROVIDER } from '../extensions/agent-experience/src/semantic/local-model-manifest.ts';

const execFileAsync = promisify(execFile);

function refs(count = 3, generation = 'phase7b8') {
  return Array.from({ length: count }, (_, index) => ({ file_generation: generation, seq: index + 1, checksum: String(index + 1).repeat(64).slice(0, 64) }));
}

function habitData(overrides = {}) {
  return {
    schema_version: 2,
    record_kind: 'candidate_habit_v1',
    status: 'active',
    active: true,
    injectable: false,
    condition: 'answering phase seven selector questions',
    behavior: 'use lexical guidance',
    polarity: 1,
    confidence_bp: 9000,
    activation: 1,
    staleness: 0,
    source_refs: refs(3),
    source_dates: ['2026-07-06T00:00:00.000Z', '2026-07-06T01:00:00.000Z', '2026-07-07T00:00:00.000Z'],
    ...overrides,
  };
}

function makeObservation({ seq, previous = null, safe, createdAt = `2026-07-08T00:0${seq}:00.000Z` }) {
  const base = {
    id: `obs-${seq}`,
    seq,
    user_id: 'owner',
    origin: { source: 'test', command: 'phase7b8' },
    prev_pair_ref: previous ? observationPairRefForTest(previous) : null,
    payload_redacted: { kind: 'conversation_pair_v1', safe, redacted_fixture: true },
    created_at: createdAt,
  };
  return { ...base, checksum: observationChecksumForTest(base) };
}

function modelOutput(records, overrides = {}) {
  return {
    schema_version: 1,
    user_id: 'owner',
    file_generation: 'active',
    batch_id: overrides.batch_id || 'phase7b8-batch',
    model: overrides.model || 'openai-codex/gpt-5.5',
    created_at: overrides.created_at || '2026-07-08T01:00:00.000Z',
    observations_read: overrides.observations_read || { seq_start: records[0].seq, seq_end: records.at(-1).seq, checksum: records.at(-1).checksum },
    proposals: overrides.proposals ?? [{
      proposal_id: 'phase7b8-proposal-1',
      kind: 'habit_candidate',
      candidate_key: 'phase7b8-concise',
      condition: 'When reviewing phase seven work',
      behavior: 'Preserve exact evidence gates',
      polarity: 1,
      confidence_bp: 8800,
      source_refs: records.map((record) => ({ file_generation: record.file_generation, seq: record.seq, checksum: record.checksum })),
      evidence_summary: 'redacted evidence summary',
    }],
  };
}

function counts(db) {
  return Object.fromEntries(['habits', 'evidence', 'pending_review', 'model_output_quarantine', 'consolidation_audit', 'consolidation_watermarks', 'proposal_read_watermarks', 'selector_hit_log'].map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
}

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
  return { commands, handlers };
}

const parsed = parseAgentExperienceConfig(`
selector_model = "flat/model"
selector_timeout_ms = 2000
selector.mode = "smart"
[selector]
model = "zai/glm-5.2"
timeout_ms = 5000
min_overlap_score = 2
`, { AX_SELECTOR_MODE: 'instant', AX_SELECTOR_TIMEOUT_MS: '4500' });
assert.equal(parsed.selector_mode, 'instant', 'env mode wins over section/dotted/flat/default');
assert.equal(parsed.selector_model, 'zai/glm-5.2', 'section selector model wins over flat key');
assert.equal(parsed.selector_timeout_ms, 4500, 'env timeout wins over section timeout');
assert.equal(parsed.selector_min_overlap_score, 2, 'legacy lexical key remains readable but is ignored by runtime');
const rewrittenConfig = formatAgentExperienceConfig(parsed);
assert.doesNotMatch(rewrittenConfig, /^(?:selector_mode|selector_min_overlap_score)\s*=/m, 'config rewrite must remove obsolete lexical controls');

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase7b8-'));
process.env.AX_STATE_ROOT = join(temp, 'state');
delete process.env.AX_SELECTOR_MODE;
const root = await ensurePrivateRoot(process.env.AX_STATE_ROOT);
const storage = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
try {
  const law = lawSnapshotForTest('phase7b8 law');
  insertStorageRecord(storage.db, 'habits', { id: 'active-good', userId: 'owner', data: habitData({ law_hash: law.hash }), now: '2026-07-08T00:00:00.000Z' });
  insertStorageRecord(storage.db, 'habits', { id: 'active-zero-overlap', userId: 'owner', data: habitData({ condition: 'completely different topic', behavior: 'never match', law_hash: law.hash, confidence_bp: 10000, activation: 99 }), now: '2026-07-08T00:01:00.000Z' });
  insertStorageRecord(storage.db, 'habits', { id: 'candidate-hidden', userId: 'owner', data: habitData({ status: 'candidate', condition: 'phase seven selector', behavior: 'must not inject', law_hash: law.hash }), now: '2026-07-08T00:02:00.000Z' });
  const unit = (index) => { const vector = new Float32Array(LOCAL_EMBEDDING_DIMENSIONS); vector[index] = 1; return vector; };
  const vectorGood = unit(0);
  const vectorOther = unit(1);
  const vectorUnrelated = unit(2);
  const embeddingAdapter = {
    id: `${LOCAL_EMBEDDING_PROVIDER}:${LOCAL_EMBEDDING_MODEL}:${LOCAL_EMBEDDING_DIMENSIONS}`,
    provider: LOCAL_EMBEDDING_PROVIDER,
    model: LOCAL_EMBEDDING_MODEL,
    dimensions: LOCAL_EMBEDDING_DIMENSIONS,
    async embed(texts) { return texts.map((text) => /phase seven selector/i.test(String(text)) ? vectorGood : /completely different/i.test(String(text)) ? vectorOther : vectorUnrelated); },
  };
  const eligible = filterEligibleSelectorCandidates(selectActiveSelectorSnapshot(storage.db, { userId: 'owner' }), { minConfidenceBp: 7500, stalenessMax: 0.8 });
  await prepareSelectorConditionVectors(storage.db, { userId: 'owner', candidates: eligible, embeddingAdapter, now: '2026-07-08T01:30:00.000Z' });
  let adapterCalls = 0;
  const legacyModeConfig = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, selector_enabled: true, selector_mode: 'instant', selector_min_confidence_bp: 7500, selector_min_overlap_score: 2, selector_staleness_max: 0.8 };
  const judged = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'phase seven selector questions', config: legacyModeConfig, law, now: '2026-07-08T02:00:00.000Z', embeddingAdapter, adapter: { async select({ candidateIds }) { adapterCalls += 1; return { schema_version: 3, judgments: candidateIds.map((id) => id === 'active-good' ? { id, applicable: true, confidence_bp: 9000, reason: 'current_applicability' } : { id, applicable: false, confidence_bp: 9000, reason: 'not_currently_relevant' }) }; } } });
  assert.equal(judged.injected, true);
  assert.equal(judged.mode, 'vector_judge', 'legacy instant mode must not restore lexical-only selection');
  assert.equal(adapterCalls, 1, 'mandatory judge runs after vectors even when legacy config says instant');
  assert.equal(JSON.stringify(storage.db.prepare('SELECT data_json FROM selector_hit_log').all()).includes('lexical'), false);
  const silent = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'unrelated words only', config: legacyModeConfig, law, now: '2026-07-08T02:01:00.000Z', embeddingAdapter, adapter: { async select() { adapterCalls += 1; throw new Error('below-floor request must not call judge'); } } });
  assert.equal(silent.injected, false, 'vector floor preserves silence-default');
  assert.equal(silent.reason, 'no_vector_candidates');
  assert.equal(adapterCalls, 1);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM selector_hit_log WHERE user_id = ? AND action = 'inject' AND selected = 1").get('owner').count, 1);
  const configuredModel = await runSelectorRuntime(storage.db, { userId: 'owner', prompt: 'phase seven selector questions', config: { ...legacyModeConfig, selector_mode: 'smart', selector_model: 'zai/glm-5.2' }, law, now: '2026-07-08T02:03:00.000Z', embeddingAdapter, adapter: { async select({ model, candidateIds }) { adapterCalls += 1; assert.equal(model, 'zai/glm-5.2'); return { schema_version: 3, judgments: candidateIds.map((id) => id === 'active-good' ? { id, applicable: true, confidence_bp: 9000, reason: 'current_applicability' } : { id, applicable: false, confidence_bp: 9000, reason: 'not_currently_relevant' }) }; } } });
  assert.equal(configuredModel.injected, true);
  assert.equal(configuredModel.mode, 'vector_judge');
  assert.equal(adapterCalls, 2);

  const metrics = collectAgentExperienceMetrics(storage.db, { userId: 'owner' });
  assert.equal(metrics.selector_hits_by_mode.vector_judge.inject >= 2, true);
  assert.equal(metrics.skip_timeout_no_injection_counts, 'unavailable_without_aggregate_metrics_table');
  assert.equal(canonicalJson(metrics).includes('phase seven selector questions'), false);

  const { commands } = makePi();
  const notes = [];
  const previousHome = process.env.HOME;
  process.env.HOME = join(temp, 'isolated-home');
  try {
    await commands.get('experience').handler('status', { cwd: process.cwd(), ui: { notify(message) { notes.push(message); } } });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.match(notes.at(-1), /Experience: OFF/);
  assert.match(notes.at(-1), /Analyze saved examples now: available when you choose it in setup/);
  assert.match(notes.at(-1), /Automatic schedule: OFF/);
  await commands.get('experience').handler('help', { cwd: process.cwd(), ui: { notify(message) { notes.push(message); } } });
  assert.match(notes.at(-1), /Discuss a pattern naturally/);
  assert.match(notes.at(-1), /\/experience setup as the complete control panel/);
  assert.doesNotMatch(notes.at(-1), /setup model|setup analyze-now|setup review|setup use-habits/);
  await commands.get('experience').handler('selector calibrate', { cwd: process.cwd(), ui: { notify(message) { notes.push(message); } } });
  assert.match(notes.at(-1), /Manual calibration/);
  assert.match(notes.at(-1), /No recurring reminder is enabled/);

  const r1 = makeObservation({ seq: 1, safe: 'prefers exact evidence gates' });
  const r2 = makeObservation({ seq: 2, previous: r1, safe: 'asks for range checks' });
  const observations = validateObservationRecords({ records: [r1, r2], userId: 'owner', fileGeneration: 'active' });
  await writeFile(join(root, 'observations.jsonl'), observations.map((record) => {
    const { file_generation, ...rest } = record;
    return JSON.stringify(rest);
  }).join('\n') + '\n', 'utf8');
  const output = modelOutput(observations);
  const fixture = join(temp, 'model-output.json');
  await writeFile(fixture, JSON.stringify(output), 'utf8');
  const beforeDry = counts(storage.db);
  const dry = await runConsolidationOnce({ root, db: storage.db, userId: 'owner', observations, modelOutput: output, model: 'openai-codex/gpt-5.5', dryRun: true, now: '2026-07-08T03:00:00.000Z' });
  assert.equal(dry.ok, true);
  assert.equal(dry.dry_run, true);
  assert.deepEqual(counts(storage.db), beforeDry, 'dry-run must make zero durable mutations');
  const dryBadSource = await runConsolidationOnce({ root, db: storage.db, userId: 'owner', observations, modelOutput: modelOutput(observations, { batch_id: 'dry-bad-source', proposals: [{ ...modelOutput(observations).proposals[0], source_refs: observations.map((record) => ({ file_generation: record.file_generation, seq: record.seq, checksum: '0'.repeat(64) })) }] }), model: 'openai-codex/gpt-5.5', dryRun: true, now: '2026-07-08T03:01:00.000Z' });
  assert.equal(dryBadSource.ok, false, 'dry-run must reject forged source ref checksums');
  assert.match(dryBadSource.reason, /checksum/i);

  for (const [label, read] of [
    ['shrunk', { seq_start: 1, seq_end: 1, checksum: observations[0].checksum }],
    ['expanded', { seq_start: 1, seq_end: 3, checksum: observations.at(-1).checksum }],
    ['shifted', { seq_start: 2, seq_end: 2, checksum: observations.at(-1).checksum }],
  ]) {
    const bad = await runConsolidationOnce({ root, db: storage.db, userId: 'owner', observations, modelOutput: modelOutput(observations, { batch_id: `bad-${label}`, observations_read: read }), model: 'openai-codex/gpt-5.5', dryRun: false, now: `2026-07-08T03:0${label.length}:00.000Z` });
    assert.equal(bad.ok, false, label);
    assert.equal(bad.quarantined, true, label);
  }
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS count FROM model_output_quarantine WHERE user_id = ?').get('owner').count, 3, 'all range mismatch shapes quarantined');
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS count FROM proposal_read_watermarks WHERE user_id = ?').get('owner').count, 0, 'range mismatch must not advance read watermark');

  const lock = await acquireConsolidationLock(root, { owner: 'test' });
  try {
    await assert.rejects(() => runConsolidationOnce({ root, db: storage.db, userId: 'owner', observations, modelOutput: output, model: 'openai-codex/gpt-5.5', dryRun: false }), /consolidation_lock_active/);
  } finally {
    await lock.release();
  }

  const commit = await runConsolidationOnce({ root, db: storage.db, userId: 'owner', observations, modelOutput: modelOutput(observations, { batch_id: 'commit-ok' }), model: 'openai-codex/gpt-5.5', dryRun: false, now: '2026-07-08T03:30:00.000Z' });
  assert.equal(commit.ok, true);
  assert.equal(commit.dry_run, false);
  assert.equal(storage.db.prepare('SELECT seq FROM proposal_read_watermarks WHERE user_id = ? AND file_generation = ?').get('owner', 'active').seq, 2);

  storage.db.close();
  const backup = await createBackup(root, { backupId: 'phase7b8-before-extra', createdAt: '2026-07-08T04:00:00.000Z' });
  assert.ok(backup.manifest.artifacts.some((artifact) => artifact.name === 'ledger.sqlite'));
  const reopened = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
  insertStorageRecord(reopened.db, 'habits', { id: 'rollback-extra', userId: 'owner', data: habitData({ condition: 'rollback extra', behavior: 'remove after restore' }), now: '2026-07-08T04:01:00.000Z' });
  assert.equal(selectStorageRecordsByUser(reopened.db, 'habits', 'owner').some((row) => row.id === 'rollback-extra'), true);
  reopened.db.close();
  await restoreBackup(root, 'phase7b8-before-extra', { allowOverwrite: true, confirmDatabaseClosed: true });
  const restored = await initExperienceStorage(root, { allowInit: true, userId: 'owner' });
  assert.equal(selectStorageRecordsByUser(restored.db, 'habits', 'owner').some((row) => row.id === 'rollback-extra'), false, 'rollback restore removes post-backup selector-visible state');
  restored.db.close();
  assert.equal(await readFile(join(root, 'observations.jsonl'), 'utf8'), '', 'privacy-first rollback starts a fresh generation without retained source text');
  await rm(join(root, 'observations-tail.json'), { force: true });
  await rm(join(root, 'observations.idx'), { force: true });
  await writeFile(join(root, 'observations.jsonl'), observations.map((record) => {
    const { file_generation, ...rest } = record;
    return JSON.stringify(rest);
  }).join('\n') + '\n', 'utf8');

  await assert.rejects(() => execFileAsync(process.execPath, ['--experimental-strip-types', './bin/experience-consolidate.mjs', 'now', '--dry-run', '--fixture-output', fixture, '--root', root], { cwd: process.cwd() }), /learning_disabled/);
  await writeFile(join(root, 'agent-experience.toml'), formatAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, consolidation_enabled: true }), 'utf8');
  const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', './bin/experience-consolidate.mjs', 'now', '--dry-run', '--fixture-output', fixture, '--root', root], { cwd: process.cwd() });
  assert.match(stdout, /"dry_run": true/);
  assert.equal(existsSync(join(root, '.consolidate.lock')), false, 'CLI dry-run must not leave lock');

  const service = await readFile('extensions/agent-experience/units/experience-consolidate.service', 'utf8');
  const timer = await readFile('extensions/agent-experience/units/experience-consolidate.timer', 'utf8');
  assert.match(service, /Type=oneshot/);
  assert.match(service, / scheduled --root /);
  assert.match(service, / --pi-runtime-root @PI_RUNTIME_ROOT@/);
  assert.doesNotMatch(service, /exit 1|\/usr\/bin\/env/);
  assert.match(timer, /OnCalendar=\*-\*-\* 03:30:00/);
  assert.match(timer, /Persistent=true/);
  assert.doesNotMatch(timer, /RandomizedDelaySec|ConditionACPower/);
  assert.equal(existsSync(join(temp, '.config/systemd/user/pi-experiences-agent-experience-analyze.timer')), false, 'tests/package must not install systemd timer');
} finally {
  try { storage.db.close(); } catch {}
  await rm(temp, { recursive: true, force: true });
  delete process.env.AX_STATE_ROOT;
}

console.log('agent-experience phase7b8 checks passed');
