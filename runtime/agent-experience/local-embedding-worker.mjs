import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ort from '../vendor/onnxruntime-web/ort.node.min.mjs';
import { Tokenizer } from '@huggingface/tokenizers';

if (!parentPort) throw new Error('local_embedding_worker_requires_parent_port');

const DIMENSIONS = 384;
const MAX_BATCH = 64;
const MAX_TOKENS = 128;
let statePromise;

async function loadState() {
  const assetDir = String(workerData?.assetDir || '');
  const wasmPath = `${assetDir}/ort-wasm-simd-threaded.wasm`;
  const gluePath = new URL('../vendor/onnxruntime-web/ort-wasm-simd-threaded.mjs', import.meta.url);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { mjs: gluePath, wasm: pathToFileURL(wasmPath) };
  const tokenizerJson = JSON.parse(await readFile(`${assetDir}/tokenizer.json`, 'utf8'));
  const tokenizerConfig = JSON.parse(await readFile(`${assetDir}/tokenizer_config.json`, 'utf8'));
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  const modelBytes = await readFile(`${assetDir}/model_int8.onnx`);
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return { tokenizer, session };
}

function getState() {
  statePromise ||= loadState();
  return statePromise;
}

function makeFeeds(texts, tokenizer, session) {
  const encoded = texts.map((text) => tokenizer.encode(text, { add_special_tokens: true }));
  if (encoded.some((item) => item.ids.length > MAX_TOKENS)) throw new Error('local_embedding_input_exceeds_128_tokens');
  const maxLength = Math.max(...encoded.map((item) => item.ids.length));
  const padId = tokenizer.token_to_id('<pad>') ?? 1;
  const ids = new BigInt64Array(texts.length * maxLength);
  const masks = new BigInt64Array(texts.length * maxLength);
  const types = new BigInt64Array(texts.length * maxLength);
  ids.fill(BigInt(padId));
  encoded.forEach((item, row) => {
    item.ids.forEach((id, col) => {
      const offset = row * maxLength + col;
      ids[offset] = BigInt(id);
      masks[offset] = 1n;
    });
  });
  const feeds = {};
  for (const name of session.inputNames) {
    if (name === 'input_ids') feeds[name] = new ort.Tensor('int64', ids, [texts.length, maxLength]);
    else if (name === 'attention_mask') feeds[name] = new ort.Tensor('int64', masks, [texts.length, maxLength]);
    else if (name === 'token_type_ids') feeds[name] = new ort.Tensor('int64', types, [texts.length, maxLength]);
    else throw new Error(`local_embedding_unsupported_model_input:${name}`);
  }
  return { feeds, masks, maxLength };
}

async function embed(texts) {
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > MAX_BATCH || texts.some((text) => typeof text !== 'string' || text.length < 1 || text.length > 5000)) throw new Error('local_embedding_invalid_batch');
  const { tokenizer, session } = await getState();
  const { feeds, masks, maxLength } = makeFeeds(texts, tokenizer, session);
  const outputs = await session.run(feeds);
  const output = outputs[session.outputNames[0]];
  const [batch, seq, dims] = output.dims;
  if (batch !== texts.length || seq !== maxLength || dims !== DIMENSIONS) throw new Error(`local_embedding_unexpected_output:${output.dims}`);
  const vectors = [];
  for (let row = 0; row < batch; row += 1) {
    const vector = new Float32Array(dims);
    let count = 0;
    for (let token = 0; token < seq; token += 1) {
      if (masks[row * seq + token] === 0n) continue;
      count += 1;
      const base = (row * seq + token) * dims;
      for (let dim = 0; dim < dims; dim += 1) vector[dim] += output.data[base + dim];
    }
    let norm = 0;
    for (let dim = 0; dim < dims; dim += 1) {
      vector[dim] /= Math.max(1, count);
      norm += vector[dim] * vector[dim];
    }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 0) throw new Error('local_embedding_invalid_vector_norm');
    for (let dim = 0; dim < dims; dim += 1) vector[dim] /= norm;
    vectors.push(vector);
  }
  return vectors;
}

parentPort.on('message', async (message) => {
  const id = message?.id;
  try {
    if (message?.type === 'embed') {
      const vectors = await embed(message.texts);
      parentPort.postMessage({ id, ok: true, vectors }, vectors.map((vector) => vector.buffer));
      return;
    }
    if (message?.type === 'close') {
      parentPort.postMessage({ id, ok: true, closed: true });
      setImmediate(() => process.exit(0));
      return;
    }
    throw new Error('local_embedding_unknown_worker_message');
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message || error).slice(0, 300) });
  }
});
