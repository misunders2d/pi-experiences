#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentExperienceExtension from '../extensions/agent-experience/index.ts';
import { getAgentExperiencePaths, readAgentExperienceConfig } from '../extensions/agent-experience/src/paths.ts';

const root = await mkdtemp(join(tmpdir(), 'agent-experience-phase1-'));
process.env.AX_STATE_ROOT = join(root, 'state');

const commands = new Map();
const handlers = new Map();
const fakePi = {
  registerCommand(name, options) {
    commands.set(name, options);
  },
  registerTool() {
    throw new Error('Agent Experience must not register tools');
  },
  on(event, handler) {
    handlers.set(event, handler);
  },
  registerShortcut() {
    throw new Error('Agent Experience must not register shortcuts');
  },
  registerFlag() {
    throw new Error('Agent Experience must not register flags');
  },
};

agentExperienceExtension(fakePi);
assert.deepEqual([...commands.keys()], ['experience'], 'extension should register only /experience command');
assert.deepEqual([...handlers.keys()].sort(), ['agent_end', 'before_agent_start', 'input', 'session_shutdown'], 'extension may register capture lifecycle plus fail-closed selector hook');

const paths = getAgentExperiencePaths();
assert.equal(paths.root, process.env.AX_STATE_ROOT);
assert.equal(existsSync(paths.root), false, 'extension load must not create state root');

const notes = [];
let setupChoices = [];
const ctx = {
  cwd: process.cwd(),
  ui: {
    async select(title, options) {
      notes.push({ message: `${title}: ${options.join(' | ')}`, level: 'select', options });
      return setupChoices.shift();
    },
    notify(message, level) {
      notes.push({ message, level });
    },
  },
};

await commands.get('experience').handler('status', ctx);
assert.equal(existsSync(paths.root), false, 'status must not create state root or config');
assert.match(notes.at(-1).message, /Experience: OFF/);
assert.match(notes.at(-1).message, /not created; using defaults/);

let readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.exists, false);
assert.equal(readResult.config.enabled, false);
assert.equal(readResult.config.capture_enabled, false);
assert.equal(readResult.config.selector_enabled, false);
assert.equal(readResult.config.embedding_enabled, false);
assert.equal(readResult.config.consolidation_enabled, false);
assert.equal(readResult.config.timer_enabled, false);

const notifyOnlyCtx = {
  cwd: process.cwd(),
  ui: {
    notify(message, level) {
      notes.push({ message, level });
    },
  },
};
await commands.get('experience').handler('setup', notifyOnlyCtx);
assert.equal(existsSync(paths.root), false, 'setup with no select UI must not create state root');
assert.ok(notes.some((note) => /setup controls/.test(note.message)), 'no-select setup must show fallback setup controls text');
assert.ok(notes.some((note) => /no config changed/i.test(note.message)), 'no-select setup must say no config changed');
const headlessCtx = {
  cwd: process.cwd(),
  hasUI: false,
  ui: {
    async select() {
      throw new Error('select should not be called when hasUI=false');
    },
    notify(message, level) {
      notes.push({ message, level });
    },
  },
};
await commands.get('experience').handler('setup', headlessCtx);
assert.equal(existsSync(paths.root), false, 'setup with hasUI=false must not create state root');
const throwingCtx = {
  cwd: process.cwd(),
  ui: {
    async select() {
      throw new Error('Bearer abcdefghijk should be redacted');
    },
    notify(message, level) {
      notes.push({ message, level });
    },
  },
};
await commands.get('experience').handler('setup', throwingCtx);
assert.equal(existsSync(paths.root), false, 'setup with throwing select must not create state root');
const throwNote = notes.find((note) => /setup menu failed/.test(note.message));
assert.ok(throwNote, 'throwing setup select must report menu failure');
assert.doesNotMatch(throwNote.message, /abcdefghijk/);

setupChoices = ['Unknown action'];
await commands.get('experience').handler('setup', ctx);
assert.equal(existsSync(paths.root), false, 'unknown setup choice must not create state root');
assert.match(notes.at(-1).message, /No config changed/);

setupChoices = [undefined];
await commands.get('experience').handler('setup', ctx);
assert.equal(existsSync(paths.root), false, 'escaped setup menu must not create state root');
assert.ok(notes.some((note) => /\/experience setup on/.test(note.message)), 'bare setup must show explicit setup subcommands even when selector is unavailable');
assert.match(notes.at(-1).message, /cancelled/);
assert.deepEqual(notes.find((note) => note.level === 'select').options, [
  'Turn on safe local capture (no timers/models/pre-injection)',
  'Turn Agent Experience off (capture + all runtime gates)',
  'Show current status (no changes)',
  'Review candidates (no changes)',
  'Configure learning/consolidation',
  'Configure guidance/pre-injection',
  'Background timer settings',
  'Show advanced help (no changes)',
  'Cancel (no changes)',
]);
setupChoices = ['Cancel (no changes)'];
await commands.get('experience').handler('setup', ctx);
assert.equal(existsSync(paths.root), false, 'cancelled setup menu must not create state root');
setupChoices = ['Show current status (no changes)'];
await commands.get('experience').handler('setup', ctx);
assert.equal(existsSync(paths.root), false, 'setup status choice must not create state root');
setupChoices = ['Review candidates (no changes)'];
await commands.get('experience').handler('setup', ctx);
assert.equal(existsSync(paths.root), false, 'setup review choice must not create state root');
setupChoices = ['Show advanced help (no changes)'];
await commands.get('experience').handler('setup', ctx);
assert.equal(existsSync(paths.root), false, 'setup advanced-help choice must not create state root');
setupChoices = ['Turn on safe local capture (no timers/models/pre-injection)'];
await commands.get('experience').handler('setup', ctx);
assert.equal(existsSync(paths.root), true, 'setup menu choice may create state root');
assert.equal(existsSync(paths.configPath), true, 'setup menu choice may write intended config');
let rootStat = await stat(paths.root);
let configStat = await stat(paths.configPath);
assert.equal(rootStat.mode & 0o777, 0o700, 'state root must be 0700');
assert.equal(configStat.mode & 0o777, 0o600, 'config file must be 0600');
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.exists, true);
assert.equal(readResult.config.enabled, true);
assert.equal(readResult.config.capture_enabled, true, 'setup/on enables local capture');
assert.equal(readResult.config.selector_enabled, false, 'setup/on must not enable selector/pre-injection');
assert.equal(readResult.config.embedding_enabled, false, 'setup/on must not enable embeddings');
assert.equal(readResult.config.consolidation_enabled, false, 'setup/on must not enable consolidation/timer trap');
assert.equal(readResult.config.timer_enabled, false, 'setup/on must not enable timers');
assert.equal(readResult.config.selector_timeout_ms, 5000, 'selector timeout must default to the package smart-mode ceiling');
assert.equal(readResult.config.selector_daily_budget, 20, 'package selector daily budget must default to a practical low cap; live installs may override higher');
assert.equal(readResult.config.law_path, 'law.md', 'law path must default to state-root law.md, not cwd docs');
assert.equal(readResult.config.selector_min_confidence_bp, 7500, 'selector min confidence must default to 7500bp');
assert.equal(readResult.config.selector_max_habits, 3, 'selector max injected habits must default to 3');
assert.equal(readResult.config.embedding_dimensions, 1536, 'embedding dimension contract must be 1536');

const afterEnableEntries = await readdir(paths.root);
assert.deepEqual(afterEnableEntries.sort(), ['agent-experience.toml'], 'setup should create only intended config file');
const configText = await readFile(paths.configPath, 'utf8');
assert.match(configText, /law_path = "law\.md"/, 'config must persist law path');
assert.doesNotMatch(configText, /TOKEN|SECRET|PRIVATE_KEY|BEGIN PRIVATE KEY/i, 'config must not contain secret-like fixture text');

setupChoices = ['Configure learning/consolidation', 'Enable manual consolidation flag (advanced; no timer/model starts)'];
await commands.get('experience').handler('setup', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.consolidation_enabled, true, 'setup menu can enable manual consolidation flag');
assert.equal(readResult.config.timer_enabled, false, 'consolidation setup must not start timer');
setupChoices = ['Configure learning/consolidation', 'Disable manual consolidation flag'];
await commands.get('experience').handler('setup', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.consolidation_enabled, false, 'setup menu can disable manual consolidation flag');
await commands.get('experience').handler('setup consolidation on', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.consolidation_enabled, true, 'setup subcommand can enable manual consolidation flag');
await commands.get('experience').handler('setup consolidation off', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.consolidation_enabled, false, 'setup subcommand can disable manual consolidation flag');

setupChoices = ['Configure guidance/pre-injection', 'Enable guidance/pre-injection (advanced; uses configured selector mode)'];
await commands.get('experience').handler('setup', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.selector_enabled, true, 'setup menu can enable advanced guidance');
setupChoices = ['Configure guidance/pre-injection', 'Disable guidance/pre-injection'];
await commands.get('experience').handler('setup', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.selector_enabled, false, 'setup menu can disable guidance');
await commands.get('experience').handler('setup guidance on', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.selector_enabled, true, 'setup subcommand can enable guidance');
await commands.get('experience').handler('setup guidance off', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.selector_enabled, false, 'setup subcommand can disable guidance');

setupChoices = ['Configure learning/consolidation', 'Enable manual consolidation flag (advanced; no timer/model starts)'];
await commands.get('experience').handler('setup', ctx);
setupChoices = ['Background timer settings', 'Keep timer/background learning disabled'];
await commands.get('experience').handler('setup', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.consolidation_enabled, true, 'timer setup must not disable manual consolidation flag');
assert.equal(readResult.config.timer_enabled, false, 'timer setup keeps timer disabled');
assert.equal(readResult.config.break_in_enabled, false, 'timer setup keeps break-in disabled');

await commands.get('experience').handler('review', ctx);
assert.match(notes.at(-1).message, /No review ledger yet/);
assert.equal(existsSync(join(paths.root, 'ledger.sqlite')), false, 'review empty-state must not initialize ledger');
await writeFile(join(paths.root, 'ledger.sqlite'), 'not sqlite', 'utf8');
await commands.get('experience').handler('status', ctx);
assert.match(notes.at(-1).message, /ledger unreadable/);
await commands.get('experience').handler('review list', ctx);
assert.match(notes.at(-1).message, /Review ledger unreadable/);
await commands.get('experience').handler('review show candidate-1', ctx);
assert.match(notes.at(-1).message, /Review ledger unreadable/);
await commands.get('experience').handler('review diff', ctx);
assert.match(notes.at(-1).message, /Review ledger unreadable/);
setupChoices = ['Review candidates (no changes)'];
await commands.get('experience').handler('setup', ctx);
assert.match(notes.at(-1).message, /Review ledger unreadable/);
await rm(join(paths.root, 'ledger.sqlite'), { force: true });

await commands.get('experience').handler('capture on', ctx);
await commands.get('experience').handler('consolidation on', ctx);
await commands.get('experience').handler('selector on', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.capture_enabled, true, 'advanced capture gate can be enabled independently');
assert.equal(readResult.config.consolidation_enabled, true, 'advanced consolidation gate can be enabled independently');
assert.equal(readResult.config.selector_enabled, true, 'advanced selector/pre-injection gate can be enabled independently');
await commands.get('experience').handler('capture off', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.capture_enabled, false, 'capture off disables capture only');
assert.equal(readResult.config.consolidation_enabled, true, 'capture off must not silently disable consolidation');
assert.equal(readResult.config.selector_enabled, true, 'capture off must not silently disable selector');
await commands.get('experience').handler('selector off', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.selector_enabled, false, 'selector off disables selector only');
assert.equal(readResult.config.consolidation_enabled, true, 'selector off must not silently disable consolidation');

setupChoices = ['Turn Agent Experience off (capture + all runtime gates)'];
await commands.get('experience').handler('setup', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.enabled, false, 'setup menu can turn experience off');
assert.equal(readResult.config.capture_enabled, false);
assert.equal(readResult.config.selector_enabled, false);
assert.equal(readResult.config.consolidation_enabled, false);
await commands.get('experience').handler('setup on', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.enabled, true, 'setup on shortcut enables experience');
assert.equal(readResult.config.capture_enabled, true, 'setup on shortcut enables capture');
assert.equal(readResult.config.selector_enabled, false, 'setup on shortcut keeps selector off');
await commands.get('experience').handler('setup timer off', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.timer_enabled, false, 'setup timer off keeps timer disabled');
await commands.get('experience').handler('setup off', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.enabled, false, 'setup off shortcut disables experience');
await commands.get('experience').handler('on', ctx);
await commands.get('experience').handler('off', ctx);
readResult = await readAgentExperienceConfig(paths);
assert.equal(readResult.config.enabled, false);
assert.equal(readResult.config.capture_enabled, false);
assert.equal(readResult.config.selector_enabled, false);
assert.equal(readResult.config.embedding_enabled, false);
assert.equal(readResult.config.consolidation_enabled, false);
assert.equal(readResult.config.timer_enabled, false);

await commands.get('experience').handler('nonsense', ctx);
assert.match(notes.at(-1).message, /Unknown subcommand/);

console.log('agent-experience phase1 checks passed');
