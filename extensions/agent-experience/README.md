# Agent Experience

Opt-in Pi package extension for local Agent Experience capture, review, selector guidance, and manual consolidation.

## Safety defaults

- Package install alone does not enable capture, selector, consolidation, timer, or live runtime behavior.
- `/experience enable` only flips the master flag. Capture/selector remain explicit.
- Selector remains disabled by default.
- Default selector mode, once selector is enabled, is `instant`: local lexical selection only, no model/network call.
- `smart` selector mode is opt-in and may call the configured model/provider.
- Live runtime install/smoke is separate from package installation and should be explicitly reviewed by the user.

## Enable / disable

Inside Pi after package install:

```text
/experience status
/experience enable
/experience capture on
/experience selector on
/experience selector off
/experience capture off
/experience disable
```

Disable is safe: it drops in-memory capture buffers and disables feature flags without flushing hidden data.

## Selector modes

Config supports flat keys plus `[selector]` / dotted selector keys. Precedence:

```text
built-in defaults < flat config keys < [selector]/selector.* keys < environment overrides
```

Relevant environment overrides:

```text
AX_SELECTOR_MODE=instant|smart
AX_SELECTOR_MODEL=provider/model
AX_SELECTOR_TIMEOUT_MS=5000
AX_SELECTOR_MIN_OVERLAP_SCORE=1
```

Law config:

```toml
law_path = "law.md" # relative to ~/.agents/experience by default; absolute paths also work
```

The selector and habit activation commands fail closed when the configured law file is missing. They do not resolve law from the current working directory.

Example config:

```toml
enabled = true
selector_enabled = true

[selector]
mode = "instant"
min_overlap_score = 1
model = "openai-codex/gpt-5.4-mini"
timeout_ms = 5000
```

### `instant`

- Default mode once selector is enabled.
- Uses active same-user habits only.
- Uses law freshness, deterministic law-safety denylist, confidence, staleness, and daily budget gates.
- Selects with pure lexical overlap threshold.
- Makes zero model/network calls.
- Hit logs record model `lexical`.

### `smart`

- Opt-in mode.
- Uses same active/law/staleness/confidence/budget gates as instant.
- Calls configured model through Pi model registry/auth at call time.
- No hidden fallback. Unavailable model/auth/timeout/malformed output fails closed to no injection.
- Credentials remain in memory and are never logged or persisted.

Smart mode latency should be measured against the user's configured threshold before any go-live claim.

## Privacy model

- No raw prompt/session/injected text persistence.
- Selector `prompt_hash` stays `omitted`.
- Reports, evidence rows, pending-review rows, quarantine rows, disabled/suppressed/dormant/candidate/archived rows are never selector input.
- `habits-report.md` is report-only and never injection input.
- Law-file writes never happen; law graduation remains suggestion-only.
- The current law check is deterministic v1: it requires a configured law file for freshness hashing and blocks a small denylist of dangerous habit text patterns. It does not semantically compare habit text against the full law text. Future semantic contradiction detection should route proposed conflicts to pending review, not direct injection.

## Manual consolidation

Package bin:

```bash
experience-consolidate status
experience-consolidate now --dry-run --fixture-output /path/to/model-output.json
```

`--dry-run` produces reviewable output and advances no watermark. It must produce zero durable mutations.

Model-output safety:

- runner sends a specific observation range;
- model output must echo exact `observations_read.seq_start`, `seq_end`, and checksum;
- shrunk, expanded, or shifted ranges fail closed and quarantine on non-dry-run.

## Systemd timer templates

Templates live in `extensions/agent-experience/units/`.

Manual install example only:

```bash
mkdir -p ~/.config/systemd/user
cp extensions/agent-experience/units/experience-consolidate.service ~/.config/systemd/user/
cp extensions/agent-experience/units/experience-consolidate.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now experience-consolidate.timer
```

Manual uninstall:

```bash
systemctl --user disable --now experience-consolidate.timer
rm -f ~/.config/systemd/user/experience-consolidate.service ~/.config/systemd/user/experience-consolidate.timer
systemctl --user daemon-reload
```

Package tests do not run these commands and do not install or enable units silently.

Timer template uses:

```text
OnCalendar=daily
Persistent=true
```

Optional laptop AC-power gate is documented in the timer file as a commented `ConditionACPower=true` line.

## Break-in mode

Break-in mode makes timer-triggered consolidation review-first. It cannot silently go live unless:

- explicit accept path is used; or
- a configured confidence threshold is explicitly enabled and met.

Auto-apply threshold defaults off.

## Metrics and calibration

```text
/experience status
/experience selector calibrate
```

Surfaces include redacted aggregate metrics: selector hits by mode, stale-hit rate, quarantine/pending-review counts, and consolidation outcomes. Timeout/no-injection counts are unavailable unless a sanitized aggregate-only metrics table is explicitly implemented.

Weekly calibration is manual. Optional reminders may be documented separately; no recurring schedule is enabled silently.

## Rollback

Use backups/restore helpers only with the database closed/quiesced or a tested safe copy path. Restore requires explicit overwrite and database-closed confirmation.

## Validation

From package repo:

```bash
npm run check
```

This standalone package declares `type: module` and requires a Node version with TypeScript type stripping for the development checks and consolidation CLI.
