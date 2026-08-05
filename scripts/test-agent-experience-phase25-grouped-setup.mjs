#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildFallbackSetupOptions,
  buildSetupItems,
  setupActionForFallbackOption,
  showSetupView,
} from '../extensions/agent-experience/src/setup-ui.ts';

function snapshot(overrides = {}) {
  const base = {
    config: {
      enabled: false,
      advisor_enabled: false,
      advisor_model: '',
      capture_enabled: false,
      consolidation_enabled: false,
      consolidation_model: 'openai-codex/gpt-5.5',
      selector_enabled: false,
      selector_model: 'openai-codex/gpt-5.4-mini',
      embedding_enabled: false,
      observation_retention_days: 7,
      timer_enabled: false,
      break_in_enabled: false,
    },
    counts: {
      observations: 14,
      approved: 12,
      suggestions: 2,
      duplicates: 1,
    },
    semanticFiles: 'Ready',
    effectiveAdvisorModel: 'openai-codex/gpt-5.4-mini',
  };
  return {
    ...base,
    ...overrides,
    config: { ...base.config, ...(overrides.config || {}) },
    counts: { ...base.counts, ...(overrides.counts || {}) },
  };
}

const expectedLabels = {
  home: [
    'Learning from conversations',
    'Guidance and Advisor',
    'Manage habits',
    'Automation and privacy',
    'Status and help',
    'Turn everything off',
    'Done',
  ],
  learning: [
    'Learn from conversations',
    'Habit-learning model',
    'Analyze waiting examples',
    'Review suggested habits',
    'Back',
  ],
  guidance: [
    'Runtime Advisor',
    'Advisor model',
    'Use approved habits',
    'Habit-assessment model',
    'Back',
  ],
  habits: [
    'Review approved habits',
    'Resolve possible duplicates',
    'Prevent duplicate habits',
    'Back',
  ],
  automation: [
    'Keep analyzed source examples',
    'Automatic Analyze schedule',
    'Review prompts after Analyze',
    'Local semantic files',
    'Back',
  ],
};

const inherited = snapshot();
for (const [view, labels] of Object.entries(expectedLabels)) {
  const items = buildSetupItems(view, inherited);
  assert.deepEqual(items.map((item) => item.label), labels, `${view} rows must match the approved grouped setup`);
  const fallback = buildFallbackSetupOptions(view, inherited);
  assert.equal(fallback.length, items.length, `${view} custom/fallback row counts must match`);
  assert.deepEqual(
    fallback.map((option) => setupActionForFallbackOption(view, inherited, option)),
    items.map((item) => item.id),
    `${view} custom/fallback rows must share action ids and ordering`,
  );
  for (let index = 0; index < items.length; index += 1) {
    assert.ok(fallback[index].startsWith(items[index].label), `${view} fallback label must preserve custom label semantics: ${items[index].label}`);
  }
}

assert.equal(buildSetupItems('home', inherited).length, 7, 'home must always contain exactly seven rows');
assert.equal(buildSetupItems('guidance', inherited)[1].currentValue, 'Same as habit assessment');
assert.equal(buildSetupItems('guidance', snapshot({ config: { advisor_model: 'openrouter/openai/gpt-5' }, effectiveAdvisorModel: 'openrouter/openai/gpt-5' }))[1].currentValue, 'openrouter/openai/gpt-5');
assert.equal(buildSetupItems('guidance', snapshot({ config: { enabled: true, advisor_enabled: true, selector_enabled: false } }))[0].currentValue, '[x] ON');
assert.equal(buildSetupItems('guidance', snapshot({ config: { enabled: true, advisor_enabled: false, selector_enabled: true } }))[2].currentValue, '[x] ON');
assert.equal(buildSetupItems('guidance', snapshot({ config: { enabled: true, advisor_enabled: true, selector_enabled: false } }))[2].currentValue, '[ ] OFF', 'Advisor must not silently enable approved habits');
assert.equal(buildSetupItems('guidance', snapshot({ config: { enabled: true, advisor_enabled: false, selector_enabled: true } }))[0].currentValue, '[ ] OFF', 'approved habits must not silently enable Advisor');

const unavailable = snapshot({
  reviewState: 'Needs attention',
  counts: { approved: 0, suggestions: 0, duplicates: 0 },
});
assert.equal(buildSetupItems('home', unavailable)[2].currentValue, 'Needs attention');
assert.equal(buildSetupItems('learning', unavailable)[3].currentValue, 'Needs attention');
assert.deepEqual(buildSetupItems('habits', unavailable).slice(0, 2).map((item) => item.currentValue), ['Needs attention', 'Needs attention']);

let statusRender = '';
await showSetupView({
  hasUI: true,
  ui: {
    custom: async (factory) => {
      const component = await factory({}, {}, {}, () => undefined);
      statusRender = component.render(120).join('\n');
      return undefined;
    },
  },
}, 'status', snapshot({ config: { enabled: true, advisor_enabled: true } }));
const unavailableAdvisorLine = statusRender.split('\n').find((line) => line.includes('Advisor —')) || '';
assert.doesNotMatch(unavailableAdvisorLine, /\bReady\b|\b0 queued\b/, 'status must omit Advisor lifecycle and queue claims when runtime state is unavailable');

await showSetupView({
  hasUI: true,
  ui: {
    custom: async (factory) => {
      const component = await factory({}, {}, {}, () => undefined);
      statusRender = component.render(120).join('\n');
      return undefined;
    },
  },
}, 'status', unavailable);
assert.match(statusRender, /Habits — Needs attention/);
assert.match(statusRender, /suggestions need attention/);

const forbidden = /hybrid|learning evidence|sync backlog|immune turns|dimensions|basis points|checksums?|provider endpoints?/i;
for (const view of [...Object.keys(expectedLabels), 'status']) {
  const visible = buildSetupItems(view, inherited).flatMap((item) => [item.label, item.currentValue, item.description || '']).join('\n');
  assert.doesNotMatch(visible, forbidden, `${view} normal UI must not expose implementation controls or terms`);
}

const before = structuredClone(inherited);
for (const view of [...Object.keys(expectedLabels), 'status']) {
  buildSetupItems(view, inherited);
  buildFallbackSetupOptions(view, inherited);
}
assert.deepEqual(inherited, before, 'opening and rendering setup must not mutate its snapshot');

console.log('agent experience phase25 grouped setup tests passed');
