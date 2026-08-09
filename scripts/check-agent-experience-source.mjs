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
assert.ok(packageJson.files.includes('CHANGELOG.md'),'packed package must include user-facing release history');
const changelog=await readFile(join(root,'CHANGELOG.md'),'utf8');
assert.match(changelog,/^# Changelog$/m,'changelog heading missing');
assert.match(changelog,/^## \[Unreleased\]$/m,'changelog must preserve an Unreleased section');
assert.match(changelog,new RegExp(`^## \\[${packageJson.version.replaceAll('.', '\\.')}\\]`, 'm'),'changelog must contain the current published package version');
assert.equal(packageJson.description,'Human-reviewed habits for Pi and OMP coding agents—a local-first behavioral learning layer alongside skills and memory.','package description must preserve the discoverable dual-host habits category');
assert.equal(packageJson.dependencies?.typebox,'1.1.38','conversational tool schemas must declare their TypeBox runtime directly');
assert.equal(packageJson.peerDependencies?.['@earendil-works/pi-coding-agent'],'>=0.83.0','agent_settled requires pi-coding-agent >=0.83.0');
assert.equal(packageJson.devDependencies?.['@earendil-works/pi-coding-agent'],'^0.83.0','development must test the first supported public agent_settled API line');
assert.equal(packageJson.peerDependencies?.['@earendil-works/pi-agent-core'],'*','Advisor runtime must declare pi-agent-core as a direct peer');
assert.equal(packageJson.devDependencies?.['@earendil-works/pi-agent-core'],'^0.83.0','development must match the supported pi-agent-core line');
assert.match(packageJson.scripts?.['check:agent-experience']||'',/test-agent-experience-phase16-conversation\.mjs/,'complete checks must include conversational habit validation');
assert.match(packageJson.scripts?.['check:agent-experience']||'',/test-agent-experience-phase22-provider-guidance\.mjs/,'complete checks must include system-level provider guidance validation');
assert.match(packageJson.scripts?.['check:agent-experience']||'',/test-agent-experience-phase23-advisor-core\.mjs/,'complete checks must include Advisor core validation');
assert.match(packageJson.scripts?.['check:agent-experience']||'',/test-agent-experience-phase24-advisor-habits-learning\.mjs/,'complete checks must include Advisor habits and learning validation');
assert.match(packageJson.scripts?.['check:agent-experience']||'',/test-agent-experience-phase25-grouped-setup\.mjs/,'complete checks must include grouped setup validation');
const packedVerifierSource=await readFile(join(root,'scripts/verify-packed-install.mjs'),'utf8');
for(const required of [
  'extensions/agent-experience/src/setup-ui.ts',
  'extensions/agent-experience/src/advisor/types.ts',
  'extensions/agent-experience/src/advisor/prompt.ts',
  'extensions/agent-experience/src/advisor/tools.ts',
  'extensions/agent-experience/src/advisor/model.ts',
  'extensions/agent-experience/src/advisor/workspace-tools.ts',
  'extensions/agent-experience/src/advisor/transcript.ts',
  'extensions/agent-experience/src/advisor/emission-guard.ts',
  'extensions/agent-experience/src/advisor/retrieval-query.ts',
  'extensions/agent-experience/src/advisor/habits.ts',
  'extensions/agent-experience/src/advisor/message.ts',
  'extensions/agent-experience/src/advisor/observation.ts',
  'extensions/agent-experience/src/advisor/runtime.ts',
  'skills/agent-experience/references/runtime-advisor.md',
  'scripts/test-agent-experience-phase23-advisor-core.mjs',
  'scripts/test-agent-experience-phase24-advisor-habits-learning.mjs',
  'scripts/test-agent-experience-phase25-grouped-setup.mjs',
  'scripts/fixtures/advisor-tui-driver.ts',
  'scripts/test-advisor-tui-smoke.py',
])assert.match(packedVerifierSource,new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),`packed verifier must require ${required}`);
assert.match(packedVerifierSource,/'@earendil-works\/pi-agent-core':'\*'/,'packed verifier must enforce the direct pi-agent-core peer');
assert.match(packedVerifierSource,/'@earendil-works\/pi-coding-agent':'>=0\.83\.0'/,'packed verifier must enforce the supported pi-coding-agent peer');
const advisorDirectory=join(root,'extensions/agent-experience/src/advisor');
const advisorSources=(await readdir(advisorDirectory)).filter((name)=>name.endsWith('.ts')).sort();
const advisorSourceText=(await Promise.all(advisorSources.map((name)=>readFile(join(advisorDirectory,name),'utf8')))).join('\n');
assert.doesNotMatch(advisorSourceText,/__advisor\.jsonl|advisor[-_.]?(?:transcript|model[-_.]?output)\.jsonl/i,'Advisor source must not name private transcript or raw-model persistence paths');
assert.doesNotMatch(advisorSourceText,/generic_advice|\badvise\s*\(/,'Advisor production source must not retain an alternate generic-policy path');
assert.doesNotMatch(advisorSourceText,/severity[^\n]*(?:nit)|["']nit["']/i,'Advisor production source must allow only concern and blocker findings');
const advisorModelSource=await readFile(join(advisorDirectory,'model.ts'),'utf8');
const advisorToolsSource=await readFile(join(advisorDirectory,'tools.ts'),'utf8');
const emissionFactorySource=advisorToolsSource.slice(advisorToolsSource.indexOf('export function createAdvisorEmissionTools'));
assert.match(emissionFactorySource,/name:\s*["']report_habit_violation["']/,'Advisor model must expose exact approved-habit violation emission');
assert.doesNotMatch(emissionFactorySource,/name:\s*["']advise["']/,'Advisor model must not expose generic reviewer-created advice');
assert.match(advisorModelSource,/createAdvisorWorkspaceTools/,'Advisor model must obtain confined read-only tools through the wrapper');
assert.match(advisorModelSource,/reviewFailure\("advisor_auth_unavailable"\)/,'Advisor model must report authentication failure distinctly from legitimate silence');
assert.match(advisorModelSource,/reviewFailure\("advisor_context_overflow"\)/,'Advisor model must report context overflow distinctly from legitimate silence');
assert.match(advisorModelSource,/reviewFailure\("advisor_timeout"\)/,'Advisor model must report timeout distinctly from legitimate silence');
assert.doesNotMatch(advisorModelSource,/create(?:Read|Grep)Tool|nodeGlob/,'Advisor model must not instantiate unwrapped read-only tools');
assert.doesNotMatch(advisorModelSource,/(?:name\s*:\s*["']|["'])(?:write|edit|bash|shell|exec|delete|remove|move|rename|mkdir|apply_patch)["']/i,'Advisor model must not expose mutating tool names');
const advisorWorkspaceSource=await readFile(join(advisorDirectory,'workspace-tools.ts'),'utf8');
const advisorPromptSource=await readFile(join(advisorDirectory,'prompt.ts'),'utf8');
const agentExperienceExtensionSource=await readFile(join(root,'extensions/agent-experience/index.ts'),'utf8');
const advisorTranscriptSource=await readFile(join(advisorDirectory,'transcript.ts'),'utf8');
const advisorObservationSource=await readFile(join(advisorDirectory,'observation.ts'),'utf8');
const advisorHabitsSource=await readFile(join(advisorDirectory,'habits.ts'),'utf8');
const runtimeRetrievalSource=advisorHabitsSource.slice(advisorHabitsSource.indexOf('export async function retrieveAdvisorHabitCandidates'));
assert.match(advisorWorkspaceSource,/return \[read, grep, glob\]/,'Advisor workspace factory must return only wrapped read-only tools');
assert.match(advisorPromptSource,/boundedText\(update\.configuredLaw,\s*["']configured law["'],\s*MAX_CONFIGURED_LAW_CHARS\)/,'Advisor prompt must bound and redact current configured law');
assert.match(advisorPromptSource,/habits\.length\s*>\s*0\s*&&\s*!configuredLaw\.trim\(\)/,'Advisor prompt must fail closed when habit review lacks configured law');
assert.match(agentExperienceExtensionSource,/configuredLaw\s*=\s*law\.text/,'Advisor runtime must read configured law from the current law snapshot');
assert.match(agentExperienceExtensionSource,/currentRequest:\s*delta\.currentRequest,\s*\n\s*configuredLaw,\s*\n\s*habits,/,'Advisor runtime must pass configured law with the ephemeral update');
assert.match(advisorWorkspaceSource,/MAX_FILE_INPUT_BYTES\s*=\s*256\s*\*\s*1_024/,'Advisor workspace reads must have an explicit per-file input byte cap');
assert.match(advisorWorkspaceSource,/MAX_GREP_INPUT_BYTES\s*=\s*1_024\s*\*\s*1_024/,'Advisor workspace grep must have an explicit aggregate input byte cap');
const boundedReadSource=advisorWorkspaceSource.slice(advisorWorkspaceSource.indexOf('async function readBoundedOpenFile'),advisorWorkspaceSource.indexOf('async function readConfinedFile'));
assert.ok(boundedReadSource.indexOf('opened.size > maxBytes')>=0 && boundedReadSource.indexOf('opened.size > maxBytes')<boundedReadSource.indexOf('Buffer.alloc(opened.size)'),'Advisor workspace must reject oversized files before Buffer allocation');
assert.doesNotMatch(advisorWorkspaceSource,/\.readFile\(/,'Advisor workspace production path must not perform unbounded whole-file reads');
assert.match(advisorTranscriptSource,/JSON\.stringify\(redactJson\(block\.arguments\)\)/,'Advisor must structurally redact tool arguments before review serialization');
assert.match(advisorTranscriptSource,/filter\(\(block\) => block\.type === ["']text["']/,'Advisor durable behavior must derive only from visible assistant text');
assert.doesNotMatch(advisorObservationSource,/boundedRedactedText\(update\.primaryDelta/,'Advisor observations must never persist review-only transcript/tool bytes');
assert.doesNotMatch(advisorObservationSource,/current_request_redacted|advice_redacted/,'Advisor observation schema must not persist user prompts or obsolete generic advice');
assert.match(agentExperienceExtensionSource,/advisor_observation_write_failed/,'Advisor observation persistence failure must produce a safe deduplicated diagnostic');
const consolidationModelAdapterSource=await readFile(join(root,'extensions/agent-experience/src/consolidate/model-adapter.ts'),'utf8');
assert.doesNotMatch(consolidationModelAdapterSource,/current_request_redacted|advice_redacted/,'Analyze prompt assembly must not recover user prompts or obsolete generic advice from Advisor observations');
assert.doesNotMatch(runtimeRetrievalSource,/prepareAdvisorHabitVectors|upsertCachedHabitEmbedding/,'ordinary Advisor retrieval must never mutate the vector cache');
const sourceGateText=await readFile(fileURLToPath(import.meta.url),'utf8');
assert.match(sourceGateText,/external:\[[^\]]*'@earendil-works\/pi-agent-core'/,'Advisor bundle check must externalize direct pi-agent-core');
const isolatedVerifierSource=await readFile(join(root,'scripts/verify-isolated-package.mjs'),'utf8');
for(const marker of [
  'mkdtemp',
  '--pack-destination',
  "'install', '--prefix'",
  '@earendil-works/pi-agent-core@^0.83.0',
  '@earendil-works/pi-coding-agent@>=0.83.0',
  'AX_STATE_ROOT',
  'AX_VERIFY_TEMP_ROOT',
  'test-installed-tui-smoke.py',
  'test-advisor-tui-smoke.py',
  'the repository',
  'the npm cache',
  'the global npm prefix',
  'the live Experience state root',
])assert.match(isolatedVerifierSource,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),`isolated verifier contract missing: ${marker}`);
for(const marker of [
  'stagePackageSource',
  'repositoryManifestBefore',
  'canonicalizeExistingDirectory',
  'rejectSymlinkComponents',
  'safeCleanupTemporaryRoot',
  'buildChildEnvironment',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_OFFLINE',
  'PI_TELEMETRY',
  'recursiveManifest',
  'parseNpmPackJson',
  'validatePackResult',
  'artifactManifestEmitted',
  '--self-test',
])assert.match(isolatedVerifierSource,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),`isolated verifier hardening missing: ${marker}`);
for(const marker of [
  'anchoredCleanupScript',
  'runAnchoredCleanup',
  'temporaryParentHandle',
  'temporaryRootHandle',
  'os.fstat',
  'dir_fd=parent_fd',
  'afterValidation',
  'preserve replacement',
])assert.match(isolatedVerifierSource,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),`isolated verifier anchored-cleanup contract missing: ${marker}`);
assert.match(isolatedVerifierSource,/rename\(temporaryRoot,\s*movedOriginal\)[\s\S]*readFile\(replacementSentinel/,'cleanup swap self-test must preserve the replacement sentinel');
assert.doesNotMatch(isolatedVerifierSource,/\.\.\.process\.env/,'isolated children must use an allowlisted environment');
assert.doesNotMatch(packedVerifierSource,/PI_SKILL_LOADER/,'packed skill validation must use only the freshly installed loader');
assert.match(packedVerifierSource,/privateAdvisorArtifactPath/,'packed verifier must reject private Advisor artifacts by every relative path');
const groupedTuiSmokeSource=await readFile(join(root,'scripts/test-installed-tui-smoke.py'),'utf8');
const advisorTuiSmokeSource=await readFile(join(root,'scripts/test-advisor-tui-smoke.py'),'utf8');
for(const [name,text] of [['grouped TUI smoke',groupedTuiSmokeSource],['Advisor TUI smoke',advisorTuiSmokeSource]]){
  assert.match(text,/--session-dir/ ,`${name} must confine Pi sessions explicitly`);
  assert.match(text,/--offline/ ,`${name} must disable startup network operations`);
  assert.match(text,/PI_CODING_AGENT_DIR/ ,`${name} must require an isolated Pi agent directory`);
  assert.match(text,/PI_CODING_AGENT_SESSION_DIR/ ,`${name} must require an isolated Pi session directory`);
}
assert.match(advisorTuiSmokeSource,/finally:[\s\S]*write_bytes|finally:[\s\S]*open\(['"]ab['"]\)/,'Advisor PTY smoke must persist raw bytes on failure');
const advisorTuiDriverSource=await readFile(join(root,'scripts/fixtures/advisor-tui-driver.ts'),'utf8');
assert.doesNotMatch(advisorTuiDriverSource,/generic_advice|generic-(?:nit|concern|blocker)|severity:\s*["']nit["']/,'Advisor PTY fixtures must exercise approved-habit findings only');
for(const marker of ['habit-concern','habit-blocker','◇ Experience · habit violation · concern','◇ Experience · habit violation · blocker']){
  const target=marker.startsWith('◇')?advisorTuiSmokeSource:`${advisorTuiDriverSource}\n${advisorTuiSmokeSource}`;
  assert.match(target,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),`Advisor PTY approved-habit fixture missing: ${marker}`);
}
for(const keyword of ['pi-package','pi-coding-agent','coding-agent','agent-habits','agent-memory','agent-profile','agent-skills','behavioral-learning','context-management','human-in-the-loop','local-first','token-efficiency']){
  assert.ok(packageJson.keywords.includes(keyword),`package discovery keyword missing: ${keyword}`);
}
assert.equal(packageJson.pi?.image,`https://raw.githubusercontent.com/misunders2d/pi-experiences/v${packageJson.version}/docs/images/pi-experiences-habits.png`,'Pi gallery image must point at the immutable matching-release preview asset');
assert.deepEqual(packageJson.omp?.extensions, packageJson.pi?.extensions, 'OMP must load the same extension entry points as Pi');
assert.deepEqual(packageJson.omp?.skills, packageJson.pi?.skills, 'OMP must load the same skills as Pi');
assert.equal(packageJson.omp?.image, packageJson.pi?.image, 'OMP and Pi galleries must use the same immutable preview asset');
assert.equal(packageJson.scripts?.install,undefined);
assert.equal(packageJson.scripts?.postinstall,undefined);
assert.equal(packageJson.scripts?.prepare,undefined,'package installation must never download local model assets');
const configText=formatAgentExperienceConfig(DEFAULT_AGENT_EXPERIENCE_CONFIG);
assert.doesNotMatch(configText,/embedding_(provider|model|dimensions|review_threshold|strong_threshold|timeout|openai)/i);
assert.doesNotMatch(configText,/selector_daily_budget|daily_budget/i,'formatted config must not emit a selector quota');

const readme=await readFile(join(root,'README.md'),'utf8');
const technicalSummary='<summary><strong>For agents and maintainers: technical contract, caveats, and release discipline</strong></summary>';
const technicalSummaryIndex=readme.indexOf(technicalSummary);
assert.notEqual(technicalSummaryIndex,-1,'README must preserve the collapsed agent/maintainer technical contract');
const technicalOpenIndex=readme.lastIndexOf('<details>',technicalSummaryIndex);
const technicalCloseIndex=readme.indexOf('</details>',technicalSummaryIndex);
assert.notEqual(technicalOpenIndex,-1,'agent/maintainer technical contract must be inside <details>');
assert.notEqual(technicalCloseIndex,-1,'agent/maintainer technical contract must close its <details> block');
assert.equal(readme.slice(technicalOpenIndex,technicalSummaryIndex).trim(),'<details>','agent/maintainer technical contract must be collapsed by default');
for(const marker of ['# Pi Experiences — habits for Pi and OMP coding agents','## The missing layer in AI agent improvement','## Why not put every preference in `profile.md`?','## Real-life habits Pi can learn','## How the review-first learning loop works','## Safety model','## Normal workflow','## See when a habit steers an answer','## Local duplicate prevention','## Privacy in plain language','## Frequently asked questions']){
  const index=readme.indexOf(marker);
  assert.ok(index>=0&&index<technicalOpenIndex,`README human-first product section missing before technical contract: ${marker}`);
}
assert.match(readme.slice(0,technicalOpenIndex),/\[CHANGELOG\.md\]\(\.\/CHANGELOG\.md\)/,'README must link the user-facing changelog');
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
for(const phrase of ['exact `When:` \/ `Do:` wording','later, explicit confirmation','bypasses only that repetition threshold','numbered plain-language items','◇ Steered by habit','No marker means that response received no habit guidance','not an LLM message','There is no daily quota']) assert.match(humanReadme,new RegExp(phrase,'i'),`README conversational/transparency contract missing: ${phrase}`);
for(const phrase of ['one short-lived draft and one numbered review snapshot','no raw conversation or confirmation utterance','If it is unavailable, no candidate','expire after 15 minutes','agent_experience.habit_steering','durable marker does not participate in LLM context','system-instruction field','non-TUI modes']) assert.match(technicalReadme,new RegExp(phrase,'i'),`README technical conversational/transparency contract missing: ${phrase}`);
assert.match(technicalReadme,/non-TUI modes[^.]*suppress/is,'README technical contract must fail closed outside the visible TUI');
for(const phrase of ['lower of separate condition and behavior cosine scores','Review threshold: 5,500 basis points','candidate-to-candidate semantic routing is excluded','obsolete pending scoring-method relations','every pending relation involving it','keep-separate decisions survive scoring/cache method upgrades'])assert.match(technicalReadme,new RegExp(phrase,'i'),`README dedupe correction contract missing: ${phrase}`);
const extensionReadme=await readFile(join(root,'extensions/agent-experience/README.md'),'utf8');
const experienceSkill=await readFile(join(root,'skills/agent-experience/SKILL.md'),'utf8');
const runtimeAdvisorReference=await readFile(join(root,'skills/agent-experience/references/runtime-advisor.md'),'utf8');
const experienceSkillWithAdvisorReference=`${experienceSkill}\n${runtimeAdvisorReference}`;
assert.match(experienceSkill,/references\/runtime-advisor\.md/, 'public skill must conditionally route detailed Runtime Advisor work to its reference');
assert.match(experienceSkill,/Pi and OMP|Pi\/OMP/i, 'public skill must trigger for both Pi and OMP Experience operation');
assert.match(experienceSkillWithAdvisorReference,/OMP[\s\S]*native Advisor[\s\S]*no second Advisor/i, 'skill guidance must distinguish OMP native Advisor context from Pi Runtime Advisor');
const experienceEvals=JSON.parse(await readFile(join(root,'skills/agent-experience/evals/evals.json'),'utf8'));
assert.deepEqual(Object.keys(experienceEvals).sort(),['evals','skill_name'],'skill eval corpus must use the repository skill-creator schema');
assert.equal(experienceEvals.skill_name,'agent-experience','skill eval corpus must target agent-experience');
assert.ok(Array.isArray(experienceEvals.evals)&&experienceEvals.evals.length>=9,'skill eval corpus must contain at least nine cases');
const evalIds=new Set();
for(const skillEval of experienceEvals.evals){
  assert.deepEqual(Object.keys(skillEval).sort(),['expectations','expected_output','files','id','prompt'],`skill eval ${skillEval?.id??'<missing>'} has an unsupported or missing field`);
  assert.ok(Number.isInteger(skillEval.id)&&skillEval.id>0,`skill eval id must be a positive integer: ${skillEval.id}`);
  assert.ok(!evalIds.has(skillEval.id),`skill eval id must be unique: ${skillEval.id}`);
  evalIds.add(skillEval.id);
  for(const field of ['prompt','expected_output'])assert.ok(typeof skillEval[field]==='string'&&skillEval[field].trim(),`skill eval ${skillEval.id} must define non-empty ${field}`);
  assert.ok(Array.isArray(skillEval.files)&&skillEval.files.every((file)=>typeof file==='string'),`skill eval ${skillEval.id} files must be strings`);
  assert.ok(Array.isArray(skillEval.expectations)&&skillEval.expectations.length>=2&&skillEval.expectations.every((expectation)=>typeof expectation==='string'&&expectation.trim()),`skill eval ${skillEval.id} must define at least two non-empty expectations`);
}
const evalIntents=experienceEvals.evals.map((skillEval)=>skillEval.expected_output);
for(const [intent,minimum] of [['Should trigger',2],['Should not trigger',2],['Boundary',1],['Contradiction',1],['Adversarial',3]]){
  assert.ok(evalIntents.filter((expected)=>expected.startsWith(`${intent}:`)).length>=minimum,`skill eval corpus must include ${minimum} ${intent.toLowerCase()} case(s)`);
}
const evalCorpus=experienceEvals.evals.map((skillEval)=>[skillEval.prompt,skillEval.expected_output,...skillEval.expectations].join('\n')).join('\n\n');
for(const [pattern,message] of [
  [/Runtime Advisor/i,'Runtime Advisor trigger'],
  [/\/experience setup/i,'grouped setup trigger'],
  [/unrelated Pi extension/i,'unrelated Pi negative boundary'],
  [/generic (?:career |business )?advisor/i,'generic advisor negative boundary'],
  [/approved habits?[\s\S]*complete[\s\S]*policy source/i,'approved-habits-only authority defense'],
  [/later user (?:message|turn)|later, explicit/i,'two-turn habit approval defense'],
  [/private Advisor transcript|raw model output/i,'Advisor privacy defense'],
])assert.match(evalCorpus,pattern,`skill eval corpus must cover ${message}`);
assert.match(evalCorpus,/OMP[\s\S]*native Advisor|native OMP Advisor/i,'skill eval corpus must cover OMP native Advisor integration');
for(const [name,text] of [['extension README',extensionReadme],['public skill',experienceSkill]]){
  assert.match(text,/condition and behavior.*two independent inputs/is,`${name} must preserve separate-field privacy contract`);
  assert.match(text,/candidate-to-candidate/is,`${name} must preserve candidate-pair exclusion`);
  assert.match(text,/obsolete pending scoring-method/is,`${name} must preserve reconciliation contract`);
  assert.match(text,/exact `When:` \/ `Do:`/is,`${name} must document exact conversational habit drafting`);
  assert.match(text,/later user (?:input )?turn|later user message/is,`${name} must preserve two-turn confirmation`);
  assert.match(text,/bypasses only (?:the )?repe(?:at|tit)/is,`${name} must preserve direct-declaration evidence boundary`);
  assert.match(text,/◇ Steered by habit/is,`${name} must document exact response-specific habit steering`);
  assert.match(text,/No marker means that response received no habit guidance/is,`${name} must define marker absence semantics`);
  assert.match(text,/never enters? LLM context|does not participate in LLM context/is,`${name} must keep steering provenance out of model context`);
  assert.match(text,/system-level (?:provider )?instruction|system-instruction field/is,`${name} must keep habit guidance at system authority`);
  assert.match(text,/never (?:as|inject).*user|never user content|never inject.*user/is,`${name} must reject user-role habit guidance`);
  assert.match(text,/non-TUI|interface is not the Pi TUI/is,`${name} must preserve fail-closed interface visibility`);
  assert.match(text,/no daily quota/is,`${name} must preserve unlimited eligible guidance`);
}
for(const [name,text] of [['README',readme],['extension README',extensionReadme],['public skill plus Runtime Advisor reference',experienceSkillWithAdvisorReference]]){
  assert.match(text,/Learning from conversations[\s\S]*Guidance and Advisor[\s\S]*Manage habits[\s\S]*Automation and privacy[\s\S]*Status and help/i,`${name} must present grouped setup before advanced controls`);
  assert.match(text,/Advisor model[\s\S]*(?:Same as habit assessment|inherit(?:s|ance)[\s\S]*habit.assessment)/i,`${name} must explain separate Advisor model inheritance`);
  assert.match(text,/second model[\s\S]*incremental/i,`${name} must disclose incremental Advisor review`);
  assert.match(text,/read[\s\S]*grep[\s\S]*glob[\s\S]*(?:confined|workspace)/i,`${name} must document confined Advisor workspace tools`);
  assert.match(text,/approved (?:Experience )?habits?[\s\S]*complete[\s\S]*policy source[\s\S]*(?:generic|reviewer reasoning)[\s\S]*(?:cannot|never)/i,`${name} must limit Runtime Advisor authority to approved habits`);
  assert.match(text,/concern[\s\S]*blocker[\s\S]*steer/i,`${name} must explain approved-habit severity delivery`);
  assert.match(text,/plan mode[\s\S]*visible/i,`${name} must document visible-only Advisor states`);
  assert.match(text,/Learning[\s\S]*(?:off|disabled)[\s\S]*no Advisor observation/i,`${name} must preserve the Advisor learning evidence gate`);
  assert.match(text,/never persist[\s\S]*Advisor transcript[\s\S]*raw model output[\s\S]*aliases[\s\S]*scores/i,`${name} must document Advisor private-state non-persistence`);
  assert.match(text,/Pi 0\.83[\s\S]*blockable pre-execution `tool_call`/i,`${name} must state stock Pi's blockable pre-execution hook accurately`);
  assert.match(text,/Advisor[\s\S]*intentionally never registers or uses (?:that|Pi's)[\s\S]*never (?:pre-blocks|vetoes)/i,`${name} must state deliberate Advisor non-use and the non-blocking product rule`);
  assert.match(text,/followUp[\s\S]*nextTurn/i,`${name} must state the unsupported forced-continuation paths`);
}
const validationGuide=await readFile(join(root,'extensions/agent-experience/VALIDATION.md'),'utf8');
assert.match(validationGuide,/verify-isolated-package\.mjs/,'validation guide must use the isolated package gate');
for(const phrase of ['collapsed and expanded','approved-habit concern and blocker','habit','wide and narrow','one card per update','live Experience state'])assert.match(validationGuide,new RegExp(phrase,'i'),`validation guide missing Advisor PTY evidence: ${phrase}`);
assert.match(changelog,/^## \[Unreleased\][\s\S]*Runtime Advisor/m,'Unreleased changelog must document Runtime Advisor');

const selectorSource=await readFile(join(root,'extensions/agent-experience/src/selector.ts'),'utf8');
const configSource=await readFile(join(root,'extensions/agent-experience/src/config.ts'),'utf8');
assert.doesNotMatch(selectorSource,/daily_budget|dailyBudget|countDailySelectorInjections/,'selector runtime must never enforce a daily guidance quota');
assert.doesNotMatch(configSource,/selector_daily_budget|selector\.daily_budget/,'active config schema must not expose a daily guidance quota');
const steeringSource=await readFile(join(root,'extensions/agent-experience/src/steering-note.ts'),'utf8');
assert.match(steeringSource,/agent_experience\.habit_steering/,'steering custom-entry type must remain stable');
assert.doesNotMatch(steeringSource,/sendMessage|prompt_hash|confidence_bp|checksum|source_refs?|provider|model/,'steering entry module must not persist context-bearing or internal fields');
const extensionSource=await readFile(join(root,'extensions/agent-experience/index.ts'),'utf8');
assert.doesNotMatch(extensionSource,/pi\.on\(["']tool_call["']/,`Runtime Advisor must never register Pi's pre-execution blocking hook`);
const providerGuidanceSource=await readFile(join(root,'extensions/agent-experience/src/provider-guidance.ts'),'utf8');
assert.doesNotMatch(extensionSource,/agent_experience\.habit_guidance/,'habit guidance must never be emitted as a custom/user conversation message');
assert.match(extensionSource,/pi\.on\("before_provider_request"/,'habit guidance must use the pre-provider payload boundary');
assert.match(extensionSource,/appendHabitGuidanceToProviderPayload\(ctx\.model\?\.api, event\.payload, state\.guidance\)/,'provider guidance must dispatch by the exact current model API');
assert.match(providerGuidanceSource,/KNOWN_GUIDANCE_APIS/,'provider guidance must use a closed known-API allowlist');
assert.match(providerGuidanceSource,/agent_experience_response_guidance/,'provider guidance must be retry-idempotent');
assert.doesNotMatch(providerGuidanceSource,/console\.|writeFile|appendFile|sendMessage|sendUserMessage/,'transient provider guidance must not log, persist, or create conversation messages');
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
await esbuild.build({entryPoints:[join(root,'extensions/agent-experience/index.ts')],bundle:true,platform:'node',format:'esm',target:['node22'],write:false,logLevel:'silent',external:['@earendil-works/pi-ai/*','@earendil-works/pi-agent-core','@earendil-works/pi-coding-agent','@earendil-works/pi-tui']});
await esbuild.build({entryPoints:[join(root,'runtime/agent-experience/local-embedding-worker.mjs')],bundle:false,platform:'node',format:'esm',target:['node22'],write:false,logLevel:'silent'});
console.log('agent-experience source/import/package/eval-schema checks passed');
