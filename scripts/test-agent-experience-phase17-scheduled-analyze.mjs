#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import agentExperienceExtension from '../extensions/agent-experience/index.ts';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { loadStandalonePiRuntime } from '../extensions/agent-experience/src/consolidate/standalone-model-adapter.ts';
import { setAgentExperienceConsolidationModel, setAgentExperienceTimerEnabled } from '../extensions/agent-experience/src/paths.ts';
import { consumeScheduledAnalyzeReceipts, readScheduledAnalyzeReceipts, SCHEDULED_ANALYZE_RECEIPT_LIMIT, transitionScheduledAnalyzeReceiptBreakInDelivery, writeScheduledAnalyzeReceipt } from '../extensions/agent-experience/src/schedule/receipts.ts';
import { runScheduledAnalyzeCore, safeScheduledAnalyzeErrorCode } from '../extensions/agent-experience/src/schedule/runner.ts';
import { __encodeSystemdConditionPathForTest, __serviceOwnsScheduledAnalyzeStateRootForTest, disableScheduledAnalyzeSystemd, installScheduledAnalyzeSystemd, renderScheduledAnalyzeUnits, SCHEDULED_ANALYZE_ON_CALENDAR, SCHEDULED_ANALYZE_SERVICE, SCHEDULED_ANALYZE_TIMER } from '../extensions/agent-experience/src/schedule/systemd.ts';
import { acquireOwnedLock } from '../extensions/agent-experience/src/storage/locks.ts';
import { appendObservation } from '../extensions/agent-experience/src/storage/observations.ts';

const execFileAsync = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'pi-experiences-phase17-'));
try {
  const fakeRuntimeRoot = join(temp, 'fake-pi-runtime');
  await mkdir(join(fakeRuntimeRoot, 'dist'), { recursive: true });
  await mkdir(join(fakeRuntimeRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist'), { recursive: true });
  await writeFile(join(fakeRuntimeRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', type: 'module' }));
  await writeFile(join(fakeRuntimeRoot, 'dist', 'index.js'), 'export class ModelRuntime { static async create() { return { api: "modern" }; } }\nexport class ModelRegistry { constructor(runtime) { this.runtime = runtime; } }\n');
  await writeFile(join(fakeRuntimeRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'compat.js'), 'export async function completeSimple() { return {}; }\n');
  const fakeRuntime = await loadStandalonePiRuntime(fakeRuntimeRoot);
  assert.equal((await fakeRuntime.createModelRegistry()).runtime.api, 'modern');
  assert.equal(typeof fakeRuntime.completeSimple, 'function');
  const legacyRuntimeRoot = join(temp, 'legacy-pi-runtime');
  await mkdir(join(legacyRuntimeRoot, 'dist'), { recursive: true });
  await mkdir(join(legacyRuntimeRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist'), { recursive: true });
  await writeFile(join(legacyRuntimeRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', type: 'module' }));
  await writeFile(join(legacyRuntimeRoot, 'dist', 'index.js'), 'export class AuthStorage { static create() { return { api: "legacy" }; } }\nexport class ModelRegistry { static create(auth) { return { auth }; } }\n');
  await writeFile(join(legacyRuntimeRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'compat.js'), 'export async function completeSimple() { return {}; }\n');
  const legacyRuntime = await loadStandalonePiRuntime(legacyRuntimeRoot);
  assert.equal((await legacyRuntime.createModelRegistry()).auth.api, 'legacy');
  assert.equal(safeScheduledAnalyzeErrorCode(new Error('pi_runtime_root_missing_coding_agent_api')), 'runtime_incompatible');
  await assert.rejects(() => loadStandalonePiRuntime(undefined), /pi_runtime_root_missing/);
  await assert.rejects(() => loadStandalonePiRuntime('relative/path'), /pi_runtime_root_not_absolute/);
  const wrongRuntimeRoot = join(temp, 'wrong-runtime');
  await mkdir(wrongRuntimeRoot, { recursive: true });
  await writeFile(join(wrongRuntimeRoot, 'package.json'), JSON.stringify({ name: 'not-pi' }));
  await assert.rejects(() => loadStandalonePiRuntime(wrongRuntimeRoot), /pi_runtime_root_wrong_package/);

  const stateRoot = join(temp, 'state');
  const paths = { root: stateRoot, configPath: join(stateRoot, 'agent-experience.toml') };
  const cliPath = resolve('dist/experience-consolidate.mjs');
  const unitContext = { nodePath: process.execPath, cliPath, paths, userId: 'owner', piAgentDir: join(temp, 'pi-agent'), piRuntimeRoot: join(temp, 'pi-runtime') };
  const rendered = renderScheduledAnalyzeUnits(unitContext);
  assert.match(rendered.timer, new RegExp(`OnCalendar=${SCHEDULED_ANALYZE_ON_CALENDAR.replace(/[*]/g, '\\*')}`));
  assert.match(rendered.timer, /Persistent=true/);
  assert.doesNotMatch(rendered.timer, /RandomizedDelaySec/);
  assert.match(rendered.timer, new RegExp(`Unit=${SCHEDULED_ANALYZE_SERVICE}`));
  assert.equal(__encodeSystemdConditionPathForTest('/tmp/a b%$c'), '/tmp/a b%%$c');
  for (const invalid of ['relative/path', '/tmp/trailing ', '/tmp/new\nline', '/tmp/carriage\rreturn', '/tmp/nul\0byte', '/tmp/back\\slash', '/tmp/double"quote']) {
    assert.throws(() => __encodeSystemdConditionPathForTest(invalid), /scheduled_unit_invalid_path/);
  }
  assert.match(rendered.service, new RegExp(`ConditionPathExists=${paths.configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(rendered.service, /ConditionPathExists=["']/);
  assert.match(rendered.service, / scheduled --root /);
  assert.match(rendered.service, / --pi-runtime-root /);
  assert.match(rendered.service, /SyslogIdentifier=pi-experiences-analyze/);
  assert.doesNotMatch(rendered.service, /\/usr\/bin\/env|exit 1/);
  assert.equal(__serviceOwnsScheduledAnalyzeStateRootForTest(rendered.service, paths.root), true);
  assert.equal(__serviceOwnsScheduledAnalyzeStateRootForTest(rendered.service, join(temp, 'other-state')), false);

  if (process.platform === 'linux') {
    const verifyDir = join(temp, 'verify-units');
    await mkdir(verifyDir, { recursive: true });
    const servicePath = join(verifyDir, SCHEDULED_ANALYZE_SERVICE);
    const timerPath = join(verifyDir, SCHEDULED_ANALYZE_TIMER);
    await writeFile(servicePath, rendered.service);
    await writeFile(timerPath, rendered.timer);
    try {
      const verified = await execFileAsync('systemd-analyze', ['--user', 'verify', servicePath, timerPath], {
        env: { ...process.env, SYSTEMD_UNIT_PATH: [verifyDir, '/usr/local/lib/systemd/user', '/usr/lib/systemd/user'].join(delimiter) },
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      assert.doesNotMatch(`${verified.stdout || ''}\n${verified.stderr || ''}`, /path is not absolute|ignoring:/i);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const unitDir = join(temp, 'units');
  await mkdir(join(temp, 'pi-agent'), { recursive: true });
  await mkdir(join(temp, 'pi-runtime'), { recursive: true });
  const calls = [];
  const executor = async (command, args) => {
    calls.push([command, ...args]);
    return { stdout: '' };
  };
  await installScheduledAnalyzeSystemd(paths, 'owner', { executor, unitDir, nodePath: process.execPath, cliPath, piAgentDir: join(temp, 'pi-agent'), piRuntimeRoot: join(temp, 'pi-runtime') });
  assert.equal(existsSync(join(unitDir, SCHEDULED_ANALYZE_SERVICE)), true);
  assert.equal(existsSync(join(unitDir, SCHEDULED_ANALYZE_TIMER)), true);
  assert.deepEqual(calls.filter((call) => call[0] === 'systemctl').slice(-2), [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', SCHEDULED_ANALYZE_TIMER],
  ]);
  const callsBeforeForeignDisable = calls.length;
  await assert.rejects(() => disableScheduledAnalyzeSystemd({ executor, platform: 'linux', unitDir, expectedStateRoot: join(temp, 'other-state') }), /scheduled_unit_owned_by_other_state/);
  assert.equal(calls.length, callsBeforeForeignDisable, 'foreign state root cannot disable existing user timer');
  await assert.rejects(() => installScheduledAnalyzeSystemd({ root: join(temp, 'other-state'), configPath: join(temp, 'other-state', 'agent-experience.toml') }, 'owner', { executor, unitDir, nodePath: process.execPath, cliPath, piAgentDir: join(temp, 'pi-agent'), piRuntimeRoot: join(temp, 'pi-runtime') }), /scheduled_unit_owned_by_other_state/);
  const failedDir = join(temp, 'failed-units');
  await assert.rejects(() => installScheduledAnalyzeSystemd(paths, 'owner', { executor: async () => { throw new Error('offline'); }, unitDir: failedDir, nodePath: process.execPath, cliPath }), /systemd_unavailable/);
  assert.equal(existsSync(failedDir), false, 'failed preflight writes no units');

  const failedEnableDir = join(temp, 'failed-enable-units');
  const failedEnableExecutor = async (command, args) => {
    if (command === 'systemctl' && args.includes('is-enabled')) throw new Error('not enabled');
    if (command === 'systemctl' && args.includes('enable')) throw new Error('enable failed');
    return { stdout: '' };
  };
  await assert.rejects(() => installScheduledAnalyzeSystemd(paths, 'owner', { executor: failedEnableExecutor, unitDir: failedEnableDir, nodePath: process.execPath, cliPath, piAgentDir: join(temp, 'pi-agent'), piRuntimeRoot: join(temp, 'pi-runtime') }), /systemd_enable_failed/);
  assert.equal(existsSync(join(failedEnableDir, SCHEDULED_ANALYZE_SERVICE)), false, 'failed first enable removes newly rendered service');
  assert.equal(existsSync(join(failedEnableDir, SCHEDULED_ANALYZE_TIMER)), false, 'failed first enable removes newly rendered timer');

  let configured = await setAgentExperienceTimerEnabled(true, paths);
  assert.equal(configured.config.timer_enabled, true);
  configured = await setAgentExperienceConsolidationModel('openai-codex/gpt-5.5', paths);
  assert.equal(configured.config.timer_enabled, true, 'model changes preserve explicit schedule state');
  assert.equal(configured.config.break_in_enabled, false, 'schedule never enables break-in');

  const noWorkRoot = join(temp, 'no-work');
  let adapterCreated = false;
  const noWork = await runScheduledAnalyzeCore({ root: noWorkRoot, userId: 'owner', config: DEFAULT_AGENT_EXPERIENCE_CONFIG, adapterFactory: () => { adapterCreated = true; throw new Error('must not run'); } });
  assert.equal(noWork.status, 'no_work');
  assert.equal(adapterCreated, false, 'no unread work means no model adapter/auth/model call');

  const runRoot = join(temp, 'scheduled-run');
  await appendObservation(runRoot, {
    userId: 'owner',
    origin: { source: 'test' },
    payload: { kind: 'conversation_pair_v1', user_text_redacted: 'Prefer concise release summaries', assistant_text_redacted: 'Understood' },
    id: 'scheduled-1',
    createdAt: '2026-07-10T08:00:00.000Z',
  });
  let generateCalls = 0;
  const result = await runScheduledAnalyzeCore({
    root: runRoot,
    userId: 'owner',
    config: { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, consolidation_enabled: true, timer_enabled: true, consolidation_model: 'test/model' },
    adapterFactory: () => ({
      async generate(input) {
        generateCalls += 1;
        return {
          schema_version: 1,
          user_id: input.userId,
          file_generation: input.expected.file_generation,
          batch_id: 'scheduled-test',
          model: input.model,
          created_at: '2026-07-11T03:30:00.000Z',
          observations_read: { seq_start: input.expected.seq_start, seq_end: input.expected.seq_end, checksum: input.expected.read_checksum },
          proposals: [],
        };
      },
    }),
    now: () => '2026-07-11T03:30:00.000Z',
  });
  assert.equal(result.status, 'ok');
  assert.equal(generateCalls, 1);
  assert.equal(result.checked, 1);
  assert.equal(result.new_suggestions, 0);

  const boundedRoot = join(temp, 'scheduled-bounded');
  for (let index = 1; index <= 3; index += 1) {
    await appendObservation(boundedRoot, {
      userId: 'owner',
      origin: { source: 'test' },
      payload: { kind: 'conversation_pair_v1', user_text_redacted: `Scheduled bounded example ${index}`, assistant_text_redacted: 'Understood' },
      id: `scheduled-bounded-${index}`,
      createdAt: `2026-07-10T08:00:0${index}.000Z`,
    });
  }
  let boundedGenerateCalls = 0;
  const boundedResult = await runScheduledAnalyzeCore({
    root: boundedRoot,
    userId: 'owner',
    config: { ...DEFAULT_AGENT_EXPERIENCE_CONFIG, enabled: true, consolidation_enabled: true, timer_enabled: true, consolidation_model: 'test/model', analyze_batch_max_records: 2 },
    adapterFactory: () => ({
      async generate(input) {
        boundedGenerateCalls += 1;
        return {
          schema_version: 1,
          user_id: input.userId,
          file_generation: input.expected.file_generation,
          batch_id: 'scheduled-bounded-test',
          model: input.model,
          created_at: '2026-07-11T03:30:00.000Z',
          observations_read: { seq_start: input.expected.seq_start, seq_end: input.expected.seq_end, checksum: input.expected.read_checksum },
          proposals: [],
        };
      },
    }),
    now: () => '2026-07-11T03:30:00.000Z',
  });
  assert.equal(boundedResult.status, 'ok');
  assert.equal(boundedGenerateCalls, 1, 'scheduled Analyze remains one bounded model call');
  assert.equal(boundedResult.checked, 2);
  assert.equal(boundedResult.total_unread, 3);
  assert.equal(boundedResult.has_more, true);
  assert.equal(boundedResult.retention_rotated, false);

  const lockedRoot = join(temp, 'locked');
  const held = await acquireOwnedLock(lockedRoot, 'analyze', { waitMs: 0 });
  try {
    const locked = await runScheduledAnalyzeCore({ root: lockedRoot, userId: 'owner', config: DEFAULT_AGENT_EXPERIENCE_CONFIG, adapterFactory: () => { throw new Error('must not run'); } });
    assert.equal(locked.status, 'locked');
  } finally {
    await held.release();
  }

  const agedLiveRoot = join(temp, 'aged-live-lock');
  const agedLive = await acquireOwnedLock(agedLiveRoot, 'analyze', { waitMs: 0, now: () => Date.now() - 3 * 60 * 60_000 });
  try {
    const locked = await runScheduledAnalyzeCore({ root: agedLiveRoot, userId: 'owner', config: DEFAULT_AGENT_EXPERIENCE_CONFIG, adapterFactory: () => { throw new Error('must not run'); } });
    assert.equal(locked.status, 'locked', 'scheduled Analyze must not reclaim a live manual Analyze lock after the old two-hour threshold');
  } finally {
    await agedLive.release();
  }

  const receiptRoot = join(temp, 'receipts');
  for (let index = 0; index < SCHEDULED_ANALYZE_RECEIPT_LIMIT + 5; index += 1) {
    await writeScheduledAnalyzeReceipt(receiptRoot, { user_id: 'owner', status: index % 3 ? 'no_work' : 'ok', severity: 'info', checked: index, new_suggestions: 0 });
  }
  let pending = await readScheduledAnalyzeReceipts(receiptRoot);
  assert.equal(pending.receipts.length, SCHEDULED_ANALYZE_RECEIPT_LIMIT, 'receipt queue remains bounded');
  assert.equal(pending.receipts.some((receipt) => receipt.queue_overflowed), true);
  const serialized = JSON.stringify(pending.receipts);
  assert.doesNotMatch(serialized, /prompt|api.?key|credential|header|stack|checksum|source_ref|private@example/i);

  let notified = 0;
  await assert.rejects(() => consumeScheduledAnalyzeReceipts(receiptRoot, 'owner', () => { notified += 1; throw new Error('renderer unavailable'); }), /renderer unavailable/);
  assert.equal((await readScheduledAnalyzeReceipts(receiptRoot)).receipts.length, SCHEDULED_ANALYZE_RECEIPT_LIMIT, 'notify failure retains receipts');
  const consumed = await consumeScheduledAnalyzeReceipts(receiptRoot, 'owner', (message) => {
    notified += 1;
    assert.match(message, /Scheduled Agent Experience Analyze update/);
    assert.match(message, /Nothing was approved automatically|no unread saved examples/);
  });
  assert.equal(consumed.deleted, SCHEDULED_ANALYZE_RECEIPT_LIMIT);
  assert.equal(consumed.held.length, 0);
  assert.equal((await readScheduledAnalyzeReceipts(receiptRoot)).receipts.length, 0, 'successful visible notify consumes receipts once');
  assert.equal(notified, 2);

  const breakInReceiptRoot = join(temp, 'break-in-receipts');
  const eligibleReceipt = await writeScheduledAnalyzeReceipt(breakInReceiptRoot, { user_id: 'owner', status: 'ok', severity: 'info', checked: 4, new_suggestions: 2 });
  let summaryNotifications = 0;
  let heldResult = await consumeScheduledAnalyzeReceipts(breakInReceiptRoot, 'owner', (message) => {
    summaryNotifications += 1;
    assert.match(message, /2 new suggestions created/);
  }, { holdEligibleForBreakIn: true });
  assert.equal(heldResult.deleted, 0);
  assert.equal(heldResult.held.length, 1);
  assert.equal((await readScheduledAnalyzeReceipts(breakInReceiptRoot)).receipts[0].break_in_delivery.state, 'queued');
  heldResult = await consumeScheduledAnalyzeReceipts(breakInReceiptRoot, 'owner', () => { summaryNotifications += 1; }, { holdEligibleForBreakIn: true });
  assert.equal(summaryNotifications, 1, 'queued receipt summary is shown once');
  assert.equal(heldResult.held.length, 1, 'queued receipt survives restart for prompt delivery');
  assert.equal(await transitionScheduledAnalyzeReceiptBreakInDelivery(breakInReceiptRoot, { file: heldResult.held[0].file, receiptId: eligibleReceipt.id, userId: 'owner', expected: 'queued', next: 'prompted' }), 'updated');
  const promptedCleanup = await consumeScheduledAnalyzeReceipts(breakInReceiptRoot, 'owner', () => { summaryNotifications += 1; }, { holdEligibleForBreakIn: true });
  assert.equal(promptedCleanup.deleted, 1);
  assert.equal(promptedCleanup.held.length, 0);
  assert.equal(summaryNotifications, 1, 'prompted receipt is cleaned without duplicate summary');

  const notifyFailureRoot = join(temp, 'break-in-notify-failure');
  await writeScheduledAnalyzeReceipt(notifyFailureRoot, { user_id: 'owner', status: 'ok', severity: 'info', checked: 1, new_suggestions: 1 });
  await assert.rejects(() => consumeScheduledAnalyzeReceipts(notifyFailureRoot, 'owner', () => { throw new Error('summary unavailable'); }, { holdEligibleForBreakIn: true }), /summary unavailable/);
  assert.equal((await readScheduledAnalyzeReceipts(notifyFailureRoot)).receipts[0].break_in_delivery, undefined, 'summary failure marks and deletes nothing');

  process.env.AX_STATE_ROOT = receiptRoot;
  await writeScheduledAnalyzeReceipt(receiptRoot, { user_id: 'owner', status: 'ok', severity: 'info', checked: 1, new_suggestions: 0 });
  const handlers = new Map();
  const entryRenderers = new Map();
  const transcriptEntries = [];
  const activeSessionEntries = [];
  agentExperienceExtension({
    registerCommand() {},
    registerTool() {},
    on(event, handler) { handlers.set(event, handler); },
    registerEntryRenderer(type, renderer) { entryRenderers.set(type, renderer); },
    appendEntry(type, data) {
      transcriptEntries.push({ type, data });
      activeSessionEntries.push({ type: 'custom', customType: type, data });
    },
  });
  const lifecycleCtx = { mode: 'tui', hasUI: true, isIdle: () => true, sessionManager: { getBranch: () => activeSessionEntries }, ui: { notify() {} } };
  await handlers.get('session_start')({ reason: 'startup' }, { ...lifecycleCtx, mode: 'json' });
  assert.equal(transcriptEntries.length, 0, 'non-TUI starts do not consume receipts');
  assert.equal((await readScheduledAnalyzeReceipts(receiptRoot)).receipts.length, 1);
  await handlers.get('session_start')({ reason: 'reload' }, lifecycleCtx);
  assert.equal(transcriptEntries.length, 0, 'session_start must not consume before reload/startup rendering is visible');
  const pendingBeforeAppend = await readScheduledAnalyzeReceipts(receiptRoot);
  assert.equal(pendingBeforeAppend.receipts.length, 1, 'startup receipt waits for a visible post-start boundary');
  const retryFile = pendingBeforeAppend.files[0];
  const retryPath = join(receiptRoot, 'receipts', 'scheduled-analyze', 'pending', retryFile);
  const retryBody = await readFile(retryPath);
  await handlers.get('agent_settled')({}, lifecycleCtx);
  assert.equal(transcriptEntries.length, 1, 'the next settled turn appends the waiting scheduled result durably');
  assert.equal(transcriptEntries[0].type, 'agent_experience.scheduled_analyze_notice');
  assert.deepEqual(Object.keys(transcriptEntries[0].data).sort(), ['created_at', 'delivery_key', 'level', 'message', 'schema_version']);
  assert.match(transcriptEntries[0].data.delivery_key, /^[0-9a-f]{64}$/);
  assert.match(transcriptEntries[0].data.message, /Scheduled Agent Experience Analyze update/);
  assert.equal(entryRenderers.has(transcriptEntries[0].type), true, 'durable notice has a registered TUI renderer');
  assert.equal((await readScheduledAnalyzeReceipts(receiptRoot)).receipts.length, 0);
  await writeFile(retryPath, retryBody, { mode: 0o600 });
  await handlers.get('agent_settled')({}, lifecycleCtx);
  assert.equal(transcriptEntries.length, 1, 'a retained receipt with an already-appended delivery key is deleted without a duplicate entry');
  assert.equal((await readScheduledAnalyzeReceipts(receiptRoot)).receipts.length, 0, 'idempotent retry cleans the retained receipt');
  await writeScheduledAnalyzeReceipt(receiptRoot, { user_id: 'owner', status: 'failed', severity: 'warn', safe_code: 'runtime_incompatible' });
  await handlers.get('agent_settled')({}, lifecycleCtx);
  assert.equal(transcriptEntries.length, 2, 'a receipt created after session start is appended after the next settled turn');
  assert.equal(transcriptEntries[1].data.level, 'warn');
  assert.equal((await readScheduledAnalyzeReceipts(receiptRoot)).receipts.length, 0, 'durably appended late receipt is consumed once');
  await handlers.get('session_shutdown')({}, lifecycleCtx);
  await writeScheduledAnalyzeReceipt(receiptRoot, { user_id: 'owner', status: 'ok', severity: 'info', checked: 9, new_suggestions: 0 });
  await handlers.get('agent_settled')({}, lifecycleCtx);
  assert.equal(transcriptEntries.length, 2, 'stopped session never appends through a stale session API');
  assert.equal((await readScheduledAnalyzeReceipts(receiptRoot)).receipts.length, 1, 'stopped session leaves the receipt pending');

  const unavailableRendererRoot = join(temp, 'unavailable-notice-renderer');
  process.env.AX_STATE_ROOT = unavailableRendererRoot;
  await writeScheduledAnalyzeReceipt(unavailableRendererRoot, { user_id: 'owner', status: 'ok', severity: 'info', checked: 2, new_suggestions: 0 });
  const unavailableHandlers = new Map();
  agentExperienceExtension({ registerCommand() {}, registerTool() {}, appendEntry() { throw new Error('must not append without renderer'); }, on(event, handler) { unavailableHandlers.set(event, handler); } });
  await unavailableHandlers.get('session_start')({ reason: 'reload' }, lifecycleCtx);
  await unavailableHandlers.get('agent_settled')({}, lifecycleCtx);
  assert.equal((await readScheduledAnalyzeReceipts(unavailableRendererRoot)).receipts.length, 1, 'missing durable renderer leaves receipt pending');
  await unavailableHandlers.get('session_shutdown')({}, lifecycleCtx);

  const appendFailureRoot = join(temp, 'notice-append-failure');
  process.env.AX_STATE_ROOT = appendFailureRoot;
  await writeScheduledAnalyzeReceipt(appendFailureRoot, { user_id: 'owner', status: 'ok', severity: 'info', checked: 3, new_suggestions: 0 });
  const appendFailureHandlers = new Map();
  agentExperienceExtension({
    registerCommand() {},
    registerTool() {},
    registerEntryRenderer() {},
    appendEntry() { throw new Error('transcript unavailable'); },
    on(event, handler) { appendFailureHandlers.set(event, handler); },
  });
  await appendFailureHandlers.get('session_start')({ reason: 'reload' }, lifecycleCtx);
  await appendFailureHandlers.get('agent_settled')({}, lifecycleCtx);
  assert.equal((await readScheduledAnalyzeReceipts(appendFailureRoot)).receipts.length, 1, 'durable append failure leaves receipt pending');
  await appendFailureHandlers.get('session_shutdown')({}, lifecycleCtx);

  const unreadableNoticeRoot = join(temp, 'unreadable-notice-dedupe');
  process.env.AX_STATE_ROOT = unreadableNoticeRoot;
  const unreadableDir = join(unreadableNoticeRoot, 'receipts', 'scheduled-analyze', 'pending');
  await mkdir(unreadableDir, { recursive: true });
  await writeFile(join(unreadableDir, '20260717120200000-00000000-0000-4000-8000-000000000001.json'), '{invalid', { mode: 0o600 });
  const unreadableHandlers = new Map();
  const unreadableEntries = [];
  agentExperienceExtension({
    registerCommand() {},
    registerTool() {},
    registerEntryRenderer() {},
    appendEntry(type, data) { unreadableEntries.push({ type: 'custom', customType: type, data }); },
    on(event, handler) { unreadableHandlers.set(event, handler); },
  });
  const unreadableCtx = { ...lifecycleCtx, sessionManager: { getBranch: () => unreadableEntries } };
  await unreadableHandlers.get('session_start')({ reason: 'reload' }, unreadableCtx);
  await unreadableHandlers.get('agent_settled')({}, unreadableCtx);
  assert.equal(unreadableEntries.length, 1, 'retained unreadable receipt appends one durable warning');
  await unreadableHandlers.get('agent_settled')({}, unreadableCtx);
  assert.equal(unreadableEntries.length, 1, 'retained unreadable receipt does not accumulate duplicate durable warnings');
  assert.equal((await readScheduledAnalyzeReceipts(unreadableNoticeRoot)).unreadable, 1, 'unreadable receipt remains for safe recovery');
  await unreadableHandlers.get('session_shutdown')({}, unreadableCtx);
  delete process.env.AX_STATE_ROOT;

  console.log('agent-experience phase17 scheduled Analyze checks passed');
} finally {
  await rm(temp, { recursive: true, force: true });
}
