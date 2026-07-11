#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension, {
  __enqueueAgentExperienceBreakInForTest,
  __resetAgentExperienceBreakInForTest,
  __setAgentExperienceBreakInPendingCountForTest,
} from '../extensions/agent-experience/index.ts';
import { BreakInQueue, BREAK_IN_BATCH_TTL_MS, BREAK_IN_QUEUE_LIMIT } from '../extensions/agent-experience/src/break-in.ts';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG, formatAgentExperienceConfig, parseAgentExperienceConfig } from '../extensions/agent-experience/src/config.ts';
import { getAgentExperiencePaths, readAgentExperienceConfig, setAgentExperienceBreakInEnabled, setAgentExperienceConsolidationEnabled, setAgentExperienceConsolidationModel, setAgentExperienceEnabled, setAgentExperienceTimerEnabled, writeAgentExperienceConfig } from '../extensions/agent-experience/src/paths.ts';

const temp = await mkdtemp(join(tmpdir(), 'pi-experiences-phase18-'));
try {
  process.env.AX_STATE_ROOT = join(temp, 'state');
  const paths = getAgentExperiencePaths();
  await writeAgentExperienceConfig({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, capture_enabled: true, consolidation_enabled: true, break_in_enabled: true }, paths);

  const legacy = parseAgentExperienceConfig('break_in_enabled = true\nbreak_in_auto_apply_min_confidence_bp = 1\n[break_in]\nauto_apply_min_confidence_bp = 1\n');
  assert.equal(legacy.break_in_enabled, true);
  assert.doesNotMatch(formatAgentExperienceConfig(legacy), /auto_apply_min_confidence/);

  await setAgentExperienceTimerEnabled(true, paths);
  assert.equal((await readAgentExperienceConfig(paths)).config.break_in_enabled, true, 'timer setter preserves explicit break-in preference');
  await setAgentExperienceConsolidationModel('test/model', paths);
  assert.equal((await readAgentExperienceConfig(paths)).config.break_in_enabled, true, 'model setter preserves explicit break-in preference');
  await setAgentExperienceConsolidationEnabled(false, paths);
  assert.equal((await readAgentExperienceConfig(paths)).config.break_in_enabled, true, 'consolidation setter preserves explicit break-in preference');
  await setAgentExperienceEnabled(false, paths);
  assert.equal((await readAgentExperienceConfig(paths)).config.break_in_enabled, false, 'master off clears break-in');
  await setAgentExperienceEnabled(true, paths);
  await setAgentExperienceBreakInEnabled(true, paths);

  const queue = new BreakInQueue();
  const scope = { userId: 'owner', sessionId: 'session', sessionFile: '/tmp/session.jsonl' };
  assert.equal(queue.enqueue({ origin: 'manual', batchId: 'one', scope, suggestionCount: 2, now: 10 }).queued, true);
  assert.equal(queue.enqueue({ origin: 'manual', batchId: 'one', scope, suggestionCount: 2, now: 11 }).queued, false, 'same batch queues once');
  assert.equal(queue.peek(scope, 10)?.suggestionCount, 2);
  assert.equal(queue.peek(scope, 10 + BREAK_IN_BATCH_TTL_MS), undefined, 'stale batch expires');
  for (let index = 0; index <= BREAK_IN_QUEUE_LIMIT; index += 1) queue.enqueue({ origin: 'manual', batchId: `batch-${index}`, scope, suggestionCount: 1, now: 100 + index });
  assert.equal(queue.size(200), BREAK_IN_QUEUE_LIMIT, 'memory queue remains bounded');

  __resetAgentExperienceBreakInForTest();
  __setAgentExperienceBreakInPendingCountForTest(1);
  const handlers = new Map();
  const commands = new Map();
  agentExperienceExtension({
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool() {},
    registerEntryRenderer() {},
    on(event, handler) { handlers.set(event, handler); },
  });

  const choices = [];
  const notifications = [];
  const ctx = {
    mode: 'tui',
    hasUI: true,
    signal: undefined,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => 'session', getSessionFile: () => '/tmp/session.jsonl' },
    ui: {
      async select(title, options) { choices.push({ title, options }); return 'Later'; },
      notify(message, level) { notifications.push({ message, level }); },
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };

  __enqueueAgentExperienceBreakInForTest(ctx, 'tool-gated');
  await handlers.get('tool_execution_start')({ toolCallId: 'tool-1' }, ctx);
  await handlers.get('agent_settled')({}, ctx);
  assert.equal(choices.length, 0, 'tool activity suppresses prompt');
  await handlers.get('tool_execution_end')({ toolCallId: 'tool-1' }, ctx);
  await handlers.get('agent_settled')({}, ctx);
  assert.equal(choices.length, 1);
  assert.deepEqual(choices[0].options, ['Review now', 'Later', 'Turn break-in off']);
  await handlers.get('agent_settled')({}, ctx);
  assert.equal(choices.length, 1, 'one prompt per batch');

  __enqueueAgentExperienceBreakInForTest(ctx, 'compact-gated');
  await handlers.get('session_before_compact')({}, ctx);
  await handlers.get('agent_settled')({}, ctx);
  assert.equal(choices.length, 1, 'compaction suppresses prompt');
  await handlers.get('session_compact')({}, ctx);
  await handlers.get('agent_settled')({}, ctx);
  assert.equal(choices.length, 2);

  ctx.ui.select = async (title, options) => { choices.push({ title, options }); return 'Turn break-in off'; };
  __enqueueAgentExperienceBreakInForTest(ctx, 'turn-off');
  await handlers.get('agent_settled')({}, ctx);
  assert.equal((await readAgentExperienceConfig(paths)).config.break_in_enabled, false, 'prompt can explicitly turn itself off');

  await setAgentExperienceBreakInEnabled(true, paths);
  __enqueueAgentExperienceBreakInForTest(ctx, 'shutdown');
  await handlers.get('session_shutdown')({}, ctx);
  await handlers.get('agent_settled')({}, ctx);
  assert.equal(choices.length, 3, 'shutdown cancels pending batch');

  __resetAgentExperienceBreakInForTest();
  delete process.env.AX_STATE_ROOT;
  console.log('agent-experience phase18 break-in checks passed');
} finally {
  __resetAgentExperienceBreakInForTest();
  delete process.env.AX_STATE_ROOT;
  await rm(temp, { recursive: true, force: true });
}
