#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentExperiencePaths, readAgentExperienceConfig } from '../extensions/agent-experience/src/paths.ts';
import { initExperienceStorage } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { readValidatedObservationGeneration } from '../extensions/agent-experience/src/consolidate/observations.ts';
import { runConsolidationOnce } from '../extensions/agent-experience/src/consolidate/runner.ts';
import { createStandaloneConsolidationModelAdapter } from '../extensions/agent-experience/src/consolidate/standalone-model-adapter.ts';
import { runScheduledAnalyzeCore, safeScheduledAnalyzeErrorCode } from '../extensions/agent-experience/src/schedule/runner.ts';
import { writeScheduledAnalyzeReceipt } from '../extensions/agent-experience/src/schedule/receipts.ts';
import { normalizeUserId } from '../extensions/agent-experience/src/storage/private-root.ts';

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
  return [
    'Usage: experience-consolidate status|now|scheduled [--dry-run] [--fixture-output FILE] [--root DIR] [--user USER] [--generation active] [--pi-runtime-root DIR]',
    'Advanced runtime/maintainer CLI. Normal users should use only /experience setup.',
    'The setup menu contains model selection, Analyze all waiting examples now, review, approved-habit controls, and explicit local schedule management.',
    '--dry-run produces reviewable output and must not advance watermarks or mutate ledger state.',
    'Without a fixture/model adapter, the CLI fails closed rather than guessing model output.',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  if (args.includes('--help') || args.includes('-h')) { console.log(usage()); return; }
  const rootOverride = argValue(args, '--root');
  if (rootOverride) process.env.AX_STATE_ROOT = resolve(rootOverride);
  const paths = getAgentExperiencePaths();
  const { config, exists, path } = await readAgentExperienceConfig(paths);
  const userId = normalizeUserId(argValue(args, '--user') || process.env.AX_USER_ID || 'owner');
  if (command === 'status') {
    console.log(JSON.stringify({ ok: true, command: 'status', root: paths.root, config_path: path, config_exists: exists, consolidation_enabled: config.consolidation_enabled, timer_enabled: config.timer_enabled, break_in_enabled: config.break_in_enabled }, null, 2));
    return;
  }
  if (command === 'scheduled') {
    const piRuntimeRoot = argValue(args, '--pi-runtime-root');
    const gatesOpen = exists && config.enabled && config.consolidation_enabled && config.timer_enabled;
    if (!gatesOpen) {
      await writeScheduledAnalyzeReceipt(paths.root, { user_id: userId, status: 'disabled', severity: 'info', safe_code: 'config_gate_denied' });
      console.log('scheduled_analyze status=disabled code=config_gate_denied');
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('scheduled_model_call_timeout')), 130_000);
    timeout.unref?.();
    try {
      const result = await runScheduledAnalyzeCore({
        root: paths.root,
        userId,
        config,
        signal: controller.signal,
        adapterFactory: () => createStandaloneConsolidationModelAdapter({ piRuntimeRoot, signal: controller.signal }),
      });
      if (result.status === 'ok') {
        await writeScheduledAnalyzeReceipt(paths.root, { user_id: userId, status: 'ok', severity: 'info', checked: result.checked, total_unread: result.total_unread, new_suggestions: result.new_suggestions, has_more: result.has_more });
        console.log('scheduled_analyze status=ok');
      } else if (result.status === 'no_work') {
        await writeScheduledAnalyzeReceipt(paths.root, { user_id: userId, status: 'no_work', severity: 'info', total_unread: 0 });
        console.log('scheduled_analyze status=no_work');
      } else {
        await writeScheduledAnalyzeReceipt(paths.root, { user_id: userId, status: 'locked', severity: 'info', safe_code: 'consolidation_locked' });
        console.log('scheduled_analyze status=locked');
      }
      return;
    } catch (error) {
      const safeCode = safeScheduledAnalyzeErrorCode(error);
      try {
        await writeScheduledAnalyzeReceipt(paths.root, { user_id: userId, status: 'failed', severity: 'warn', safe_code: safeCode });
      } catch {
        console.error('scheduled_analyze status=failed code=receipt_write_failed');
        process.exitCode = 1;
        return;
      }
      console.error(`scheduled_analyze status=failed code=${safeCode}`);
      process.exitCode = 1;
      return;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (command !== 'now') throw new Error(usage());
  if (!config.enabled) throw new Error('learning_disabled: enable saving examples from /experience setup before using this advanced CLI');
  if (!config.consolidation_enabled) throw new Error('learning_disabled: enable Analyze all waiting examples now from /experience setup before using this advanced CLI');
  const fixturePath = argValue(args, '--fixture-output');
  if (!fixturePath) throw new Error('consolidation_model_adapter_unavailable: provide --fixture-output for package-local dry-run/test, or run through an approved Pi adapter path');
  const generation = argValue(args, '--generation') || 'active';
  const dryRun = args.includes('--dry-run');
  const ledgerPath = resolve(paths.root, 'ledger.sqlite');
  if (dryRun && !existsSync(ledgerPath)) throw new Error('dry_run_requires_existing_ledger');
  const storage = await initExperienceStorage(paths.root, { allowInit: true, userId });
  try {
    const observations = await readValidatedObservationGeneration(paths.root, { file_generation: generation, path: 'observations.jsonl' }, userId);
    const output = JSON.parse(await readFile(resolve(fixturePath), 'utf8'));
    const result = await runConsolidationOnce({ root: paths.root, db: storage.db, userId: storage.userId, observations, modelOutput: output, model: config.consolidation_model, config, dryRun, now: new Date().toISOString() });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } finally {
    storage.db.close();
  }
}

main().catch((error) => {
  if (process.argv[2] === 'scheduled') console.error('scheduled_analyze status=failed code=startup_failed');
  else console.error(String(error?.message || error));
  process.exitCode = 1;
});
