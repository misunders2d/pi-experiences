#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension, { __buildAgentExperienceConsolidationSystemPromptForTest, __formatAgentExperienceAnalyzeFailureForTest, __getAgentExperienceDetailPanelOptionsForTest, __normalizeAgentExperienceConsolidationModelOutputForTest, __setAgentExperienceConsolidationAdapterForTest } from '../extensions/agent-experience/index.ts';
import { getAgentExperiencePaths, readAgentExperienceConfig, setAgentExperienceCaptureActive, setAgentExperienceConsolidationEnabled, setAgentExperienceConsolidationModel } from '../extensions/agent-experience/src/paths.ts';
import { canonicalJson } from '../extensions/agent-experience/src/storage/checksum.ts';
import { ensurePrivateRoot, resolvePrivatePath } from '../extensions/agent-experience/src/storage/private-root.ts';
import { observationChecksumForTest, observationPairRefForTest } from '../extensions/agent-experience/src/storage/observations.ts';
import { initExperienceStorage, insertStorageRecord } from '../extensions/agent-experience/src/storage/sqlite.ts';

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
    registerTool() { throw new Error('no tools'); },
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
    assert.match(initial, /Space\/Enter toggles/, 'setup panel must advertise Space toggles');
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
assert.match(__formatAgentExperienceAnalyzeFailureForTest(new Error('Watermark would move backward')), /already analyzed/, 'stale duplicate analyze errors must be translated to human action');
assert.equal(__getAgentExperienceDetailPanelOptionsForTest().overlay, false, 'review/status detail panels should replace the editor instead of overlaying image preview lines');
assert.equal(__normalizeAgentExperienceConsolidationModelOutputForTest(strictRawOutput, strictNormalizeInput).proposals.length, 1);
const weakOneOff = __normalizeAgentExperienceConsolidationModelOutputForTest({ ...strictRawOutput, proposals: [{ ...strictRawOutput.proposals[0], source_refs: [{ file_generation: 'active', seq: 1, checksum: r1.checksum }] }] }, strictNormalizeInput);
assert.equal(weakOneOff.proposals.length, 0, 'one-off model suggestions must not become review candidates');
const canonicalizedRefs = __normalizeAgentExperienceConsolidationModelOutputForTest({ ...strictRawOutput, proposals: [{ ...strictRawOutput.proposals[0], source_refs: [{ seq: 1 }, { seq: 2, checksum: 'bad-copy' }, { file_generation: 'active', seq: 3, checksum: 'also-bad-copy' }] }] }, strictNormalizeInput);
assert.deepEqual(canonicalizedRefs.proposals[0].source_refs, [
  { file_generation: 'active', seq: 1, checksum: r1.checksum },
  { file_generation: 'active', seq: 2, checksum: r2.checksum },
  { file_generation: 'active', seq: 3, checksum: r3.checksum },
], 'live normalizer must canonicalize source ref checksums from local observations');
assert.throws(() => __normalizeAgentExperienceConsolidationModelOutputForTest({ ...strictRawOutput, proposals: [{ ...strictRawOutput.proposals[0], source_refs: [{ file_generation: 'wrong-generation', seq: 1, checksum: 'wrong' }, { file_generation: 'wrong-generation', seq: 2, checksum: 'wrong' }, { file_generation: 'wrong-generation', seq: 3, checksum: 'wrong' }] }] }, strictNormalizeInput), /generation_mismatch/, 'normalizer must reject wrong model source ref generation');
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

setupChoices = ['[ ] Use approved habits before replies', 'Done'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.selector_enabled, true);

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

notes.length = 0;
const oldOpenAiKey = process.env.OPENAI_API_KEY;
const oldAxOpenAiKey = process.env.AX_OPENAI_EMBEDDING_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.AX_OPENAI_EMBEDDING_API_KEY;
setupChoices = ['[ ] Prevent duplicate habits', 'Enable and scan for duplicate habits', 'I understand: send only normalized When/Do habit text for embeddings', 'Done'];
await commands.get('experience').handler('setup', ctx);
if (oldOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAiKey;
if (oldAxOpenAiKey === undefined) delete process.env.AX_OPENAI_EMBEDDING_API_KEY; else process.env.AX_OPENAI_EMBEDDING_API_KEY = oldAxOpenAiKey;
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.embedding_enabled, false, 'setup semantic enable must leave gate off when provider is unavailable');
assert.ok(notes.some((note) => /Semantic duplicate prevention was not enabled/.test(note.message || '')), 'setup semantic enable must show clear provider blocker');
assert.ok(!notes.some((note) => /OPENAI_API_KEY|AX_OPENAI_EMBEDDING_API_KEY/.test(note.message || '')), 'setup semantic blocker must not expose credential names as secrets to normal UI');

notes.length = 0;
setupChoices = ['Analyze saved examples now', 'Done'];
await commands.get('experience').handler('setup', ctx);
await waitForNote(/Analyze saved examples finished/, 'second analyze must finish');
assert.ok(notes.some((note) => /No new suggestions were created/.test(note.message || '')), 'duplicate analyze must say no new suggestions, not created');
assert.ok(!notes.some((note) => /New suggested habits created/.test(note.message || '')), 'duplicate analyze must not claim new suggestions were created');
storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
try {
  const rows = storage.db.prepare("SELECT id, status, condition, behavior FROM habits WHERE user_id = 'owner'").all();
  assert.equal(rows.filter((row) => row.status === 'active').length, 1, 'duplicate analyze must not demote active approved habit');
  assert.equal(rows.filter((row) => row.status === 'candidate').length, 0, 'duplicate analyze must not recreate visible candidate for active habit');
} finally {
  storage.db.close();
}
const beforeResult = await handlers.get('before_agent_start')({ prompt: `${active.condition} ${active.behavior}`, systemPrompt: 'base' }, ctx);
assert.match(beforeResult.systemPrompt, /Agent Experience reminders|approved habits|Answer concisely/i, 'before_agent_start should inject approved habit reminder');
assert.doesNotMatch(beforeResult.systemPrompt, /please be concise|too much fluff|again: concise/, 'selector injection must not include raw saved examples');

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
await rm(temp, { recursive: true, force: true });
console.log('agent-experience phase9 setup analyze checks passed');
