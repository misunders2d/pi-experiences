---
name: agent-experience
description: >-
  Use when explaining, configuring, troubleshooting, or safely operating the Pi
  Experiences / Agent Experience extension: /experience setup control panel,
  capture, review suggestions, advanced consolidation, approved-habit reminder modes, law_path, privacy
  boundaries, and the distinction between skills, memory, and experience. Do not
  use for unrelated Pi extension development.
---

# Agent Experience

Use this skill for the public `pi-experiences` package.

## Mental model

```text
skills = instructions the agent loads before work
memory = durable facts/knowledge the agent may retrieve
experience = reviewed behavioral habits inferred from repeated interaction
```

## Plain-language pieces

- **Experience** is the whole behavior-learning layer.
- **Setup** is the main control panel. It opens a Space/Enter settings menu for saving chat examples locally, choosing the habit-learning model, analyzing saved examples now, reviewing suggested habits, using approved habits before replies, showing the schedule as Phase 2/off, showing current settings, and explaining every setting. It must not change config until you choose an item. After each action it returns to the panel until Done. The safe save-examples toggle turns on local redacted capture and leaves timers and approved-habit reminders off unless explicitly toggled.
- **Capture** saves redacted text fields and metadata from completed turns to `observations.jsonl`. It creates raw material only, not habits.
- **Choose model for habit learning** opens a live typeahead model picker inside `/experience setup`; typing text such as `5.5`, `codex`, or `glm` immediately filters authenticated model suggestions, and the current model is shown/marked. Users do not type a model command.
- **Analyze saved examples now** reads already saved redacted examples, calls the configured model once, validates/sanitizes model output, and writes suggested habits into review. It never approves habits.
- **Pending review** means proposed habits await approval/rejection and are not injectable yet.
- **Active habits** are reviewed habits. The setup menu does not use them before replies unless you explicitly enable approved-habit reminders.
- **Schedule** is Phase 2/off. The package does not install, start, or pretend-enable a timer.

## Normal command

Canonical UX is one control panel:

```text
/experience setup
```

The interactive setup menu uses arrow keys plus Space/Enter. Checkbox rows show `[x]` for ON and `[ ]` for OFF; Space or Enter toggles checkbox rows and opens model/analyze/review/status/help action rows; Done exits. From this one menu a normal user can save examples, choose a model, analyze saved examples, review suggestions, approve/reject, and enable approved-habit reminders.

Human setup procedure:

1. Run `/experience setup`.
2. Toggle **Save chat examples locally** to `[x] ON` with Space/Enter.
3. Use Pi normally until repeated examples exist.
4. Choose **Choose model for habit learning**. Type to filter live; the current model is visible and marked `(current)` when present. Ctrl+E allows exact `provider/model` entry.
5. Choose **Analyze saved examples now**. It starts one nonblocking model job and returns control to Pi.
6. Choose **Review suggested habits**. Inspect the boxed focused panel and choose Approve / Reject / Back with ↑/↓ + Space/Enter or `1`/`2`/`3`.
7. Choose **Review approved habits** to browse actual active/disabled approved habits, inspect details, and disable or re-enable one without typing IDs/checksums.
7. Optionally toggle **Use approved habits before replies** to `[x] ON`.

Agent/operator procedure:

- Preserve `/experience setup` as the one normal-user command.
- Do not instruct normal users to type setup subcommands or backcompat review commands.
- Keep all normal actions in the setup menu: capture, model, analyze, review, approved-habit use, schedule/status/help, and all-off.
- Keep checkbox UI `[x]`/`[ ]`; Space/Enter toggles checkbox rows.
- Keep model selection live-searchable, with current model visible/marked and exact entry fallback.
- Keep review in a readable boxed panel with selectable Approve/Reject/Back; do not dump JSON or full habit details into chat history.
- Keep Analyze nonblocking and never auto-approve suggestions.
- Keep timer/schedule Phase 2/off.

Do not instruct normal users to type setup subcommands. If Pi does not render the interactive menu, tell the user to restart Pi so the latest extension UI loads, then run `/experience setup` again.

If observations grow but there are no suggestions, choose **Analyze saved examples now** inside `/experience setup`. Candidate generation is manual, not scheduled.

## Safety defaults

- Package install alone enables nothing.
- `/experience setup` opens a menu and changes nothing until you choose. The Save chat examples locally row enables local redacted capture only.
- Use approved habits before replies starts off.
- Default selector mode is `instant`, local lexical/no-network, but still advanced opt-in.
- Smart mode is advanced opt-in and may call the configured model/provider.
- Selector candidates are active same-user habits only.
- Reports, pending review, quarantine, evidence, disabled, dormant, candidate, suppressed, and archived rows are not selector input.
- Selector logs do not store raw prompts; `prompt_hash` remains `omitted`.
- No law-file writes happen automatically.
- No timers, recurring jobs, or auto-approval run in normal UX. The Analyze saved examples now row calls the explicitly configured model once.

## Review

Normal users review from the setup menu:

```text
/experience setup
```

Then choose **Review suggested habits**, inspect a suggestion in a focused review panel, and choose Approve or Reject. Review details are not dumped into chat history. Checksums protect stale review actions internally. No review path auto-approves habits.

Use **Review approved habits** for actual approved habits only: it lists `active` and `disabled` habits, excludes candidates/pending suggestions, shows When/Do/status/confidence/evidence count/created/updated, and offers Disable or Re-enable. The normal UI must not expose habit IDs or checksums.

Candidate habits must generalize reusable behavior, not copy a project-specific label. Durable tool/task categories are allowed when they define the repeated situation, but one-off project/package names, versions, file paths, hashes, and screenshots are not. Prefer `When preparing an npm package release, verify the real end-to-end install/update path before calling it done` over `When working on Agent Experience, do the setup flow`.

Rejecting a candidate archives that exact normalized condition/behavior/polarity. Later merges preserve that exact identity as rejected/archived. Rejection is not a semantic ban on all related ideas; a materially different or more generalized candidate may appear later if it again passes the repeated-evidence gate.

## Advanced/backcompat commands

Use only for maintainer/testing or explicit advanced operation:

```text
/experience capture on|off
/experience consolidation on|off
/experience selector on|off|calibrate
/experience pending list|show|diff|accept|reject
/experience habit explain|accept|reject|disable|enable <id> --checksum <checksum>
/experience habits report
```

Advanced consolidation CLI:

```bash
experience-consolidate status
experience-consolidate now --dry-run --fixture-output /path/to/model-output.json
```

The CLI fixture path is maintainer/test plumbing, not normal user UX.

## Law file

Default law path:

```toml
law_path = "law.md"
```

Relative paths resolve under the private state root, normally:

```text
~/.agents/experience/law.md
```

If the law file is missing, activation and selector injection fail closed. Current law checking is deterministic v1: law freshness plus a small dangerous-pattern denylist. It is not semantic contradiction detection.

## Troubleshooting

```text
/experience setup
ls -la ~/.agents/experience
wc -l ~/.agents/experience/observations.jsonl
```

If capture is enabled but no observation appears after a completed turn, reload/restart Pi and check the status row inside `/experience setup`.

If there are no suggestions while observations grow, the system is only capturing. Open `/experience setup` and choose **Analyze saved examples now**; candidate generation is manual, not scheduled.

If approved-habit reminders seem inactive:
- open `/experience setup` and check Use approved habits before replies;
- confirm active reviewed habits exist;
- confirm `~/.agents/experience/law.md` exists or configure `law_path`;
- remember reports/pending/suggestions are never reminder input.
