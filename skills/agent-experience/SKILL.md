---
name: agent-experience
description: >-
  Use when explaining, configuring, troubleshooting, or safely operating the Pi
  Experiences / Agent Experience extension: setup/on/off/status/review, capture,
  review candidates, advanced consolidation, selector modes, law_path, privacy
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
- **Setup** is the main control panel. It opens a checkbox-style settings panel for saving chat examples locally, suggesting habits from saved examples when asked, using approved habits before replies, background-learning explanation, reviewing suggested habits, showing current settings, and explaining every setting. It must not change config until you choose an item. After each toggle it returns to the panel until Done. The safe save-examples toggle turns on local redacted capture and leaves timers, live model learning, and approved-habit reminders off unless explicitly toggled.
- **Capture** saves redacted text fields and metadata from completed turns to `observations.jsonl`. It creates raw material only, not habits.
- **Suggest habits from saved examples when I ask** means Pi may analyze saved examples only when explicitly asked and then show proposed habits for review. In 0.1.10 this is not automatic: no timer or live consolidation model adapter is installed.
- **Pending review** means proposed habits await approval/rejection and are not injectable yet.
- **Active habits** are reviewed habits. Normal setup/on does not use them before replies unless you explicitly enable approved-habit reminders.
- **Timer** is only a future/advanced way to run learning in the background. It is not installed, started, or managed by the package.

## Normal commands

Canonical UX is one control panel:

```text
/experience setup                         # checkbox-style settings panel; no change until you choose
/experience setup save on|off             # save chat examples locally
/experience setup suggest on|off          # allow habit suggestions when you ask
/experience setup use-habits on|off       # use approved habits before replies
/experience setup background off          # keep background learning off
/experience setup status                  # show current settings
/experience setup review                  # review suggested habits
/experience setup help                    # explain every setting
/experience setup off                     # turn all experience features off
```

The interactive setup panel shows `[x]` for ON and `[ ]` for OFF. Press Enter on a setting to toggle it; Show current settings, Review suggested habits, and Explain these settings live inside the panel; Done exits. If Pi does not render the interactive menu, use the explicit `/experience setup ...` subcommands above.

Optional shortcuts:

```text
/experience on      # resume local redacted capture
/experience off     # stop capture and all runtime gates
/experience status  # dashboard: capture count, review count, next step
/experience review  # inspect/accept/reject candidates if any exist
```

If observations grow but `/experience review` shows no candidates, capture is working. In 0.1.10, candidate generation is not automatic.

## Safety defaults

- Package install alone enables nothing.
- `/experience setup` opens a menu and changes nothing until you choose. `/experience on` enables local redacted capture only.
- Use approved habits before replies starts off.
- Default selector mode is `instant`, local lexical/no-network, but still advanced opt-in.
- Smart mode is advanced opt-in and may call the configured model/provider.
- Selector candidates are active same-user habits only.
- Reports, pending review, quarantine, evidence, disabled, dormant, candidate, suppressed, and archived rows are not selector input.
- Selector logs do not store raw prompts; `prompt_hash` remains `omitted`.
- No law-file writes happen automatically.
- No timers, recurring jobs, live consolidation model calls, or auto-approval run in normal UX.

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

Checksums protect stale review actions. No review command auto-approves habits.

## Advanced/backcompat commands

Use only for maintainer/testing or explicit advanced operation:

```text
/experience help advanced
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
/experience status
/experience review
ls -la ~/.agents/experience
wc -l ~/.agents/experience/observations.jsonl
```

If capture is enabled but no observation appears after a completed turn, reload/restart Pi and check `/experience status`.

If `/experience review` has no candidates while observations grow, the system is only capturing. Candidate generation is not automatic in 0.1.10.

If selector/pre-injection seems inactive:
- confirm advanced selector controls were explicitly enabled;
- confirm active reviewed habits exist;
- confirm `~/.agents/experience/law.md` exists or configure `law_path`;
- remember reports/pending/candidates are never selector input.
