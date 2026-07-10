#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, rmSync } from 'node:fs';
import { access, cp, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
const execFileAsync=promisify(execFile);
const packageRoot=resolve(process.argv[2]||'');
if(!packageRoot)throw new Error('Usage: verify-packed-install.mjs /absolute/installed/pi-experiences');
const pkg=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
assert.equal(pkg.name,'pi-experiences');
assert.equal(pkg.version,'0.1.26');
assert.equal(pkg.engines.node,'>=22.19.0');
assert.deepEqual(pkg.peerDependencies,{'@earendil-works/pi-ai':'*','@earendil-works/pi-coding-agent':'*','@earendil-works/pi-tui':'*'});
assert.equal(pkg.scripts?.install,undefined);assert.equal(pkg.scripts?.postinstall,undefined);assert.equal(pkg.scripts?.prepare,undefined);
const required=['dist/experience-consolidate.mjs','extensions/agent-experience/index.ts','skills/agent-experience/SKILL.md','runtime/agent-experience/local-embedding-worker.mjs','runtime/vendor/onnxruntime-web/ort.node.min.mjs','runtime/vendor/onnxruntime-web/ort-wasm-simd-threaded.mjs','THIRD_PARTY_NOTICES.md'];
for(const relative of required)await access(join(packageRoot,relative));
async function files(directory){const out=[];for(const entry of await readdir(directory,{withFileTypes:true})){const p=join(directory,entry.name);if(entry.isDirectory())out.push(...await files(p));else out.push(p);}return out;}
const packedFiles=await files(packageRoot);
assert.ok(!packedFiles.some((path)=>/model_int8\.onnx|ort-wasm-simd-threaded\.wasm|observations\.jsonl|ledger\.sqlite|\.map$/.test(path)),'tarball must not contain model assets, private state, or source maps');
// Native Node intentionally refuses type stripping below node_modules. Pi owns real
// installed extension loading (validated separately by the PTY smoke). For the
// low-level inference probe, copy only packed bytes outside node_modules and link
// the exact dependencies installed by the tarball smoke.
const runtimeRoot=await mkdtemp(join(tmpdir(),'pi-experiences-packed-runtime-'));
process.once('exit',()=>rmSync(runtimeRoot,{recursive:true,force:true}));
const runtimePackage=join(runtimeRoot,'pi-experiences');
await cp(packageRoot,runtimePackage,{recursive:true});
await symlink(dirname(packageRoot),join(runtimePackage,'node_modules'),'dir');
const adapterModule=await import(pathToFileURL(join(runtimePackage,'extensions/agent-experience/src/semantic/local-adapter.ts')).href);
const workerUrl=adapterModule.resolveLocalEmbeddingWorkerUrl();
assert.equal(workerUrl.href,pathToFileURL(join(runtimePackage,'runtime/agent-experience/local-embedding-worker.mjs')).href);
const state=await mkdtemp(join(tmpdir(),'pi-experiences-packed-cli-state-'));
try{
  const cli=join(packageRoot,'dist/experience-consolidate.mjs');
  const help=await execFileAsync(process.execPath,[cli,'--help'],{env:{...process.env,AX_STATE_ROOT:state}});
  assert.match(help.stdout,/experience-consolidate/);
  const status=JSON.parse((await execFileAsync(process.execPath,[cli,'status'],{env:{...process.env,AX_STATE_ROOT:state}})).stdout);
  assert.equal(status.ok,true);assert.equal(status.config_exists,false);assert.equal(status.consolidation_enabled,false);assert.equal(status.timer_enabled,false);
}finally{await rm(state,{recursive:true,force:true});}
const loaderPath=process.env.PI_SKILL_LOADER||'/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js';
const {loadSkills}=await import(pathToFileURL(loaderPath).href);
const loaded=loadSkills({cwd:process.cwd(),agentDir:join(tmpdir(),'pi-experiences-no-agent-defaults'),skillPaths:[join(packageRoot,'skills/agent-experience/SKILL.md')],includeDefaults:false});
assert.equal(loaded.diagnostics.length,0,JSON.stringify(loaded.diagnostics));
assert.deepEqual(loaded.skills.map((skill)=>skill.name),['agent-experience']);
async function bytes(directory){let total=0;for(const path of await files(directory))total+=(await stat(path)).size;return total;}
let installedRuntimeBytes=await bytes(packageRoot);
for(const dependency of ['@huggingface/tokenizers','onnxruntime-common']){
  const path=join(dirname(packageRoot),dependency);
  await access(path);
  installedRuntimeBytes+=await bytes(path);
}
let localInference;
const fixtureDir=process.env.AX_LOCAL_MODEL_FIXTURE_DIR;
const fixtureWasm=process.env.AX_LOCAL_ORT_WASM;
if(fixtureDir&&fixtureWasm){
  const modelModule=await import(pathToFileURL(join(runtimePackage,'extensions/agent-experience/src/semantic/local-model.ts')).href);
  const sources={'model_int8.onnx':join(fixtureDir,'onnx','model_int8.onnx'),'tokenizer.json':join(fixtureDir,'tokenizer.json'),'tokenizer_config.json':join(fixtureDir,'tokenizer_config.json'),'config.json':join(fixtureDir,'config.json'),'ort-wasm-simd-threaded.wasm':fixtureWasm};
  const fetchImpl=async url=>{const source=sources[basename(new URL(url).pathname)];return source?new Response(Readable.toWeb(createReadStream(source)),{status:200}):new Response('missing',{status:404})};
  const modelState=await mkdtemp(join(tmpdir(),'pi-experiences-packed-model-state-'));
  try{
    const ready=await modelModule.ensureLocalEmbeddingAssets(modelState,{fetchImpl});
    const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('packed offline inference forbids network')};
    const adapter=adapterModule.createLocalEmbeddingAdapter(modelState,{idleMs:100});
    try{
      const vectors=await adapter.embed(['when reviewing code\nidentify concrete risks and recommend fixes','при проверке кода\nнаходить конкретные риски и предлагать исправления']);
      assert.equal(vectors.length,2);assert.equal(vectors[0].length,384);
      const digest=createHash('sha256').update(Buffer.from(vectors[0].buffer)).digest('hex');
      await new Promise((resolve)=>setTimeout(resolve,250));
      assert.equal(adapter.isWorkerActive(),false);
      localInference={dimensions:vectors[0].length,vector_sha256:digest,asset_bytes:ready.totalBytes,offline:true,worker_unloaded:true};
    }finally{await adapter.close();globalThis.fetch=oldFetch;}
    installedRuntimeBytes+=ready.totalBytes;
  }finally{await rm(modelState,{recursive:true,force:true});}
}
assert.ok(installedRuntimeBytes<=300_000_000,`managed installed+asset footprint exceeds cap: ${installedRuntimeBytes}`);
await rm(runtimeRoot,{recursive:true,force:true});
console.log(JSON.stringify({packageRoot,version:pkg.version,packed_file_count:packedFiles.length,skill_diagnostics:loaded.diagnostics,installed_managed_bytes:installedRuntimeBytes,localInference},null,2));
