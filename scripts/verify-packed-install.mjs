#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, rmSync } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
const execFileAsync=promisify(execFile);
const packageRoot=resolve(process.argv[2]||'');
if(!packageRoot)throw new Error('Usage: verify-packed-install.mjs /absolute/installed/pi-experiences');
const pkg=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
assert.equal(pkg.name,'pi-experiences');
assert.equal(pkg.version,'0.1.54');
assert.equal(pkg.engines.node,'>=22.19.0');
assert.deepEqual(pkg.peerDependencies,{'@earendil-works/pi-agent-core':'*','@earendil-works/pi-ai':'*','@earendil-works/pi-coding-agent':'>=0.83.0','@earendil-works/pi-tui':'*'});
const installedPeerVersions={
  '@earendil-works/pi-agent-core':JSON.parse(await readFile(join(dirname(packageRoot),'@earendil-works/pi-agent-core/package.json'),'utf8')).version,
  '@earendil-works/pi-coding-agent':JSON.parse(await readFile(join(dirname(packageRoot),'@earendil-works/pi-coding-agent/package.json'),'utf8')).version,
};
function versionTuple(version){const match=/^(\d+)\.(\d+)\.(\d+)/.exec(version);assert.ok(match,`invalid installed peer version: ${version}`);return match.slice(1).map(Number);}
const coreVersion=versionTuple(installedPeerVersions['@earendil-works/pi-agent-core']);
assert.ok(coreVersion[0]===0&&coreVersion[1]===83,'isolated pi-agent-core must resolve ^0.83.0');
const codingVersion=versionTuple(installedPeerVersions['@earendil-works/pi-coding-agent']);
assert.ok(codingVersion[0]>0||(codingVersion[0]===0&&codingVersion[1]>=83),'isolated pi-coding-agent must resolve >=0.83.0');
assert.equal(pkg.dependencies?.typebox,'1.1.38');
assert.equal(pkg.scripts?.install,undefined);assert.equal(pkg.scripts?.postinstall,undefined);assert.equal(pkg.scripts?.prepare,undefined);
const required=['CHANGELOG.md','dist/experience-consolidate.mjs','extensions/agent-experience/index.ts','extensions/agent-experience/src/setup-ui.ts','extensions/agent-experience/src/conversation.ts','extensions/agent-experience/src/conversational-tools.ts','extensions/agent-experience/src/steering-note.ts','extensions/agent-experience/src/provider-guidance.ts','extensions/agent-experience/src/advisor/types.ts','extensions/agent-experience/src/advisor/prompt.ts','extensions/agent-experience/src/advisor/tools.ts','extensions/agent-experience/src/advisor/model.ts','extensions/agent-experience/src/advisor/workspace-tools.ts','extensions/agent-experience/src/advisor/transcript.ts','extensions/agent-experience/src/advisor/emission-guard.ts','extensions/agent-experience/src/advisor/retrieval-query.ts','extensions/agent-experience/src/advisor/habits.ts','extensions/agent-experience/src/advisor/message.ts','extensions/agent-experience/src/advisor/observation.ts','extensions/agent-experience/src/advisor/runtime.ts','extensions/agent-experience/src/consolidate/model-adapter.ts','extensions/agent-experience/src/consolidate/standalone-model-adapter.ts','extensions/agent-experience/src/break-in.ts','extensions/agent-experience/src/schedule/receipts.ts','extensions/agent-experience/src/schedule/runner.ts','extensions/agent-experience/src/schedule/systemd.ts','extensions/agent-experience/units/experience-consolidate.service','extensions/agent-experience/units/experience-consolidate.timer','skills/agent-experience/SKILL.md','skills/agent-experience/references/runtime-advisor.md','scripts/test-agent-experience-phase16-conversation.mjs','scripts/test-agent-experience-phase17-scheduled-analyze.mjs','scripts/test-agent-experience-phase18-break-in.mjs','scripts/test-agent-experience-phase19-vector-selector.mjs','scripts/test-agent-experience-phase20-context-selector.mjs','scripts/test-agent-experience-phase22-provider-guidance.mjs','scripts/test-agent-experience-phase23-advisor-core.mjs','scripts/test-agent-experience-phase24-advisor-habits-learning.mjs','scripts/test-agent-experience-phase25-grouped-setup.mjs','scripts/fixtures/advisor-tui-driver.ts','scripts/test-advisor-tui-smoke.py','scripts/test-installed-tui-smoke.py','scripts/verify-isolated-package.mjs','extensions/agent-experience/src/selector-vector.ts','extensions/agent-experience/src/steering-context.ts','extensions/agent-experience/src/selector-maintenance.ts','scripts/seed-steering-tui-smoke.mjs','scripts/test-steering-tui-smoke.py','runtime/agent-experience/local-embedding-worker.mjs','runtime/vendor/onnxruntime-web/ort.node.min.mjs','runtime/vendor/onnxruntime-web/ort-wasm-simd-threaded.mjs','THIRD_PARTY_NOTICES.md'];
for(const relative of required)await access(join(packageRoot,relative));
async function files(directory,{skipNodeModules=false}={}){const out=[];for(const entry of await readdir(directory,{withFileTypes:true})){if(skipNodeModules&&entry.isDirectory()&&entry.name==='node_modules')continue;const p=join(directory,entry.name);if(entry.isDirectory())out.push(...await files(p,{skipNodeModules}));else out.push(p);}return out;}
const packedFiles=await files(packageRoot,{skipNodeModules:true});
const privateAdvisorArtifactPath=(path)=>/(?:^|\/)(?:__advisor(?:[^\/]*)?|advisor[-_.]?(?:transcript|raw[-_.]?(?:model[-_.]?)?output|model[-_.]?output)(?:[^\/]*))\.(?:jsonl|ndjson|json|log|txt|bin)$/i.test(relative(packageRoot,path).split(sep).join('/'));
assert.ok(!packedFiles.some((path)=>/model_int8\.onnx|ort-wasm-simd-threaded\.wasm|observations\.jsonl|ledger\.sqlite|__pycache__|\.py[co]$|\.map$/.test(path)||privateAdvisorArtifactPath(path)),'tarball must not contain model assets, private state, private Advisor transcripts/raw output, Python caches, or source maps');
const suppliedScratchRoot=process.env.AX_VERIFY_TEMP_ROOT?.trim()?resolve(process.env.AX_VERIFY_TEMP_ROOT):undefined;
if(suppliedScratchRoot)await mkdir(suppliedScratchRoot,{recursive:true});
async function scratchDirectory(name,prefix){
  if(!suppliedScratchRoot)return mkdtemp(join(tmpdir(),prefix));
  const directory=join(suppliedScratchRoot,name);
  await mkdir(directory);
  return directory;
}
// Native Node intentionally refuses type stripping below node_modules. Pi owns real
// installed extension loading (validated separately by the PTY smoke). For the
// low-level inference probe, copy only packed bytes outside node_modules and link
// the exact dependencies installed by the tarball smoke.
const runtimeRoot=await scratchDirectory('packed-runtime','pi-experiences-packed-runtime-');
process.once('exit',()=>rmSync(runtimeRoot,{recursive:true,force:true}));
const runtimePackage=join(runtimeRoot,'pi-experiences');
await cp(packageRoot,runtimePackage,{recursive:true});
// Shared npm roots can place conflict-resolved dependencies inside the package.
// They are install artifacts, not packed bytes; use the authoritative install root.
await rm(join(runtimePackage,'node_modules'),{recursive:true,force:true});
await symlink(dirname(packageRoot),join(runtimePackage,'node_modules'),'dir');
const adapterModule=await import(pathToFileURL(join(runtimePackage,'extensions/agent-experience/src/semantic/local-adapter.ts')).href);
const workerUrl=adapterModule.resolveLocalEmbeddingWorkerUrl();
assert.equal(workerUrl.href,pathToFileURL(join(runtimePackage,'runtime/agent-experience/local-embedding-worker.mjs')).href);
const state=await scratchDirectory('packed-cli-state','pi-experiences-packed-cli-state-');
try{
  const cli=join(packageRoot,'dist/experience-consolidate.mjs');
  const help=await execFileAsync(process.execPath,[cli,'--help'],{env:{...process.env,AX_STATE_ROOT:state}});
  assert.match(help.stdout,/experience-consolidate/);
  const status=JSON.parse((await execFileAsync(process.execPath,[cli,'status'],{env:{...process.env,AX_STATE_ROOT:state}})).stdout);
  assert.equal(status.ok,true);assert.equal(status.config_exists,false);assert.equal(status.consolidation_enabled,false);assert.equal(status.timer_enabled,false);
}finally{await rm(state,{recursive:true,force:true});}
const loaderPath=join(dirname(packageRoot),'@earendil-works/pi-coding-agent/dist/core/skills.js');
const loaderAgentDir=join(runtimeRoot,'skill-loader-agent');
await mkdir(loaderAgentDir);
const {loadSkills}=await import(pathToFileURL(loaderPath).href);
const loaded=loadSkills({cwd:process.cwd(),agentDir:loaderAgentDir,skillPaths:[join(packageRoot,'skills/agent-experience/SKILL.md')],includeDefaults:false});
assert.equal(loaded.diagnostics.length,0,JSON.stringify(loaded.diagnostics));
assert.deepEqual(loaded.skills.map((skill)=>skill.name),['agent-experience']);
async function bytes(directory,{skipNodeModules=false}={}){let total=0;for(const path of await files(directory,{skipNodeModules}))total+=(await stat(path)).size;return total;}
let installedRuntimeBytes=await bytes(packageRoot,{skipNodeModules:true});
for(const dependency of ['@huggingface/tokenizers','onnxruntime-common','typebox','@earendil-works/pi-agent-core','@earendil-works/pi-coding-agent']){
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
  const modelState=await scratchDirectory('packed-model-state','pi-experiences-packed-model-state-');
  try{
    const ready=await modelModule.ensureLocalEmbeddingAssets(modelState,{fetchImpl});
    const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('packed offline inference forbids network')};
    const adapter=adapterModule.createLocalEmbeddingAdapter(modelState,{idleMs:100});
    try{
      const vectors=await adapter.embed(['condition: when reviewing code','behavior: identify concrete risks and recommend fixes','condition: при проверке кода','behavior: находить конкретные риски и предлагать исправления']);
      assert.equal(vectors.length,4);assert.ok(vectors.every((vector)=>vector.length===384));
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
console.log(JSON.stringify({packageRoot,version:pkg.version,peer_versions:installedPeerVersions,packed_file_count:packedFiles.length,skill_diagnostics:loaded.diagnostics,installed_managed_bytes:installedRuntimeBytes,localInference},null,2));
