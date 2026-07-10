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
assert.ok(packageJson.files.includes('docs/'),'packed package must include README/gallery artwork');
assert.equal(packageJson.description,'Human-reviewed habits for Pi coding agents—a local-first behavioral learning layer alongside skills and memory.','package description must preserve the discoverable habits category');
assert.equal(packageJson.dependencies?.typebox,'1.1.38','conversational tool schemas must declare their TypeBox runtime directly');
assert.match(packageJson.scripts?.['check:agent-experience']||'',/test-agent-experience-phase16-conversation\.mjs/,'complete checks must include conversational habit validation');
for(const keyword of ['pi-package','pi-coding-agent','coding-agent','agent-habits','agent-memory','agent-profile','agent-skills','behavioral-learning','context-management','human-in-the-loop','local-first','token-efficiency']){
  assert.ok(packageJson.keywords.includes(keyword),`package discovery keyword missing: ${keyword}`);
}
assert.equal(packageJson.pi?.image,`https://raw.githubusercontent.com/misunders2d/pi-experiences/v${packageJson.version}/docs/images/pi-experiences-habits.png`,'Pi gallery image must point at the immutable matching-release preview asset');
assert.equal(packageJson.scripts?.install,undefined);
assert.equal(packageJson.scripts?.postinstall,undefined);
assert.equal(packageJson.scripts?.prepare,undefined,'package installation must never download local model assets');
const configText=formatAgentExperienceConfig(DEFAULT_AGENT_EXPERIENCE_CONFIG);
assert.doesNotMatch(configText,/embedding_(provider|model|dimensions|review_threshold|strong_threshold|timeout|openai)/i);

const readme=await readFile(join(root,'README.md'),'utf8');
const technicalSummary='<summary><strong>For agents and maintainers: technical contract, caveats, and release discipline</strong></summary>';
const technicalSummaryIndex=readme.indexOf(technicalSummary);
assert.notEqual(technicalSummaryIndex,-1,'README must preserve the collapsed agent/maintainer technical contract');
const technicalOpenIndex=readme.lastIndexOf('<details>',technicalSummaryIndex);
const technicalCloseIndex=readme.indexOf('</details>',technicalSummaryIndex);
assert.notEqual(technicalOpenIndex,-1,'agent/maintainer technical contract must be inside <details>');
assert.notEqual(technicalCloseIndex,-1,'agent/maintainer technical contract must close its <details> block');
assert.equal(readme.slice(technicalOpenIndex,technicalSummaryIndex).trim(),'<details>','agent/maintainer technical contract must be collapsed by default');
for(const marker of ['# Pi Experiences — habits for a coding agent that learns how you work','## The missing layer in AI agent improvement','## Why not put every preference in `profile.md`?','## Real-life habits Pi can learn','## How the review-first learning loop works','## Safety model','## Normal workflow','## See when a habit steers an answer','## Local duplicate prevention','## Privacy in plain language','## Frequently asked questions']){
  const index=readme.indexOf(marker);
  assert.ok(index>=0&&index<technicalOpenIndex,`README human-first product section missing before technical contract: ${marker}`);
}
for(const phrase of ['Pi coding agent','Agent skill','Agent memory','Experience habit','human-in-the-loop behavioral learning','Profiles describe the person; experience manages reviewed habits','selected Pi model/provider']){
  assert.match(readme.slice(0,technicalOpenIndex),new RegExp(phrase,'i'),`README discovery/product story missing: ${phrase}`);
}
assert.match(readme.slice(0,technicalOpenIndex),/!\[Infographic: skills give a Pi coding agent procedures, memory preserves facts, and human-reviewed habits improve how it works with you\]\(\.\/docs\/images\/pi-experiences-habits\.svg\)/,'README must show the local habits/skills/memory infographic');
for(const marker of ['### Package contract','### Hard invariants','### Why `profile.md` is not the habit store','### Local embedding contract','### Duplicate-resolution contract','### Bounded observations and privacy retention','### Law-check caveat','### Development and validation','### Release discipline']){
  const index=readme.indexOf(marker,technicalSummaryIndex);
  assert.ok(index>technicalSummaryIndex&&index<technicalCloseIndex,`README technical contract missing: ${marker}`);
}
const humanReadme=readme.slice(0,technicalOpenIndex);
const technicalReadme=readme.slice(technicalSummaryIndex,technicalCloseIndex);
assert.match(humanReadme,/situation and action separately/i,'normal-user duplicate explanation must preserve separate-field behavior');
assert.match(humanReadme,/not globally against one another/i,'normal-user duplicate explanation must preserve approved-only candidate policy');
for(const phrase of ['exact `When:` \/ `Do:` wording','later, explicit confirmation','bypasses only that repetition threshold','numbered plain-language items','◇ Habit steering','No marker means no habit guidance was injected','not an LLM message']) assert.match(humanReadme,new RegExp(phrase,'i'),`README conversational/transparency contract missing: ${phrase}`);
for(const phrase of ['one short-lived draft and one numbered review snapshot','no raw conversation or confirmation utterance','If it is unavailable, no candidate','expire after 15 minutes','agent_experience.habit_steering','Custom entries do not participate in LLM context','non-TUI modes suppress']) assert.match(technicalReadme,new RegExp(phrase,'i'),`README technical conversational/transparency contract missing: ${phrase}`);
for(const phrase of ['lower of separate condition and behavior cosine scores','Review threshold: 5,500 basis points','candidate-to-candidate semantic routing is excluded','obsolete pending scoring-method relations','every pending relation involving it','keep-separate decisions survive scoring/cache method upgrades'])assert.match(technicalReadme,new RegExp(phrase,'i'),`README dedupe correction contract missing: ${phrase}`);
const extensionReadme=await readFile(join(root,'extensions/agent-experience/README.md'),'utf8');
const experienceSkill=await readFile(join(root,'skills/agent-experience/SKILL.md'),'utf8');
for(const [name,text] of [['extension README',extensionReadme],['public skill',experienceSkill]]){
  assert.match(text,/condition and behavior.*two independent inputs/is,`${name} must preserve separate-field privacy contract`);
  assert.match(text,/candidate-to-candidate/is,`${name} must preserve candidate-pair exclusion`);
  assert.match(text,/obsolete pending scoring-method/is,`${name} must preserve reconciliation contract`);
  assert.match(text,/exact `When:` \/ `Do:`/is,`${name} must document exact conversational habit drafting`);
  assert.match(text,/later user (?:input )?turn|later user message/is,`${name} must preserve two-turn confirmation`);
  assert.match(text,/bypasses only (?:the )?repe(?:at|tit)/is,`${name} must preserve direct-declaration evidence boundary`);
  assert.match(text,/◇ Habit steering/is,`${name} must document visible per-answer habit steering`);
  assert.match(text,/No marker means no habit guidance was injected/is,`${name} must define marker absence semantics`);
  assert.match(text,/never enters? LLM context|does not participate in LLM context/is,`${name} must keep steering provenance out of model context`);
  assert.match(text,/non-TUI/is,`${name} must preserve fail-closed interface visibility`);
}

const steeringSource=await readFile(join(root,'extensions/agent-experience/src/steering-note.ts'),'utf8');
assert.match(steeringSource,/agent_experience\.habit_steering/,'steering custom-entry type must remain stable');
assert.doesNotMatch(steeringSource,/sendMessage|prompt_hash|confidence_bp|checksum|source_refs?|provider|model/,'steering entry module must not persist context-bearing or internal fields');
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
const heroSvg=await readFile(join(root,'docs/images/pi-experiences-habits.svg'),'utf8');
assert.match(heroSvg,/<title[^>]*>Pi Experiences: skills, memory, and habits<\/title>/,'README SVG needs an accessible title');
assert.match(heroSvg,/<desc[^>]*>[^<]*human-reviewed habits[^<]*<\/desc>/i,'README SVG needs an accessible description of habits');
assert.doesNotMatch(heroSvg,/<script\b|(?:href|src)=["']https?:/i,'README SVG must remain inert and self-contained');
const galleryPng=await readFile(join(root,'docs/images/pi-experiences-habits.png'));
assert.deepEqual([...galleryPng.subarray(0,8)],[137,80,78,71,13,10,26,10],'Pi gallery preview must be a valid PNG');
assert.equal(galleryPng.readUInt32BE(16),1400,'Pi gallery preview width drifted');
assert.equal(galleryPng.readUInt32BE(20),800,'Pi gallery preview height drifted');
assert.ok(galleryPng.byteLength<=500_000,'Pi gallery preview should remain lightweight');
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
