# Agent Experience

Opt-in Pi package extension for local Agent Experience capture, human review, and advanced selector/consolidation experiments.

## Normal UX

Use the setup menu first. It is the main control panel:

```text
/experience setup   # main setup/settings menu; no changes until you choose
```

Optional shortcuts:

```text
/experience on      # resume local redacted capture
/experience off     # stop capture and all runtime gates
/experience status  # dashboard: capture count, review count, next step
/experience review  # inspect/accept/reject candidates if any exist
```

`/experience setup` manages on/off, status, review, consolidation, guidance/pre-injection, timer notes, and advanced help from one menu. It changes nothing until you choose. `/experience on` enables local redacted capture only. They do **not** install timers, run background learning, call live consolidation models, enable embeddings, enable break-in mode, or enable pre-injection.

## Safety defaults

- Package install alone does not enable capture, selector, consolidation, timer, or live runtime behavior.
- The setup menu changes config only after an explicit menu choice. `/experience on` enables only `enabled=true` and `capture_enabled=true`.
- Selector/pre-injection remains off until advanced explicit enable.
- Default selector mode, once selector is enabled, is `instant`: local lexical selection only, no model/network call.
- `smart` selector mode is advanced opt-in and may call the configured model/provider.
- Live runtime install/smoke is separate from package installation and should be explicitly reviewed by the user.
- No habits are approved automatically.

## Selector modes — advanced

Config supports flat keys plus `[selector]` / dotted selector keys. Config file values are applied in file order, then environment overrides are applied last. Avoid defining the same setting twice in one file.

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

Example advanced config:

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

- Local lexical/no-network selection.
- Uses active same-user habits only.
- Uses law freshness, deterministic law-safety denylist, confidence, staleness, and daily budget gates.
- Hit logs record model `lexical`.

### `smart`

- Advanced opt-in mode.
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
- The current law check is deterministic v1: it requires a configured law file for freshness hashing and blocks a small denylist of dangerous habit text patterns. It does not semantically compare habit text against the full law text. Future semantic contradiction detection should route proposed conflicts to pending review, not direct activations.

## Review

```text
/experience review
/experience review list
/experience review show <id>
/experience review diff
/experience review accept <id> --checksum <checksum>
/experience review reject <id> --checksum <checksum>
/experience review report
```

Checksums protect stale review actions. Review never auto-approves habits.

## Manual consolidation — advanced maintainer/test only

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

## Systemd timer templates — disabled advanced templates

Templates live in `extensions/agent-experience/units/`, but 0.1.6 does **not** provide a package-owned timer or live consolidation adapter. `/experience setup` menu actions and `/experience on` never install, enable, or start these units.

The bundled service intentionally fails with an explicit message until a maintainer replaces `ExecStart` with an approved reviewed consolidation command. Do not copy/enable the timer as normal UX.

Manual timer ownership, if ever used, belongs to the user/maintainer and must be reversible with `systemctl --user disable --now experience-consolidate.timer`.

## Metrics and calibration

```text
/experience status
/experience selector calibrate
```

Calibration is manual. It reports aggregate metrics only and does not create recurring reminders.

## Validation

Run from package root:

```bash
npm run check
```

Package tests must not install timers, start services, call external models without an explicit adapter, or write outside the configured private state root.
