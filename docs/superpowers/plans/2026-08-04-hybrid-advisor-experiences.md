# Hybrid Advisor and Experiences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OMP-style persistent runtime Advisor to Pi Experiences, ground habit violations in embedding-retrieved approved habits, route accepted findings into the existing human-reviewed learning pipeline, and replace the fifteen-row setup screen with a grouped control surface.

**Architecture:** A session-scoped `pi-agent-core` Agent reviews bounded incremental primary-turn deltas with isolated read-only tools. Experiences retrieves approved habit candidates before each Advisor update and exposes separate generic-advice and habit-violation emission tools; accepted findings use Pi's documented custom-message steering path and may create bounded observations only when learning is enabled. The extension entrypoint wires focused Advisor, learning, delivery, and setup modules while existing selector, storage, approval, and provider-guidance paths remain intact.

**Tech Stack:** TypeScript on Node.js `>=22.19.0`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, TypeBox, SQLite, local ONNX embeddings, Node assertion scripts, Python PTY TUI smoke tests.

## Global Constraints

- Runtime Advisor and approved-habit guidance are independent and default off.
- Advisor model inherits `selector_model` unless `advisor_model` is explicitly set.
- Advisor tools are exactly confined `read`, `grep`, purpose-built `glob`, `advise`, and `report_habit_violation`; no mutating or orchestration tools.
- Generic findings are model judgment; habit violations must reference an exact supplied alias and use exact approved `Do` wording.
- Maximum one accepted emission per Advisor update; valid habit violation has priority.
- `nit` never triggers another model turn; eligible active-run `concern` and `blocker` findings may use safe OMP-like steering without pre-execution tool blocking, otherwise findings append visibly after settlement.
- Private Advisor transcript, deltas, aliases, retrieval scores, raw output, tool investigations, queue state, and suppressed findings are never persisted.
- Learning-off means no Advisor observation. Learning-on creates at most one bounded `advisor_finding_v1` observation per accepted event.
- Existing repetition thresholds, review, and explicit approval remain mandatory.
- Primary delta cap is 24,000 redacted characters; behavior retrieval is tokenizer-fitted to 128 tokens; other bounds are 8 represented tool events, 8 habit candidates, 5 same-generation queued batches, 3 Advisor tool calls, 8,000 redacted characters per tool result/16,000 aggregate, 60-second update timeout, 1,200-character generic note, 6,000-character Advisor observation, 3 immune turns, and 4,096 transient dedupe entries.
- `/experience setup` uses the approved grouped home and focused subpanels; no hybrid or Advisor-learning toggle is added.
- Local task commits and ephemeral temporary-directory `npm pack` validation are authorized. Do not install or reload the live extension, change timers, bump version, tag, merge, push, create a release-staging install, or publish npm artifacts.

---

## File Structure

### New runtime files

- `extensions/agent-experience/src/advisor/types.ts` — stable Advisor update, candidate, attempt, accepted-finding, and state contracts.
- `extensions/agent-experience/src/advisor/prompt.ts` — system prompt and bounded update formatting.
- `extensions/agent-experience/src/advisor/tools.ts` — strict `advise` and `report_habit_violation` tool definitions plus per-update attempt buffer.
- `extensions/agent-experience/src/advisor/model.ts` — isolated `pi-agent-core` Agent construction, model resolution, auth-aware stream wrapper, read-only tools, timeout/tool-budget enforcement.
- `extensions/agent-experience/src/advisor/workspace-tools.ts` — canonical-cwd-confined read/grep/custom-glob wrappers, sensitive-path denial, result redaction, and byte budgets.
- `extensions/agent-experience/src/advisor/transcript.ts` — primary-turn delta extraction, redaction, recursion filtering, cursor fingerprints, and bounds.
- `extensions/agent-experience/src/advisor/emission-guard.ts` — content-free suppression, normalization, bounded dedupe, priority, and per-update budget.
- `extensions/agent-experience/src/advisor/runtime.ts` — single-flight queue, coalescing, epoch/cursor/reset/dispose, catch-up waiters, and host callbacks.
- `extensions/agent-experience/src/advisor/retrieval-query.ts` — high-signal behavior-query extraction and exact local-tokenizer fitting.
- `extensions/agent-experience/src/advisor/habits.ts` — active-habit union, condition/behavior vector preparation, behavior-delta retrieval, aliases, and emission-time revalidation.
- `extensions/agent-experience/src/advisor/message.ts` — safe custom-message schema, advisory XML content, renderer, and delivery-mode selection.
- `extensions/agent-experience/src/advisor/observation.ts` — bounded `advisor_finding_v1` payload creation and append policy.
- `extensions/agent-experience/src/setup-ui.ts` — grouped setup views, status summaries, item builders, and reusable SettingsList component.

### Existing files modified

- `package.json`, `package-lock.json` — require `@earendil-works/pi-coding-agent` with the public `agent_settled` API, add direct `pi-agent-core` peer/dev dependency, and wire focused checks.
- `extensions/agent-experience/src/config.ts` — Advisor config keys, parser, formatter, env mapping, status summary.
- `extensions/agent-experience/src/semantic/service.ts` — reusable current-law condition/behavior vector preparation.
- `extensions/agent-experience/src/semantic/storage.ts` — bounded read helper for exact condition/behavior vector namespaces if not already sufficient.
- `extensions/agent-experience/src/selector.ts` and `selector-vector.ts` — expose shared eligible snapshot/identity helpers without changing direct selector behavior.
- `extensions/agent-experience/src/storage/observations.ts` — allow `advisor_finding` origin.
- `extensions/agent-experience/src/consolidate/observations.ts` — validate `advisor_finding_v1` payload kind and origin.
- `extensions/agent-experience/src/consolidate/model-adapter.ts` — render conversation and Advisor observations distinctly for Analyze.
- `extensions/agent-experience/src/consolidate/prompt.ts` — state that Advisor findings are lower-authority evidence and cannot bypass review.
- `extensions/agent-experience/index.ts` — Advisor lifecycle/event wiring and grouped setup handlers; remove obsolete flat setup builders/components.
- `scripts/check-agent-experience-source.mjs` — dependency, source invariant, and focused-test checks.
- `scripts/verify-packed-install.mjs` — require Advisor/setup files and verify packed dependency resolution.
- `scripts/test-installed-tui-smoke.py` — grouped setup smoke.
- `README.md`, `extensions/agent-experience/README.md`, `extensions/agent-experience/VALIDATION.md`, `skills/agent-experience/SKILL.md`, `CHANGELOG.md` — verified behavior and setup documentation.

### New focused tests

- `scripts/test-agent-experience-phase23-advisor-core.mjs`
- `scripts/test-agent-experience-phase24-advisor-habits-learning.mjs`
- `scripts/test-agent-experience-phase25-grouped-setup.mjs`
- `scripts/test-advisor-tui-smoke.py`

---

### Task 1: Advisor configuration and dependency contract

**Files:**
- Modify: `package.json:42-90`
- Modify: `package-lock.json`
- Modify: `extensions/agent-experience/src/config.ts:1-184`
- Modify: `extensions/agent-experience/src/paths.ts:79-97,218-226`
- Create: `extensions/agent-experience/src/advisor/types.ts`
- Create: `scripts/test-agent-experience-phase23-advisor-core.mjs`
- Modify: `scripts/check-agent-experience-source.mjs:1-32,130`

**Interfaces:**
- Produces `AdvisorSeverity`, `AdvisorHabitCandidate`, `AdvisorUpdate`, `AdvisorAttempt`, `AcceptedAdvisorFinding`, `AdvisorScope`, `AdvisorPrimaryDelta`, `AdvisorDiagnosticReason`, and `AdvisorRuntimeConfig` in `advisor/types.ts`.
- Adds config fields `advisor_enabled`, `advisor_model`, `advisor_timeout_ms`, `advisor_sync_backlog`, and `advisor_immune_turns`.
- The existing master `enabled` remains authoritative: Advisor runtime requires both flags; enabling Advisor through setup also sets the master true, and all-off clears `advisor_enabled`.
- Later tasks consume `effectiveAdvisorModel(config)` and `advisorRuntimeConfig(config)`.

- [ ] **Step 1: Add failing config and package assertions**

Append to `scripts/test-agent-experience-phase23-advisor-core.mjs`:

```js
import assert from 'node:assert/strict';
import {
  DEFAULT_AGENT_EXPERIENCE_CONFIG,
  advisorRuntimeConfig,
  effectiveAdvisorModel,
  formatAgentExperienceConfig,
  parseAgentExperienceConfig,
} from '../extensions/agent-experience/src/config.ts';

assert.equal(DEFAULT_AGENT_EXPERIENCE_CONFIG.advisor_enabled, false);
assert.equal(DEFAULT_AGENT_EXPERIENCE_CONFIG.advisor_model, '');
assert.equal(DEFAULT_AGENT_EXPERIENCE_CONFIG.advisor_timeout_ms, 60_000);
assert.equal(DEFAULT_AGENT_EXPERIENCE_CONFIG.advisor_sync_backlog, 'off');
assert.equal(DEFAULT_AGENT_EXPERIENCE_CONFIG.advisor_immune_turns, 3);
assert.equal(effectiveAdvisorModel({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, selector_model: 'p/selector' }), 'p/selector');
assert.equal(effectiveAdvisorModel({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, selector_model: 'p/selector', advisor_model: 'p/advisor' }), 'p/advisor');
const parsed = parseAgentExperienceConfig('enabled = true\n[advisor]\nenabled = true\nmodel = "p/advisor"\ntimeout_ms = 70000\nsync_backlog = 3\nimmune_turns = 4\n');
assert.deepEqual(advisorRuntimeConfig(parsed), { enabled: true, model: 'p/advisor', timeoutMs: 70_000, syncBacklog: 3, immuneTurns: 4 });
assert.match(formatAgentExperienceConfig(parsed), /\[advisor\][\s\S]*enabled = true[\s\S]*model = "p\/advisor"/);
const clamped = parseAgentExperienceConfig('[advisor]\ntimeout_ms = 120001\nimmune_turns = -1\n');
assert.equal(clamped.advisor_timeout_ms, 120_000);
assert.equal(clamped.advisor_immune_turns, 0);
assert.throws(() => parseAgentExperienceConfig('[advisor]\nsync_backlog = 2\n'), /advisor_sync_backlog/i);
console.log('phase23 advisor core config tests passed');
```

Update `scripts/check-agent-experience-source.mjs` to assert `@earendil-works/pi-coding-agent` is peer `>=0.83.0` with dev dependency `^0.83.0` (the first supported public `agent_settled` API), `@earendil-works/pi-agent-core` is a wildcard peer with matching `^0.83.0` dev dependency, both are esbuild externals, and phase23 is in `check:agent-experience`.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
node --experimental-strip-types scripts/test-agent-experience-phase23-advisor-core.mjs
```

Expected: failure because Advisor config exports do not exist.

- [ ] **Step 3: Define the runtime contracts**

Create `advisor/types.ts` with these public shapes:

```ts
export type AdvisorSeverity = 'nit' | 'concern' | 'blocker';
export type AdvisorAttempt =
  | { kind: 'generic_advice'; note: string; severity: AdvisorSeverity }
  | { kind: 'habit_violation'; habitAlias: string; severity: AdvisorSeverity };

export interface AdvisorScope {
  userId: string;
  sessionId: string;
  sessionFile: string;
}

export interface AdvisorPrimaryDelta {
  scope: AdvisorScope;
  epoch: number;
  generation: number;
  cursor: number;
  currentUserEntryId: string;
  primaryEntryIds: string[];
  causalEpisodeId: string;
  causedByAdvisor: boolean;
  text: string;
  currentRequest: string;
  inProgress: boolean;
  toolEventCount: number;
  eventFingerprint: string;
}

export type AdvisorDiagnosticReason =
  | 'advisor_auth_unavailable'
  | 'advisor_cancelled'
  | 'advisor_context_overflow'
  | 'advisor_invalid_output'
  | 'advisor_queue_coalesced'
  | 'advisor_timeout'
  | 'advisor_tool_budget_exhausted'
  | 'advisor_unavailable';

export interface AdvisorHabitCandidate {
  alias: string;
  habitId: string;
  condition: string;
  behavior: string;
  checksum: string;
  lawHash: string;
}

export interface AdvisorUpdate {
  schemaVersion: 1;
  scope: AdvisorScope;
  generation: number;
  epoch: number;
  cursor: number;
  inProgress: boolean;
  primaryDelta: string;
  currentRequest: string;
  habits: AdvisorHabitCandidate[];
  eventFingerprint: string;
  causalEpisodeId: string;
  causedByAdvisor: boolean;
}

export type AcceptedAdvisorFinding =
  | { kind: 'generic_advice'; note: string; severity: AdvisorSeverity; eventFingerprint: string }
  | { kind: 'habit_violation'; candidate: AdvisorHabitCandidate; severity: AdvisorSeverity; eventFingerprint: string };

export interface AdvisorRuntimeConfig {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  syncBacklog: 'off' | 1 | 3 | 5;
  immuneTurns: number;
}
```

- [ ] **Step 4: Implement strict config parsing and formatting**

Add the five config keys, defaults, section mappings, env mappings, format output, and status summary. Clamp timeout and immune turns at the approved lower/upper bounds for file and env input; reject unsupported discrete backlog values such as `2`. Keep `advisorRuntimeConfig(config).enabled` equal to `config.enabled && config.advisor_enabled`. Add `setAgentExperienceAdvisorEnabled`: enabling sets both master and Advisor true only after its caller completes auth/disclosure confirmation, while disabling clears only Advisor. Extend `setAgentExperienceEnabled(false)` to clear Advisor. Extend `setAgentExperienceCaptureActive`, `setAgentExperienceSimpleOn`, and backward-compatible master-on paths so a transition from master-off clears stale `advisor_enabled` rather than activating Advisor through an unrelated control.

Add:

```ts
export function effectiveAdvisorModel(config: Pick<AgentExperienceConfig, 'advisor_model' | 'selector_model'>): string {
  return config.advisor_model || config.selector_model;
}

export function advisorRuntimeConfig(config: AgentExperienceConfig): AdvisorRuntimeConfig {
  return {
    enabled: config.enabled && config.advisor_enabled,
    model: effectiveAdvisorModel(config),
    timeoutMs: config.advisor_timeout_ms,
    syncBacklog: config.advisor_sync_backlog,
    immuneTurns: config.advisor_immune_turns,
  };
}
```


- [ ] **Step 5: Run focused config and source checks**

Run:

```bash
node --experimental-strip-types scripts/test-agent-experience-phase23-advisor-core.mjs
node --experimental-strip-types scripts/check-agent-experience-source.mjs
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json extensions/agent-experience/src/config.ts extensions/agent-experience/src/paths.ts extensions/agent-experience/src/advisor/types.ts scripts/test-agent-experience-phase23-advisor-core.mjs scripts/check-agent-experience-source.mjs
git commit -m "feat: add advisor runtime configuration"
```

---

### Task 2: Isolated Advisor agent, prompt, and emission tools

**Files:**
- Create: `extensions/agent-experience/src/advisor/prompt.ts`
- Create: `extensions/agent-experience/src/advisor/tools.ts`
- Create: `extensions/agent-experience/src/advisor/workspace-tools.ts`
- Create: `extensions/agent-experience/src/advisor/model.ts`
- Modify: `scripts/test-agent-experience-phase23-advisor-core.mjs`

**Interfaces:**
- Produces `buildAdvisorSystemPrompt(sharedInstructions?: string)`, `formatAdvisorUpdate(update)`, per-review `AdvisorAttemptBuffer`, `createAdvisorWorkspaceTools(cwd, budget)`, and `createPiAdvisorAgentAdapter(ctx, input)`.
- Adapter contract:

```ts
export interface AdvisorAgentAdapter {
  review(update: AdvisorUpdate, signal?: AbortSignal): Promise<AdvisorAttempt[]>;
  reset(): void;
  dispose(): Promise<void>;
  readonly contextTokenEstimate: number;
}
```

- [ ] **Step 1: Add failing protocol, confinement, and adapter tests**

Add tests using fake tool execution and a fake Agent factory:

```js
const habits = [{ alias: 'h1', habitId: 'durable-hidden', condition: 'When releasing', behavior: 'Verify the packed install', checksum: 'a'.repeat(64), lawHash: 'b'.repeat(64) }];
const update = {
  schemaVersion: 1,
  scope: { userId: 'owner', sessionId: 's', sessionFile: 'f' },
  generation: 1,
  epoch: 1,
  cursor: 1,
  inProgress: true,
  primaryDelta: 'Assistant called npm publish.',
  currentRequest: 'Release it.',
  habits,
  eventFingerprint: 'c'.repeat(64),
  causalEpisodeId: 'episode-1',
  causedByAdvisor: false,
};
const prompt = formatAdvisorUpdate(update);
assert.match(prompt, /\"alias\":\"h1\"/);
assert.match(prompt, /Verify the packed install/);
assert.doesNotMatch(prompt, /durable-hidden|\"checksum\"|\"lawHash\"/);
const buffer = new AdvisorAttemptBuffer();
await buffer.advise({ note: 'Run the packed-install check.', severity: 'concern' });
await buffer.reportHabitViolation({ habit_alias: 'h1', severity: 'blocker' });
assert.deepEqual(buffer.drain(), [
  { kind: 'generic_advice', note: 'Run the packed-install check.', severity: 'concern' },
  { kind: 'habit_violation', habitAlias: 'h1', severity: 'blocker' },
]);
```

Assert tool names are exactly `read`, `grep`, `glob`, `advise`, `report_habit_violation`; `glob` is the custom bounded implementation; the fourth investigative call is rejected; absolute, `~`, `..`, symlink-escape, state-root, `.git`, and known secret paths are denied; content/details are redacted and capped at 8,000 characters each/16,000 aggregate; a secret-bearing result never enters Agent messages; an emission followed by timeout cannot leak into the next update; and plain assistant text never becomes a finding.

- [ ] **Step 2: Run and confirm protocol failure**

```bash
node --experimental-strip-types scripts/test-agent-experience-phase23-advisor-core.mjs
```

Expected: missing prompt/tool/adapter modules.

- [ ] **Step 3: Implement strict prompt formatting**

`prompt.ts` must define generic-critic versus approved-habit authority, make silence mean no emission call, enforce one accepted emission per update, forbid WATCHDOG/model judgment as habit policy, reject aliases not supplied in the update, escape untrusted text, omit durable IDs/integrity fields, and reject over-bound prompts.

- [ ] **Step 4: Implement per-review emission tools**

Use exact TypeBox schemas:

```ts
const AdviseParameters = Type.Object({
  note: Type.String({ minLength: 1, maxLength: 1200 }),
  severity: Type.Optional(Type.Union([Type.Literal('nit'), Type.Literal('concern'), Type.Literal('blocker')])),
}, { additionalProperties: false });

const HabitViolationParameters = Type.Object({
  habit_alias: Type.String({ pattern: '^h[1-8]$' }),
  severity: Type.Union([Type.Literal('concern'), Type.Literal('blocker')]),
}, { additionalProperties: false });
```

Tool execution only appends to the buffer owned by the current `review()` and returns `Recorded.`. It never delivers or persists directly. Create/swap the buffer before the prompt, drain only after successful completion, and clear it in `finally` on every exit.

- [ ] **Step 5: Implement confined workspace tools**

Canonicalize the workspace root once. Wrap Pi's read/grep only after validating each requested path/root; never expose `createReadOnlyTools(cwd)` unchanged. Implement `glob` with Node's filesystem glob API, reject absolute/home/parent patterns before expansion, realpath-check every result, and cap matches. Deny Experiences state, VCS internals, `.env*`, key/certificate files, and known credential paths. Transform tool content/details through existing redaction and secret detection before Agent state sees them; uncertain output becomes a static denial. Enforce 8,000 characters per result and 16,000 aggregate per update.

- [ ] **Step 6: Implement the isolated Agent adapter and context maintenance**

Construct `Agent` with the resolved authenticated model, auth-aware `streamSimple`, the three confined workspace tools, two emission tools, sequential execution, the three-call tool budget, a 60-second parent timeout, zero hidden retry expansion, and process-local transcript only.

Before every prompt, use the selected model's context window and `estimateTokens` to estimate retained messages plus the pending prompt. At 75%, reset only the private Agent and re-prime with the current bounded update—never a model-written summary or abandoned primary history. Estimation/overflow failure returns silence. `reset()` clears Agent and per-update state; `dispose()` aborts and awaits idle.

- [ ] **Step 7: Run phase23**

Expected: authenticated/inherited model selection, exact confined tools, custom glob, result budgets/redaction, fresh attempt buffers, silence, 75% maintenance, reset, abort, timeout, and no private writes all pass.

- [ ] **Step 8: Commit**

```bash
git add extensions/agent-experience/src/advisor/prompt.ts extensions/agent-experience/src/advisor/tools.ts extensions/agent-experience/src/advisor/workspace-tools.ts extensions/agent-experience/src/advisor/model.ts scripts/test-agent-experience-phase23-advisor-core.mjs
git commit -m "feat: add isolated advisor agent"
```

---
### Task 3: Incremental transcript, emission guard, and queue runtime

**Files:**
- Create: `extensions/agent-experience/src/advisor/transcript.ts`
- Create: `extensions/agent-experience/src/advisor/emission-guard.ts`
- Create: `extensions/agent-experience/src/advisor/runtime.ts`
- Modify: `scripts/test-agent-experience-phase23-advisor-core.mjs`

**Interfaces:**
- `extractAdvisorTurnDelta(input): AdvisorPrimaryDelta | undefined`
- `AdvisorEmissionGuard.accept(attempts, update): AdvisorAttempt | undefined`
- `AdvisorRuntime.enqueue(delta): void`
- `AdvisorRuntime.reset(reason): void`
- `AdvisorRuntime.waitForCatchup(): Promise<void>`
- `AdvisorRuntime.dispose(): Promise<void>`

Runtime host:

```ts
export interface AdvisorRuntimeHost {
  buildUpdate(delta: AdvisorPrimaryDelta): Promise<AdvisorUpdate | undefined>;
  acceptFinding(finding: AcceptedAdvisorFinding, update: AdvisorUpdate): Promise<void>;
  onStaticDiagnostic(reason: AdvisorDiagnosticReason): void;
}
```

- [ ] **Step 1: Add failing transcript and queue tests**

Test:

```js
const delta = extractAdvisorTurnDelta({
  scope: { userId: 'owner', sessionId: 's', sessionFile: 'f' },
  epoch: 2,
  generation: 7,
  cursor: 11,
  currentUserEntryId: 'u-entry',
  primaryEntryIds: ['a-entry', 'tool-result-entry'],
  causalEpisodeId: 'episode-7',
  causedByAdvisor: false,
  currentRequest: 'Release the package',
  assistantMessage: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Need to publish quickly.' },
    { type: 'text', text: 'Publishing now.' },
    { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'npm publish' } },
  ] },
  toolResults: [{ role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'published' }], isError: false }],
});
assert.match(delta.text, /Publishing now|npm publish|published/);
assert.ok(delta.text.length <= 24_000);
assert.equal(delta.toolEventCount, 1);
```

Add queue assertions for single flight, five-batch bound, coalescing only within one generation/causal episode, immutable origin stamps, a queued generation-A delta while generation B starts, cursor monotonicity, reset abort, stale scope/generation/epoch discard, sync backlog thresholds, and primary release on adapter failure.

Add guard assertions for `Stop.`, `Done.`, `No issue; continue.`, exact duplicates, one-per-update, habit-over-generic priority, escalation, and a genuinely new event fingerprint.

- [ ] **Step 2: Run and confirm failure**

Expected: missing transcript/guard/runtime modules.

- [ ] **Step 3: Implement bounded transcript extraction**

Use existing redaction helpers. At `turn_end`, resolve the exact current user and ordered assistant/tool-result session-entry IDs and include the scope/epoch/generation/cursor captured for that response. Include current-turn reasoning/text/tool intent/results, cap tool events at eight, and cap serialized delta at 24,000 characters. Compute a non-reversible SHA-256 event fingerprint over session scope, stable entry-ID list, causal episode, and canonical redacted content: resume replay is identical, while a genuinely later identical action has new entry IDs. Return no delta for an Advisor-caused generation, Advisor/Experience custom message, or empty assistant turn. Missing or ambiguous stable entry identity fails closed for that delta.

- [ ] **Step 4: Implement emission guard**

Normalize with NFKC, lowercase, replace non-letter/digit runs with one space, and trim. Maintain a FIFO 4,096-key ring and a per-update consumed flag. Validate habit aliases against the current update before priority selection. Do not place suppressed notes into Adapter context.

- [ ] **Step 5: Implement AdvisorRuntime**

Implement a single async drain loop. Every await checks the envelope's captured scope/epoch/generation and disposal; current runtime state never restamps queued work. Keep at most five queued batches and coalesce only the newest envelopes sharing one response generation/causal episode by concatenating bounded redacted content and ordered `primaryEntryIds`; recompute the merged fingerprint and preserve the 24,000-character cap. Never coalesce across a generation, causal episode, reset, or scope. Abort adapter work on reset/dispose. Catch and convert failures to closed diagnostic reasons without throwing into the primary event loop. Catch-up waits cap at 30 seconds and resolves immediately during failure.

- [ ] **Step 6: Run phase23**

Expected: all transcript, guard, queue, timeout, reset, and failure-isolation assertions pass.

- [ ] **Step 7: Commit**

```bash
git add extensions/agent-experience/src/advisor/transcript.ts extensions/agent-experience/src/advisor/emission-guard.ts extensions/agent-experience/src/advisor/runtime.ts scripts/test-agent-experience-phase23-advisor-core.mjs
git commit -m "feat: add advisor review runtime"
```

---

### Task 4: Approved-habit vector retrieval and strict violation grounding

**Files:**
- Create: `extensions/agent-experience/src/advisor/habits.ts`
- Create: `extensions/agent-experience/src/advisor/retrieval-query.ts`
- Modify: `extensions/agent-experience/src/semantic/service.ts:129-190,465-528`
- Modify: `extensions/agent-experience/src/semantic/storage.ts:76-130`
- Modify: `extensions/agent-experience/src/selector.ts:123-210,430-456`
- Modify: `extensions/agent-experience/src/selector-vector.ts`
- Create: `scripts/test-agent-experience-phase24-advisor-habits-learning.mjs`

**Interfaces:**
- `prepareAdvisorHabitVectors(db, input): Promise<{ total: number; cached: number; prepared: number }>`
- `prepareAdvisorRetrievalQuery(input): Promise<{ text: string; tokenCount: number }>`
- `retrieveAdvisorHabitCandidates(db, input): Promise<AdvisorHabitCandidate[]>`
- `revalidateAdvisorHabitFinding(db, input): AdvisorHabitCandidate`
- `buildAdvisorHabitAliases(candidates): { candidates; originalIdByAlias }`

- [ ] **Step 1: Add failing vector, tokenizer, and alias tests**

Seed active, disabled, pending, superseded, stale-law, and corrupt-checksum habits. Use deterministic embeddings where a new tool behavior is close to a habit behavior but not its condition:

```js
const retrieved = await retrieveAdvisorHabitCandidates(db, {
  userId: 'owner',
  delta: behaviorDelta,
  activeRequestHabitIds: [],
  law,
  config,
  embeddingAdapter,
  signal: undefined,
});
assert.deepEqual(retrieved.map(x => x.behavior), ['Verify the packed install before publishing']);
assert.ok(retrieved.every(x => /^h[1-8]$/.test(x.alias)));
assert.ok(retrieved.every(x => !['disabled-id', 'pending-id', 'stale-id'].includes(x.habitId)));
```

Assert active request candidates sort first, retrieval uses `max(conditionSimilarity, behaviorSimilarity)`, output caps at eight, vectors alone never create a finding, and changed status/wording/law fails emission-time revalidation. Assert `prepareAdvisorRetrievalQuery` uses the configured local tokenizer, prioritizes tool intent/results over prose, and yields at most 128 actual token IDs for 24,000-character ASCII, multibyte, and adversarial no-whitespace deltas while preserving the emergent action signal.

- [ ] **Step 2: Run phase24 and confirm failure**

```bash
node --experimental-strip-types scripts/test-agent-experience-phase24-advisor-habits-learning.mjs
```

Expected: missing Advisor habit/retrieval modules.

- [ ] **Step 3: Expose reusable field-vector preparation**

Refactor `semantic/service.ts` without changing duplicate behavior. Export bounded preparation/persistence of exact condition and behavior embedding namespaces for a current-law snapshot, with row revalidation before commit. Keep duplicate comparison's lower-of-two-field score unchanged.

- [ ] **Step 4: Implement tokenizer-bounded behavior retrieval**

Build a deterministic redacted high-signal source from bounded tool names, sanitized arguments/results, and assistant action text. Load the exact configured local tokenizer, encode, retain action-priority spans, and decode at most 128 token IDs. Do not send the 24,000-character Advisor delta directly to `EmbeddingAdapter.embed`.

Embed the fitted query once. Read exact current-law condition/behavior vectors, score each eligible active habit by the higher field similarity, apply the existing conservative floor, sort score-descending/id-ascending, union active request habits first, cap eight, then alias. If preparation or extra retrieval fails, retain still-valid active-request habits; never use lexical fallback or alter the direct selector query path.

- [ ] **Step 5: Implement strict revalidation**

Map alias to durable ID only in memory. Immediately before delivery, require exact user, active status, condition, behavior, checksum, approval identity, confidence/freshness, law hash, response generation, cursor, and Advisor epoch. Return exact approved wording only.

- [ ] **Step 6: Run phase24 and existing vector suites**

```bash
node --experimental-strip-types scripts/test-agent-experience-phase24-advisor-habits-learning.mjs
node --experimental-strip-types scripts/test-agent-experience-phase19-vector-selector.mjs
node --experimental-strip-types scripts/test-agent-experience-phase20-context-selector.mjs
node --experimental-strip-types scripts/test-agent-experience-phase10-semantic-dedupe.mjs
```

Expected: all pass with unchanged direct-selector and duplicate semantics.

- [ ] **Step 7: Commit**

```bash
git add extensions/agent-experience/src/advisor/habits.ts extensions/agent-experience/src/advisor/retrieval-query.ts extensions/agent-experience/src/semantic/service.ts extensions/agent-experience/src/semantic/storage.ts extensions/agent-experience/src/selector.ts extensions/agent-experience/src/selector-vector.ts scripts/test-agent-experience-phase24-advisor-habits-learning.mjs
git commit -m "feat: ground advisor in approved habits"
```

---
### Task 5: Visible messages, safe steering, and extension lifecycle wiring

**Files:**
- Create: `extensions/agent-experience/src/advisor/message.ts`
- Modify: `extensions/agent-experience/index.ts:1-118,2917-3389`
- Modify: `scripts/test-agent-experience-phase24-advisor-habits-learning.mjs`

**Interfaces:**
- Stable message type `agent_experience.advisor_finding` and fallback entry type `agent_experience.advisor_finding_visible`.
- `buildAdvisorCustomMessage(finding, update): { customType; content; display; details }`
- `renderAdvisorFinding(message, options, theme): Component`
- `chooseAdvisorDelivery(input): { mode: 'steer' | 'append_when_settled' | 'append_now' | 'visible_fallback' }`
- Index owns one `AdvisorRuntime` and one causal-generation tracker per exact session scope.

- [ ] **Step 1: Add failing message, delivery, and lifecycle tests**

Register a fake ExtensionAPI and drive real event names. Assert:

```js
assert.deepEqual(delivered.at(-1).message.details, {
  schema_version: 1,
  kind: 'habit_violation',
  severity: 'blocker',
  condition: 'When releasing packages',
  behavior: 'Verify the packed install first',
  created_at: '2026-08-04T00:00:00.000Z',
});
assert.match(delivered.at(-1).message.content, /<advisory severity=\"blocker\"[^>]*>.*Verify the packed install first.*<\/advisory>/s);
assert.doesNotMatch(JSON.stringify(delivered.at(-1)), /habit-id|checksum|vector|score|alias/);
```

Test active non-plan-mode concern/blocker uses `steer`; nit never uses `followUp` or triggers a turn; terminal, canceled, plan-mode, ambiguous, and idle states append immediately or after `agent_settled` with `triggerTurn:false` and no `deliverAs`; shutdown uses a same-schema `appendEntry` fallback only when model-visible delivery is impossible. Test the latest active-branch `plan-mode` custom-state convention, no hidden `nextTurn`, no extra continuation, delivery causal marking, catch-up behavior for `off`/`1`/`3`/`5`, and stale rejection across tree navigation, compaction, model selection, reset, and shutdown.

- [ ] **Step 2: Run phase24 and confirm failure**

Expected: missing message renderer/delivery and lifecycle wiring.

- [ ] **Step 3: Implement safe custom messages and both renderers**

Validate exact details keys and bounds. Generic details contain sanitized note; habit details contain exact condition/behavior. Render distinct `◇ Advisor` and `◇ Experience · habit violation` collapsed/expanded cards. Escape model-visible XML. Generic advice alone carries `guidance=\"weigh, don't blindly obey\"`. The UI-only fallback renderer uses the same visible details but never claims guidance reached the model.

- [ ] **Step 4: Implement delivery policy**

Never use `sendUserMessage`, `followUp`, or `nextTurn`. Eligible active concern/blocker findings use `steer`. Nits and all non-steerable findings remain process-local until `agent_settled`, then call `sendMessage(message, { triggerTurn: false })` with no delivery mode; if already idle, append immediately. If shutdown/replacement prevents model-visible append, use `pi.appendEntry` with the safe fallback type.

Detect plan mode from the latest validated `plan-mode` custom entry on the active branch. Enabled or malformed/ambiguous present state means visible-only delivery. Track cancellation, terminal state, client capability, and immune turns conservatively.

- [ ] **Step 5: Wire exact Pi lifecycle and causal tracking**

Require `@earendil-works/pi-coding-agent >=0.83.0` with public `agent_settled`. Register message and entry renderers. Abort/increment epoch before `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_before_tree`, and `session_shutdown`; rebuild/reseed after successful `session_start`, `session_compact`, and `session_tree`. Reset/rebuild directly after model selection or Advisor-model config changes. If a before-event is canceled, reseed the current branch rather than reusing the aborted runtime.

At `before_agent_start`, increment and snapshot response generation, current user entry, request, scope, epoch, and whether the run was caused by an Advisor custom message observed via `message_start`/`message_end`. At `turn_end`, resolve assistant entry, suppress Advisor-caused generations, enqueue the immutable envelope, and conditionally await `waitForCatchup()` according to `advisor_sync_backlog`, releasing immediately on failure/reset. At `agent_settled`, append pending non-steering cards without a turn. Clear causal state only when the next genuinely user-caused generation begins. Revalidate scope/generation/cursor/epoch immediately before generic and habit delivery. Flush truthful visible fallbacks and dispose on shutdown.

- [ ] **Step 6: Run focused integration regressions**

```bash
node --experimental-strip-types scripts/test-agent-experience-phase23-advisor-core.mjs
node --experimental-strip-types scripts/test-agent-experience-phase24-advisor-habits-learning.mjs
node --experimental-strip-types scripts/test-agent-experience-phase22-provider-guidance.mjs
node --experimental-strip-types scripts/test-agent-experience-phase18-break-in.mjs
```

Expected: all pass; existing direct transient habit guidance remains provider-level.

- [ ] **Step 7: Commit**

```bash
git add extensions/agent-experience/src/advisor/message.ts extensions/agent-experience/index.ts scripts/test-agent-experience-phase24-advisor-habits-learning.mjs
git commit -m "feat: deliver advisor findings safely"
```

---
### Task 6: Advisor findings as bounded learning evidence

**Files:**
- Create: `extensions/agent-experience/src/advisor/observation.ts`
- Modify: `extensions/agent-experience/src/storage/observations.ts:17-36,396-440`
- Modify: `extensions/agent-experience/src/consolidate/observations.ts:11-70`
- Modify: `extensions/agent-experience/src/consolidate/model-adapter.ts:35-45,108-120,150-190`
- Modify: `extensions/agent-experience/src/consolidate/prompt.ts:1-30`
- Modify: `extensions/agent-experience/index.ts`
- Modify: `scripts/test-agent-experience-phase24-advisor-habits-learning.mjs`

**Interfaces:**
- `buildAdvisorFindingObservation(finding, update, createdAt): AdvisorFindingPayloadV1`
- `appendAdvisorFindingObservation(root, input): Promise<{ appended: boolean; reason: string }>`
- Payload kind `advisor_finding_v1`, origin source `advisor_finding`.

- [ ] **Step 1: Add failing observation, replay, and threshold tests**

Assert Learning-off writes nothing. Learning-on writes one bounded record:

```js
assert.deepEqual(record.origin, { source: 'advisor_finding' });
assert.equal(record.payload_redacted.kind, 'advisor_finding_v1');
assert.equal(record.payload_redacted.finding_kind, 'generic_advice');
assert.equal(record.payload_redacted.severity, 'concern');
assert.ok(record.payload_redacted.primary_behavior_redacted.length <= 3000);
assert.ok(record.payload_redacted.advice_redacted.length <= 1200);
assert.doesNotMatch(JSON.stringify(record), /model|provider|habit_id|alias|vector|score|thinking/);
```

Assert one stable causal fingerprint appends once across restart/resume, a later identical action with new entry IDs can append, Advisor-caused generations and UI-only fallback cards are excluded, total payload is at most 6,000 characters, validation accepts both payload kinds, and Analyze preserves Advisor origin.

- [ ] **Step 2: Run phase24 and confirm failure**

Expected: unsupported origin/payload kind and missing durable dedupe.

- [ ] **Step 3: Implement bounded observation creation and durable replay rejection**

Use the exact payload:

```ts
interface AdvisorFindingPayloadV1 {
  kind: 'advisor_finding_v1';
  finding_kind: 'generic_advice' | 'habit_violation';
  severity: AdvisorSeverity;
  current_request_redacted: string;
  primary_behavior_redacted: string;
  advice_redacted: string;
  event_fingerprint: string;
  primary_created_at: string;
}
```

Redact before serialization, reject residual secrets, and derive a deterministic observation ID from the non-reversible event fingerprint. Under the existing observation lock, reverse-read the active retained generation through fixed-size offsets up to a hard cap; reject an existing ID/fingerprint and fail closed if the cap is exceeded. Keep the in-memory ring only as a fast path. Append only after model-visible accepted delivery and only when `config.enabled && config.capture_enabled`.

- [ ] **Step 4: Extend validation and deterministic Analyze authority**

Allow exact origin `advisor_finding` and payload kind `advisor_finding_v1`. Render it to the model as a distinct lower-authority field, not a user correction:

```ts
return payload.kind === 'advisor_finding_v1'
  ? { seq, checksum, created_at, origin: 'advisor_finding', user: request, assistant: behavior, advisor_finding: advice, severity }
  : { seq, checksum, created_at, origin: record.origin.source, user, assistant };
```

Before prompting, collapse Advisor observations by event fingerprint. In deterministic normalization, Advisor-origin refs can never satisfy `explicitCorrection`, correction-split, or any one-shot replacement path. Prompt text states that distinct recurrence and normal review/approval remain mandatory.

- [ ] **Step 5: Test recurrence, correction bypass, and causality**

Use three distinct fingerprints across two days and verify they may create a pending suggestion only through repeated evidence. Verify one high-confidence Advisor correction remains `collecting`; restart replay, duplicate rows, same-day-only evidence, one-shot correction output, and Advisor-caused generations do not qualify. Verify a later identical action with new stable entry IDs is distinct and explicit approval is still required.

- [ ] **Step 6: Run observation, Analyze, and capture suites**

```bash
node --experimental-strip-types scripts/test-agent-experience-phase24-advisor-habits-learning.mjs
node --experimental-strip-types scripts/test-agent-experience-phase12-observations.mjs
node --experimental-strip-types scripts/test-agent-experience-phase4b-model-output.mjs
node --experimental-strip-types scripts/test-agent-experience-phase9-setup-analyze.mjs
node --experimental-strip-types scripts/test-agent-experience-phase3-capture.mjs
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add extensions/agent-experience/src/advisor/observation.ts extensions/agent-experience/src/storage/observations.ts extensions/agent-experience/src/consolidate/observations.ts extensions/agent-experience/src/consolidate/model-adapter.ts extensions/agent-experience/src/consolidate/prompt.ts extensions/agent-experience/index.ts scripts/test-agent-experience-phase24-advisor-habits-learning.mjs
git commit -m "feat: learn from advisor findings safely"
```

---
### Task 7: Grouped `/experience setup`

**Files:**
- Create: `extensions/agent-experience/src/setup-ui.ts`
- Modify: `extensions/agent-experience/index.ts:99-276,919-1240,2284-2458`
- Create: `scripts/test-agent-experience-phase25-grouped-setup.mjs`
- Modify: `scripts/test-agent-experience-phase1.mjs:149-185`
- Modify: `scripts/test-agent-experience-phase9-setup-analyze.mjs:159-236,398-465`
- Modify: `scripts/test-installed-tui-smoke.py:37-67`

**Interfaces:**
- `SetupView = 'home' | 'learning' | 'guidance' | 'habits' | 'automation' | 'status'`
- `buildSetupItems(view, snapshot): SettingItem[]`
- `buildFallbackSetupOptions(view, snapshot): string[]`
- `SetupSnapshot` includes config, counts, semantic-file state, and effective Advisor model.
- `showSetupView(ctx, view, snapshot): Promise<SetupAction | undefined>`.

- [ ] **Step 1: Add failing pure setup tests**

Assert the home has exactly seven rows in this order:

```js
assert.deepEqual(buildSetupItems('home', snapshot).map(x => x.label), [
  'Learning from conversations',
  'Guidance and Advisor',
  'Manage habits',
  'Automation and privacy',
  'Status and help',
  'Turn everything off',
  'Done',
]);
```

Assert the four subpanel row sets exactly match the approved spec, custom/fallback labels are semantically identical, Advisor status renders inherited/override models, opening setup performs no writes, toggles remain independent, and all-off disables runtime gates while preserving records/local files.

- [ ] **Step 2: Run phase25 and confirm failure**

Expected: missing setup-ui module and old fifteen-row home.

- [ ] **Step 3: Extract setup UI primitives**

Move setup `SettingsList` component, styles, item types, grouped builders, and fallback labels into `setup-ui.ts`. Do not move product mutations into UI code. The UI returns typed actions; `index.ts` handlers remain mutation owners.

- [ ] **Step 4: Implement grouped navigation**

Replace the old `SetupAction` flat loop with a view stack. `Back` returns to home; Esc closes the current subpanel to home, then closes setup from home. Both custom and fallback UIs use the same snapshot and action IDs.

- [ ] **Step 5: Implement Advisor controls and disclosures**

Add handlers for Advisor on/off and model inherit/override. Enabling validates auth, presents the approved concise disclosure, and requires explicit confirmation. The model picker begins with `Same as habit assessment`. Do not add hybrid, learning-evidence, tool, sync-backlog, or immune-turn controls to normal setup.

- [ ] **Step 6: Contextually prepare shared semantic files**

When approved habits or duplicate prevention is enabled, prepare required local assets and exact vector namespaces through one progress panel. `Local semantic files` explains/verifies/removes files; removal is blocked or requires disabling dependent features first. No implementation terms such as dimensions, basis points, checksums, or provider endpoints appear in normal UI.

- [ ] **Step 7: Run grouped setup and existing setup tests**

```bash
node --experimental-strip-types scripts/test-agent-experience-phase25-grouped-setup.mjs
node --experimental-strip-types scripts/test-agent-experience-phase1.mjs
node --experimental-strip-types scripts/test-agent-experience-phase9-setup-analyze.mjs
```

Expected: all pass with seven-row grouped home and unchanged mutation safety.

- [ ] **Step 8: Run isolated installed TUI setup smoke**

Run the existing packed/install PTY fixture command used by project validation, not the live extension. Capture artifact paths for wide/narrow home and all subpanels.

- [ ] **Step 9: Commit**

```bash
git add extensions/agent-experience/src/setup-ui.ts extensions/agent-experience/index.ts scripts/test-agent-experience-phase25-grouped-setup.mjs scripts/test-agent-experience-phase1.mjs scripts/test-agent-experience-phase9-setup-analyze.mjs scripts/test-installed-tui-smoke.py
git commit -m "feat: simplify experience setup"
```

---

### Task 8: Package gates, documentation, and isolated Advisor TUI smoke

**Files:**
- Create: `scripts/fixtures/advisor-tui-driver.ts`
- Create: `scripts/test-advisor-tui-smoke.py`
- Create: `scripts/verify-isolated-package.mjs`
- Modify: `package.json:42-50`
- Modify: `scripts/check-agent-experience-source.mjs`
- Modify: `scripts/verify-packed-install.mjs:14-58`
- Modify: `README.md`
- Modify: `extensions/agent-experience/README.md`
- Modify: `extensions/agent-experience/VALIDATION.md`
- Modify: `skills/agent-experience/SKILL.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- `check:agent-experience` runs phases 23, 24, and 25 after phase22.
- Packed verifier requires all Advisor/setup source files and resolves direct `@earendil-works/pi-agent-core ^0.83.0` plus `@earendil-works/pi-coding-agent >=0.83.0` peers in an isolated install.
- `verify-isolated-package.mjs` creates one temporary directory, packs there, fresh-installs there, runs packed/source/runtime checks and both PTY smokes with explicit installed-package/transcript paths and temporary `AX_STATE_ROOT`, then removes the directory in `finally`.

- [ ] **Step 1: Add failing package-gate assertions**

Require phase23/24/25 scripts in the check command, Advisor/setup modules in packed artifacts, no private Advisor transcript patterns such as `__advisor.jsonl`, no unwrapped read-only tools, no mutating Advisor tool names in `advisor/model.ts`, direct `pi-agent-core` externalization, and `pi-coding-agent >=0.83.0`.

- [ ] **Step 2: Run source checks to confirm failure**

```bash
node --experimental-strip-types scripts/check-agent-experience-source.mjs
```

Expected: failure until package gates and required files are updated. Do not invoke `verify-packed-install.mjs` without an installed-package argument.

- [ ] **Step 3: Add isolated Advisor TUI smoke**

The PTY smoke must use the packed/fresh-installed package created by `verify-isolated-package.mjs`, temporary `AX_STATE_ROOT`, explicit transcript destinations, and a test-only companion extension loaded alongside the package. Create `scripts/fixtures/advisor-tui-driver.ts`; its `/advisor-smoke` command imports `buildAdvisorCustomMessage`, sends deterministic generic/habit fixtures through Pi's public custom-message API, and never modifies production runtime behavior. Verify:

- collapsed/expanded generic nit, concern, blocker cards;
- collapsed/expanded habit violation card with exact `When`/`Do`;
- narrow and wide wrapping;
- generic advice framing versus habit authority;
- one card per update;
- no IDs, aliases, scores, checksums, transcript excerpts, private paths, or raw model output;
- no live user state touched.

- [ ] **Step 4: Update existing documentation**

Read and follow `skill://skill-maintainer` before changing the installed skill. Document the grouped setup first. Explain separate Advisor model inheritance, incremental second-model review, confined read-only tools, generic versus habit authority, safe steering/visible-only states, learning evidence gates, private-state non-persistence, and exact stock Pi delivery limitations. Keep typed subcommands advanced/backward-compatible only.

Update `CHANGELOG.md` under **Unreleased** only.

- [ ] **Step 5: Update package and isolated validation**

Append phases 23-25 to `check:agent-experience`. Add Advisor/setup paths to packed required files. Include `@earendil-works/pi-agent-core` and the supported `@earendil-works/pi-coding-agent` peer in isolated dependency resolution and size accounting. Preserve no install/postinstall scripts.

Implement `scripts/verify-isolated-package.mjs` with `mkdtemp`, `npm pack --pack-destination <tmp>`, a fresh `npm install --prefix <tmp>/install <tarball>`, explicit installed-package and transcript arguments to both Python smokes, a child-only `AX_STATE_ROOT=<tmp>/state`, and unconditional recursive cleanup. It must refuse any destination under the repository, npm cache, global prefix, or live Experience state root.

- [ ] **Step 6: Run focused package gates and isolated smokes**

```bash
node --experimental-strip-types scripts/check-agent-experience-source.mjs
node scripts/verify-isolated-package.mjs
```

Expected: all source, packed-install, grouped setup TUI, and Advisor TUI checks pass; the harness prints artifact paths before cleanup or copies screenshots/transcripts to the repository's ignored test-artifact directory, and confirms no live state/install was touched.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json scripts/check-agent-experience-source.mjs scripts/verify-packed-install.mjs scripts/verify-isolated-package.mjs scripts/test-advisor-tui-smoke.py scripts/fixtures/advisor-tui-driver.ts README.md extensions/agent-experience/README.md extensions/agent-experience/VALIDATION.md skills/agent-experience/SKILL.md CHANGELOG.md
git commit -m "docs: document hybrid advisor experience"
```

---
### Task 9: Full validation and independent reviews

**Files:**
- Modify only files required to fix evidence-backed review findings.

**Interfaces:**
- Produces final command evidence, TUI artifact paths, changed-file report, architecture limitations, and clean stop-gate status.

- [ ] **Step 1: Run the complete package suite**

```bash
npm run check
```

Expected: exit 0 with phases 1-25, source, CLI, and generated checks passing.

- [ ] **Step 2: Run security and artifact checks**

```bash
npm audit --omit=dev
git diff --check
node scripts/verify-isolated-package.mjs
```

Expected: audit reports no production vulnerability requiring action; diff check and packed verifier pass.

- [ ] **Step 3: Run isolated behavior smoke**

Exercise a temporary session containing:

1. compliant generic work — silence;
2. generic concrete concern — one Advisor card and safe steer;
3. active approved habit violation — one exact Experience card and exact behavior guidance;
4. emergent tool behavior matching a previously inactive habit — embedding retrieval then violation;
5. Learning off — no observation;
6. Learning on — one `advisor_finding_v1` observation;
7. repeated same event — no duplicate;
8. session reset during review — late result discarded.

Expected: all eight scenarios pass without reading or writing the installed state root.

- [ ] **Step 4: Perform required reviews in parallel**

After the candidate passes the smoke, dispatch four independent reviewers concurrently:

- skill-maintainer audit for `skills/agent-experience/SKILL.md` routing and authority accuracy;
- architecture/code review against the approved design and documented Pi APIs;
- security/privacy review of workspace-tool confinement, prompt/result redaction, persistent payloads, and stale-state handling;
- Constitution review against the stabilized candidate and the explicit 2026-08-04 hybrid-scope supersession.

Give each reviewer exact changed-file and spec paths; instruct read-only review and no project-wide validation. Fix every blocking or high-severity evidence-backed finding, then rerun affected focused tests followed by `npm run check` and `node scripts/verify-isolated-package.mjs` once.

- [ ] **Step 5: Verify stop gates and report**

Report:

- exact changed files;
- local branch and commits;
- Advisor model/tool/delivery architecture;
- Pi extension delivery limitations;
- focused/full command results;
- TUI screenshot/artifact paths;
- installed runtime untouched;
- no version bump, tag, merge, push, reload, timer change, staging, or publication.

Do not merge or push.
