# Agent Experience

Opt-in Pi package extension for local Agent Experience capture, human review, and advanced selector/consolidation experiments.

## Normal UX

Use exactly one normal-user command:

```text
/experience setup
```

`/experience setup` opens the normal-user control panel for saving chat examples locally, choosing the habit-learning model from live typeahead search or exact model entry with the current model visible, analyzing saved examples now, reviewing suggested habits, approving/rejecting, using approved habits before replies, showing current settings, and explaining schedule/privacy behavior. Checkbox rows show `[x]` for ON and `[ ]` for OFF. Space or Enter toggles checkbox rows or opens action rows, then returns to the menu until Done. It changes nothing until you choose.

No typed setup subcommands are required for normal use. If Pi does not render the interactive panel, restart Pi so the latest extension UI loads and run `/experience setup` again. Setup does **not** install timers, run background learning, enable embeddings, enable break-in mode, auto-approve suggestions, or use approved habits before replies unless explicitly enabled from the setup menu.

Human setup procedure:

1. Run `/experience setup`.
2. Toggle **Save chat examples locally** to `[x] ON` with Space/Enter.
3. Use Pi normally until repeated examples exist.
4. Choose **Choose model for habit learning**. Type to filter live, e.g. `5.5`; the current model is visible and marked `(current)`.
5. Choose **Analyze saved examples now**. It starts one nonblocking model job.
6. Choose **Review suggested habits**. Inspect details in the focused panel, then Approve / Reject / Back.
7. Optionally toggle **Use approved habits before replies** to `[x] ON`.

Agent/operator setup rules:

- Preserve `/experience setup` as the one normal-user command.
- Do not tell normal users to type advanced setup/review subcommands.
- Keep checkbox rows `[x]`/`[ ]`, Space/Enter toggles, live model typeahead, current-model marker, focused review panel, nonblocking Analyze, explicit approval, and Phase 2/off schedule behavior.

## Safety defaults

- Package install alone does not enable capture, approved-habit reminders, timer, or live runtime behavior.
- The setup menu changes config only after an explicit menu choice. The Save chat examples locally row turns on local redacted capture; approved-habit reminders, timers, embeddings, and break-in mode stay off unless explicitly enabled from setup. Model jobs run only when you choose Analyze saved examples now.
- Approved-habit reminders remain off until explicitly enabled from setup.
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
law_path = "law.md" # private-state relative path under ~/.agents/experience; absolute paths are rejected
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
- No automatic law-file writes occur; setup may create default private `law.md` only after explicit user choice and must not overwrite an existing unreadable file.
- The current law check is deterministic v1: it requires a configured law file for freshness hashing and blocks a small denylist of dangerous habit text patterns. It does not semantically compare habit text against the full law text. Future semantic contradiction detection should route proposed conflicts to pending review, not direct activations.

## Review

Normal users review from the same setup menu:

```text
/experience setup
```

Then choose **Review suggested habits**, inspect a suggestion in a focused review panel, and choose Approve or Reject. Review details are not dumped into chat history. Checksums protect stale review actions internally. Review never auto-approves habits.

Candidate habits must generalize the reusable behavioral essence. Durable tool/task categories are allowed when they define the repeated situation, but one-off project/package names, versions, file paths, hashes, and screenshots are not. Prefer `When preparing an npm package release, verify the real end-to-end install/update path before calling it done` over `When working on Agent Experience, do the setup flow`.

Rejecting a candidate archives that exact normalized condition/behavior/polarity. The exact same identity is preserved as rejected/archived on later merges. A materially different or more generalized candidate can still appear later if it again passes the repeated-evidence threshold.

## Analyze saved examples

Normal users run habit learning from the setup menu:

```text
/experience setup
```

Then choose **Choose model for habit learning**, **Analyze saved examples now**, and **Review suggested habits** from the menu.

The package bin remains advanced maintainer/test plumbing:

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

Templates live in `extensions/agent-experience/units/`, but the current package does **not** provide a package-owned timer. `/experience setup` menu actions never install, enable, or start these units. Setup shows automatic scheduling as Phase 2/off.

The bundled service intentionally fails with an explicit message until a maintainer replaces `ExecStart` with an approved reviewed consolidation command. Do not copy/enable the timer as normal UX.

Manual timer ownership, if ever used, belongs to the user/maintainer and must be reversible with `systemctl --user disable --now experience-consolidate.timer`.

## Metrics and calibration

Open `/experience setup` for normal status and settings. Advanced calibration remains maintainer-only and reports aggregate metrics only; it does not create recurring reminders.

## Validation

Run from package root:

```bash
npm run check
```

Package tests must not install timers, start services, call external models without an explicit adapter, or write outside the configured private state root.
