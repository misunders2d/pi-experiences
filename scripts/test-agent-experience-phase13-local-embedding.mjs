#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseAgentExperienceConfig } from '../extensions/agent-experience/src/config.ts';
import { buildContextualRetrievalPrompt, SELECTOR_CONTEXT_RETRIEVAL_MAX_UTF8_BYTES } from '../extensions/agent-experience/src/selector.ts';
import { cosineBp, effectiveFieldSimilarityBp, habitBehaviorEmbeddingInputV1, habitConditionEmbeddingInputV1 } from '../extensions/agent-experience/src/semantic/core.ts';
import { createEmbeddingAdapterFromConfig, semanticPolicyFromConfig } from '../extensions/agent-experience/src/semantic/config.ts';
import { createLocalEmbeddingAdapter } from '../extensions/agent-experience/src/semantic/local-adapter.ts';
import { ensureLocalEmbeddingAssets, getLocalEmbeddingAssetStatus, removeLocalEmbeddingAssets } from '../extensions/agent-experience/src/semantic/local-model.ts';
import { LOCAL_EMBEDDING_ASSETS, LOCAL_EMBEDDING_DOWNLOAD_BYTES, LOCAL_EMBEDDING_MAX_MANAGED_BYTES, LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP, LOCAL_EMBEDDING_STRONG_THRESHOLD_BP } from '../extensions/agent-experience/src/semantic/local-model-manifest.ts';

assert.equal(LOCAL_EMBEDDING_DOWNLOAD_BYTES, 148_618_669, 'public about-150-MB wording must match the exact pinned asset manifest');
assert.ok(LOCAL_EMBEDDING_DOWNLOAD_BYTES > 100_000_000 && LOCAL_EMBEDDING_DOWNLOAD_BYTES < LOCAL_EMBEDDING_MAX_MANAGED_BYTES, 'pinned local assets must stay within managed footprint cap');
assert.equal(LOCAL_EMBEDDING_ASSETS.length, 5);
assert.ok(LOCAL_EMBEDDING_ASSETS.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256) && asset.bytes > 0), 'every managed asset must be size/hash pinned');
assert.equal(parseAgentExperienceConfig('embedding_enabled = false\nembedding_provider = "hosted"\nembedding_model = "remote"\n').embedding_enabled, false, 'legacy hosted fields must be ignored');
assert.equal(createEmbeddingAdapterFromConfig(parseAgentExperienceConfig('embedding_enabled = false\n'), '/tmp/unused-local-model-root'), undefined, 'disabled mode must not start or fetch local assets');
const policy = semanticPolicyFromConfig(parseAgentExperienceConfig('embedding_enabled = true\n'));
assert.equal(policy.reviewThresholdBp, LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP);

const missingRoot = await mkdtemp(join(tmpdir(), 'pi-experience-local-missing-'));
try {
  const missing = await getLocalEmbeddingAssetStatus(join(missingRoot, 'state'));
  assert.equal(missing.ready, false);
  const unavailable = createLocalEmbeddingAdapter(join(missingRoot, 'state'));
  await assert.rejects(() => unavailable.embed(['when testing\nfail closed']), /assets_unavailable/);
  await unavailable.close();
  const controller = new AbortController();
  controller.abort(new Error('fixture_cancelled'));
  await assert.rejects(() => ensureLocalEmbeddingAssets(join(missingRoot, 'cancelled'), {signal: controller.signal}), /fixture_cancelled/);
  const localDir = join(missingRoot, 'cancelled', 'models', 'local-embedding');
  const leftovers = await readdir(localDir).catch(() => []);
  assert.equal(leftovers.some((name) => name.startsWith('.staging-')), false, 'cancelled setup must remove staging files');

  const symlinkRoot = join(missingRoot, 'symlink-state');
  const outside = join(missingRoot, 'outside-cache');
  const outsideManagedName = join(outside, '.staging-must-survive');
  const outsideMarker = join(outsideManagedName, 'outside.txt');
  await mkdir(join(symlinkRoot, 'models'), {recursive: true, mode: 0o700});
  await mkdir(outsideManagedName, {recursive: true, mode: 0o700});
  await writeFile(outsideMarker, 'preserve', {mode: 0o600});
  await symlink(outside, join(symlinkRoot, 'models', 'local-embedding'), 'dir');
  await assert.rejects(() => removeLocalEmbeddingAssets(symlinkRoot), /symlinked local embedding path/);
  assert.equal(await readFile(outsideMarker, 'utf8'), 'preserve', 'removal must never follow a symlinked cache parent outside the private root');
} finally { await rm(missingRoot, {recursive: true, force: true}); }

const fixtureDir = process.env.AX_LOCAL_MODEL_FIXTURE_DIR;
const fixtureWasm = process.env.AX_LOCAL_ORT_WASM;
if (!fixtureDir || !fixtureWasm) {
  console.log('agent-experience phase13 local embedding unit checks passed (real asset fixture integration skipped)');
  process.exit(0);
}

const sources = {
  'model_int8.onnx': join(fixtureDir, 'onnx', 'model_int8.onnx'),
  'tokenizer.json': join(fixtureDir, 'tokenizer.json'),
  'tokenizer_config.json': join(fixtureDir, 'tokenizer_config.json'),
  'config.json': join(fixtureDir, 'config.json'),
  'ort-wasm-simd-threaded.wasm': fixtureWasm,
};
let fetchCount = 0;
const fetchImpl = async (url) => {
  fetchCount += 1;
  const source = sources[basename(new URL(url).pathname)];
  if (!source) return new Response('missing fixture', {status: 404});
  return new Response(Readable.toWeb(createReadStream(source)), {status: 200});
};
const temp = await mkdtemp(join(tmpdir(), 'pi-experience-local-real-'));
const root = join(temp, 'state');
try {
  const phases = [];
  const installed = await ensureLocalEmbeddingAssets(root, {fetchImpl, createdAt: '2026-07-10T00:00:00.000Z', onProgress: (progress) => phases.push(progress.phase)});
  assert.equal(installed.ready, true);
  assert.equal(fetchCount, LOCAL_EMBEDDING_ASSETS.length);
  assert.equal(phases.at(-1), 'ready');
  assert.equal((await stat(installed.assetDir)).mode & 0o777, 0o700);
  for (const asset of LOCAL_EMBEDDING_ASSETS) assert.equal((await stat(join(installed.assetDir, asset.name))).mode & 0o777, 0o600);
  await ensureLocalEmbeddingAssets(root, {fetchImpl});
  assert.equal(fetchCount, LOCAL_EMBEDDING_ASSETS.length, 'ready cache must work without another network request');

  const localDir = dirname(installed.assetDir);
  const interrupted = join(localDir, '.invalid-interrupted-install');
  await rename(installed.assetDir, interrupted);
  const recovered = await ensureLocalEmbeddingAssets(root, {fetchImpl});
  assert.equal(recovered.ready, true, 'a complete cache displaced by a hard crash must recover without redownload');
  assert.equal(fetchCount, LOCAL_EMBEDDING_ASSETS.length, 'interrupted-install recovery must remain offline');
  assert.equal((await readdir(localDir)).some((name) => name.startsWith('.invalid-')), false, 'recovery must remove invalid-transition leftovers');
  await mkdir(join(localDir, '.staging-abandoned'), {mode: 0o700});
  await mkdir(join(localDir, '.invalid-abandoned'), {mode: 0o700});
  await mkdir(join(localDir, 'multilingual-minilm-l12-int8-v0'), {mode: 0o700});
  await ensureLocalEmbeddingAssets(root, {fetchImpl});
  const cleanedEntries = await readdir(localDir);
  assert.equal(cleanedEntries.some((name) => name.startsWith('.staging-') || name.startsWith('.invalid-') || name === 'multilingual-minilm-l12-int8-v0'), false, 'ready-cache checks must clean crash/obsolete artifacts before they can accumulate beyond the footprint cap');
  assert.equal(fetchCount, LOCAL_EMBEDDING_ASSETS.length, 'stale artifact cleanup must not redownload a valid cache');

  const codeReview = {condition:'When reviewing code',behavior:'Identify concrete risks and recommend fixes.'};
  const handoff = {condition:'When a long-running task must continue in another session',behavior:'Record completed work, current status, unresolved blockers, and the exact next action so another agent can resume safely.'};
  const fixtures = [
    ['positive-code-en', codeReview, {condition:'During a code review',behavior:'Find specific failure modes and propose corrections.'}, true],
    ['positive-code-ru', codeReview, {condition:'При проверке кода',behavior:'Находить конкретные риски и предлагать исправления.'}, true],
    ['positive-code-es', codeReview, {condition:'Al revisar código',behavior:'Identificar riesgos concretos y recomendar correcciones.'}, true],
    ['positive-release-es', {condition:'Antes de publicar un paquete',behavior:'Ejecutar todas las pruebas y verificar el artefacto instalable.'}, {condition:'Al preparar una versión de software',behavior:'Completar la validación y probar el paquete final.'}, true],
    ['positive-handoff-conservative-false-negative', handoff, {condition:'At a context boundary during unfinished work',behavior:'Write a durable checkpoint covering what is done, what remains blocked, and where execution should continue.'}, true],
    ['positive-status-ru', {condition:'When reporting progress on ongoing work',behavior:'State whether work is done or blocked, give minimal evidence, and name the next action.'}, {condition:'При сообщении о ходе текущей работы',behavior:'Указать, завершена ли работа или заблокирована, привести краткие доказательства и назвать следующий шаг.'}, true],
    ['positive-code-de', codeReview, {condition:'Bei der Codeprüfung',behavior:'Konkrete Risiken erkennen und Korrekturen empfehlen.'}, true],
    ['positive-code-fr', codeReview, {condition:'Lors de la revue du code',behavior:'Identifier les risques concrets et recommander des corrections.'}, true],
    ['positive-code-zh', codeReview, {condition:'审查代码时',behavior:'识别具体风险并提出修复建议。'}, true],
    ['negative-breakfast', codeReview, {condition:'When preparing breakfast',behavior:'Choose fresh seasonal fruit.'}, false],
    ['negative-same-release-condition', {condition:'When preparing a software release',behavior:'Run the full validation suite and verify the installable package.'}, {condition:'When preparing a software release',behavior:'Write a concise public announcement and social media summary for users.'}, false],
    ['negative-identical-status-action', {condition:'When reporting task progress',behavior:'State current status and the next action.'}, {condition:'When checking live service health',behavior:'State current status and the next action.'}, false],
    ['negative-release-security', {condition:'When preparing a software release',behavior:'Run tests and verify the installable artifact.'}, {condition:'When reviewing security-sensitive code',behavior:'Identify concrete attack paths and recommend mitigations.'}, false],
    ['negative-setup-release', {condition:'When exposing user controls',behavior:'Keep one setup panel as the complete normal-user surface.'}, {condition:'When preparing a software release',behavior:'Run all checks against the final installable package.'}, false],
    ['negative-handoff-live-status', handoff, {condition:'When checking live service status',behavior:'Report the current state and immediate next action.'}, false],
    ['negative-cross-month-close', {condition:'When exposing user controls',behavior:'Keep one setup panel as the complete normal-user surface.'}, {condition:'При закрытии месяца',behavior:'Сверять банковские операции с бухгалтерским отчетом.'}, false],
  ];
  const texts = fixtures.flatMap(([, left, right]) => [habitConditionEmbeddingInputV1(left), habitBehaviorEmbeddingInputV1(left), habitConditionEmbeddingInputV1(right), habitBehaviorEmbeddingInputV1(right)]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline test forbids network'); };
  const adapter = createLocalEmbeddingAdapter(root, {idleMs: 100});
  try {
    const vectors = await adapter.embed(texts);
    assert.equal(vectors.length, texts.length);
    assert.ok(vectors.every((vector) => vector.length === 384));
    let expectedDuplicates = 0;
    let routedExpectedDuplicates = 0;
    let strongExpectedDuplicates = 0;
    fixtures.forEach(([name,,, duplicate], index) => {
      const base = index * 4;
      const conditionScore = cosineBp(vectors[base], vectors[base + 2]);
      const behaviorScore = cosineBp(vectors[base + 1], vectors[base + 3]);
      const score = effectiveFieldSimilarityBp(conditionScore, behaviorScore);
      if (duplicate) {
        expectedDuplicates += 1;
        if (score >= LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP) routedExpectedDuplicates += 1;
        if (score >= LOCAL_EMBEDDING_STRONG_THRESHOLD_BP) strongExpectedDuplicates += 1;
        if (name === 'positive-handoff-conservative-false-negative') assert.ok(score < LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP, `${name} score ${score} documents intentional precision-first false negative`);
        else assert.ok(score >= LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP, `${name} effective duplicate score ${score} (${conditionScore}/${behaviorScore}) must reach calibrated threshold`);
      } else assert.ok(score < LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP, `${name} effective distinct score ${score} (${conditionScore}/${behaviorScore}) must remain below calibrated threshold`);
    });
    assert.equal(expectedDuplicates, 9);
    assert.equal(routedExpectedDuplicates, 8, 'precision-first field rule must route eight of nine representative paraphrases');
    assert.ok(strongExpectedDuplicates >= 5, 'strong threshold must remain reserved for closely aligned multilingual paraphrases');

    // Real tokenizer/worker regression: old contextual input breaks the whole
    // batch; selector-only compact input preserves the strict worker contract.
    const currentRequest = "reloaded just in case. let's still plan the summer vacation";
    const longContextTurns = [
      {role:'assistant',text:'First prior response about diagnostics and selector behavior. '.repeat(6)},
      {role:'assistant',text:'Second prior response about local embeddings and bounded context. '.repeat(6)},
      {role:'assistant',text:'Третий предыдущий ответ о летнем отпуске и проверке контекста. '.repeat(6)},
      {role:'assistant',text:'Newest prior response keeps the current request as the only trigger. '.repeat(6)},
    ];
    const oldContextualInput = [...longContextTurns.map((turn) => `${turn.role}: ${turn.text}`), `current_user: ${currentRequest}`].join('\n');
    await assert.rejects(() => adapter.embed([currentRequest, oldContextualInput]), /128_tokens/);
    const compactContextualInput = buildContextualRetrievalPrompt(currentRequest, longContextTurns);
    assert.ok(Buffer.byteLength(compactContextualInput, 'utf8') <= SELECTOR_CONTEXT_RETRIEVAL_MAX_UTF8_BYTES);
    assert.ok(compactContextualInput.startsWith(`current_user: ${currentRequest}`));
    const compactVectors = await adapter.embed([currentRequest, compactContextualInput]);
    assert.equal(compactVectors.length, 2);
    assert.ok(compactVectors.every((vector) => vector.length === 384));
    const multilingualCompact = buildContextualRetrievalPrompt('да, продолжай', [{role:'assistant',text:'Составь подробный план летнего отпуска. '.repeat(20)}]);
    assert.ok(Buffer.byteLength(multilingualCompact, 'utf8') <= SELECTOR_CONTEXT_RETRIEVAL_MAX_UTF8_BYTES);
    assert.equal((await adapter.embed(['да, продолжай', multilingualCompact])).length, 2);

    await assert.rejects(() => adapter.embed([`when text is too long\n${'token '.repeat(300)}`]), /128_tokens/);
    assert.equal(adapter.isWorkerActive(), true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(adapter.isWorkerActive(), false, 'idle worker must unload model memory');
  } finally {
    await adapter.close();
    globalThis.fetch = originalFetch;
  }

  const tokenizerPath = join(installed.assetDir, 'tokenizer_config.json');
  await chmod(tokenizerPath, 0o600);
  await writeFile(tokenizerPath, '{}', {mode: 0o600});
  assert.equal((await getLocalEmbeddingAssetStatus(root)).ready, false, 'corruption must invalidate cache');
  const corruptAdapter = createLocalEmbeddingAdapter(root);
  await assert.rejects(() => corruptAdapter.embed(['when corrupt\nfail closed']), /assets_unavailable/);
  await corruptAdapter.close();
  await removeLocalEmbeddingAssets(root);
  assert.equal((await getLocalEmbeddingAssetStatus(root)).ready, false, 'managed assets must be removable');
} finally { await rm(temp, {recursive: true, force: true}); }
console.log('agent-experience phase13 local embedding checks passed');
