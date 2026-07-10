#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import agentExperienceExtension from '../extensions/agent-experience/index.ts';
import { formatAgentExperienceConfig, DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { resolveLocalEmbeddingWorkerUrl } from '../extensions/agent-experience/src/semantic/local-adapter.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
assert.equal(typeof agentExperienceExtension,'function');
assert.match(fileURLToPath(resolveLocalEmbeddingWorkerUrl()),/runtime\/agent-experience\/local-embedding-worker\.mjs$/);
const packageJson=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
assert.equal(packageJson.engines.node,'>=22.19.0','package Node floor must match locked Pi peers');
assert.ok(packageJson.files.includes('runtime/'),'packed package must include local worker/vendor runtime');
assert.equal(packageJson.scripts?.install,undefined);
assert.equal(packageJson.scripts?.postinstall,undefined);
assert.equal(packageJson.scripts?.prepare,undefined,'package installation must never download local model assets');
const configText=formatAgentExperienceConfig(DEFAULT_AGENT_EXPERIENCE_CONFIG);
assert.doesNotMatch(configText,/embedding_(provider|model|dimensions|review_threshold|strong_threshold|timeout|openai)/i);

const forbidden=/OPENAI_API_KEY|AX_OPENAI_EMBEDDING|openai-compatible embedding|api\.openai\.com/i;
async function sourceFiles(directory){
  const out=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=join(directory,entry.name);
    if(entry.isDirectory())out.push(...await sourceFiles(path));
    else if(/\.(?:ts|mjs|md|json)$/.test(entry.name))out.push(path);
  }
  return out;
}
for(const path of await sourceFiles(join(root,'extensions')))assert.doesNotMatch(await readFile(path,'utf8'),forbidden,`hosted embedding behavior must be absent: ${path}`);
const expectedGlue={
  'ort.node.min.mjs':'e89f5e9feb40384ab2bd1f95ade074e3de8ce3b64485bd03fb79d2cde2a620f1',
  'ort-wasm-simd-threaded.mjs':'0a1e718d99c41b22c21f2520ff4f9e883a6b5533856e398d21816ee8eb8185d3',
};
for(const [name,expected] of Object.entries(expectedGlue)){
  const bytes=await readFile(join(root,'runtime/vendor/onnxruntime-web',name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,`vendored runtime hash mismatch: ${name}`);
}
await esbuild.build({entryPoints:[join(root,'extensions/agent-experience/index.ts')],bundle:true,platform:'node',format:'esm',target:['node22'],write:false,logLevel:'silent',external:['@earendil-works/pi-ai/*','@earendil-works/pi-coding-agent','@earendil-works/pi-tui']});
await esbuild.build({entryPoints:[join(root,'runtime/agent-experience/local-embedding-worker.mjs')],bundle:false,platform:'node',format:'esm',target:['node22'],write:false,logLevel:'silent'});
console.log('agent-experience source/import/package checks passed');
