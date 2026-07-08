---
name: agent-experience
description: Use when explaining, configuring, troubleshooting, or safely operating the Pi Experiences / Agent Experience extension: capture, review, consolidation, selector modes, law_path, privacy boundaries, and the distinction between skills, memory, and experience. Do not use for unrelated Pi extension development.
---

# Agent Experience

Agent Experience is the behavioral layer in the Pi Experiences package.

Use three separate concepts:

- **Skills** are explicit procedures and playbooks.
- **Memory** is remembered factual context.
- **Experience** is reviewed behavioral/habitual guidance inferred from repeated interaction.

Do not blur them. A habit is not a skill unless it describes a repeatable workflow. A habit is not memory unless it is a durable fact. Experience should stay small, reviewed, and injectable only when relevant.

## Safety defaults

- Capture starts disabled.
- Selector starts disabled.
- Default selector mode is `instant`, local lexical/no-network.
- Smart mode is opt-in and may call the configured model/provider.
- Selector candidates are active same-user habits only.
- Reports, pending review, quarantine, evidence, disabled, dormant, candidate, suppressed, and archived rows are not selector input.
- Selector logs do not store raw prompts; `prompt_hash` remains `omitted`.
- No law-file writes happen automatically.

## Commands

Setup:

```text
/experience status
/experience enable
/experience capture on
```

Help:

```text
/experience help setup
/experience help review
/experience help selector
/experience help troubleshoot
```

Review:

```text
/experience pending list
/experience pending show <id>
/experience pending diff
/experience pending accept <id> --checksum <checksum>
/experience pending reject <id> --checksum <checksum>
/experience habit explain <id>
/experience habit accept|reject|disable|enable <id> --checksum <checksum>
/experience habits report
```

Selector:

```text
/experience selector on
/experience selector off
/experience selector calibrate
```

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

Capture check:

```bash
ls -la ~/.agents/experience
wc -l ~/.agents/experience/observations.jsonl
```

If capture is enabled but no observation appears after a completed turn, reload/restart Pi and check `/experience status`.

Selector check:

- confirm `enabled=true` and `selector_enabled=true`;
- confirm `~/.agents/experience/law.md` exists or configure `law_path`;
- confirm active habits exist with fresh `law_hash`;
- remember that missing ledger/law/model/auth/timeouts fail closed.

## Maintenance rule

For bugs, patch the package source first, add a regression test, run review, then release a new Git tag. Avoid live-only patches.
