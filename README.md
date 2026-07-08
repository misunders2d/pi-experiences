# Pi Experiences

Pi Experiences is an experimental Pi package that tries to give coding agents a third kind of long-term learning: **experience**.

Most agent setups already have two buckets:

1. **Skills** — explicit procedures: how to do a task, which workflow to follow, what tools to use.
2. **Memory** — remembered facts: preferences, entities, project notes, decisions, history.

Pi Experiences explores a separate bucket:

3. **Experience** — reviewed behavioral patterns inferred from repeated interaction: how the agent tends to help this user better, which communication habits work, which review/caution patterns recur, and which response styles should be nudged at the right moment.

The goal is not to replace skills or memory. The goal is to keep behavioral/habitual traits out of both, review them explicitly, and inject only small, relevant guidance when it is safe.

## What it does

The package installs the `agent-experience` Pi extension and an explanatory skill.

The extension can:

- opt in to local capture of redacted conversation pairs;
- store captures under a private state root, default `~/.agents/experience/`;
- consolidate repeated observations into candidate habits;
- require human review before habits become active;
- keep selector injection disabled by default;
- when enabled, select only active same-user habits;
- inject only bounded guidance, never raw conversation history;
- keep skills, memory, reports, pending review rows, and quarantine rows out of selector input.

## Mental model

```text
skills  = procedures you wrote on purpose
memory  = facts you want the agent to remember
experience = habits inferred from repeated interaction, then reviewed
```

Examples of experience-style habits might be:

- "When discussing risky runtime changes, summarize rollback path first."
- "When a user asks for public packaging, mention install/update semantics."
- "When tests pass but live runtime is stale, ask for reload before claiming smoke success."

These are not domain skills and not factual memories. They are behavior patterns. Pi Experiences keeps them separate so they can be inspected, accepted, disabled, or allowed to decay.

## Install

Git install, pinned to a tag:

```bash
pi install git:github.com/misunders2d/pi-experiences@v0.1.0
```

For local development:

```bash
pi install /absolute/path/to/pi-experiences
```

Or try it for one run without installing:

```bash
pi -e /absolute/path/to/pi-experiences
```

> Security note: Pi extensions run with your user permissions. Review extension code before installing any third-party package.

## Important: avoid duplicate extension loads

If you previously copied `agent-experience` directly into Pi's live extensions directory, remove or disable that copy before installing this package:

```bash
rm -rf ~/.pi/agent/extensions/agent-experience
```

Then restart or reload Pi.

Duplicate copies can register the same hooks twice and cause duplicate capture or command conflicts.

## First run

Inside Pi:

```text
/experience status
/experience enable
/experience capture on
```

Then use Pi normally for a few turns. Captures are written locally to:

```text
~/.agents/experience/observations.jsonl
```

The file stores redacted conversation-pair records, not raw full session logs.

Helpful commands:

```text
/experience help setup
/experience help review
/experience help selector
/experience help troubleshoot
/experience status
```

## State and privacy

Default state root:

```text
~/.agents/experience/
```

Important files:

```text
agent-experience.toml     # local config
observations.jsonl        # redacted capture stream
ledger.sqlite             # reviewed/consolidated records and hit logs
law.md                    # optional configured law file for habit activation/selector freshness
habits-report.md          # report-only output, never selector input
```

Privacy and safety invariants:

- capture is off until explicitly enabled;
- selector is off until explicitly enabled;
- selector defaults to `instant` mode, a local lexical/no-network selector;
- smart selector mode is opt-in and may call a configured model/provider;
- no raw prompt/session/injected text is persisted by selector logs;
- selector `prompt_hash` is deliberately `omitted`;
- only active same-user habits are selector candidates;
- disabled, dormant, candidate, pending-review, quarantine, evidence, and report rows are not selector input;
- no law-file writes are performed by the extension;
- no automatic habit activation happens from selector use.

## Law file

Agent Experience uses a configured law snapshot for habit activation and selector freshness. Default:

```toml
law_path = "law.md"
```

Relative paths resolve under the state root (`~/.agents/experience/law.md`). Absolute paths are also supported.

If the law file is missing:

- habit activation commands fail closed;
- selector injection fails closed;
- the selector emits a bounded warning instead of silently doing nothing.

The current law check is deterministic v1: it requires a configured law file for freshness hashing and blocks a small denylist of dangerous habit text patterns. It does **not** semantically compare every habit against the full law text. Future semantic contradiction checks should route to pending review, not direct injection.

## Selector modes

### Instant mode

Default when selector is enabled.

- local only;
- no model/network call;
- active same-user habits only;
- confidence, freshness, staleness, overlap, and daily-budget gates;
- bounded guidance injection.

### Smart mode

Opt-in.

- calls the configured model/provider through Pi;
- uses the same active/freshness/staleness/confidence/budget gates;
- no hidden fallback;
- model/auth/timeout/malformed output fails closed to no injection.

## Review flow

The extension is designed around human review.

```text
capture redacted pairs -> consolidate observations -> propose candidate habits -> human review -> active habits -> optional selector injection
```

Review commands:

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

Checksums are used so stale review actions fail closed.

## Configuration

Example config:

```toml
enabled = true
capture_enabled = true
selector_enabled = false
selector_mode = "instant"
selector_daily_budget = 20
selector_timeout_ms = 5000
law_path = "law.md"
```

Environment override for state root:

```bash
AX_STATE_ROOT=/path/to/private/state pi
```

## Development

Run checks:

```bash
npm run check
```

This package is intentionally TypeScript-source-first for Pi's extension loader. It does not compile to `dist/` for normal use.

## Release and update model

This first package is intended for GitHub tag installs:

```bash
pi install git:github.com/misunders2d/pi-experiences@v0.1.0
```

Git package refs are pinned. `pi update --extensions` reconciles the pinned ref but does not float users to a new tag.

For a bug fix:

1. update this repo;
2. add or update regression tests;
3. run review and `npm run check`;
4. commit and tag, for example `v0.1.1`;
5. users update explicitly:

```bash
pi install git:github.com/misunders2d/pi-experiences@v0.1.1
```

## Status

Experimental. This is a research package for separating behavioral experience from skills and memory. Treat active habit injection as something to test carefully, not as a fully solved alignment layer.
