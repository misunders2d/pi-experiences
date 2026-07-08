#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentExperiencePaths, readAgentExperienceConfig } from '../extensions/agent-experience/src/paths.ts';
import { initExperienceStorage } from '../extensions/agent-experience/src/storage/sqlite.ts';
import { readValidatedObservationGeneration } from '../extensions/agent-experience/src/consolidate/observations.ts';
import { runConsolidationOnce } from '../extensions/agent-experience/src/consolidate/runner.ts';

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
  return [
    'Usage: experience-consolidate status|now [--dry-run] [--fixture-output FILE] [--root DIR] [--user USER] [--generation active]',
    'Advanced maintainer/test CLI. Normal users should use /experience status and /experience review.',
    '0.1.6 has no live consolidation model adapter and never installs/enables timers.',
    '--dry-run produces reviewable output and must not advance watermarks or mutate ledger state.',
    'Without a fixture/model adapter, now fails closed rather than guessing model output.',
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
  const userId = argValue(args, '--user') || process.env.AX_USER_ID || 'owner';
  if (command === 'status') {
    console.log(JSON.stringify({ ok: true, command: 'status', root: paths.root, config_path: path, config_exists: exists, consolidation_enabled: config.consolidation_enabled, timer_enabled: config.timer_enabled, break_in_enabled: config.break_in_enabled }, null, 2));
    return;
  }
  if (command !== 'now') throw new Error(usage());
  if (!config.enabled) throw new Error('consolidation_disabled: run /experience setup or /experience on before experience-consolidate now');
  if (!config.consolidation_enabled) throw new Error('consolidation_disabled: run /experience consolidation on before experience-consolidate now');
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
    const result = await runConsolidationOnce({ root: paths.root, db: storage.db, userId: storage.userId, observations, modelOutput: output, model: config.consolidation_model, config, dryRun, breakIn: config.break_in_enabled, now: new Date().toISOString() });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } finally {
    storage.db.close();
  }
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exitCode = 1;
});
