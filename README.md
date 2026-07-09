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
- choose a Pi model for habit learning inside `/experience setup`;
- manually analyze saved examples from `/experience setup` and create candidate habits today;
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
pi install git:github.com/misunders2d/pi-experiences@v0.1.22
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
- **Setup** is the main control panel. It opens a Space/Enter settings menu for saving chat examples locally, choosing the habit-learning model, analyzing saved examples now, reviewing suggested habits, using approved habits before replies, showing the schedule as Phase 2/off, showing current settings, and explaining every setting. It must not change config until you choose an item. The safe save-examples choice turns on local redacted capture and leaves timers and approved-habit reminders off unless you explicitly toggle them.
- **Capture** means saving redacted text fields and metadata from completed user/assistant turns to `observations.jsonl`. It is the raw material. Capture does **not** create habits by itself.
- **Choose model for habit learning** opens a live typeahead model picker inside `/experience setup`; typing text such as `5.5`, `codex`, or `glm` immediately filters authenticated model suggestions, and the current model is shown/marked. Users do not type a model command.
- **Analyze saved examples now** reads already saved redacted examples, calls the configured model once, validates/sanitizes the model output, and writes suggested habits into review. It never approves habits.
- **Pending review** means proposed habits are waiting for you to approve or reject them. Pending items are not used for injection.
- **Active habits** are reviewed habits. The setup menu does not use them before replies unless you explicitly enable approved-habit reminders.
- **Schedule** is Phase 2/off. The package does not install, start, or pretend-enable a timer.

Inside Pi, start with exactly one normal-user command:

```text
/experience setup
```

Then use Pi normally for a few turns. Captures are written locally to:

```text
~/.agents/experience/observations.jsonl
```

The file stores redacted conversation-pair records with bounded text fields and metadata, not raw full session logs.

### Normal command

The normal UX is one control panel:

```text
/experience setup
```

The interactive `/experience setup` menu uses arrow keys plus Space/Enter. Checkbox rows show `[x]` for ON and `[ ]` for OFF; Space or Enter toggles checkbox rows and opens action rows. From that one menu a normal user can save examples, choose a model from live typeahead search or exact model entry with the current model visible, analyze saved examples now, review suggestions, approve/reject, use approved habits before replies, see status, and read explanations.

No typed setup subcommands are required for normal use. If the panel does not render, restart Pi so the latest extension UI loads and run `/experience setup` again.

### Human setup procedure

1. Run `/experience setup`.
2. Toggle **Save chat examples locally** to `[x] ON` with Space or Enter.
3. Use Pi normally for enough repeated examples to exist.
4. Open `/experience setup` again and choose **Choose model for habit learning**.
   - Type to filter live, for example `5.5`, `codex`, or `glm`.
   - The currently configured model is shown at the top and marked `(current)` in the list when present.
   - Use Ctrl+E only when you need to enter an exact `provider/model` id.
5. Choose **Analyze saved examples now**. This starts one nonblocking model job and returns control to Pi.
6. After analysis finishes, choose **Review suggested habits**.
   - Full details appear in a focused review panel, not in chat history.
   - Use ↑/↓ then Space/Enter, or `1`/`2`/`3`, to Approve / Reject / Back.
7. Optionally toggle **Use approved habits before replies** to `[x] ON`. This uses only approved active habits and remains off by default.

### Agent/operator procedure

When maintaining or troubleshooting this package:

- Preserve the one normal-user command: `/experience setup`.
- Do not instruct normal users to type advanced setup/review subcommands.
- Keep setup controls in the menu: capture, model, analyze, review, approved-habit use, schedule explanation, status, help, and all-off.
- Keep checkbox semantics: `[x]` is ON, `[ ]` is OFF, Space/Enter toggles checkbox rows.
- Keep model selection live-searchable; typing text such as `5.5` must immediately filter suggestions and the current model must be visible.
- Keep review details inside the focused panel; do not dump suggested-habit details into chat history for the normal setup flow.
- Do not auto-approve suggestions. Approval/rejection must remain explicit and checksum-protected.
- Keep Analyze nonblocking. It may post completion status, but it must not freeze the foreground setup flow.
- Keep schedule/timer Phase 2/off in normal UX.

If observations are growing but there are no suggestions, choose **Analyze saved examples now** inside `/experience setup`. Candidate generation is manual, not scheduled.

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
- no automatic law-file writes are performed by the extension; the Use approved habits row in `/experience setup` may create the default private `law.md` only after an explicit user choice;
- no automatic habit activation happens from selector use.

## Review flow

The extension is designed around human review.

```text
capture redacted pairs -> analyze saved examples now -> proposed suggestions -> human review -> active habits -> optional approved-habit reminders
```

The **Analyze saved examples now** row inside `/experience setup` can create suggestions from already saved examples using the configured Pi model. Then use **Review suggested habits** inside the same setup menu to inspect them in a focused review panel, then approve or reject them. Normal users do not need typed review commands.

Checksums are still used internally so stale review actions fail closed. Advanced/backcompat review commands exist for maintainers, but they are not the normal path.

### Candidate quality and rejection semantics

Candidate habits should be generalized behavioral guidance, not narrow project labels. Durable tool/task categories are allowed when they define the repeated situation, but one-off project/package names, versions, file paths, hashes, and screenshots are not. The analyzer prompt asks the model to extract the reusable essence across repeated examples:

- good: `When preparing an npm package release, verify the real end-to-end install/update path before calling it done.`
- bad: `When working on Agent Experience, do the 0.1.19 setup flow.`
- good: `When the user reports UI confusion, inspect the real visible UI state before declaring the fix complete.`
- bad: `When using the pi-experiences extension, remember screenshot b0ec...`

Rejecting a candidate archives that exact candidate identity. The exact same normalized condition/behavior/polarity is preserved as rejected/archived on later merges. Rejection is not a permanent semantic ban on every related idea: a materially different or more generalized candidate can appear later if repeated evidence again passes the threshold. Repeated evidence currently means at least 3 cited examples across at least 2 different days.

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

`law_path` is a private-state relative path under the state root (`~/.agents/experience/law.md` by default). Absolute paths, parent traversal, and path separators outside the private state are rejected.

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
- No automatic law-file writes from the extension; setup may create default private `law.md` only after explicit user choice and must not overwrite an existing unreadable file.
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
6. commit and tag, for example `v0.1.22`;
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
pi install git:github.com/misunders2d/pi-experiences@v0.1.22
```

Git package refs are pinned. `pi update --extensions` reconciles the pinned ref but does not float Git installs to a new tag.

For a bug fix:

1. update this repo;
2. add or update regression tests;
3. run review and `npm run check`;
4. bump `package.json` version;
5. commit and tag, for example `v0.1.22`;
6. publish the same commit to npm;
7. npm users update with `pi update --extensions`; Git-pinned users install the new tag explicitly.

## Show current settings

Experimental. This is a research package for separating behavioral experience from skills and memory. Treat active habit injection as something to test carefully, not as a fully solved alignment layer.
