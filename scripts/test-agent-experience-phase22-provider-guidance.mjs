#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendHabitGuidanceToProviderPayload, KNOWN_GUIDANCE_APIS } from '../extensions/agent-experience/src/provider-guidance.ts';

const BASE = 'BASE_SYSTEM_SENTINEL';
const USER = 'USER_SENTINEL';
const GUIDANCE = 'Agent Experience approved habit guidance:\nWhen: validating provider guidance\nDo: keep it system-level';
const OPEN = '<agent_experience_response_guidance>';

const fixtures = new Map([
  ['openai-completions', { messages: [{ role: 'developer', content: BASE }, { role: 'user', content: USER }] }],
  ['mistral-conversations', { messages: [{ role: 'system', content: BASE }, { role: 'user', content: USER }] }],
  ['openai-responses', { input: [{ role: 'developer', content: BASE }, { role: 'user', content: USER }] }],
  ['azure-openai-responses', { input: [{ role: 'system', content: BASE }, { role: 'user', content: USER }] }],
  ['openai-codex-responses', { instructions: BASE, input: [{ role: 'user', content: USER }] }],
  ['anthropic-messages', { system: [{ type: 'text', text: BASE }], messages: [{ role: 'user', content: USER }] }],
  ['bedrock-converse-stream', { system: [{ text: BASE }, { cachePoint: { type: 'default' } }], messages: [{ role: 'user', content: USER }] }],
  ['google-generative-ai', { config: { systemInstruction: BASE }, contents: [{ role: 'user', parts: [{ text: USER }] }] }],
  ['google-vertex', { config: { systemInstruction: BASE }, contents: [{ role: 'user', parts: [{ text: USER }] }] }],
  ['pi-messages', { context: { systemPrompt: BASE, messages: [{ role: 'user', content: USER }] } }],
]);

assert.deepEqual([...fixtures.keys()].sort(), [...KNOWN_GUIDANCE_APIS].sort(), 'fixtures must cover every current supported Pi API');

function systemText(api, payload) {
  if (api === 'openai-completions' || api === 'mistral-conversations') return payload.messages.filter((row) => row.role === 'system' || row.role === 'developer').map((row) => row.content).join('\n');
  if (api === 'openai-responses' || api === 'azure-openai-responses') return payload.input.filter((row) => row.role === 'system' || row.role === 'developer').map((row) => row.content).join('\n');
  if (api === 'openai-codex-responses') return payload.instructions;
  if (api === 'anthropic-messages' || api === 'bedrock-converse-stream') return JSON.stringify(payload.system);
  if (api === 'google-generative-ai' || api === 'google-vertex') return payload.config.systemInstruction;
  if (api === 'pi-messages') return payload.context.systemPrompt;
  throw new Error(`unknown fixture ${api}`);
}

for (const [api, payload] of fixtures) {
  const snapshot = JSON.stringify(payload);
  const applied = appendHabitGuidanceToProviderPayload(api, payload, GUIDANCE);
  assert.equal(applied.ok, true, `${api}: valid payload must be accepted`);
  assert.equal(applied.changed, true, `${api}: first application must change a copied payload`);
  assert.equal(JSON.stringify(payload), snapshot, `${api}: input payload must stay immutable`);
  if (api === 'bedrock-converse-stream') assert.deepEqual(applied.payload.system[1], { cachePoint: { type: 'default' } }, 'bedrock-converse-stream: non-text system blocks must remain unchanged');
  assert.match(systemText(api, applied.payload), /Agent Experience approved habit guidance/);
  assert.equal(JSON.stringify(applied.payload).includes(USER), true, `${api}: user content must be retained`);
  const withoutSystem = JSON.parse(JSON.stringify(applied.payload));
  if (api === 'openai-completions' || api === 'mistral-conversations') withoutSystem.messages = withoutSystem.messages.filter((row) => row.role === 'user');
  else if (api === 'openai-responses' || api === 'azure-openai-responses') withoutSystem.input = withoutSystem.input.filter((row) => row.role === 'user');
  else if (api === 'openai-codex-responses') delete withoutSystem.instructions;
  else if (api === 'anthropic-messages' || api === 'bedrock-converse-stream') delete withoutSystem.system;
  else if (api === 'google-generative-ai' || api === 'google-vertex') delete withoutSystem.config.systemInstruction;
  else delete withoutSystem.context.systemPrompt;
  assert.doesNotMatch(JSON.stringify(withoutSystem), /Agent Experience approved habit guidance|agent_experience_response_guidance/, `${api}: guidance must exist only in system instruction`);
  const repeated = appendHabitGuidanceToProviderPayload(api, applied.payload, GUIDANCE);
  assert.equal(repeated.ok, true, `${api}: retry must be accepted`);
  assert.equal(repeated.changed, false, `${api}: retry must be idempotent`);
  assert.equal((JSON.stringify(repeated.payload).match(/<agent_experience_response_guidance>/g) || []).length, 1, `${api}: retry must not duplicate guidance`);
}

const malformed = [
  ['openai-completions', { messages: [{ role: 'user', content: USER }] }],
  ['openai-completions', { messages: [{ role: 'system', content: BASE }, { role: 'developer', content: BASE }] }],
  ['openai-responses', { input: [] }],
  ['openai-codex-responses', { instructions: 7 }],
  ['anthropic-messages', { system: 'bad' }],
  ['bedrock-converse-stream', { system: null }],
  ['google-generative-ai', { config: {} }],
  ['google-vertex', {}],
  ['mistral-conversations', { messages: [] }],
  ['pi-messages', { context: {} }],
];
for (const [api, payload] of malformed) assert.equal(appendHabitGuidanceToProviderPayload(api, payload, GUIDANCE).ok, false, `${api}: malformed shape must fail closed`);
assert.deepEqual(appendHabitGuidanceToProviderPayload('custom-api', { instructions: BASE }, GUIDANCE), { ok: false, reason: 'unsupported_api' });
assert.deepEqual(appendHabitGuidanceToProviderPayload('openai-codex-responses', null, GUIDANCE), { ok: false, reason: 'known_api_shape_mismatch' });
assert.deepEqual(appendHabitGuidanceToProviderPayload('openai-codex-responses', undefined, GUIDANCE), { ok: false, reason: 'known_api_shape_mismatch' });
assert.deepEqual(appendHabitGuidanceToProviderPayload('openai-codex-responses', { instructions: BASE }, ''), { ok: false, reason: 'invalid_guidance' });
assert.deepEqual(appendHabitGuidanceToProviderPayload('openai-codex-responses', { instructions: BASE }, 'x'.repeat(10_001)), { ok: false, reason: 'invalid_guidance' });
assert.deepEqual(appendHabitGuidanceToProviderPayload('openai-codex-responses', { instructions: `${BASE}\n${OPEN}\nother` }, GUIDANCE), { ok: false, reason: 'conflicting_guidance' });
assert.equal(appendHabitGuidanceToProviderPayload('openai-codex-responses', { instructions: BASE }, `${OPEN} injected`).ok, false, 'guidance may not contain internal framing sentinel');

console.log('agent-experience phase22 provider guidance checks passed');
