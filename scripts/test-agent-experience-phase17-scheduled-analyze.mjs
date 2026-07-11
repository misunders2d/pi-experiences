#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import agentExperienceExtension from '../extensions/agent-experience/index.ts';
import { DEFAULT_AGENT_EXPERIENCE_CONFIG } from '../extensions/agent-experience/src/config.ts';
import { loadStandalonePiRuntime } from '../extensions/agent-experience/src/consolidate/standalone-model-adapter.ts';
import { setAgentExperienceConsolidationModel, setAgentExperienceTimerEnabled } from '../extensions/agent-experience/src/paths.ts';
import { consumeScheduledAnalyzeReceipts, readScheduledAnalyzeReceipts, SCHEDULED_ANALYZE_RECEIPT_LIMIT, writeScheduledAnalyzeReceipt } from '../extensions/agent-experience/src/schedule/receipts.ts';
import { runScheduledAnalyzeCore } from '../extensions/agent-experience/src/schedule/runner.ts';
import { __encodeSystemdConditionPathForTest, installScheduledAnalyzeSystemd, renderScheduledAnalyzeUnits, SCHEDULED_ANALYZE_ON_CALENDAR, SCHEDULED_ANALYZE_SERVICE, SCHEDULED_ANALYZE_TIMER } from '../extensions/agent-experience/src/schedule/systemd.ts';
import { acquireOwnedLock } from '../extensions/agent-experience/src/storage/locks.ts';
import { appendObservation } from '../extensions/agent-experience/src/storage/observations.ts';

const execFileAsync = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'pi-experiences-phase17-'));
try {
  const fakeRuntimeRoot = join(temp, 'fake-pi-runtime');
  await mkdir(join(fakeRuntimeRoot, 'dist'), { recursive: true });
  await mkdir(join(fakeRuntimeRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist'), { recursive: true });
  await writeFile(join(fakeRuntimeRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', type: 'module' }));
  await writeFile(join(fakeRuntimeRoot, 'dist', 'index.js'), 'export class AuthStorage { static create() { return {}; } }\nexport class ModelRegistry { static create() { return {}; } }\n');
  await writeFile(join(fakeRuntimeRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'compat.js'), 'export async function completeSimple() { return {}; }\n');
  const fakeRuntime = await loadStandalonePiRuntime(fakeRuntimeRoot);
  assert.equal(typeof fakeRuntime.AuthStorage.create, 'function');
  assert.equal(typeof fakeRuntime.ModelRegistry.create, 'function');
  assert.equal(typeof fakeRuntime.completeSimple, 'function');
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

  const lockedRoot = join(temp, 'locked');
  const held = await acquireOwnedLock(lockedRoot, 'analyze', { waitMs: 0 });
  try {
    const locked = await runScheduledAnalyzeCore({ root: lockedRoot, userId: 'owner', config: DEFAULT_AGENT_EXPERIENCE_CONFIG, adapterFactory: () => { throw new Error('must not run'); } });
    assert.equal(locked.status, 'locked');
  } finally {
    await held.release();
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
  assert.equal((await readScheduledAnalyzeReceipts(receiptRoot)).receipts.length, 0, 'successful visible notify consumes receipts once');
  assert.equal(notified, 2);

  process.env.AX_STATE_ROOT = receiptRoot;
  await writeScheduledAnalyzeReceipt(receiptRoot, { user_id: 'owner', status: 'ok', severity: 'info', checked: 1, new_suggestions: 0 });
  const handlers = new Map();
  agentExperienceExtension({ registerCommand() {}, registerTool() {}, on(event, handler) { handlers.set(event, handler); } });
  let lifecycleNotes = 0;
  const lifecycleCtx = { mode: 'tui', ui: { notify() { lifecycleNotes += 1; } } };
  await handlers.get('session_start')({ reason: 'reload' }, lifecycleCtx);
  await handlers.get('session_start')({ reason: 'fork' }, lifecycleCtx);
  await handlers.get('session_start')({ reason: 'startup' }, { ...lifecycleCtx, mode: 'json' });
  assert.equal(lifecycleNotes, 0, 'reload, fork, and non-TUI starts do not consume receipts');
  assert.equal((await readScheduledAnalyzeReceipts(receiptRoot)).receipts.length, 1);
  await handlers.get('session_start')({ reason: 'startup' }, lifecycleCtx);
  assert.equal(lifecycleNotes, 1);
  assert.equal((await readScheduledAnalyzeReceipts(receiptRoot)).receipts.length, 0, 'eligible TUI startup consumes after notify');
  delete process.env.AX_STATE_ROOT;

  console.log('agent-experience phase17 scheduled Analyze checks passed');
} finally {
  await rm(temp, { recursive: true, force: true });
}
