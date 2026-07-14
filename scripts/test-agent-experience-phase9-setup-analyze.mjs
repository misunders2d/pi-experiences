#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension, { __buildAgentExperienceConsolidationSystemPromptForTest, __formatAgentExperienceAnalyzeFailureForTest, __getAgentExperienceDetailPanelOptionsForTest, __normalizeAgentExperienceConsolidationModelOutputForTest, __setAgentExperienceConsolidationAdapterForTest, __setAgentExperienceSelectorAdapterForTest, __setAgentExperienceSelectorEmbeddingAdapterForTest } from '../extensions/agent-experience/index.ts';
import { getAgentExperiencePaths, readAgentExperienceConfig, setAgentExperienceCaptureActive, setAgentExperienceConsolidationEnabled, setAgentExperienceConsolidationModel, setAgentExperienceSelectorModel, writeAgentExperienceConfig } from '../extensions/agent-experience/src/paths.ts';
import { canonicalJson } from '../extensions/agent-experience/src/storage/checksum.ts';
import { ensurePrivateRoot, resolvePrivatePath } from '../extensions/agent-experience/src/storage/private-root.ts';
import { observationChecksumForTest, observationPairRefForTest } from '../extensions/agent-experience/src/storage/observations.ts';
import { initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { listHabitDuplicates, upsertHabitDuplicate } from '../extensions/agent-experience/src/semantic/storage.ts';
import { LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_PROVIDER } from '../extensions/agent-experience/src/semantic/local-model-manifest.ts';

function makeObservation({ seq, previous = null, createdAt, user, assistant }) {
  const base = {
    id: `setup-analyze-${seq}`,
    seq,
    user_id: 'owner',
    origin: { source: 'test', command: 'setup-analyze' },
    prev_pair_ref: previous ? observationPairRefForTest(previous) : null,
    payload_redacted: {
      kind: 'conversation_pair_v1',
      close_reason: 'agent_end',
      user_text_redacted: user,
      assistant_text_redacted: assistant,
      user_char_count: user.length,
      assistant_char_count: assistant.length,
      input_created_at: createdAt,
      completed_at: createdAt,
    },
    created_at: createdAt,
  };
  return { ...base, checksum: observationChecksumForTest(base) };
}

async function writeObservationFile(root, records) {
  await ensurePrivateRoot(root);
  await rm(resolvePrivatePath(root, 'observations-tail.json'), { force: true });
  await rm(resolvePrivatePath(root, 'observations.idx'), { force: true });
  await writeFile(resolvePrivatePath(root, 'observations.jsonl'), records.map((record) => canonicalJson(record)).join('\n') + '\n', { mode: 0o600 });
}

async function waitForNote(pattern, label) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (notes.some((note) => pattern.test(note.message || ''))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(label);
}

function makePi() {
  const commands = new Map();
  const handlers = new Map();
  const fakePi = {
    registerCommand(name, options) { commands.set(name, options); },
    on(event, handler) { handlers.set(event, handler); },
    registerTool() {},
    registerEntryRenderer() {},
    appendEntry() {},
    registerFlag() { throw new Error('no flags'); },
    registerShortcut() { throw new Error('no shortcuts'); },
  };
  agentExperienceExtension(fakePi);
  return { commands, handlers };
}

const temp = await mkdtemp(join(tmpdir(), 'agent-experience-phase9-'));
process.env.AX_STATE_ROOT = join(temp, 'state');
process.env.AX_USER_ID = 'owner';
const paths = getAgentExperiencePaths();
const { commands, handlers } = makePi();
const notes = [];
let setupChoices = [];
let setupInputs = [];
const availableModel = { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT 5.5', input: ['text'] };
const slashModel = { provider: 'openrouter', id: 'openai/gpt-5', name: 'OpenRouter GPT 5', input: ['text'] };
const unavailableModel = { provider: 'example', id: 'unauth', name: 'Unauthenticated', input: ['text'] };
const extraAuthModels = Array.from({ length: 40 }, (_, index) => ({ provider: 'openrouter', id: `bulk-${index}`, name: `Bulk ${index}`, input: ['text'] }));
let authHeadersAvailable = true;
const modelRegistry = {
  getAvailable() { return [availableModel, slashModel, unavailableModel, ...extraAuthModels]; },
  find(provider, modelId) {
    if (provider === availableModel.provider && modelId === availableModel.id) return availableModel;
    if (provider === unavailableModel.provider && modelId === unavailableModel.id) return unavailableModel;
    if (provider === slashModel.provider && modelId === slashModel.id) return slashModel;
    return extraAuthModels.find((model) => model.provider === provider && model.id === modelId);
  },
  hasConfiguredAuth(model) { return model !== unavailableModel; },
  async getApiKeyAndHeaders() { return authHeadersAvailable ? { ok: true, apiKey: 'test-not-used' } : { ok: false }; },
};
const ctx = {
  cwd: process.cwd(),
  mode: 'tui',
  sessionManager: { getSessionId: () => 'phase9-main', getSessionFile: () => join(temp, 'phase9-main.jsonl') },
  hasUI: true,
  modelRegistry,
  model: availableModel,
  ui: {
    async select(title, options) {
      notes.push({ title, options });
      if (/Choose model/.test(title)) {
        assert.ok(options.includes('openai-codex/gpt-5.5'), 'authenticated model should be listed');
        assert.ok(!options.includes('example/unauth'), 'unauthenticated model must not be listed');
        assert.ok(options.includes('Search authenticated models'), 'model picker must offer search instead of giant all-model list');
        assert.ok(options.includes('Enter exact model id'), 'model picker must allow exact model id entry');
        assert.ok(!options.some((option) => /^Show all authenticated models/.test(option)), 'model picker must not dump all models');
        assert.ok(options.length <= 11, 'default model picker must stay short and usable');
        if (setupChoices[0] === 'Search authenticated models') return setupChoices.shift();
        if (setupChoices[0] === 'Enter exact model id') return setupChoices.shift();
        return 'openai-codex/gpt-5.5';
      }
      if (/Search results/.test(title)) {
        assert.ok(options.length <= 27, 'search results must be capped and navigable');
        return setupChoices.shift() ?? options[0];
      }
      if (/Review suggested habits/.test(title)) return setupChoices.shift() ?? options[0];
      if (/What do you want/.test(title)) return 'Approve';
      const next = setupChoices.shift();
      if (next !== undefined) return next;
      return undefined;
    },
    input(title, placeholder) { notes.push({ title, placeholder, level: 'input' }); return setupInputs.shift(); },
    notify(message, level) { notes.push({ message, level }); },
  },
};

const selectorVector = new Float32Array(LOCAL_EMBEDDING_DIMENSIONS);
selectorVector[0] = 1;
const selectorEmbedding = {
  id: `${LOCAL_EMBEDDING_PROVIDER}:${LOCAL_EMBEDDING_MODEL}:${LOCAL_EMBEDDING_DIMENSIONS}`,
  provider: LOCAL_EMBEDDING_PROVIDER,
  model: LOCAL_EMBEDDING_MODEL,
  dimensions: LOCAL_EMBEDDING_DIMENSIONS,
  async embed(texts, { signal } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    return texts.map(() => selectorVector);
  },
};
__setAgentExperienceSelectorEmbeddingAdapterForTest(selectorEmbedding);
__setAgentExperienceSelectorAdapterForTest({
  async select({ candidateIds, signal }) {
    assert.ok(signal instanceof AbortSignal);
    return { schema_version: 2, judgments: candidateIds.map((id) => ({ id, applicable: true, confidence_bp: 9500, reason: 'current_applicability' })) };
  },
});

setupChoices = ['[ ] Save chat examples locally', 'Choose model for habit learning (openai-codex/gpt-5.5)', 'Done'];
await commands.get('experience').handler('setup', ctx);
let configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.enabled, true);
assert.equal(configResult.config.capture_enabled, true);
assert.equal(configResult.config.consolidation_model, 'openai-codex/gpt-5.5');
assert.equal(configResult.config.consolidation_enabled, true);
assert.equal(configResult.config.timer_enabled, false);

setupChoices = ['Choose model for habit learning (openai-codex/gpt-5.5)', 'Search authenticated models', 'openrouter/openai/gpt-5', 'Choose model for habit learning (openrouter/openai/gpt-5)', 'openai-codex/gpt-5.5', 'Done'];
setupInputs = ['gpt-5'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.consolidation_model, 'openai-codex/gpt-5.5', 'model ids containing slash can be selected by search, then normal model can be restored');
assert.ok(notes.some((note) => /Habit-learning model: openrouter\/openai\/gpt-5/.test(note.message || '')), 'OpenRouter slash model id should save successfully from searchable picker');
setupChoices = ['Choose model for habit learning (openai-codex/gpt-5.5)', 'Enter exact model id', 'Done'];
setupInputs = ['openrouter/openai/gpt-5'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.consolidation_model, 'openrouter/openai/gpt-5', 'exact model entry must support provider/model ids containing slash');
setupChoices = ['Choose model for habit learning (openrouter/openai/gpt-5)', 'Enter exact model id', 'Done'];
setupInputs = ['example/unauth'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.consolidation_model, 'openrouter/openai/gpt-5', 'unauthenticated exact model entry must be rejected without changing config');
await setAgentExperienceConsolidationModel('openai-codex/gpt-5.5', paths);
ctx.ui.custom = async (factory) => {
  let resolved = false;
  let value;
  const component = await factory({ requestRender() {} }, {}, {}, (result) => { resolved = true; value = result; });
  const initial = component.render(80).join('\n');
  if (/Agent Experience setup/.test(initial)) {
    assert.match(initial, /\[x\] ON|\[ \] OFF/, 'setup panel must show checkbox-style ON/OFF rows');
    assert.match(initial, /Choose model for habit learning\s+openai-codex\/gpt-5\.5/, 'setup panel must show current habit-learning model instead of generic open');
    assert.match(initial, /Choose model for habit assessment\s+openai-codex\/gpt-5\.4-mini/, 'setup panel must show the separate current habit-assessment model');
    assert.match(initial, /Space\/Enter toggles/, 'setup panel must advertise Space toggles');
    assert.match(initial, /Keep analyzed source examples\s+7 days/, 'setup panel must expose privacy retention without an advanced command');
    const next = setupChoices.shift();
    value = next === 'Choose model for habit learning' ? 'model' : next === 'Done' ? 'done' : undefined;
    resolved = true;
    return value;
  }
  assert.match(initial, /Current model: openai-codex\/gpt-5\.5/, 'live model picker must show the currently selected model');
  assert.match(initial, /openai-codex\/gpt-5\.5\s+\(current\)/, 'live model picker must mark the current model in the list');
  assert.match(initial, /Recommended authenticated models/, 'live model picker should start with recommendations');
  assert.doesNotMatch(initial, /bulk-39/, 'live model picker must not dump all models before typing');
  for (const ch of '5.5') component.handleInput(ch);
  const filtered = component.render(80).join('\n');
  assert.match(filtered, /openai-codex\/gpt-5\.5/, 'typing 5.5 should immediately show matching model');
  assert.doesNotMatch(filtered, /openrouter\/bulk-0/, 'typing 5.5 should filter unrelated models out');
  component.handleInput('\r');
  assert.equal(resolved, true, 'enter should select the live-filtered model');
  return value;
};
setupChoices = ['Choose model for habit learning', 'Done'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.consolidation_model, 'openai-codex/gpt-5.5', 'live typeahead picker should save selected filtered model');
delete ctx.ui.custom;

configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.selector_enabled, false);
const learningModelBeforeAssessmentChoice = configResult.config.consolidation_model;
setupChoices = ['Choose model for habit assessment (openai-codex/gpt-5.4-mini)', 'Search authenticated models', 'openrouter/openai/gpt-5', 'Done'];
setupInputs = ['gpt-5'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.selector_model, 'openrouter/openai/gpt-5', 'habit-assessment picker must save an authenticated provider/model id');
assert.equal(configResult.config.selector_enabled, false, 'changing assessment model must not enable reminders');
assert.equal(configResult.config.consolidation_model, learningModelBeforeAssessmentChoice, 'changing assessment model must not change habit-learning model');
assert.ok(notes.some((note) => /Habit-assessment model: openrouter\/openai\/gpt-5/.test(note.message || '')), 'assessment picker must report the saved model clearly');

authHeadersAvailable = false;
setupChoices = ['Choose model for habit assessment (openrouter/openai/gpt-5)', 'Enter exact model id', 'Done'];
setupInputs = ['openai-codex/gpt-5.5'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.selector_model, 'openrouter/openai/gpt-5', 'failed assessment-model auth must leave config unchanged');
assert.equal(configResult.config.selector_enabled, false, 'failed assessment-model auth must not toggle reminders');
assert.ok(notes.some((note) => /Habit-assessment model unchanged because authentication failed/.test(note.message || '')), 'assessment-model auth failure must be visible');
authHeadersAvailable = true;
await setAgentExperienceSelectorModel('openai-codex/gpt-5.4-mini', paths);

await setAgentExperienceConsolidationEnabled(false, paths);
setupChoices = ['Analyze saved examples now', 'Done'];
await commands.get('experience').handler('setup', ctx);
assert.ok(notes.some((note) => /Choose a habit-learning model/.test(note.message || '')), 'analyze must not run when model learning is disabled');
await setAgentExperienceConsolidationModel('openai-codex/gpt-5.5', paths);
notes.length = 0;
authHeadersAvailable = false;
setupChoices = ['Analyze saved examples now', 'Done'];
await commands.get('experience').handler('setup', ctx);
assert.ok(notes.some((note) => /Current model: openai-codex\/gpt-5\.5/.test(note.message || '') && /model auth unavailable/.test(note.message || '')), 'analyze must preflight real model auth before showing started');
assert.ok(!notes.some((note) => /Analyze saved examples started/.test(note.message || '')), 'analyze must not show started when auth preflight fails');
authHeadersAvailable = true;
notes.length = 0;
setupChoices = ['Analyze saved examples now', 'Done'];
await commands.get('experience').handler('setup', ctx);
assert.ok(notes.some((note) => /No readable saved examples|No saved examples/.test(note.message || '')), 'analyze must preflight saved examples before showing started');
assert.ok(!notes.some((note) => /Analyze saved examples started/.test(note.message || '')), 'analyze must not show started when there are no saved examples');

const r1 = makeObservation({ seq: 1, createdAt: '2026-07-08T08:00:00.000Z', user: 'please be concise', assistant: 'understood, concise answer' });
const r2 = makeObservation({ seq: 2, previous: r1, createdAt: '2026-07-08T09:00:00.000Z', user: 'too much fluff, give evidence only', assistant: 'short evidence list' });
const r3 = makeObservation({ seq: 3, previous: r2, createdAt: '2026-07-09T08:00:00.000Z', user: 'again: concise and evidence-backed', assistant: 'concise evidence-backed answer' });
await writeObservationFile(paths.root, [r1, r2, r3]);

const strictNormalizeInput = {
  model: 'openai-codex/gpt-5.5',
  userId: 'owner',
  observations: [r1, r2, r3].map((record) => ({ ...record, file_generation: 'active' })),
  expected: { file_generation: 'active', seq_start: 1, seq_end: 3, read_checksum: r3.checksum },
};
const strictRawOutput = {
  schema_version: 1,
  user_id: 'owner',
  file_generation: 'active',
  batch_id: 'strict-refs',
  model: 'openai-codex/gpt-5.5',
  created_at: '2026-07-09T09:00:00.000Z',
  observations_read: { seq_start: 1, seq_end: 3, checksum: r3.checksum },
  proposals: [{
    proposal_id: 'strict-p1',
    kind: 'habit_candidate',
    candidate_key: 'strict-ref-check',
    condition: 'When evidence is required',
    behavior: 'Use exact checked source references',
    polarity: 1,
    confidence_bp: 9000,
    source_refs: [r1, r2, r3].map((record) => ({ file_generation: 'active', seq: record.seq, checksum: record.checksum })),
    evidence_summary: 'Supported by three checked refs across two days.',
    ambiguous: false,
  }],
};
const liveSystemPrompt = __buildAgentExperienceConsolidationSystemPromptForTest();
assert.match(liveSystemPrompt, /reusable behavioral essence/, 'live setup analyzer prompt must require generalized habits');
assert.match(liveSystemPrompt, /one-off names such as Agent Experience/, 'live setup analyzer prompt must reject one-project habit labels');
assert.match(liveSystemPrompt, /return no proposal/, 'live setup analyzer prompt must suppress project-specific-only patterns');
const rotatedGeneration = 'g-20260710132454239-test';
const rotatedSystemPrompt = __buildAgentExperienceConsolidationSystemPromptForTest(rotatedGeneration);
const rotatedOutputSchema = JSON.parse(rotatedSystemPrompt.split('\n').at(-1));
assert.equal(rotatedOutputSchema.file_generation, rotatedGeneration, 'Analyze schema must use the current rotated observation generation');
assert.equal(rotatedOutputSchema.proposals[0].source_refs[0].file_generation, rotatedGeneration, 'Analyze source-ref schema must use the current rotated observation generation');
assert.ok(!rotatedSystemPrompt.includes('"file_generation":"active"'), 'rotated Analyze schema must not retain the legacy active-generation placeholder');
assert.match(__formatAgentExperienceAnalyzeFailureForTest(new Error('Watermark would move backward')), /already analyzed/, 'stale duplicate analyze errors must be translated to human action');
assert.equal(__getAgentExperienceDetailPanelOptionsForTest().overlay, false, 'review/status detail panels should replace the editor instead of overlaying image preview lines');
assert.equal(__normalizeAgentExperienceConsolidationModelOutputForTest(strictRawOutput, strictNormalizeInput).proposals.length, 1);
const weakOneOff = __normalizeAgentExperienceConsolidationModelOutputForTest({ ...strictRawOutput, proposals: [{ ...strictRawOutput.proposals[0], source_refs: [{ file_generation: 'active', seq: 1, checksum: r1.checksum }] }] }, strictNormalizeInput);
assert.equal(weakOneOff.proposals.length, 1, 'one-off model output may be retained only as hidden cross-batch evidence');
assert.equal(weakOneOff.proposals[0].evidence_stage, 'collecting', 'one-off model output must not enter the human review queue');
const canonicalizedRefs = __normalizeAgentExperienceConsolidationModelOutputForTest({ ...strictRawOutput, proposals: [{ ...strictRawOutput.proposals[0], source_refs: [{ seq: 1 }, { seq: 2, checksum: 'bad-copy' }, { file_generation: 'active', seq: 3, checksum: 'also-bad-copy' }] }] }, strictNormalizeInput);
assert.deepEqual(canonicalizedRefs.proposals[0].source_refs, [
  { file_generation: 'active', seq: 1, checksum: r1.checksum },
  { file_generation: 'active', seq: 2, checksum: r2.checksum },
  { file_generation: 'active', seq: 3, checksum: r3.checksum },
], 'live normalizer must canonicalize source ref checksums from local observations');
assert.throws(() => __normalizeAgentExperienceConsolidationModelOutputForTest({ ...strictRawOutput, proposals: [{ ...strictRawOutput.proposals[0], source_refs: [{ file_generation: 'wrong-generation', seq: 1, checksum: 'wrong' }, { file_generation: 'wrong-generation', seq: 2, checksum: 'wrong' }, { file_generation: 'wrong-generation', seq: 3, checksum: 'wrong' }] }] }, strictNormalizeInput), /generation_mismatch/, 'normalizer must reject wrong model source ref generation');
const rotatedNormalizeInput = {
  ...strictNormalizeInput,
  observations: strictNormalizeInput.observations.map((record) => ({ ...record, file_generation: rotatedGeneration })),
  expected: { ...strictNormalizeInput.expected, file_generation: rotatedGeneration },
};
assert.throws(() => __normalizeAgentExperienceConsolidationModelOutputForTest(strictRawOutput, rotatedNormalizeInput), /generation_mismatch/, 'strict normalizer must still reject a copied active placeholder for rotated observations');
assert.throws(() => __normalizeAgentExperienceConsolidationModelOutputForTest({ ...strictRawOutput, proposals: [{ ...strictRawOutput.proposals[0], source_refs: [{ seq: 999 }] }] }, strictNormalizeInput), /invalid_source_ref/);

__setAgentExperienceConsolidationAdapterForTest({
  async generate(input) {
    assert.equal(input.model, 'openai-codex/gpt-5.5');
    assert.deepEqual(input.observations.map((record) => record.seq), [1, 2, 3]);
    return {
      schema_version: 1,
      user_id: input.userId,
      file_generation: input.expected.file_generation,
      batch_id: 'manual-setup-test',
      model: input.model,
      created_at: '2026-07-09T09:00:00.000Z',
      observations_read: { seq_start: input.expected.seq_start, seq_end: input.expected.seq_end, checksum: input.expected.read_checksum },
      proposals: [{
        proposal_id: 'setup-proposal-1',
        kind: 'habit_candidate',
        candidate_key: 'concise-evidence-backed',
        condition: 'When answering Sergey after a correction',
        behavior: 'Answer concisely and cite concrete evidence before claiming success',
        polarity: 1,
        confidence_bp: 9200,
        source_refs: input.observations.map((record) => ({ file_generation: record.file_generation, seq: record.seq, checksum: record.checksum })),
        evidence_summary: 'User repeatedly asked for concise evidence-backed answers.',
        ambiguous: false,
      }],
    };
  },
});

setupChoices = ['Analyze saved examples now', 'Done'];
await commands.get('experience').handler('setup', ctx);
assert.ok(notes.some((note) => /Analyze saved examples started/.test(note.message || '')), 'analyze-now must start without blocking setup');
assert.ok(!notes.some((note) => /Agent Experience setup closed/.test(note.message || '')), 'setup should close silently after Analyze starts so completion cannot print behind the menu');
await waitForNote(/New suggested habits created: 1/, 'analyze-now must create one suggestion');

notes.length = 0;
let reviewPanelSeen = false;
let safetyActionPanelSeen = false;
ctx.ui.custom = async (factory) => {
  let resolved = false;
  let value;
  const component = await factory({ requestRender() {} }, {}, {}, (result) => { resolved = true; value = result; });
  const rendered = component.render(100).join('\n');
  if (/Agent Experience setup/.test(rendered)) {
    const next = setupChoices.shift();
    value = next === 'Review suggested habits' ? 'review' : next === 'Done' ? 'done' : undefined;
    resolved = true;
    return value;
  }
  if (/Approved-habit safety file is missing/.test(rendered)) {
    assert.match(rendered, /Space\/Enter run/, 'safety file action panel must advertise Space/Enter');
    safetyActionPanelSeen = true;
    component.handleInput(' ');
    assert.equal(resolved, true, 'safety file action panel Space should choose selected action');
    return value;
  }
  assert.match(rendered, /Suggested habit/, 'review details must render inside the focused review panel');
  assert.match(rendered, /When:/, 'review panel must include full habit details');
  assert.match(rendered, /Action:/, 'review panel must include approve/reject/back actions');
  assert.match(rendered, /48;5;235/, 'review panel must render with a solid background');
  reviewPanelSeen = true;
  component.handleInput('a');
  assert.equal(resolved, true, 'review panel keyboard shortcut should choose approve');
  return value;
};
setupChoices = ['Review suggested habits', undefined, 'Create default safety file and continue', 'Done'];
await commands.get('experience').handler('setup', ctx);
delete ctx.ui.custom;
assert.equal(reviewPanelSeen, true, 'setup review must use the focused review panel');
assert.equal(safetyActionPanelSeen, true, 'missing safety file prompt must use Space-aware action panel');
assert.ok(notes.some((note) => /Approved suggestion/.test(note.message || '')), 'setup review must approve suggestion from setup flow');
assert.ok(!notes.some((note) => /Suggested habit\n|Suggested habits waiting for review|When:/.test(note.message || '')), 'review details must not be dumped into chat history notifications');
assert.equal(existsSync(resolvePrivatePath(paths.root, 'law.md')), true, 'first-run approval must create missing safety file inside setup');

configResult = await readAgentExperienceConfig(paths);
await writeAgentExperienceConfig({ ...configResult.config, selector_model: 'openai-codex/gpt-5.5' }, paths);
authHeadersAvailable = false;
setupChoices = ['[ ] Use approved habits before replies', 'Done'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.selector_enabled, false, 'missing judge auth must keep reminders off before local asset preparation');
authHeadersAvailable = true;
setupChoices = ['[ ] Use approved habits before replies', 'Prepare private local vectors and enable reminders', 'Done'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.selector_enabled, true);
assert.ok(notes.some((note) => /local vectors first|bounded openai-codex\/gpt-5\.5 applicability call/i.test(note.message || '')), 'enable flow must disclose mandatory local vectors plus one bounded judge call');

notes.length = 0;
let statusPanelSeen = false;
ctx.ui.custom = async (factory) => {
  let value;
  const component = await factory({ requestRender() {} }, {}, {}, (result) => { value = result; });
  const rendered = component.render(100).join('\n');
  if (/Agent Experience setup/.test(rendered)) {
    const next = setupChoices.shift();
    return next === 'Show current settings' ? 'status' : next === 'Done' ? 'done' : value;
  }
  assert.match(rendered, /Agent Experience current settings/, 'show current settings should open an in-panel status view');
  assert.match(rendered, /Habit-learning model: openai-codex\/gpt-5\.5/, 'status panel should show current habit-learning model');
  assert.match(rendered, /Habit-assessment model: openai-codex\/gpt-5\.5/, 'status panel should show current habit-assessment model');
  statusPanelSeen = true;
  component.handleInput('\r');
  return value;
};
setupChoices = ['Show current settings', 'Done'];
await commands.get('experience').handler('setup', ctx);
delete ctx.ui.custom;
assert.equal(statusPanelSeen, true, 'show current settings must not post behind the setup overlay');
assert.ok(!notes.some((note) => /^Experience:/.test(note.message || '')), 'show current settings from setup should stay in-panel, not chat history');

notes.length = 0;
let helpPanelSeen = false;
ctx.ui.custom = async (factory) => {
  let value;
  const component = await factory({ requestRender() {} }, {}, {}, (result) => { value = result; });
  const rendered = component.render(100).join('\n');
  if (/Agent Experience setup/.test(rendered) && /Explain these settings/.test(rendered)) {
    const next = setupChoices.shift();
    return next === 'Explain these settings' ? 'help' : next === 'Done' ? 'done' : value;
  }
  assert.match(rendered, /Agent Experience setup help/, 'explain settings should open an in-panel help view');
  assert.match(rendered, /Use arrow keys/, 'help panel should contain setup help text');
  helpPanelSeen = true;
  component.handleInput('\r');
  return value;
};
setupChoices = ['Explain these settings', 'Done'];
await commands.get('experience').handler('setup', ctx);
delete ctx.ui.custom;
assert.equal(helpPanelSeen, true, 'explain settings must not post behind the setup overlay');
assert.ok(!notes.some((note) => /Use arrow keys to move/.test(note.message || '')), 'explain settings from setup should stay in-panel, not chat history');

let storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
let active;
try {
  const rows = storage.db.prepare("SELECT id, condition, behavior, checksum FROM habits WHERE user_id = 'owner' AND status = 'active'").all();
  assert.equal(rows.length, 1, 'approved eligible habit should be active');
  active = rows[0];
  assert.match(active.behavior, /concrete evidence/);
  insertStorageRecord(storage.db, 'habits', {
    id: 'candidate-hidden-from-approved-browser',
    userId: 'owner',
    data: {
      record_kind: 'habit_candidate',
      schema_version: 1,
      status: 'candidate',
      condition: 'When candidate suggestions exist',
      behavior: 'This candidate must not appear in approved habits browser',
      polarity: 1,
      confidence_bp: 9100,
      source_refs: [{ file_generation: 'active', seq: 1, checksum: r1.checksum }, { file_generation: 'active', seq: 2, checksum: r2.checksum }, { file_generation: 'active', seq: 3, checksum: r3.checksum }],
    },
    now: '2026-07-09T09:05:00.000Z',
  });
} finally {
  storage.db.close();
}

notes.length = 0;
let approvedHabitListSeen = false;
let approvedHabitDetailSeen = false;
let approvedHabitActionDone = false;
ctx.ui.custom = async (factory) => {
  let value;
  const component = await factory({ requestRender() {} }, {}, {}, (result) => { value = result; });
  const rendered = component.render(110).join('\n');
  assert.doesNotMatch(rendered, new RegExp(active.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'approved habits UI must not expose habit id');
  assert.doesNotMatch(rendered, new RegExp(active.checksum.slice(0, 16)), 'approved habits UI must not expose checksum');
  assert.doesNotMatch(rendered, /source_refs|prompt_hash/, 'approved habits UI must not expose internal source refs or prompt hashes');
  if (/Agent Experience setup/.test(rendered)) {
    assert.match(rendered, /Review approved habits/, 'setup panel must include approved habit browser row');
    const next = setupChoices.shift();
    return next === 'Review approved habits' ? 'habits' : next === 'Done' ? 'done' : value;
  }
  if (/Review approved habits/.test(rendered)) {
    if (approvedHabitActionDone) return undefined;
    assert.match(rendered, /\[active\]/, 'approved habit browser must show active habits');
    assert.match(rendered, /Answer concisely and cite concrete e/, 'approved habit browser must show actual approved habit');
    assert.doesNotMatch(rendered, /candidate must not appear/, 'approved habit browser must exclude candidate suggestions');
    approvedHabitListSeen = true;
    component.handleInput('\r');
    return value;
  }
  assert.match(rendered, /Approved habit #/, 'approved habit detail panel should open after selecting a habit');
  assert.match(rendered, /Status: active/, 'approved habit detail panel must show active status');
  assert.match(rendered, /When:/, 'approved habit detail panel must show condition');
  assert.match(rendered, /Do:/, 'approved habit detail panel must show behavior');
  assert.match(rendered, /Disable habit/, 'active habit detail panel must offer disable action');
  assert.match(rendered, /Archive\/hide habit/, 'active habit detail panel must offer archive/hide action');
  approvedHabitDetailSeen = true;
  approvedHabitActionDone = true;
  component.handleInput(' ');
  return value;
};
setupChoices = ['Review approved habits', undefined, 'Done'];
await commands.get('experience').handler('setup', ctx);
delete ctx.ui.custom;
assert.equal(approvedHabitListSeen, true, 'setup must open approved habits list panel');
assert.equal(approvedHabitDetailSeen, true, 'setup must open approved habit detail/action panel');
assert.ok(notes.some((note) => /Habit disabled/.test(note.message || '')), 'setup approved-habit action must disable active habit');
assert.ok(!notes.some((note) => String(note.message || '').includes(active.id) || String(note.message || '').includes(active.checksum.slice(0, 16))), 'approved-habit notifications must not expose id/checksum');
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
try {
  const rows = storage.db.prepare("SELECT id, status FROM habits WHERE user_id = 'owner' AND id = ?").all(active.id);
  assert.equal(rows[0].status, 'disabled', 'setup approved-habit action must persist disabled status');
} finally {
  storage.db.close();
}

notes.length = 0;
let disabledHabitListSeen = false;
let reenableDetailSeen = false;
let reenableActionDone = false;
ctx.ui.custom = async (factory) => {
  let value;
  const component = await factory({ requestRender() {} }, {}, {}, (result) => { value = result; });
  const rendered = component.render(110).join('\n');
  assert.doesNotMatch(rendered, new RegExp(active.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'approved habits re-enable UI must not expose habit id');
  assert.doesNotMatch(rendered, new RegExp(active.checksum.slice(0, 16)), 'approved habits re-enable UI must not expose old checksum');
  if (/Agent Experience setup/.test(rendered)) {
    const next = setupChoices.shift();
    return next === 'Review approved habits' ? 'habits' : next === 'Done' ? 'done' : value;
  }
  if (/Review approved habits/.test(rendered)) {
    if (reenableActionDone) return undefined;
    assert.match(rendered, /\[disabled\]/, 'approved habit browser must include disabled habits');
    disabledHabitListSeen = true;
    component.handleInput('\r');
    return value;
  }
  assert.match(rendered, /Status: disabled/, 'approved habit detail panel must show disabled status');
  assert.match(rendered, /Re-enable habit/, 'disabled habit detail panel must offer re-enable action');
  assert.match(rendered, /Archive\/hide habit/, 'disabled habit detail panel must offer archive/hide action');
  reenableDetailSeen = true;
  reenableActionDone = true;
  component.handleInput(' ');
  return value;
};
setupChoices = ['Review approved habits', undefined, 'Done'];
await commands.get('experience').handler('setup', ctx);
delete ctx.ui.custom;
assert.equal(disabledHabitListSeen, true, 'setup must list disabled approved habits');
assert.equal(reenableDetailSeen, true, 'setup must open disabled habit detail/action panel');
assert.ok(notes.some((note) => /Habit re-enabled/.test(note.message || '')), 'setup approved-habit action must re-enable disabled habit');
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
try {
  const rows = storage.db.prepare("SELECT id, status FROM habits WHERE user_id = 'owner' AND id = ?").all(active.id);
  assert.equal(rows[0].status, 'active', 'setup approved-habit action must persist active status after re-enable');
  storage.db.prepare("UPDATE habits SET status = 'archived' WHERE user_id = 'owner' AND id = 'candidate-hidden-from-approved-browser'").run();
} finally {
  storage.db.close();
}

const duplicateA = {
  id: 'duplicate-ui-habit-a',
  condition: 'When preparing nontrivial code changes or package releases with multiple validation stages',
  behavior: 'Run required checks and independent review before declaring the release ready, then report concrete evidence and any remaining caveats.',
};
const duplicateB = {
  id: 'duplicate-ui-habit-b',
  condition: 'Before calling a substantial implementation or software release complete',
  behavior: 'Complete the relevant validation and external critique, verify the final artifact, and describe the evidence instead of making an unsupported completion claim.',
};
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
let duplicateRelation;
try {
  insertStorageRecord(storage.db, 'habits', { id: duplicateA.id, userId: 'owner', data: { schema_version: 2, record_kind: 'candidate_habit_v1', status: 'active', active: true, injectable: false, condition: duplicateA.condition, behavior: duplicateA.behavior, polarity: 1, confidence_bp: 9000, source_refs: [], source_dates: [] }, now: '2026-07-10T08:00:00.000Z' });
  insertStorageRecord(storage.db, 'habits', { id: duplicateB.id, userId: 'owner', data: { schema_version: 2, record_kind: 'candidate_habit_v1', status: 'candidate', review_status: 'duplicate_resolution', active: false, injectable: false, condition: duplicateB.condition, behavior: duplicateB.behavior, polarity: 1, confidence_bp: 8800, source_refs: [], source_dates: [], approved_identity: { candidate_id: duplicateB.id, condition: duplicateB.condition.toLowerCase(), behavior: duplicateB.behavior.toLowerCase(), polarity: 1, approved_at: '2026-07-10T08:01:30.000Z' } }, now: '2026-07-10T08:01:00.000Z' });
  duplicateRelation = upsertHabitDuplicate(storage.db, { userId: 'owner', habitId: duplicateA.id, otherHabitId: duplicateB.id, canonicalHabitId: duplicateA.id, duplicateHabitId: duplicateB.id, similarityBp: 8048, thresholdBp: 5500, provider: 'local-fixture', model: 'multilingual-fixture', dimensions: 384, decision: 'pending', data: { action: 'ui_regression_fixture' }, now: '2026-07-10T08:02:00.000Z' });
} finally {
  storage.db.close();
}

const normalSelect = ctx.ui.select;
async function exerciseDuplicatePanel({ confirm }) {
  let duplicateListVisits = 0;
  let setupVisits = 0;
  let comparisonVisits = 0;
  let comparisonSeen = false;
  let confirmationSeen = false;
  ctx.ui.select = async (title, options) => {
    if (/Resolve duplicate habits —/.test(title)) {
      duplicateListVisits += 1;
      if (duplicateListVisits === 1) {
        assert.match(options[0], /approved — active/);
        assert.match(options[0], /approved — waiting for duplicate resolution/);
        assert.match(options[0], /When preparing|Before calling/i);
        assert.match(options[0], /Run required|Complete the relevant/i);
        assert.doesNotMatch(options[0], new RegExp(`${duplicateA.id}|${duplicateB.id}`));
        return options[0];
      }
      return 'Back to setup';
    }
    return normalSelect.call(ctx.ui, title, options);
  };
  ctx.ui.custom = async (factory) => {
    let value;
    const component = await factory({ requestRender() {} }, {}, {}, (result) => { value = result; });
    const firstRows = component.render(72);
    assert.ok(firstRows.every((row) => !/[\r\n]/.test(row)), 'every custom-panel render entry must be exactly one terminal row');
    const first = firstRows.join('\n');
    if (/Agent Experience setup/.test(first)) return setupVisits++ === 0 ? 'duplicates' : 'done';
    component.handleInput('\x1b[6~');
    const secondRows = component.render(72);
    assert.ok(secondRows.every((row) => !/[\r\n]/.test(row)), 'scrolled duplicate panel rows must not contain embedded newlines');
    const rendered = `${first}\n${secondRows.join('\n')}`;
    assert.doesNotMatch(rendered, new RegExp(`${duplicateA.id}|${duplicateB.id}|${duplicateRelation.checksum.slice(0, 16)}|8048|local-fixture|multilingual-fixture`), 'normal duplicate UI must hide ids, checksums, scores, and backend metadata');
    if (/Confirm duplicate resolution/.test(rendered)) {
      confirmationSeen = true;
      assert.match(rendered, /Will keep — Habit A/);
      assert.match(rendered, /Will archive\/hide — Habit B/);
      assert.match(rendered, /Evidence from both will be retained under Habit A/);
      component.handleInput(confirm ? '2' : '1');
      return value;
    }
    assert.match(rendered, /Possible duplicate habits/);
    assert.match(rendered, /Habit A:[\s\S]*approved — active/);
    assert.match(rendered, /Habit B:[\s\S]*approved — waiting for duplicate resolution/);
    assert.match(rendered, /preparing nontrivial code changes[\s\S]*multiple validation stages/i);
    assert.match(rendered, /Complete the relevant validation[\s\S]*unsupported completion claim/i);
    assert.match(rendered, /Same habit[\s\S]*keep Habit A wording[\s\S]*hide Habit[\s\S]*B/);
    assert.match(rendered, /Use Habit B wording[\s\S]*replace and hide Habit A/);
    assert.match(rendered, /Different habits[\s\S]*keep both/);
    assert.match(rendered, /Hide Habit B[\s\S]*keep Habit A without combining evidence/);
    comparisonSeen = true;
    comparisonVisits += 1;
    component.handleInput(!confirm && comparisonVisits > 1 ? '5' : '1');
    return value;
  };
  await commands.get('experience').handler('setup', ctx);
  delete ctx.ui.custom;
  ctx.ui.select = normalSelect;
  assert.equal(comparisonSeen, true, 'duplicate comparison panel must render');
  assert.equal(confirmationSeen, true, 'destructive duplicate action must open explicit confirmation');
}

await exerciseDuplicatePanel({ confirm: false });
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
try {
  assert.equal(listHabitDuplicates(storage.db, { userId: 'owner', decision: 'pending' }).some((row) => row.id === duplicateRelation.id), true, 'confirmation cancellation must leave duplicate relation pending');
  assert.equal(storage.db.prepare('SELECT status FROM habits WHERE id = ?').get(duplicateA.id).status, 'active');
  assert.equal(storage.db.prepare('SELECT status FROM habits WHERE id = ?').get(duplicateB.id).status, 'candidate');
} finally {
  storage.db.close();
}

await exerciseDuplicatePanel({ confirm: true });
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
try {
  assert.equal(listHabitDuplicates(storage.db, { userId: 'owner', decision: 'merged' }).some((row) => row.id === duplicateRelation.id), true, 'confirmed merge must resolve the selected relation');
  assert.equal(storage.db.prepare('SELECT status FROM habits WHERE id = ?').get(duplicateA.id).status, 'active');
  assert.equal(storage.db.prepare('SELECT status FROM habits WHERE id = ?').get(duplicateB.id).status, 'archived');
} finally {
  storage.db.close();
}
assert.ok(notes.some((note) => /Duplicate resolved\. Kept Habit A wording, combined evidence, and archived Habit B\./.test(note.message || '')), 'resolution result must state the exact survivor and archived habit');
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
try {
  storage.db.prepare("UPDATE habits SET status = 'archived' WHERE user_id = 'owner' AND id = ?").run(duplicateA.id);
} finally {
  storage.db.close();
}

notes.length = 0;
setupChoices = ['[ ] Prevent duplicate habits', 'Explain duplicate prevention (no changes)', 'Done'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.embedding_enabled, false, 'explanation must not enable duplicate prevention or download assets');
assert.equal(existsSync(join(paths.root, 'models')), false, 'package/setup explanation must not download a model');
assert.ok(notes.some((note) => /about 150 MB|on this computer|never sends/i.test(note.message || '')), 'setup must explain local privacy and one-time size in normal language');
assert.ok(!notes.some((note) => /provider|endpoint|api key|model id|dimensions|server/i.test(note.message || '')), 'normal setup must not expose backend jargon');

setupChoices = ['Keep analyzed source examples (7 days)', '14 days', 'Done'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.observation_retention_days, 14, 'normal setup must configure bounded source retention');
assert.ok(notes.some((note) => /deleted after 14 days/.test(note.message || '')), 'retention change must explain deletion and preserved minimized evidence');

notes.length = 0;
setupChoices = ['Analyze saved examples now', 'Done'];
await commands.get('experience').handler('setup', ctx);
assert.ok(notes.some((note) => /No saved examples yet|already analyzed/.test(note.message || '')), 'second analyze must not resend the committed and rotated generation');
assert.ok(!notes.some((note) => /Analyze saved examples started|New suggested habits created/.test(note.message || '')), 'caught-up analyze must not start a model job or claim new suggestions');
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
try {
  const rows = storage.db.prepare("SELECT id, status, condition, behavior FROM habits WHERE user_id = 'owner'").all();
  assert.equal(rows.filter((row) => row.status === 'active').length, 1, 'duplicate analyze must not demote active approved habit');
  assert.equal(rows.filter((row) => row.status === 'candidate').length, 0, 'duplicate analyze must not recreate visible candidate for active habit');
} finally {
  storage.db.close();
}
const activePrompt = `${active.condition} ${active.behavior}`;
const beforeResult = await handlers.get('before_agent_start')({ prompt: activePrompt, systemPrompt: 'base' }, ctx);
assert.equal(beforeResult, undefined, 'before_agent_start must not inject response guidance above the user prompt');
const activeContext = await handlers.get('context')({ messages: [{ role: 'user', content: [{ type: 'text', text: activePrompt }], timestamp: Date.now() }] }, ctx);
const activeGuidance = activeContext.messages.at(-1);
assert.equal(activeGuidance.customType, 'agent_experience.habit_guidance');
assert.match(activeGuidance.content, /approved habit guidance|Answer concisely/i, 'response context should receive approved habit guidance only after marker commit');
assert.doesNotMatch(activeGuidance.content, /please be concise|too much fluff|again: concise/, 'selector injection must not include raw saved examples');

const offTestOn = await setAgentExperienceCaptureActive(true, paths);
assert.equal(offTestOn.config.enabled && offTestOn.config.capture_enabled, true, 'test precondition: capture on before custom off action');
ctx.ui.custom = async (factory) => {
  let value;
  const component = await factory({ requestRender() {} }, {}, {}, (result) => { value = result; });
  const rendered = component.render(100).join('\n');
  assert.match(rendered, /Space\/Enter toggles/, 'custom setup panel should advertise Space/Enter checkbox behavior');
  const next = setupChoices.shift();
  return next === 'Turn all experience features off' ? 'off' : next === 'Done' ? 'done' : value;
};
setupChoices = ['Turn all experience features off', 'Done'];
await commands.get('experience').handler('setup', ctx);
delete ctx.ui.custom;
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.enabled, false, 'custom setup off action must turn master experience off');
assert.equal(configResult.config.capture_enabled, false, 'custom setup off action must turn capture off');
assert.equal(configResult.config.selector_enabled, false, 'custom setup off action must turn approved-habit reminders off');

__setAgentExperienceConsolidationAdapterForTest(undefined);
__setAgentExperienceSelectorAdapterForTest(undefined);
__setAgentExperienceSelectorEmbeddingAdapterForTest(undefined);
await rm(temp, { recursive: true, force: true });
console.log('agent-experience phase9 setup analyze checks passed');
