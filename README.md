# Pi Experiences

Pi Experiences is an experimental Pi package for giving coding agents a third kind of long-term learning: **experience**.

## For humans: what is this for?

Most agent personalization gets mixed into two buckets:

- **Skills** — explicit procedures: "when doing X, follow these steps."
- **Memory** — remembered facts: "this project uses Y," "the user prefers Z," "this decision happened."

But humans also learn a third way: through repeated interaction. We develop habits, tone, caution, timing, and judgment patterns. We learn things like:

- when to be brief vs. careful;
- when to ask before acting;
- when a user wants a rollback path before a risky change;
- when a repeated correction means "change your behavior next time." 

Pi Experiences tries to model that third bucket separately.

```text
skills     = procedures you intentionally wrote down
memory     = facts you want the agent to remember
experience = behavioral patterns inferred from repeated interaction, then reviewed
```

The goal is **not** to let an agent silently rewrite itself. The goal is to capture behavioral patterns, make them reviewable, and only inject small, relevant guidance after they are accepted.

Think of it as a local, review-first habit layer:

```text
normal work
  -> redacted local observations
  -> candidate habits
  -> human review
  -> active habits
  -> optional just-in-time guidance
```

Examples of experience-style habits:

- "When discussing risky runtime changes, summarize rollback path first."
- "When tests pass but live runtime may be stale, ask for reload before claiming smoke success."
- "When packaging public code, explain install/update semantics in human terms."

Those are not skills. They are not facts. They are behavioral tendencies that may help the agent feel less reset between sessions.

## What gets installed?

The package installs:

- the `agent-experience` Pi extension;
- a small public `agent-experience` skill explaining how to operate it.

The extension can:

- opt in to local capture of redacted conversation pairs;
- store captures under a private state root, default `~/.agents/experience/`;
- consolidate repeated observations into candidate habits;
- require human review before habits become active;
- keep selector injection disabled by default;
- when enabled, select only active same-user habits;
- inject only bounded guidance, never raw conversation history;
- keep skills, memory, reports, pending review rows, and quarantine rows out of selector input.

## Install

Recommended stable install from npm:

```bash
pi install npm:pi-experiences
```

Update npm-installed Pi packages to the latest published stable version:

```bash
pi update --extensions
```

Pinned GitHub tag install is also available when you want an exact source ref:

```bash
pi install git:github.com/misunders2d/pi-experiences@v0.1.2
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

<details>
<summary>For agents and maintainers: technical contract, caveats, and release discipline</summary>

### Package contract

- `package.json` includes the `pi-package` keyword.
- `pi.extensions` points at `./extensions`.
- `pi.skills` points at `./skills`.
- Pi core packages are peer dependencies, not bundled runtime code.
- The package is TypeScript-source-first for Pi's extension loader.
- Node engine: `>=22.18.0`.

### Hard invariants

- Do not persist raw prompts, raw session logs, or raw injected guidance in selector logs.
- Keep `prompt_hash = "omitted"` unless a future design explicitly proves non-linkability.
- Selector candidates must be active same-user habits only.
- No injection from reports, pending review, quarantine, evidence, disabled, dormant, candidate, suppressed, or archived rows.
- Selector remains disabled by default.
- Default selector mode remains `instant`.
- Smart mode must fail closed on auth/model/timeout/malformed output.
- Missing ledger/law must fail closed.
- Hot selector path must not initialize storage or run migrations.
- No law-file writes from the extension.
- No automatic activation from selector use.

### Capture contract

- Capture writes redacted conversation-pair records to `observations.jsonl`.
- Completed pairs flush at `agent_end`, not at next input, so the last turn survives normal process exit.
- `close_reason = "agent_end"` is expected for normal capture records.
- `prev_pair_ref` links records so later consolidation can reason over sequence without storing reaction inside the previous pair.

### Law-check caveat

The current law checker is deterministic v1. It checks law freshness and a small denylist of dangerous habit text patterns. It is not full semantic contradiction detection. Future semantic checks should create pending-review items, not direct activations.

### Selector caveats

- Instant mode is lexical and deterministic; it is intentionally simple.
- Smart mode may add latency and requires measured p95 before recommending always-on use.
- No-injection paths intentionally do not write skip rows unless an injection transaction is already happening; this preserves the no durable trace invariant for failed selection paths.

### Release discipline

GitHub is the source of truth. npm is the stable distribution channel.

For a bug fix:

1. patch source in GitHub repo;
2. add a regression test;
3. run reviewer/debate for non-trivial safety or runtime changes;
4. run `npm run check`;
5. bump `package.json` version;
6. commit and tag, for example `v0.1.3`;
7. publish the same commit to npm;
8. tell npm users to run `pi update --extensions`.

Git installs are pinned. They do not float to newer tags.

</details>

## Development

Run checks:

```bash
npm run check
```

This package is intentionally TypeScript-source-first for Pi's extension loader. It does not compile to `dist/` for normal use.

## Release and update model

GitHub is the source of truth. npm is the stable distribution channel.

For users who want latest stable updates:

```bash
pi install npm:pi-experiences
pi update --extensions
```

For users who want a pinned exact source ref:

```bash
pi install git:github.com/misunders2d/pi-experiences@v0.1.2
```

Git package refs are pinned. `pi update --extensions` reconciles the pinned ref but does not float Git installs to a new tag.

For a bug fix:

1. update this repo;
2. add or update regression tests;
3. run review and `npm run check`;
4. bump `package.json` version;
5. commit and tag, for example `v0.1.3`;
6. publish the same commit to npm;
7. npm users update with `pi update --extensions`; Git-pinned users install the new tag explicitly.

## Status

Experimental. This is a research package for separating behavioral experience from skills and memory. Treat active habit injection as something to test carefully, not as a fully solved alignment layer.
