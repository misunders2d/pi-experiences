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
const ctx = {
  cwd: process.cwd(),
  ui: {
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

await commands.get('experience').handler('setup', ctx);
assert.equal(existsSync(paths.root), true, 'setup may create state root');
assert.equal(existsSync(paths.configPath), true, 'setup may write intended config');
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

await commands.get('experience').handler('review', ctx);
assert.match(notes.at(-1).message, /No review ledger yet/);
assert.equal(existsSync(join(paths.root, 'ledger.sqlite')), false, 'review empty-state must not initialize ledger');
await writeFile(join(paths.root, 'ledger.sqlite'), 'not sqlite', 'utf8');
await commands.get('experience').handler('status', ctx);
assert.match(notes.at(-1).message, /ledger unreadable/);
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
