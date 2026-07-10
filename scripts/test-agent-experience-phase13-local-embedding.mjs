#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseAgentExperienceConfig } from '../extensions/agent-experience/src/config.ts';
import { cosineBp, habitEmbeddingInputV1 } from '../extensions/agent-experience/src/semantic/core.ts';
import { createEmbeddingAdapterFromConfig, semanticPolicyFromConfig } from '../extensions/agent-experience/src/semantic/config.ts';
import { createLocalEmbeddingAdapter } from '../extensions/agent-experience/src/semantic/local-adapter.ts';
import { ensureLocalEmbeddingAssets, getLocalEmbeddingAssetStatus, removeLocalEmbeddingAssets } from '../extensions/agent-experience/src/semantic/local-model.ts';
import { LOCAL_EMBEDDING_ASSETS, LOCAL_EMBEDDING_DOWNLOAD_BYTES, LOCAL_EMBEDDING_MAX_MANAGED_BYTES, LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP } from '../extensions/agent-experience/src/semantic/local-model-manifest.ts';

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

  const fixtures = [
    ['positive-en', {condition:'When reviewing code',behavior:'Identify concrete risks and recommend fixes.'}, {condition:'During a code review',behavior:'Find specific failure modes and propose corrections.'}, true],
    ['positive-ru', {condition:'При проверке кода',behavior:'Находить конкретные риски и предлагать исправления.'}, {condition:'Во время ревью программы',behavior:'Выявлять точные сценарии отказа и рекомендовать изменения.'}, true],
    ['positive-cross-ru', {condition:'When reviewing code',behavior:'Identify concrete risks and recommend fixes.'}, {condition:'При проверке кода',behavior:'Находить конкретные риски и предлагать исправления.'}, true],
    ['positive-cross-es', {condition:'When reviewing code',behavior:'Identify concrete risks and recommend fixes.'}, {condition:'Al revisar código',behavior:'Identificar riesgos concretos y recomendar correcciones.'}, true],
    ['positive-cross-de', {condition:'When reviewing code',behavior:'Identify concrete risks and recommend fixes.'}, {condition:'Bei der Codeprüfung',behavior:'Konkrete Risiken erkennen und Korrekturen empfehlen.'}, true],
    ['positive-cross-fr', {condition:'When reviewing code',behavior:'Identify concrete risks and recommend fixes.'}, {condition:'Lors de la revue du code',behavior:'Identifier les risques concrets et recommander des corrections.'}, true],
    ['positive-cross-zh', {condition:'When reviewing code',behavior:'Identify concrete risks and recommend fixes.'}, {condition:'审查代码时',behavior:'识别具体风险并提出修复建议。'}, true],
    ['positive-es', {condition:'Antes de publicar un paquete',behavior:'Ejecutar todas las pruebas y verificar el artefacto instalable.'}, {condition:'Al preparar una versión de software',behavior:'Completar la validación y probar el paquete final.'}, true],
    ['negative-en', {condition:'When reviewing code',behavior:'Identify concrete risks and recommend fixes.'}, {condition:'When preparing breakfast',behavior:'Choose fresh seasonal fruit.'}, false],
    ['negative-ru', {condition:'При проверке кода',behavior:'Находить конкретные риски и предлагать исправления.'}, {condition:'Перед поездкой',behavior:'Проверять прогноз погоды и брать подходящую одежду.'}, false],
    ['negative-cross', {condition:'When exposing user controls',behavior:'Keep one setup panel as the complete normal-user surface.'}, {condition:'При закрытии месяца',behavior:'Сверять банковские операции с бухгалтерским отчетом.'}, false],
  ];
  const texts = fixtures.flatMap(([, left, right]) => [habitEmbeddingInputV1(left), habitEmbeddingInputV1(right)]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline test forbids network'); };
  const adapter = createLocalEmbeddingAdapter(root, {idleMs: 100});
  try {
    const vectors = await adapter.embed(texts);
    assert.equal(vectors.length, texts.length);
    assert.ok(vectors.every((vector) => vector.length === 384));
    fixtures.forEach(([name,,, duplicate], index) => {
      const score = cosineBp(vectors[index * 2], vectors[index * 2 + 1]);
      if (duplicate) assert.ok(score >= LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP, `${name} duplicate score ${score} must reach calibrated threshold`);
      else assert.ok(score < LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP, `${name} non-duplicate score ${score} must remain below calibrated threshold`);
    });
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
