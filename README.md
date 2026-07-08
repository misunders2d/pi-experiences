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
- manually consolidate repeated observations into candidate habits through the bundled `experience-consolidate` CLI;
- require human review before habits become active;
- keep pre-injection / selector injection disabled by default;
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
pi install git:github.com/misunders2d/pi-experiences@v0.1.10
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

### Plain-language pieces

- **Experience** is the whole behavior-learning layer.
- **Setup** is the main control panel. It opens a checkbox-style settings panel for saving chat examples locally, suggesting habits from saved examples when asked, using approved habits before replies, background-learning explanation, reviewing suggested habits, showing current settings, and explaining every setting. It must not change config until you choose an item. The safe save-examples choice turns on local redacted capture and leaves timers, model learning, and approved-habit reminders off unless you explicitly toggle them.
- **Capture** means saving redacted text fields and metadata from completed user/assistant turns to `observations.jsonl`. It is the raw material. Capture does **not** create habits by itself.
- **Suggest habits from saved examples when I ask** means Pi may analyze saved examples only when explicitly asked and then show proposed habits for review. In 0.1.10 this is **not automatic**: no timer or live consolidation model adapter is installed.
- **Pending review** means proposed habits are waiting for you to approve or reject them. Pending items are not used for injection.
- **Active habits** are reviewed habits. Normal setup/on does not use them before replies unless you explicitly enable approved-habit reminders.
- **Timer** is only a future/advanced way to run learning in the background. It is not installed, started, or managed by this package.

Inside Pi:

```text
/experience setup
/experience status
/experience review
```

Then use Pi normally for a few turns. Captures are written locally to:

```text
~/.agents/experience/observations.jsonl
```

The file stores redacted conversation-pair records with bounded text fields and metadata, not raw full session logs.

### Normal commands

The normal UX is a single control panel plus optional shortcuts:

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
/experience on                            # shortcut: resume local redacted capture
/experience off                           # shortcut: stop capture and all runtime gates
/experience status                        # shortcut: plain dashboard
/experience review                        # shortcut: inspect/accept/reject candidates if any exist
```

The interactive `/experience setup` panel uses checkbox-style rows: `[x]` means ON and `[ ]` means OFF. Press Enter on a setting to toggle it; Show current settings, Review suggested habits, and Explain these settings live inside the panel; Done exits. You can also manage all settings from `/experience setup ...` without remembering the shortcuts. If Pi does not render the interactive menu, use the explicit setup subcommands above.

If observations are growing but `/experience review` shows no candidates, capture is working. In 0.1.10, candidate generation is not automatic because the package does not ship a live consolidation model adapter or install/manage a timer.

Advanced/backcompat commands such as `/experience capture`, `/experience consolidation`, `/experience selector`, `/experience pending`, and `experience-consolidate --fixture-output` are maintainer/testing controls, not the normal first-run path.

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
capture redacted pairs -> future/advanced consolidation -> proposed candidates -> human review -> active habits -> optional advanced selector injection
```

In 0.1.10, the package captures locally but does **not** automatically create candidates. The bundled `experience-consolidate` command is an advanced maintainer/test CLI that requires explicit fixture/model output; normal users should not need it.

Review commands:

```text
/experience review
/experience review list
/experience review show <id>
/experience review diff
/experience review accept <id> --checksum <checksum>
/experience review reject <id> --checksum <checksum>
/experience review report
```

Checksums are used so stale review actions fail closed. The old `/experience pending ...` and `/experience habit ...` commands remain advanced/backcompat aliases.

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
6. commit and tag, for example `v0.1.10`;
7. publish the same commit to npm;
8. tell npm users to run `pi update --extensions`.

Git installs are pinned. They do not float to newer tags.

</details>

## Development

Run checks:

```bash
npm run check
```

This package keeps TypeScript extension source for Pi's extension loader and builds the public consolidation CLI to `dist/experience-consolidate.mjs` for npm/Git installs.

## Release and update model

GitHub is the source of truth. npm is the stable distribution channel.

For users who want latest stable updates:

```bash
pi install npm:pi-experiences
pi update --extensions
```

For users who want a pinned exact source ref:

```bash
pi install git:github.com/misunders2d/pi-experiences@v0.1.10
```

Git package refs are pinned. `pi update --extensions` reconciles the pinned ref but does not float Git installs to a new tag.

For a bug fix:

1. update this repo;
2. add or update regression tests;
3. run review and `npm run check`;
4. bump `package.json` version;
5. commit and tag, for example `v0.1.10`;
6. publish the same commit to npm;
7. npm users update with `pi update --extensions`; Git-pinned users install the new tag explicitly.

## Show current settings

Experimental. This is a research package for separating behavioral experience from skills and memory. Treat active habit injection as something to test carefully, not as a fully solved alignment layer.
