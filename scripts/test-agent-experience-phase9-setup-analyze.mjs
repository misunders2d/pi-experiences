#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension, { __normalizeAgentExperienceConsolidationModelOutputForTest, __setAgentExperienceConsolidationAdapterForTest } from '../extensions/agent-experience/index.ts';
import { getAgentExperiencePaths, readAgentExperienceConfig, setAgentExperienceCaptureActive, setAgentExperienceConsolidationEnabled, setAgentExperienceConsolidationModel } from '../extensions/agent-experience/src/paths.ts';
import { canonicalJson } from '../extensions/agent-experience/src/storage/checksum.ts';
import { ensurePrivateRoot, resolvePrivatePath } from '../extensions/agent-experience/src/storage/private-root.ts';
import { observationChecksumForTest, observationPairRefForTest } from '../extensions/agent-experience/src/storage/observations.ts';
import { initExperienceStorage } from '../extensions/agent-experience/src/storage/sqlite.ts';

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
const modelRegistry = {
  getAvailable() { return [availableModel, slashModel, unavailableModel, ...extraAuthModels]; },
  find(provider, modelId) {
    if (provider === availableModel.provider && modelId === availableModel.id) return availableModel;
    if (provider === unavailableModel.provider && modelId === unavailableModel.id) return unavailableModel;
    if (provider === slashModel.provider && modelId === slashModel.id) return slashModel;
    return extraAuthModels.find((model) => model.provider === provider && model.id === modelId);
  },
  hasConfiguredAuth(model) { return model !== unavailableModel; },
  async getApiKeyAndHeaders() { return { ok: true, apiKey: 'test-not-used' }; },
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

setupChoices = ['[ ] Save chat examples locally', 'Choose model for habit learning', 'Done'];
await commands.get('experience').handler('setup', ctx);
let configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.enabled, true);
assert.equal(configResult.config.capture_enabled, true);
assert.equal(configResult.config.consolidation_model, 'openai-codex/gpt-5.5');
assert.equal(configResult.config.consolidation_enabled, true);
assert.equal(configResult.config.timer_enabled, false);

setupChoices = ['Choose model for habit learning', 'Search authenticated models', 'openrouter/openai/gpt-5', 'Choose model for habit learning', 'openai-codex/gpt-5.5', 'Done'];
setupInputs = ['gpt-5'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.consolidation_model, 'openai-codex/gpt-5.5', 'model ids containing slash can be selected by search, then normal model can be restored');
assert.ok(notes.some((note) => /Habit-learning model: openrouter\/openai\/gpt-5/.test(note.message || '')), 'OpenRouter slash model id should save successfully from searchable picker');
setupChoices = ['Choose model for habit learning', 'Enter exact model id', 'Done'];
setupInputs = ['openrouter/openai/gpt-5'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.consolidation_model, 'openrouter/openai/gpt-5', 'exact model entry must support provider/model ids containing slash');
setupChoices = ['Choose model for habit learning', 'Enter exact model id', 'Done'];
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
    assert.match(initial, /Space\/Enter toggles/, 'setup panel must advertise Space toggles');
    const next = setupChoices.shift();
    value = next === 'Choose model for habit learning' ? 'model' : next === 'Done' ? 'done' : undefined;
    resolved = true;
    return value;
  }
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
assert.equal(__normalizeAgentExperienceConsolidationModelOutputForTest(strictRawOutput, strictNormalizeInput).proposals.length, 1);
const weakOneOff = __normalizeAgentExperienceConsolidationModelOutputForTest({ ...strictRawOutput, proposals: [{ ...strictRawOutput.proposals[0], source_refs: [{ seq: 1 }] }] }, strictNormalizeInput);
assert.equal(weakOneOff.proposals.length, 0, 'one-off model suggestions must not become review candidates');
const repairedMissingRefFields = __normalizeAgentExperienceConsolidationModelOutputForTest({ ...strictRawOutput, proposals: [{ ...strictRawOutput.proposals[0], source_refs: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] }] }, strictNormalizeInput);
assert.deepEqual(repairedMissingRefFields.proposals[0].source_refs, [
  { file_generation: 'active', seq: 1, checksum: r1.checksum },
  { file_generation: 'active', seq: 2, checksum: r2.checksum },
  { file_generation: 'active', seq: 3, checksum: r3.checksum },
], 'normalizer repairs source refs from local seq');
const repairedWrongChecksum = __normalizeAgentExperienceConsolidationModelOutputForTest({ ...strictRawOutput, proposals: [{ ...strictRawOutput.proposals[0], source_refs: [{ file_generation: 'wrong-generation', seq: 1, checksum: 'wrong' }, { file_generation: 'wrong-generation', seq: 2, checksum: 'wrong' }, { file_generation: 'wrong-generation', seq: 3, checksum: 'wrong' }] }] }, strictNormalizeInput);
assert.equal(repairedWrongChecksum.proposals[0].source_refs.length, 3, 'normalizer ignores model checksum/generation typos when seq is valid');
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
await waitForNote(/Suggested habits created: 1/, 'analyze-now must create one suggestion');

notes.length = 0;
let reviewPanelSeen = false;
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
assert.ok(notes.some((note) => /Approved suggestion/.test(note.message || '')), 'setup review must approve suggestion from setup flow');
assert.ok(!notes.some((note) => /Suggested habit\n|Suggested habits waiting for review|When:/.test(note.message || '')), 'review details must not be dumped into chat history notifications');
assert.ok(notes.some((note) => /safety file/i.test(note.title || '') || /Safety file/i.test(note.message || '')), 'first-run approval must repair missing safety file inside setup');

setupChoices = ['[ ] Use approved habits before replies', 'Done'];
await commands.get('experience').handler('setup', ctx);
configResult = await readAgentExperienceConfig(paths);
assert.equal(configResult.config.selector_enabled, true);

let storage = await initExperienceStorage(paths.root, { allowInit: true, userId: 'owner' });
let active;
try {
  const rows = storage.db.prepare("SELECT id, condition, behavior FROM habits WHERE user_id = 'owner' AND status = 'active'").all();
  assert.equal(rows.length, 1, 'approved eligible habit should be active');
  active = rows[0];
  assert.match(active.behavior, /concrete evidence/);
} finally {
  storage.db.close();
}
notes.length = 0;
setupChoices = ['Analyze saved examples now', 'Done'];
await commands.get('experience').handler('setup', ctx);
await waitForNote(/Analyze saved examples finished/, 'second analyze must finish');
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
