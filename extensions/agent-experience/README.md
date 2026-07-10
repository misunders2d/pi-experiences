# Agent Experience extension

Agent Experience learns **reviewed behavioral and working habits** from repeated interaction. It is not a skill store or factual memory store.

## Normal control surface

Use one command:

```text
/experience setup
```

The panel contains every normal action:

- save redacted chat examples locally;
- choose the Pi model used for manual habit learning;
- analyze the next bounded unread range;
- review suggestions;
- resolve possible duplicates;
- browse, disable, re-enable, archive, or recheck approved habits;
- prepare/remove local duplicate prevention;
- choose 7/14/30-day source-example retention;
- enable approved-habit reminders;
- inspect current settings;
- confirm scheduling is Phase 2/off;
- turn everything off.

Normal users do not type IDs, checksums, thresholds, endpoints, model-server settings, or advanced commands.

## Product invariants

- New or materially reworded habits require explicit approval.
- Exact normalized evidence may increase support for an unchanged approved identity.
- Exact strong contradiction may make one uniquely matched active habit dormant; replacement wording remains a proposal.
- Direct instructions and law override habits.
- No automatic approval, merge, replacement activation, law write, or timer installation.
- One private state root represents one human.
- Missing/corrupt/stale state fails closed.

Approved-but-waiting candidates remain visible under **Review approved habits** and are automatically rechecked after successful Analyze commits. Prior approval remains valid only while normalized condition, behavior, and polarity are unchanged.

## Capture and Analyze

Capture writes bounded, heuristically redacted completed conversation pairs. It does not create habits.

Observation generations use a checksummed tail manifest and fixed-width offset index, so normal append and Analyze do not parse or resend all history. Analyze reads only the next contiguous same-user unread range (default maximum 200 records / 80,000 bytes), includes compact structured prior-habit context, and advances its watermark only in the successful reducer transaction.

Fully analyzed source generations rotate through a recovery journal. Rotated redacted source text expires after 7 days by default, with 14/30-day choices. Minimized evidence, provenance, integrity checks, and review audit remain.

Redaction is heuristic, not a formal proof that every sensitive value is recognizable.

## Local duplicate prevention

Duplicate prevention is fully local and extension-managed.

- off by default;
- no download during package installation;
- explicit setup preparation downloads about 150 MB once;
- the pinned semantic-similarity model supports 50+ languages and is tested across languages;
- no hosted provider/fallback, API key, external runtime, Python, model server, port, account, or service;
- private 0700/0600 cache inside the state root;
- pinned version/size/SHA-256 manifest;
- offline inference after preparation;
- cancellation cleanup, corruption fail-closed, upgrade staging, and setup removal;
- single-threaded bounded worker, 128-token input cap, maximum 64 texts per local request, and 30-second idle unload.

Only normalized `condition + "\n" + behavior` enters local inference. Raw examples, source refs, evidence summaries, residual JSON, paths, checksums, audit text, credentials, and tokens do not.

Scans are capped at 100 habits / 4,950 pairs, batched, cancellable, progress-visible, snapshot-revalidated, and committed in one transaction. Failure leaves pre-scan semantic state unchanged.

Similarity only routes possible duplicates for explicit resolution. Opposite polarity is excluded before comparison. No semantic result approves or merges a habit.

## Activation concurrency

Approve, re-enable, and approved-pending promotion share one atomic activation path:

1. snapshot target and active/disabled comparators;
2. prepare missing local vectors outside the writer transaction;
3. begin `BEGIN IMMEDIATE`;
4. re-read target, comparators, kept-separate decisions, and current law;
5. persist valid cache/relation/audit changes;
6. block or perform the state transition before one commit.

State drift retries boundedly, then fails closed. Two concurrent connections cannot both activate semantic duplicates.

## Storage safety

- schema v6;
- first statement on an existing ledger is read-only `PRAGMA user_version`;
- future versions receive no mutation;
- v5→v6 migration is transactional/idempotent;
- current schemas verify required structures.

Online backups contain a standalone consistent `ledger.sqlite` only. Restore allowlists and prevalidates artifacts, rejects symlinks/traversal/tamper/future schemas, uses a checksummed recovery journal, removes stale WAL/SHM, and produces a complete old or restored state rather than a mixed generation.

Shared locks carry random token, PID, hostname, and creation time. Live locks block; expired/dead/malformed locks recover under bounded rules; foreign-host locks fail closed; release verifies ownership.

## Selector/reminders

Approved-habit reminders are off by default. Default instant mode is lexical, local, and no-network. Only active same-user approved habits are candidates. Raw prompts and injected text are not persisted; `prompt_hash` remains `omitted`.

The configured law file is synchronously revalidated at activation. Current law checking combines freshness/integrity with a deterministic dangerous-pattern denylist; it is not full semantic interpretation of law text.

## State layout

Default root: `~/.agents/experience/`

```text
agent-experience.toml
ledger.sqlite
observations.jsonl
observations.idx
observations-tail.json
archive/observations/
models/local-embedding/
law.md
habits-report.md
```

`habits-report.md` is report-only and never selector input.

## Advanced compatibility controls

Typed capture/consolidation/review/selector commands and `experience-consolidate` exist for maintainers and tests. Do not present them as the normal workflow. Setup must remain complete.

Timer unit files are disabled templates only. No setup action installs or enables them.

## Validation

Run from package root:

```bash
npm run check
npm audit --omit=dev
```

See `VALIDATION.md` for local-model fixtures, packed installation, Node 22.19+, skill loader, and isolated real Pi TUI validation.
