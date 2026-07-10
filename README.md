# pi-experiences

A Pi extension package for **reviewed behavioral experience**: repeated working habits learned from interaction, kept separate from skills and memory.

- **Skills** are deliberate procedures.
- **Memory** is durable facts and knowledge.
- **Experience** is reviewed behavioral and working habits inferred from repetition.

Experience may learn durable work preferences or recurring task/tool categories. It must not learn project facts, one-off labels, credentials, or task knowledge as habits.

## Safety model

Everything starts off.

- Package installation does not capture conversations, download a local model, run learning, activate habits, install timers, or inject reminders.
- Every new or materially reworded habit requires explicit human approval before activation.
- Exact normalized evidence may update counts for an already approved identity without changing its meaning.
- Strong exact contradictory evidence may make one uniquely matched old habit dormant, but the replacement remains a proposal requiring approval.
- Direct user instructions and configured law always override habits.
- No automatic approval, semantic merge, replacement activation, law-file modification, or scheduling occurs.
- Missing, corrupt, stale, or incompatible state fails closed.

The complete normal-user surface is:

```text
/experience setup
```

Normal users do not need IDs, checksums, thresholds, endpoints, model servers, or advanced subcommands.

## Install

Stable npm installation:

```bash
pi install npm:pi-experiences
```

Update npm-installed Pi packages:

```bash
pi update --extensions
```

Pinned GitHub installation:

```bash
pi install git:github.com/misunders2d/pi-experiences@v0.1.27
```

Git refs remain pinned; they do not float to newer tags.

Requirements:

- Node.js `>=22.19.0`
- a compatible Pi installation

Pi core packages remain wildcard peer dependencies so the extension uses the host Pi runtime rather than bundling another copy.

## Normal workflow

1. Run `/experience setup`.
2. Turn on **Save chat examples locally**.
3. Use Pi normally until repeated examples exist.
4. Choose **Choose model for habit learning**.
5. Choose **Analyze saved examples now**.
6. Open **Review suggested habits** and explicitly approve or reject each proposal.
7. Use **Review approved habits** to inspect, disable, re-enable, archive, or recheck an approved habit that is waiting.
8. Optionally enable **Prevent duplicate habits**.
9. Optionally enable **Use approved habits before replies**.

The setup panel also contains:

- duplicate resolution;
- 7/14/30-day source-example retention;
- current settings;
- schedule explanation (Phase 2/off);
- all-off;
- plain-language help.

Analyze runs as a bounded nonblocking job. Suggestions remain inert until approval.

## Review and activation

A suggestion needs repeated evidence: currently at least three cited observations across at least two days.

Approval and activation are separate when a requirement is temporarily unmet. An approved candidate can remain visibly waiting for:

- enough evidence;
- current safety-law approval;
- conflict resolution;
- local duplicate checking.

Analyze automatically rechecks approved waiting candidates after a validated commit. The same recheck is available under **Review approved habits**. Prior approval applies only while normalized condition, behavior, and polarity remain unchanged; material wording changes require approval again.

Potential duplicates are never silently merged. **Resolve duplicate habits** shows both complete wordings, states exactly which habit each outcome keeps or hides, and confirms merge, replacement, and archive choices before changing anything.

Candidate habits should generalize reusable behavior:

- good: `When preparing a package release, verify the real installed artifact before calling it complete.`
- bad: `When working on project X version Y, run this one-off file.`

## Fully managed local duplicate prevention

Duplicate prevention uses one extension-managed multilingual local component. It has no hosted provider or fallback.

- It is off by default.
- Package installation downloads nothing.
- Explicit preparation from `/experience setup` downloads about 150 MB once.
- The pinned model is trained for semantic similarity across 50+ languages; release tests include same-language and cross-language fixtures.
- No API key, account, Python, Ollama, LM Studio, port, service, provider, endpoint, dimension, or model identifier is configured by the user.
- Assets stay under the private Agent Experience state root with 0700 directories and 0600 files.
- Every asset is version, size, and SHA-256 checked before use.
- A valid cache works offline.
- Corruption, missing assets, failed download, cancellation, or incompatible runtime fails closed with no external fallback.
- Setup can remove all managed local model files.
- Upgrades stage and verify the new version before replacing/cleaning superseded managed versions.
- Inference runs in a bounded worker and unloads after 30 seconds idle or explicit scan completion.

The only embedding input is exactly normalized:

```text
condition\nbehavior
```

Raw examples, source references, evidence summaries, residual JSON, file paths, checksums, audit text, credentials, and tokens are excluded. Raw vectors exist only in the private SQLite cache, not duplicate relation/audit JSON.

Explicit scans are capped at 100 current habits (4,950 pairs), batch local work, show progress, support cancellation, revalidate their snapshot, and commit atomically. Failure or cancellation leaves pre-scan semantic state unchanged.

## Bounded observations and privacy retention

Captured conversation pairs are heuristically redacted and bounded. Redaction reduces exposure; it is not a formal guarantee that every sensitive value can be recognized.

Observation storage uses:

- an append-only JSONL generation;
- a checksummed tail manifest;
- a fixed-width offset index;
- token-owned single-writer locking.

Append validates only bounded tail state rather than parsing all history. Analyze seeks directly to the next same-user contiguous unread range, with defaults of at most 200 records and 80,000 bytes. A watermark advances only in the successful reducer transaction. Compact structured habit/candidate context preserves cross-batch learning without resending committed raw observations.

After a generation is fully analyzed, source text rotates through a recovery journal. Rotated redacted source text expires after:

- 7 days by default (recommended/privacy-first);
- optionally 14 or 30 days from `/experience setup`.

Deletion preserves minimized evidence, provenance, checksums, and review audit. Raw source text is never retained merely to compensate for missing incremental state.

## Private state

Default root:

```text
~/.agents/experience/
```

Representative contents:

```text
agent-experience.toml       # private user controls
ledger.sqlite               # habits, evidence, review/audit, vectors, watermarks
observations.jsonl          # current bounded redacted source generation
observations.idx            # fixed-width end-offset index
observations-tail.json      # checksummed current-generation authority
archive/observations/       # journaled short-retention rotated generations
models/local-embedding/     # optional managed local duplicate-check assets
law.md                      # explicitly created/configured private safety law
habits-report.md            # report-only output; never selector input
```

One state root represents one human across local agents/harnesses. Shared multi-human roots are outside v1 scope.

## SQLite safety, backup, and restore

Storage schema remains v6 for rollback compatibility with the corrective release.

- Existing databases read `PRAGMA user_version` before WAL or any writeful operation.
- A future schema fails closed and is not downgraded or modified.
- Supported v5→v6 migration is transactional and idempotent.
- Current-schema opens verify required tables/indexes rather than silently reconstructing malformed state.

Backups use Node's SQLite online backup API to create a standalone consistent `ledger.sqlite`. New backups intentionally exclude WAL/SHM, raw observation text, archives, model assets, config, and law so backup cannot bypass source-retention policy.

Restore prevalidates allowlisted artifacts, paths, symlinks, sizes, hashes, schema, and `PRAGMA integrity_check`. A checksummed restore journal provides recoverable old-or-new transitions, removes stale sidecars, and starts a fresh observation generation after a storage-v2 restore.

## Locks and concurrency

Maintenance, observation, model-installation, Analyze, and consolidation operations use token-owned locks with PID, hostname, and creation time.

- acquisition is atomic;
- live owners block concurrent writers;
- expired, dead-owner, and aged malformed locks can be reclaimed safely;
- foreign-host ownership fails closed;
- release removes only the caller's token;
- ownership mismatch preserves the replacement lock.

Habit approval, re-enable, and promotion prepare local vectors outside the SQLite writer transaction, then use one `BEGIN IMMEDIATE` transaction to revalidate target/comparator/law state and either block or activate. Concurrent duplicate activations therefore cannot both succeed.

## Approved-habit reminders

Reminder injection is off by default.

Default `instant` mode is local lexical/no-network matching. Only active, same-user, fresh approved habits are candidates. Pending, disabled, dormant, suppressed, archived, evidence, quarantine, report, and raw observation rows are excluded.

Optional advanced smart matching is separately configured and fails closed on unavailable authentication, timeout, or malformed output. Selector logs never persist raw prompts, sessions, or injected guidance; `prompt_hash` is deliberately `omitted`.

Timers remain Phase 2/off. The package does not install or enable bundled timer templates.

## Configuration

Normal configuration belongs in `/experience setup`. A minimal technical example:

```toml
enabled = true
capture_enabled = true
consolidation_enabled = true
embedding_enabled = false
selector_enabled = false
selector_mode = "instant"
observation_retention_days = 7
analyze_batch_max_records = 200
analyze_batch_max_bytes = 80000
law_path = "law.md"
timer_enabled = false
break_in_enabled = false
```

Legacy hosted-embedding fields are ignored and removed on the next config write. No hosted embedding environment variables are supported.

Override the private root when isolating a test:

```bash
AX_STATE_ROOT=/path/to/private/state pi
```

## Development and validation

From the package root:

```bash
npm run check
npm audit --omit=dev
npm pack --dry-run
```

`npm run check` covers prior behavior plus:

- future-schema and v5 migration regressions;
- online backup/journaled restore adversarial tests;
- bounded observation append/Analyze/rotation/retention;
- real optional local-model integration when fixture paths are supplied;
- semantic two-connection barriers and atomic scan failure/cancellation;
- stale lock recovery;
- source/import bundling;
- CLI generation drift.

The real local-model integration command used by maintainers is documented in `extensions/agent-experience/VALIDATION.md` and requires already downloaded pinned fixtures; it makes inference offline.

Before release, validate the exact `npm pack` tarball in a fresh `--ignore-scripts` installation and run an isolated real Pi TUI with a temporary `AX_STATE_ROOT`. Source-path smoke alone is insufficient.

## Release discipline

For a release:

1. update source, tests, docs, and generated CLI together;
2. run complete automated and packed-installed validation;
3. obtain independent code/privacy/constitution review for significant changes;
4. bump version;
5. commit and push `main`;
6. create and push the matching immutable tag;
7. publish npm only as a separate explicit manual action.

GitHub is the source of truth. npm publication is not performed automatically by this repository.

## Status

Agent Experience is a research package. Treat approved-habit injection as a carefully reviewed personalization layer, not a solved alignment system.
