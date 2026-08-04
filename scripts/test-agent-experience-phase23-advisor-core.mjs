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
